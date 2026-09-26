/**
 * Snapshot portable + empaquetado relativo + consumidor externo (P-006).
 *
 * Implementa la receta CONGELADA de `docs/contracts/consumption.md`:
 *  1. copia de fuentes de los cinco workspaces a un snapshot bajo TMP;
 *  2. `bun pm pack` por workspace → `vendor/*.tgz` con nombres canónicos;
 *  3. `consumer-smoke/` con specs `file:../vendor/*.tgz` RELATIVAS;
 *  4. `bun install --offline` + `bun test smoke.test.ts` fuera del repo;
 *  5. relocalización: copiar bundle+consumidor a un segundo TMP y repetir.
 *
 * Prohibiciones que este módulo hace cumplir (y que la suite verifica): sin
 * `node_modules`/`dist` en el snapshot, sin rutas absolutas de esta máquina en
 * ningún manifest, sin red externa (entorno efímero + `--offline`), sin tocar
 * el monorepo.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalVendorName, CONSUMER_FRAGMENT_RELATIVE_PATH, CONSUMER_FRAGMENT_SCHEMA, type EvidenceConsumer } from "./handoff-schema";
import type { PackageFact, RepoFacts } from "./repo-facts";
import { childEnv, runCommand, type CommandResult } from "./isolation";

export interface PackedArtifact {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Workspace del snapshot que se empaquetó (relativo al snapshot). */
  readonly workspaceDir: string;
}

/** Directorio estático del consumidor (se copia al snapshot). */
export const CONSUMER_SMOKE_SOURCE_DIR = join(import.meta.dir, "..", "consumer-smoke");

const SKIP_DIR_NAMES: Record<string, true> = { node_modules: true, dist: true, coverage: true, ".git": true };

function copyTreeFiltered(src: string, dest: string, skip: (rel: string) => boolean): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const rel = entry.name;
    if (skip(rel)) continue;
    const from = join(src, rel);
    const to = join(dest, rel);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES[rel] === true) continue;
      copyTreeFiltered(from, to, skip);
      continue;
    }
    if (entry.isFile()) copyFileSync(from, to);
  }
}

/** Normaliza specs internas `workspace:*` → versión concreta (consumo sin npm). */
function normalizedManifest(fact: PackageFact, facts: RepoFacts): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(facts.repoRoot, fact.dir, "package.json"), "utf8")) as Record<string, unknown>;
  const dependencies: Record<string, string> = {};
  for (const [name, spec] of Object.entries(fact.dependencies)) {
    const local = facts.packages.find((candidate) => candidate.name === name);
    dependencies[name] = local === undefined ? spec : local.version;
  }
  return {
    name: fact.name,
    version: fact.version,
    description: manifest["description"],
    type: manifest["type"],
    private: manifest["private"],
    exports: manifest["exports"],
    dependencies,
    devDependencies: {},
  };
}

/**
 * Construye el snapshot en `snapshotDir` (layout congelado de consumption.md).
 * No ejecuta nada: solo copia fuentes y escribe manifests portables.
 */
export function buildSnapshot(input: { facts: RepoFacts; snapshotDir: string }): void {
  const { facts, snapshotDir } = input;
  mkdirSync(snapshotDir, { recursive: true });
  for (const fact of facts.packages) {
    const wsSrc = join(facts.repoRoot, fact.dir);
    const wsDest = join(snapshotDir, fact.dir);
    copyTreeFiltered(join(wsSrc, "src"), join(wsDest, "src"), () => false);
    writeFileSync(join(wsDest, "package.json"), `${JSON.stringify(normalizedManifest(fact, facts), null, 2)}\n`, "utf8");
  }
  const rootManifest = {
    name: "@session-broker/handoff-snapshot",
    version: facts.packages[0]?.version ?? "0.1.0",
    private: true,
    type: "module",
    workspaces: ["packages/*", "apps/*"],
  };
  writeFileSync(join(snapshotDir, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`, "utf8");
  // Consumidor externo: package.json con specs relativas + smoke (plantilla → smoke.test.ts).
  const consumerDest = join(snapshotDir, "consumer-smoke");
  mkdirSync(consumerDest, { recursive: true });
  for (const entry of readdirSync(CONSUMER_SMOKE_SOURCE_DIR)) {
    const targetName = entry === "smoke.template.ts" ? "smoke.test.ts" : entry;
    copyFileSync(join(CONSUMER_SMOKE_SOURCE_DIR, entry), join(consumerDest, targetName));
  }
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const buffer = readFileSync(path);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: statSync(path).size };
}

/**
 * Empaqueta los cinco workspaces con `bun pm pack` (corre en tiempo de test)
 * y deja los tarballs en `<snapshot>/vendor/` con los nombres canónicos.
 */
export async function packWorkspaces(input: {
  facts: RepoFacts;
  snapshotDir: string;
  envTmp: string;
}): Promise<PackedArtifact[]> {
  const { facts, snapshotDir, envTmp } = input;
  const vendorDir = join(snapshotDir, "vendor");
  mkdirSync(vendorDir, { recursive: true });
  const artifacts: PackedArtifact[] = [];
  for (const fact of facts.packages) {
    const wsDir = join(snapshotDir, fact.dir);
    const result = await runCommand(["bun", "pm", "pack"], { cwd: wsDir, env: childEnv(envTmp) });
    if (result.exitCode !== 0) {
      throw new Error(`bun pm pack falló en ${fact.dir} (exit ${result.exitCode}):\n${result.stderr}`);
    }
    const tarballs = readdirSync(wsDir).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`bun pm pack en ${fact.dir} produjo ${tarballs.length} tarballs (se esperaba 1): ${tarballs.join(", ")}`);
    }
    const produced = join(wsDir, tarballs[0] as string);
    const canonical = canonicalVendorName(fact.name, fact.version);
    const target = join(vendorDir, canonical);
    renameSync(produced, target);
    const { sha256, bytes } = sha256File(target);
    artifacts.push({ file: canonical, sha256, bytes, workspaceDir: fact.dir });
  }
  return artifacts;
}

/** `bun install --offline` del consumidor (resuelve solo los `file:` relativos). */
export async function installConsumer(input: { consumerDir: string; envTmp: string }): Promise<CommandResult> {
  return await runCommand(["bun", "install", "--offline"], { cwd: input.consumerDir, env: childEnv(input.envTmp) });
}

/** Ejecuta el smoke del consumidor (`bun test smoke.test.ts`) fuera del repo. */
export async function runConsumerSmoke(input: { consumerDir: string; envTmp: string }): Promise<CommandResult> {
  return await runCommand(["bun", "test", "./smoke.test.ts"], { cwd: input.consumerDir, env: childEnv(input.envTmp) });
}

/**
 * Copia bundle+consumidor a otro directorio (relocalización): sin `node_modules`
 * ni locks generados; el destino resuelve TODO por su propia ruta.
 */
export function relocateSnapshot(input: { from: string; to: string }): void {
  copyTreeFiltered(input.from, input.to, (name) => name === "bun.lock" || name === "node_modules" || name === ".bun");
}

export interface ManifestLeak {
  readonly file: string;
  readonly needle: string;
}

/**
 * Escanea manifests/locks bajo `root` en busca de rutas absolutas de esta
 * máquina (`extraNeedles` añade rutas concretas del entorno actual).
 */
export function scanForMachinePaths(root: string, extraNeedles: readonly string[]): ManifestLeak[] {
  const leaks: ManifestLeak[] = [];
  const needles = ["/home/", "file:/", "file://", "C:\\", ...extraNeedles];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES[entry.name] === true) continue;
        walk(full);
        continue;
      }
      if (entry.name !== "package.json" && entry.name !== "bun.lock") continue;
      const text = readFileSync(full, "utf8");
      for (const needle of needles) {
        if (text.includes(needle)) leaks.push({ file: full, needle });
      }
    }
  };
  walk(root);
  return leaks;
}

/**
 * Escribe el fragmento REAL del bloque `consumer` (observado por la suite del
 * consumidor) en `docs/handoff/evidence/consumer.fragment.json` — ruta estable
 * y excluida del source hash — para que el coordinador lo fusione en su
 * evidence input. Devuelve la ruta absoluta escrita.
 */
export function writeConsumerEvidenceFragment(input: {
  repoRoot: string;
  consumer: EvidenceConsumer;
}): string {
  const target = join(input.repoRoot, ...CONSUMER_FRAGMENT_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  const fragment = {
    schema: CONSUMER_FRAGMENT_SCHEMA,
    producedBy: "bun test tests/handoff/consumer.test.ts",
    note:
      "Bloque \"consumer\" REAL observado por la suite del consumidor. Fusión: copiar el objeto \"consumer\" " +
      "literalmente al campo \"consumer\" del evidence input de build-handoff.ts. Excluido del source hash " +
      "(docs/handoff/**). smokeExitCode/relocationExitCode son los exit codes REALES de los dos smoke del " +
      "consumidor (snapshot inicial y relocalización); equivalen a que bun test tests/handoff/consumer.test.ts termine en 0.",
    consumer: input.consumer,
  };
  writeFileSync(target, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
  return target;
}
