/**
 * Suite `test:handoff` — validación del handoff materializado (P-006).
 *
 * Comprueba `docs/handoff/omp-broker-v1.json` y `.md` contra el repo vivo:
 * schema, coherencia JSON↔MD, versiones/exports contra `docs/contracts/freeze.json`
 * Y contra los `package.json` reales, símbolos públicos presentes en el src,
 * hash de fuente RE-COMPUTADO y campos de comandos/exit codes.
 *
 * Si los artefactos no existen, la suite FALLA con un mensaje claro
 * («materializa el handoff con el generator»): jamás se salta tests ni se
 * aceptan placeholders. Un source modificado después de generar, un hash
 * corrupto o un export faltante producen exit no cero (ver tamper.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_COMMANDS,
  HANDOFF_JSON_NAME,
  HANDOFF_MD_NAME,
  HANDOFF_SCHEMA,
  REQUIREMENT_TITLES,
  SELF_REFERENTIAL_COMMAND_IDS,
  SELF_REFERENTIAL_SUITE,
  SUITE_NAMES,
  type HandoffDoc,
} from "./lib/handoff-schema";
import { readRepoFacts } from "./lib/repo-facts";
import { computeSourceHash } from "./lib/source-hash";
import { HANDOFF_MISSING_MESSAGE, validateHandoffTree } from "./lib/validate-handoff";

const repoRoot = join(import.meta.dir, "..", "..");
const handoffDir = join(repoRoot, "docs", "handoff");
const jsonPath = join(handoffDir, HANDOFF_JSON_NAME);
const mdPath = join(handoffDir, HANDOFF_MD_NAME);

function readHandoffDoc(): HandoffDoc {
  for (const path of [jsonPath, mdPath]) {
    if (!existsSync(path)) throw new Error(`falta ${path}: ${HANDOFF_MISSING_MESSAGE}`);
  }
  return JSON.parse(readFileSync(jsonPath, "utf8")) as HandoffDoc;
}

describe("handoff materializado con evidencia real", () => {
  test("existen omp-broker-v1.json y omp-broker-v1.md (sin placeholders)", () => {
    const missing = [jsonPath, mdPath].filter((path) => !existsSync(path));
    if (missing.length > 0) throw new Error(`faltan ${missing.join(" y ")}: ${HANDOFF_MISSING_MESSAGE}`);
  });

  test("validación completa sin issues contra el repo vivo", () => {
    const issues = validateHandoffTree(repoRoot, handoffDir);
    expect(issues.map((issue) => `[${issue.code}] ${issue.message}`)).toEqual([]);
  });

  test("schema, identificación y versiones/exports contra freeze.json y manifests reales", () => {
    const doc = readHandoffDoc();
    const facts = readRepoFacts(repoRoot);
    expect(doc.schema).toBe(HANDOFF_SCHEMA);
    expect(doc.identification.protocolVersion).toBe(facts.protocolVersion);
    for (const fact of facts.packages) {
      const entry = doc.identification.packages.find((pkg) => pkg.name === fact.name);
      expect(entry?.version).toBe(fact.version);
      expect(entry?.dir).toBe(fact.dir);
      expect(Object.keys(entry?.exports ?? {})).toEqual(Object.keys(fact.exports));
    }
  });

  test("source hash re-computado coincide con el declarado", () => {
    const doc = readHandoffDoc();
    const recomputed = computeSourceHash(repoRoot);
    expect(doc.codeTraceability.sourceHash.algorithm).toBe(recomputed.algorithm);
    expect(doc.codeTraceability.sourceHash.hash).toBe(recomputed.hash);
    expect(doc.codeTraceability.sourceHash.fileCount).toBe(recomputed.fileCount);
    // El hash no es vacío ni solo-documentación: cubre contratos, manifests, source y tests.
    expect(recomputed.fileCount).toBeGreaterThan(20);
    expect(recomputed.files).toContain("docs/contracts/freeze.json");
    expect(recomputed.files).toContain("bun.lock");
    expect(recomputed.files.some((file) => file.startsWith("packages/protocol/src/"))).toBe(true);
    expect(recomputed.files.some((file) => file.startsWith("tests/handoff/"))).toBe(true);
  });

  test("cobertura del manifiesto del source hash por subtree (regresión del off-by-depth)", () => {
    const files = computeSourceHash(repoRoot).files;
    // DEBEN estar: ejemplos representativos de cada subtree declarado en las
    // reglas de inclusión (incluidos archivos ANIDADOS de docs/**).
    const required = [
      "README.md",
      "bun.lock",
      "package.json",
      "docs/contracts/freeze.json",
      "docs/contracts/packages.md",
      "docs/compatibility/omp-api-matrix.md",
      "docs/operations/README.md",
      "ops/systemd/session-broker.service.example",
      "ops/systemd/session-broker.env.example",
      "packages/protocol/package.json",
      "packages/protocol/src/index.ts",
      "apps/broker/src/server.ts",
      "scripts/verify.ts",
      "tests/handoff/consumer-smoke/package.json",
      "tests/handoff/lib/source-hash.ts",
    ];
    for (const rel of required) {
      if (!files.includes(rel)) {
        throw new Error(`falta en el manifiesto del source hash: ${rel} (reglas de inclusión rotas)`);
      }
    }
    // NO deben estar: autorreferencia, planificación, dependencias y salidas.
    for (const rel of files) {
      const segments = rel.split("/");
      const forbidden =
        rel.startsWith("docs/handoff/") ||
        rel.startsWith(".plans/") ||
        segments.includes("node_modules") ||
        segments.includes(".git") ||
        segments.includes("dist") ||
        segments.includes("coverage") ||
        rel.startsWith("prompts/") ||
        rel.endsWith(".tgz");
      if (forbidden) {
        throw new Error(`no debe estar en el manifiesto del source hash: ${rel} (reglas de exclusión rotas)`);
      }
    }
  });

  test("stage coherente: pre-gate con pendientes explícitos o final todo observado", () => {
    const doc = readHandoffDoc();
    expect(["pre-gate", "final"]).toContain(doc.verification.stage);
    expect(doc.generatedFrom.stage).toBe(doc.verification.stage);
    for (const [id, command] of Object.entries(EXPECTED_COMMANDS)) {
      const entry = doc.verification.commands.find((candidate) => candidate.id === id);
      expect(entry?.command).toBe(command);
      expect(typeof entry?.cwd).toBe("string");
      const selfReferential = SELF_REFERENTIAL_COMMAND_IDS.includes(id);
      if (entry?.status === "pending") {
        // Pending SOLO en pre-gate y SOLO para los comandos autorreferenciales.
        expect(doc.verification.stage).toBe("pre-gate");
        expect(selfReferential).toBe(true);
        expect(entry.exitCode).toBeNull();
      } else {
        expect(entry?.status).toBe("ok");
        expect(Number.isInteger(entry?.exitCode)).toBe(true);
        expect(entry?.exitCode).toBe(0);
      }
    }
    for (const name of SUITE_NAMES) {
      const suite = doc.verification.suites.find((candidate) => candidate.suite === name);
      if (suite?.status === "pending") {
        expect(doc.verification.stage).toBe("pre-gate");
        expect(name).toBe(SELF_REFERENTIAL_SUITE);
        expect(suite.tests).toBeNull();
        expect(suite.exitCode).toBeNull();
      } else {
        expect(suite?.status).toBe("ok");
        expect(suite?.tests).toBeGreaterThan(0);
        expect(suite?.exitCode).toBe(0);
      }
    }
    if (doc.verification.stage === "final") {
      expect(doc.verification.commands.filter((command) => command.status === "pending")).toEqual([]);
      expect(doc.verification.suites.filter((suite) => suite.status === "pending")).toEqual([]);
    }
  });

  test("trazabilidad FR/NFR completa y coherente", () => {
    const doc = readHandoffDoc();
    const ids = doc.requirementsTraceability.map((row) => row.id);
    expect(ids.sort()).toEqual(Object.keys(REQUIREMENT_TITLES).sort());
    for (const row of doc.requirementsTraceability) {
      expect(row.title).toBe(REQUIREMENT_TITLES[row.id]);
      expect(row.suites.length).toBeGreaterThan(0);
      expect(["pass", "partial"]).toContain(row.result);
    }
  });

  test("capacidades 1:1 con freeze.json y core cubierto", () => {
    const doc = readHandoffDoc();
    const facts = readRepoFacts(repoRoot);
    const names = doc.capabilities.matrix.map((entry) => entry.name);
    expect([...names].sort()).toEqual([...facts.freeze.capabilities].sort());
    for (const core of facts.freeze.coreCapabilities) {
      expect(doc.capabilities.matrix.find((entry) => entry.name === core)?.status).toBe("supported");
    }
  });
});
