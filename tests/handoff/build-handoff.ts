/**
 * GENERADOR determinista del handoff verificado (P-006 / G-001).
 *
 * INVOCACIÓN EXACTA (la ejecuta el coordinador con evidencia real):
 *
 * ```sh
 * bun tests/handoff/build-handoff.ts --evidence <ruta-al-evidence.json>
 * ```
 *
 * Opciones:
 *   --evidence <path>   (obligatorio) evidence input real (schema abajo)
 *   --out <dir>         directorio de salida (default: `docs/handoff`)
 *   --repo-root <dir>   raíz del repo (default: raíz de este checkout)
 *   --check             valida y calcula SIN escribir artefactos
 *
 * Salida: `<out>/omp-broker-v1.json` + `<out>/omp-broker-v1.md`.
 * Exit codes: 0 ok · 1 evidencia/coherencia inválida · 2 error de uso.
 *
 * REGLAS DE HONESTIDAD (no negociables):
 *  - Flujo de DOS ESTADOS sin evidencia circular (ver docs/handoff/README.md):
 *    `stage: "pre-gate"` materializa el handoff ANTES de los gates que dependen
 *    de sus propios artefactos (`test:handoff`, `verify`,
 *    `test:handoff-other-cwd`): esos tres comandos —y la suite `handoff`— se
 *    registran EXPLÍCITAMENTE como `status: "pending"` con números `null`;
 *    los 6 gates base exigen resultados REALES en verde. `stage: "final"` exige
 *    los 9 comandos y las 6 suites con resultados reales (sin ningún pending).
 *    Jamás se inventa un exit 0 para poder arrancar.
 *  - El source hash se calcula aquí sobre el repo vivo (algoritmo
 *    `sha256-canonical-file-manifest-v1`, ver `lib/source-hash.ts`); un cambio
 *    de fuente posterior invalida el handoff y exige regenerar + repetir gates.
 *  - Determinismo: mismo evidence + misma fuente ⇒ mismos bytes. Sin relojes
 *    propios: la fecha viene del evidence. Las rutas absolutas de esta máquina
 *    se normalizan (`<repo>`, `~`) y si queda alguna, el generator falla.
 *  - Si existe `docs/handoff/evidence/consumer.fragment.json` (lo escribe
 *    `tests/handoff/consumer.test.ts` con los resultados REALES del smoke), el
 *    generator exige que el bloque `consumer` del evidence coincida con él en
 *    exit codes y nombres de artefactos.
 *
 * SCHEMA DEL EVIDENCE INPUT (`omp-session-broker-evidence/1`):
 *
 * ```jsonc
 * {
 *   "schema": "omp-session-broker-evidence/1",
 *   "stage": "pre-gate",                        // "pre-gate" | "final"
 *   "evidenceDate": "2026-09-26T12:00:00Z",      // fecha real de la evidencia
 *   "operator": "coordinator",
 *   "environment": { "bun": "1.4.2", "typescript": "7.0.2", "os": "linux" },
 *   "commands": [                                // comandos EXACTOS (EXPECTED_COMMANDS)
 *     // 6 gates base: SIEMPRE resultados reales en verde (ambos stages)
 *     { "id": "typecheck", "command": "bun run typecheck", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     { "id": "test:protocol", "command": "bun run test:protocol", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     { "id": "test:broker", "command": "bun run test:broker", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     { "id": "test:cli", "command": "bun run test:cli", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     { "id": "test:omp", "command": "bun run test:omp", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     { "id": "test:recovery", "command": "bun run test:recovery", "cwd": ".", "status": "ok", "exitCode": 0 },
 *     // autorreferenciales: "pending"/null en stage "pre-gate"; "ok"/0 REAL en stage "final"
 *     { "id": "verify", "command": "bun run verify", "cwd": ".", "status": "pending", "exitCode": null },
 *     { "id": "test:handoff", "command": "bun run test:handoff", "cwd": ".", "status": "pending", "exitCode": null },
 *     { "id": "test:handoff-other-cwd",
 *       "command": "bun run --cwd <repo> test:handoff", "cwd": ".", "status": "pending", "exitCode": null }
 *   ],
 *   "suites": [
 *     { "suite": "protocol", "status": "ok", "tests": 83, "failures": 0, "skipped": 0, "exitCode": 0 }
 *     // … idem broker, cli, omp, recovery (siempre ok/0 reales)
 *     // suite "handoff": "pending" con tests/failures/skipped/exitCode null en stage
 *     // "pre-gate"; "ok" con números REALES en stage "final"
 *   ],
 *   "teardown": "observación real de teardown (TMP/HOME/fake model/red)",
 *   "consumer": {
 *     "smokeExitCode": 0,
 *     "relocationExitCode": 0,
 *     "vendorArtifacts": [
 *       { "file": "session-broker-protocol-0.1.0.tgz", "sha256": "<64 hex>", "bytes": 12345 }
 *       // … los cinco nombres canónicos de docs/contracts/consumption.md
 *     ]
 *   },
 *   "omp": { "version": "omp v18.3.1 (binario) con fuentes 18.3.1", "notes": "…" },
 *   "capabilities": [                            // exactamente las de freeze.json
 *     { "name": "session.reply_tool", "status": "supported", "evidence": "tests/omp/…; consumer smoke …" }
 *   ],
 *   "limitations": ["…"],                        // ≥ 1, honestas
 *   "notPerformed": ["G-BROKER-LIVE: …", "…"],   // ≥ 1, evidencia NO realizada
 *   "requirements": [                            // FR-001..FR-011 + NFR-001..NFR-004
 *     { "id": "FR-001", "suites": ["broker", "cli"], "result": "pass" }
 *   ]
 * }
 * ```
 *
 * Los `id` de comando requeridos y sus textos exactos están en
 * `lib/handoff-schema.ts` (`EXPECTED_COMMANDS`, `SELF_REFERENTIAL_COMMAND_IDS`,
 * `SELF_REFERENTIAL_SUITE`); el validador del schema se niega a generar si falta
 * alguno, si un status/exitCode contradice el `stage`, si una suite está en
 * rojo/vacía, si un exit code no es 0 o si una capability CORE no está
 * `supported`. El pipeline completo por el que el coordinador obtiene ambos
 * stages está en `docs/handoff/README.md`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isRecord } from "@session-broker/protocol";
import {
  CONSUMER_FRAGMENT_RELATIVE_PATH,
  buildHandoffDoc,
  parseEvidenceInput,
  HANDOFF_JSON_NAME,
  HANDOFF_MD_NAME,
  type EvidenceInput,
  type EvidenceStage,
  type EvidenceVendorArtifact,
} from "./lib/handoff-schema";
import { renderHandoffMarkdown } from "./lib/render-markdown";
import { readRepoFacts } from "./lib/repo-facts";
import { computeSourceHash } from "./lib/source-hash";
import { findMachinePathLeaks, validateHandoffDoc } from "./lib/validate-handoff";

const USAGE =
  "uso: bun tests/handoff/build-handoff.ts --evidence <ruta-al-evidence.json> [--stage pre-gate|final] [--out <dir>] [--repo-root <dir>] [--check]";

interface CliOptions {
  readonly evidencePath: string;
  readonly outDir: string;
  readonly repoRoot: string;
  readonly checkOnly: boolean;
  /** Verificación opcional: el stage del evidence debe coincidir con el pedido. */
  readonly expectStage?: EvidenceStage;
}

function parseArgs(argv: readonly string[]): CliOptions | string {
  let evidencePath: string | undefined;
  let outDir = "docs/handoff";
  let repoRoot = resolve(join(import.meta.dir, "..", ".."));
  let checkOnly = false;
  let expectStage: EvidenceStage | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--evidence") {
      evidencePath = argv[index + 1];
      index += 1;
    } else if (token === "--stage") {
      const value = argv[index + 1];
      if (value !== "pre-gate" && value !== "final") {
        return `--stage debe ser "pre-gate" o "final" (obtenido: ${String(value)})\n${USAGE}`;
      }
      expectStage = value;
      index += 1;
    } else if (token === "--out") {
      outDir = argv[index + 1] ?? outDir;
      index += 1;
    } else if (token === "--repo-root") {
      const value = argv[index + 1];
      if (value !== undefined) repoRoot = resolve(value);
      index += 1;
    } else if (token === "--check") {
      checkOnly = true;
    } else {
      return `argumento no reconocido: ${String(token)}\n${USAGE}`;
    }
  }
  if (evidencePath === undefined || evidencePath.length === 0) {
    return `falta --evidence <ruta-al-evidence.json>\n${USAGE}`;
  }
  return { evidencePath, outDir, repoRoot, checkOnly, ...(expectStage === undefined ? {} : { expectStage }) };
}

/**
 * Cruce opcional con el fragmento REAL del consumidor (si existe): los exit
 * codes del smoke y los nombres de artefactos del evidence deben coincidir con
 * lo que observó `tests/handoff/consumer.test.ts`.
 */
function consumerFragmentMismatches(
  repoRoot: string,
  consumer: {
    readonly smokeExitCode: number;
    readonly relocationExitCode: number;
    readonly vendorArtifacts: readonly EvidenceVendorArtifact[];
  },
): string[] {
  const fragmentPath = join(repoRoot, ...CONSUMER_FRAGMENT_RELATIVE_PATH.split("/"));
  if (!existsSync(fragmentPath)) return [];
  let fragment: unknown;
  try {
    fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
  } catch (error) {
    return [`no se pudo leer ${CONSUMER_FRAGMENT_RELATIVE_PATH}: ${String(error)}`];
  }
  if (!isRecord(fragment) || !isRecord(fragment["consumer"])) {
    return [`${CONSUMER_FRAGMENT_RELATIVE_PATH} sin objeto "consumer"`];
  }
  const observed = fragment["consumer"];
  const problems: string[] = [];
  if (observed["smokeExitCode"] !== consumer.smokeExitCode) {
    problems.push(`consumer.smokeExitCode del evidence (${consumer.smokeExitCode}) ≠ fragmento (${String(observed["smokeExitCode"])})`);
  }
  if (observed["relocationExitCode"] !== consumer.relocationExitCode) {
    problems.push(`consumer.relocationExitCode del evidence (${consumer.relocationExitCode}) ≠ fragmento (${String(observed["relocationExitCode"])})`);
  }
  const fragmentFiles = Array.isArray(observed["vendorArtifacts"])
    ? (observed["vendorArtifacts"] as Array<{ file?: unknown }>).map((entry) => String(entry.file)).sort()
    : [];
  const evidenceFiles = consumer.vendorArtifacts.map((entry) => entry.file).sort();
  if (fragmentFiles.join("\n") !== evidenceFiles.join("\n")) {
    problems.push(`vendorArtifacts del evidence [${evidenceFiles.join(", ")}] ≠ fragmento [${fragmentFiles.join(", ")}]`);
  }
  return problems;
}

/** Normaliza rutas absolutas de esta máquina a placeholders portables. */
function normalizeAbsolutePaths(value: unknown, replacements: ReadonlyArray<{ from: string; to: string }>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const { from, to } of replacements) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeAbsolutePaths(entry, replacements));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = normalizeAbsolutePaths(entry, replacements);
    return out;
  }
  return value;
}

function replacementsFor(repoRoot: string): Array<{ from: string; to: string }> {
  const replacements: Array<{ from: string; to: string }> = [];
  const roots = new Set<string>([repoRoot]);
  try {
    roots.add(realpathSync(repoRoot));
  } catch {
    // realpath indisponible: se usa la ruta tal cual.
  }
  for (const root of roots) {
    if (root.length > 1) replacements.push({ from: root, to: "<repo>" });
  }
  const home = homedir();
  if (home.length > 1) replacements.push({ from: home, to: "~" });
  // Raíces primero: `<repo>` vive dentro de `$HOME` y debe sustituirse antes.
  return replacements.sort((a, b) => b.from.length - a.from.length);
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    process.stderr.write(`build-handoff: ${parsed}\n`);
    return 2;
  }
  let rawEvidence: unknown;
  try {
    rawEvidence = JSON.parse(readFileSync(parsed.evidencePath, "utf8"));
  } catch (error) {
    process.stderr.write(`build-handoff: no se pudo leer el evidence input: ${String(error)}\n`);
    return 1;
  }

  const facts = readRepoFacts(parsed.repoRoot);
  let evidence: EvidenceInput | undefined;
  try {
    evidence = parseEvidenceInput(normalizeAbsolutePaths(rawEvidence, replacementsFor(parsed.repoRoot)), { facts });
  } catch (error) {
    process.stderr.write(`build-handoff: ${String(error instanceof Error ? error.message : error)}\n`);
    return 1;
  }
  if (evidence === undefined) {
    process.stderr.write("build-handoff: el evidence input no se pudo parsear\n");
    return 1;
  }
  if (parsed.expectStage !== undefined && evidence.stage !== parsed.expectStage) {
    process.stderr.write(`build-handoff: el evidence declara stage "${evidence.stage}" pero se pidió --stage ${parsed.expectStage}\n`);
    return 1;
  }
  const fragmentProblems = consumerFragmentMismatches(parsed.repoRoot, evidence.consumer);
  if (fragmentProblems.length > 0) {
    process.stderr.write(`build-handoff: evidencia del consumidor desalineada con ${CONSUMER_FRAGMENT_RELATIVE_PATH}:\n`);
    for (const problem of fragmentProblems) process.stderr.write(`- ${problem}\n`);
    return 1;
  }
  const sourceHash = computeSourceHash(parsed.repoRoot);
  const doc = buildHandoffDoc({ evidence, facts, sourceHash });
  const jsonText = `${JSON.stringify(doc, null, 2)}\n`;
  const mdText = renderHandoffMarkdown(doc);

  for (const [label, text] of [
    [HANDOFF_JSON_NAME, jsonText],
    [HANDOFF_MD_NAME, mdText],
  ] as const) {
    const leaks = findMachinePathLeaks(text);
    if (leaks.length > 0) {
      process.stderr.write(`build-handoff: ${label} conserva rutas de esta máquina (${leaks.join(", ")}); usa placeholders en la evidencia\n`);
      return 1;
    }
  }

  const issues = validateHandoffDoc(doc, { facts, sourceHash, repoRoot: parsed.repoRoot });
  if (issues.length > 0) {
    process.stderr.write(`build-handoff: documento incoherente (${issues.length} issue(s)):\n`);
    for (const issue of issues) process.stderr.write(`- [${issue.code}] ${issue.message}\n`);
    return 1;
  }

  process.stdout.write(`build-handoff: stage ${evidence.stage}; sourceHash ${sourceHash.hash} (${sourceHash.fileCount} archivos)\n`);
  if (parsed.checkOnly) {
    process.stdout.write("build-handoff: --check OK (sin escritura)\n");
    return 0;
  }

  const outDir = isAbsolute(parsed.outDir) ? parsed.outDir : join(parsed.repoRoot, parsed.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, HANDOFF_JSON_NAME), jsonText, "utf8");
  writeFileSync(join(outDir, HANDOFF_MD_NAME), mdText, "utf8");
  process.stdout.write(`build-handoff: escritos ${join(outDir, HANDOFF_JSON_NAME)} y ${join(outDir, HANDOFF_MD_NAME)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
