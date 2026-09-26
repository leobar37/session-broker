/**
 * Suite `test:handoff` — consumidor externo portable y relocalización
 * (P-006 / FR-011, DoD binario de la fase).
 *
 * Ejecuta la receta congelada de `docs/contracts/consumption.md` completa:
 * snapshot de los cinco workspaces bajo TMP, `bun pm pack` → `vendor/*.tgz`
 * relativos, `consumer-smoke/` con specs `file:../vendor/*.tgz`, `bun install
 * --offline` y el smoke FUERA del repo. Después copia bundle+consumidor a un
 * SEGUNDO TMP y repite el smoke resolviendo todo respecto a la nueva ruta.
 *
 * Nada se escribe fuera de TMP (prefijo reservado `omp-session-broker-test-`),
 * la red externa queda bloqueada y el smoke usa fake model que FALLA si se le
 * invoca. El smoke se ejecuta como proceso hijo (`bun test ./smoke.test.ts`):
 * resuelve los paquetes instalados como cualquier consumidor real.
 *
 * ÚNICA escritura documentada fuera de TMP: `docs/handoff/evidence/
 * consumer.fragment.json` (excluido del source hash) con el bloque `consumer`
 * REAL observado (smokeExitCode, relocationExitCode y vendorArtifacts con
 * sha256/bytes de los .tgz empaquetados). El coordinador lo fusiona en su
 * evidence input; ver docs/handoff/README.md. Equivalencia reproducible:
 * `bun test tests/handoff/consumer.test.ts` exit 0 ⇔ ambos smokes en verde.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONSUMER_FRAGMENT_RELATIVE_PATH, canonicalVendorName } from "./lib/handoff-schema";
import { installNetworkGuard, makeTmpDir, removeTmpDir, type CommandResult } from "./lib/isolation";
import { readRepoFacts, type RepoFacts } from "./lib/repo-facts";
import {
  buildSnapshot,
  installConsumer,
  packWorkspaces,
  relocateSnapshot,
  runConsumerSmoke,
  scanForMachinePaths,
  writeConsumerEvidenceFragment,
  type PackedArtifact,
} from "./lib/snapshot";

const repoRoot = join(import.meta.dir, "..", "..");
const SMOKE_ALLOWED_IMPORTS: Record<string, true> = {
  "bun:test": true,
  "@session-broker/protocol": true,
  "@session-broker/protocol/fixtures": true,
  "@session-broker/client": true,
  "@session-broker/server": true,
  "@session-broker/cli": true,
  "@session-broker/omp-adapter": true,
};

interface ConsumerFlow {
  readonly facts: RepoFacts;
  readonly snapshotA: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly installA: CommandResult;
  readonly smokeA: CommandResult;
  readonly snapshotB: string;
  readonly installB: CommandResult;
  readonly smokeB: CommandResult;
}

let restoreNetwork: (() => void) | undefined;
const tmpRoots: string[] = [];
let flow: ConsumerFlow | undefined;

function mustPass(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} falló (exit ${result.exitCode})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
}

async function runConsumerFlow(): Promise<ConsumerFlow> {
  const facts = readRepoFacts(repoRoot);
  // Un fragmento viejo no debe sobrevivir a una corrida fallida: se borra al
  // arrancar y solo se reescribe con los resultados REALES de esta corrida.
  rmSync(join(repoRoot, ...CONSUMER_FRAGMENT_RELATIVE_PATH.split("/")), { force: true });
  const tmpA = makeTmpDir("handoff-consumer");
  tmpRoots.push(tmpA);
  const snapshotA = join(tmpA, "snapshot");
  buildSnapshot({ facts, snapshotDir: snapshotA });
  const artifacts = await packWorkspaces({ facts, snapshotDir: snapshotA, envTmp: tmpA });
  const consumerA = join(snapshotA, "consumer-smoke");
  const installA = await installConsumer({ consumerDir: consumerA, envTmp: tmpA });
  mustPass(installA, "bun install --offline del consumidor (snapshot A)");
  const smokeA = await runConsumerSmoke({ consumerDir: consumerA, envTmp: tmpA });

  // Relocalización: bundle + consumidor en un SEGUNDO TMP independiente.
  const tmpB = makeTmpDir("handoff-relocated");
  tmpRoots.push(tmpB);
  const snapshotB = join(tmpB, "snapshot");
  relocateSnapshot({ from: snapshotA, to: snapshotB });
  const consumerB = join(snapshotB, "consumer-smoke");
  const installB = await installConsumer({ consumerDir: consumerB, envTmp: tmpB });
  mustPass(installB, "bun install --offline del consumidor (snapshot B relocalizado)");
  const smokeB = await runConsumerSmoke({ consumerDir: consumerB, envTmp: tmpB });

  return { facts, snapshotA, artifacts, installA, smokeA, snapshotB, installB, smokeB };
}

function requireFlow(): ConsumerFlow {
  if (flow === undefined) throw new Error("el flujo del consumidor no se ejecutó (beforeAll)");
  return flow;
}

beforeAll(async () => {
  restoreNetwork = installNetworkGuard();
  flow = await runConsumerFlow();
});

afterAll(() => {
  restoreNetwork?.();
  for (const dir of tmpRoots) removeTmpDir(dir);
});

describe("consumidor externo portable (fuera del repo)", () => {
  test("snapshot: cinco workspaces con src completo, sin node_modules/dist ni rutas absolutas", () => {
    const current = requireFlow();
    for (const fact of current.facts.packages) {
      const wsDir = join(current.snapshotA, fact.dir);
      expect(existsSync(join(wsDir, "package.json"))).toBe(true);
      expect(existsSync(join(wsDir, "src"))).toBe(true);
      expect(existsSync(join(wsDir, "node_modules"))).toBe(false);
      expect(existsSync(join(wsDir, "dist"))).toBe(false);
    }
    const leaks = scanForMachinePaths(current.snapshotA, [repoRoot, homedir()]);
    expect(leaks.map((leak) => `${leak.file} → ${leak.needle}`)).toEqual([]);
  });

  test("empaquetado relativo: vendor/ con los cinco tarballs canónicos", () => {
    const current = requireFlow();
    const expected = current.facts.packages.map((fact) => canonicalVendorName(fact.name, fact.version));
    expect(current.artifacts.map((artifact) => artifact.file)).toEqual(expected);
    for (const artifact of current.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(existsSync(join(current.snapshotA, "vendor", artifact.file))).toBe(true);
    }
    expect(existsSync(join(current.snapshotA, "consumer-smoke", "smoke.test.ts"))).toBe(true);
  });

  test("bun install --offline + smoke del consumidor pasan en el primer TMP", () => {
    const current = requireFlow();
    mustPass(current.smokeA, "smoke del consumidor (snapshot A)");
  });

  test("relocalización: segundo TMP resuelve por su propia ruta y repite el smoke", () => {
    const current = requireFlow();
    expect(current.snapshotB).not.toBe(current.snapshotA);
    expect(current.snapshotB.startsWith(current.snapshotA)).toBe(false);
    mustPass(current.smokeB, "smoke del consumidor (snapshot B relocalizado)");
    // Explícito: ningún manifest del consumidor relocalizado contiene rutas de esta máquina.
    const leaks = scanForMachinePaths(current.snapshotB, [repoRoot, homedir(), current.snapshotA]);
    expect(leaks.map((leak) => `${leak.file} → ${leak.needle}`)).toEqual([]);
  });

  test("el consumidor importa SOLO exports públicos de los cinco paquetes", () => {
    const current = requireFlow();
    const smokeSource = readFileSync(join(current.snapshotB, "consumer-smoke", "smoke.test.ts"), "utf8");
    expect(smokeSource).not.toContain("packages/");
    expect(smokeSource).not.toContain("apps/");
    expect(smokeSource).not.toContain("/src/");
    const specifiers = [...smokeSource.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const allowed = SMOKE_ALLOWED_IMPORTS[specifier] === true || specifier.startsWith("node:");
      if (!allowed) throw new Error(`import no público en el consumidor: ${specifier}`);
    }
    const packaged = readdirSync(join(current.snapshotB, "vendor"));
    expect(packaged.sort()).toEqual(
      current.facts.packages.map((fact) => canonicalVendorName(fact.name, fact.version)).sort(),
    );
  });

  test("fragmento de evidencia del consumidor: bloque consumer REAL para el coordinador", () => {
    const current = requireFlow();
    // Solo con los DOS smokes en verde se materializa evidencia (sin fabricar).
    mustPass(current.smokeA, "smoke del consumidor (snapshot A)");
    mustPass(current.smokeB, "smoke del consumidor (snapshot B relocalizado)");
    const fragmentPath = writeConsumerEvidenceFragment({
      repoRoot,
      consumer: {
        smokeExitCode: current.smokeA.exitCode,
        relocationExitCode: current.smokeB.exitCode,
        vendorArtifacts: current.artifacts.map((artifact) => ({
          file: artifact.file,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        })),
      },
    });
    const fragmentText = readFileSync(fragmentPath, "utf8");
    process.stdout.write(`\n[consumer evidence] ${CONSUMER_FRAGMENT_RELATIVE_PATH}\n${fragmentText}\n`);
    const parsed = JSON.parse(fragmentText) as {
      consumer: { smokeExitCode: number; relocationExitCode: number; vendorArtifacts: unknown[] };
    };
    expect(parsed.consumer.smokeExitCode).toBe(0);
    expect(parsed.consumer.relocationExitCode).toBe(0);
    expect(parsed.consumer.vendorArtifacts.length).toBe(5);
  });
});
