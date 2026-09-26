/**
 * Validación del handoff materializado contra el repo vivo (P-006, DoD
 * binario de la fase). La usan `tests/handoff/handoff-doc.test.ts` (caso
 * positivo) y `tests/handoff/tamper.test.ts` (casos negativos sobre copias en
 * TMP). Ninguna validación se relaja para que un artefacto pase: un source
 * modificado, un hash corrupto o un export faltante producen issue y fallo.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HandoffDoc } from "./handoff-schema";
import {
  EXPECTED_COMMANDS,
  HANDOFF_JSON_NAME,
  HANDOFF_MD_NAME,
  HANDOFF_SCHEMA,
  HANDOFF_ID,
  REQUIREMENT_TITLES,
  SELF_REFERENTIAL_COMMAND_IDS,
  SELF_REFERENTIAL_SUITE,
  SUITE_NAMES,
  canonicalVendorName,
} from "./handoff-schema";
import { renderHandoffMarkdown } from "./render-markdown";
import { readRepoFacts, type RepoFacts } from "./repo-facts";
import { SOURCE_HASH_ALGORITHM, computeSourceHash, type SourceHashResult } from "./source-hash";

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

export const HANDOFF_MISSING_MESSAGE =
  "materializa el handoff con el generator: bun tests/handoff/build-handoff.ts --evidence <evidence.json> " +
  "(schema del evidence input y comando exacto en docs/handoff/README.md)";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Agujeros por donde una ruta de esta máquina se filtraría al handoff. */
function pathBearingFields(doc: HandoffDoc): Array<{ label: string; text: string }> {
  const fields: Array<{ label: string; text: string }> = [];
  for (const command of doc.verification?.commands ?? []) {
    fields.push({ label: `commands[${command.id}]`, text: `${command.command} ${command.cwd}` });
  }
  for (const pkg of doc.identification?.packages ?? []) {
    fields.push({ label: `packages[${pkg.name}].dir`, text: pkg.dir });
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      fields.push({ label: `packages[${pkg.name}].exports[${key}]`, text: target });
    }
  }
  for (const artifact of doc.verification?.consumer?.vendorArtifacts ?? []) {
    fields.push({ label: `vendorArtifacts[${String(artifact.file)}]`, text: String(artifact.file) });
  }
  return fields;
}

/** Escanea campos con rutas en busca de rutas absolutas de esta máquina. */
export function findMachinePathLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const needle of ["/home/", "file://", "file:/", "C:\\"]) {
    if (text.includes(needle)) leaks.push(needle);
  }
  return leaks;
}

function symbolsMissingInSource(repoRoot: string, pkgDir: string, symbols: readonly string[]): string[] {
  const missing: string[] = [];
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) sources.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(repoRoot, pkgDir, "src"));
  const haystack = sources.join("\n");
  for (const symbol of symbols) {
    const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (!pattern.test(haystack)) missing.push(symbol);
  }
  return missing;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Valida el documento contra facts + hash recomputado; devuelve issues. */
export function validateHandoffDoc(
  doc: HandoffDoc,
  ctx: { facts: RepoFacts; sourceHash: SourceHashResult; repoRoot: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: string, message: string): void => {
    issues.push({ code, message });
  };

  if (doc.schema !== HANDOFF_SCHEMA) push("schema-invalid", `schema: se esperaba "${HANDOFF_SCHEMA}"`);
  if (doc.handoffId !== HANDOFF_ID) push("schema-invalid", `handoffId: se esperaba "${HANDOFF_ID}"`);
  if (doc.generatedFrom?.evidenceSchema !== "omp-session-broker-evidence/1") {
    push("schema-invalid", "generatedFrom.evidenceSchema incoherente");
  }
  if (doc.identification?.protocolVersion !== ctx.facts.protocolVersion) {
    push("version-mismatch", `protocolVersion del handoff (${String(doc.identification?.protocolVersion)}) ≠ freeze (${ctx.facts.protocolVersion})`);
  }

  // -------------------------------------------- paquetes / exports / símbolos
  const handoffPackages = doc.identification?.packages ?? [];
  for (const fact of ctx.facts.packages) {
    const entry = handoffPackages.find((pkg) => pkg.name === fact.name);
    if (entry === undefined) {
      push("package-missing", `falta el paquete ${fact.name} en el handoff`);
      continue;
    }
    if (entry.version !== fact.version) {
      push("version-mismatch", `${fact.name}: versión del handoff (${entry.version}) ≠ manifest real (${fact.version})`);
    }
    if (entry.dir !== fact.dir) {
      push("version-mismatch", `${fact.name}: dir del handoff (${entry.dir}) ≠ freeze (${fact.dir})`);
    }
    const handoffExportKeys = Object.keys(entry.exports ?? {}).sort();
    const factExportKeys = Object.keys(fact.exports).sort();
    if (!sameStrings(handoffExportKeys, factExportKeys)) {
      push("export-mismatch", `${fact.name}: exports del handoff [${handoffExportKeys.join(", ")}] ≠ manifest real [${factExportKeys.join(", ")}]`);
    } else {
      for (const key of factExportKeys) {
        if (entry.exports[key] !== fact.exports[key]) {
          push("export-mismatch", `${fact.name}: export "${key}" → "${String(entry.exports[key])}" ≠ "${String(fact.exports[key])}"`);
        }
      }
    }
    const freezeEntry = ctx.facts.freeze.packages.find((pkg) => pkg.name === fact.name);
    if (freezeEntry !== undefined) {
      const freezeKeys = [...freezeEntry.exports].sort();
      if (!sameStrings(freezeKeys, factExportKeys)) {
        push("export-mismatch", `${fact.name}: exports del manifest real [${factExportKeys.join(", ")}] ≠ freeze.json [${freezeKeys.join(", ")}]`);
      }
      if (freezeEntry.version !== fact.version) {
        push("version-mismatch", `${fact.name}: versión del manifest (${fact.version}) ≠ freeze.json (${freezeEntry.version})`);
      }
    }
    const missing = symbolsMissingInSource(ctx.repoRoot, fact.dir, entry.publicSymbols ?? []);
    if (missing.length > 0) {
      push("symbol-missing", `${fact.name}: símbolos ausentes del src: ${missing.join(", ")}`);
    }
  }

  // ------------------------------------------------------------- source hash
  const sourceHash = doc.codeTraceability?.sourceHash;
  if (sourceHash === undefined) {
    push("schema-invalid", "codeTraceability.sourceHash ausente");
  } else {
    if (sourceHash.algorithm !== SOURCE_HASH_ALGORITHM) {
      push("source-hash-mismatch", `algoritmo "${String(sourceHash.algorithm)}" ≠ "${SOURCE_HASH_ALGORITHM}"`);
    }
    if (typeof sourceHash.hash !== "string" || !HASH_PATTERN.test(sourceHash.hash)) {
      push("source-hash-mismatch", `hash con formato inválido: ${String(sourceHash.hash)}`);
    } else if (sourceHash.hash !== ctx.sourceHash.hash) {
      push("source-hash-mismatch", `hash del handoff ${sourceHash.hash} ≠ recomputado ${ctx.sourceHash.hash} (fuente modificada tras generar: regenera con el generator y repite el gate)`);
    }
    if (sourceHash.fileCount !== ctx.sourceHash.fileCount) {
      push("source-hash-mismatch", `fileCount del handoff ${String(sourceHash.fileCount)} ≠ recomputado ${ctx.sourceHash.fileCount}`);
    }
    if ((sourceHash.include ?? []).length === 0 || (sourceHash.exclude ?? []).length === 0) {
      push("schema-invalid", "sourceHash.include/exclude deben declarar las reglas del algoritmo");
    }
  }
  const revision = doc.codeTraceability?.revision;
  if (revision === undefined || revision.commits !== 0 || revision.commit !== null || typeof revision.note !== "string" || revision.note.length === 0) {
    push("schema-invalid", "codeTraceability.revision debe declarar «sin commit» (commits 0, commit null, nota explícita)");
  }

  // -------------------------------------------------------------- verificación
  const verification = doc.verification;
  const stage = verification?.stage;
  const stageValid = stage === "pre-gate" || stage === "final";
  if (!stageValid) {
    push("stage-incoherent", `verification.stage debe ser "pre-gate" o "final" (obtenido: ${String(stage)})`);
  }
  if (doc.generatedFrom?.stage !== stage) {
    push("stage-incoherent", `generatedFrom.stage (${String(doc.generatedFrom?.stage)}) ≠ verification.stage (${String(stage)}): artefactos de un stage con evidencia de otro`);
  }
  const commands = verification?.commands ?? [];
  const commandIds = new Set(commands.map((command) => command.id));
  for (const [id, expected] of Object.entries(EXPECTED_COMMANDS)) {
    const entry = commands.find((command) => command.id === id);
    if (entry === undefined) {
      push("commands-incomplete", `falta el comando "${id}" (${expected})`);
      continue;
    }
    if (entry.command !== expected) push("commands-incomplete", `comando "${id}" debe ser exactamente "${expected}"`);
    if (typeof entry.cwd !== "string" || entry.cwd.length === 0) push("commands-incomplete", `comando "${id}" sin cwd`);
    const selfReferential = SELF_REFERENTIAL_COMMAND_IDS.includes(id);
    if (entry.status === "pending") {
      if (stage !== "pre-gate" || !selfReferential || entry.exitCode !== null) {
        push(
          "commands-incoherent",
          `comando "${id}" marcado pending fuera de las reglas: solo en stage "pre-gate", solo para ${SELF_REFERENTIAL_COMMAND_IDS.join(", ")} y con exitCode null`,
        );
      }
    } else if (entry.status === "ok") {
      if (typeof entry.exitCode !== "number" || !Number.isInteger(entry.exitCode)) {
        push("commands-incoherent", `comando "${id}" con status ok sin exit code observado`);
      } else if (entry.exitCode !== 0) {
        push("commands-incoherent", `comando "${id}" con exit code ${entry.exitCode} ≠ 0: un gate en rojo bloquea la integración`);
      }
      if (stage === "pre-gate" && selfReferential) {
        push("commands-incoherent", `comando "${id}" autorreferencial declarado ok en stage "pre-gate": antes del cierre del gate su resultado es pending (sin fabricar un 0)`);
      }
    } else {
      push("commands-incoherent", `comando "${id}" con status desconocido: ${String(entry.status)}`);
    }
  }
  if (commandIds.size !== commands.length) {
    push("commands-incomplete", "ids de comando duplicados");
  }
  const suites = verification?.suites ?? [];
  const suiteNames = new Set(suites.map((suite) => suite.suite));
  for (const name of SUITE_NAMES) {
    const entry = suites.find((suite) => suite.suite === name);
    if (entry === undefined) {
      push("suites-incomplete", `falta el resultado de la suite "${name}"`);
      continue;
    }
    const selfReferential = name === SELF_REFERENTIAL_SUITE;
    if (entry.status === "pending") {
      const nulls = entry.tests === null && entry.failures === null && entry.skipped === null && entry.exitCode === null;
      if (stage !== "pre-gate" || !selfReferential || !nulls) {
        push(
          "suites-incoherent",
          `suite "${name}" marcada pending fuera de las reglas: solo en stage "pre-gate", solo "${SELF_REFERENTIAL_SUITE}" y con todos los números en null`,
        );
      }
    } else if (entry.status === "ok") {
      if (typeof entry.tests !== "number" || entry.tests <= 0) push("suites-incoherent", `suite "${name}" sin tests > 0`);
      if (typeof entry.exitCode !== "number" || entry.exitCode !== 0) {
        push("suites-incoherent", `suite "${name}" con exit code ${String(entry.exitCode)} (se exige 0 observado)`);
      }
      if (typeof entry.failures !== "number" || entry.failures !== 0 || typeof entry.skipped !== "number" || entry.skipped !== 0) {
        push("suites-incoherent", `suite "${name}" con failures/skipped distintos de 0 observados`);
      }
      if (stage === "pre-gate" && selfReferential) {
        push("suites-incoherent", `suite "${name}" en ok dentro de stage "pre-gate": sus resultados se anexan al cierre del gate`);
      }
    } else {
      push("suites-incoherent", `suite "${name}" con status desconocido: ${String(entry.status)}`);
    }
  }
  if (suiteNames.size !== suites.length) push("suites-incomplete", "suites duplicadas");
  if (typeof verification?.teardown !== "string" || verification.teardown.length === 0) {
    push("suites-incomplete", "verification.teardown sin observación");
  }
  const consumer = verification?.consumer;
  if (consumer === undefined || typeof consumer.smokeExitCode !== "number" || typeof consumer.relocationExitCode !== "number") {
    push("bundle-incomplete", "verification.consumer sin exit codes del smoke/relocalización");
  }
  const facts = ctx.facts;
  const expectedArtifacts = facts.packages.map((pkg) => canonicalVendorName(pkg.name, pkg.version));
  const artifacts = consumer?.vendorArtifacts ?? [];
  const artifactNames = new Set(artifacts.map((artifact) => artifact.file));
  for (const expected of expectedArtifacts) {
    if (!artifactNames.has(expected)) push("bundle-incomplete", `falta el artefacto vendor "${expected}"`);
  }
  for (const artifact of artifacts) {
    if (typeof artifact.sha256 !== "string" || !HASH_PATTERN.test(`sha256:${artifact.sha256}`)) {
      push("bundle-incomplete", `artefacto "${String(artifact.file)}" sin sha256 hex de 64 chars`);
    }
    if (typeof artifact.bytes !== "number" || artifact.bytes <= 0) {
      push("bundle-incomplete", `artefacto "${String(artifact.file)}" sin tamaño observado`);
    }
  }

  // ------------------------------------------------------------- capacidades
  const matrix = doc.capabilities?.matrix ?? [];
  const matrixNames = new Set(matrix.map((entry) => entry.name));
  for (const name of facts.freeze.capabilities) {
    if (!matrixNames.has(name)) {
      push("capabilities-incoherent", `falta la capability "${name}" en la matriz del handoff`);
      continue;
    }
    const entry = matrix.find((candidate) => candidate.name === name);
    if (facts.freeze.coreCapabilities.includes(name) && entry?.status !== "supported") {
      push("capabilities-incoherent", `capability core "${name}" declarada "${String(entry?.status)}": un core faltante bloquea la entrega`);
    }
    if (entry !== undefined && (typeof entry.evidence !== "string" || entry.evidence.length === 0)) {
      push("capabilities-incoherent", `capability "${name}" sin evidencia`);
    }
  }
  if (matrixNames.size !== facts.freeze.capabilities.length) {
    push("capabilities-incoherent", "la matriz de capacidades no coincide 1:1 con freeze.json");
  }
  if (typeof doc.capabilities?.ompVersion !== "string" || doc.capabilities.ompVersion.length === 0) {
    push("capabilities-incoherent", "capabilities.ompVersion ausente");
  }

  // ------------------------------------------------------------------ consumo
  const consumption = doc.consumption;
  if ((consumption?.recipe ?? []).length === 0 || (consumption?.snapshotLayout ?? []).length === 0) {
    push("consumption-incoherent", "consumption.recipe/snapshotLayout vacíos");
  }
  if ((consumption?.prohibitions ?? []).length === 0 || typeof consumption?.adapterReuse !== "string" || consumption.adapterReuse.length === 0) {
    push("consumption-incoherent", "consumption.prohibitions/adapterReuse incompletos");
  }
  if (!sameStrings((consumption?.vendorArtifacts ?? []).map((artifact) => artifact.file), (artifacts ?? []).map((artifact) => artifact.file))) {
    push("consumption-incoherent", "consumption.vendorArtifacts ≠ verification.consumer.vendorArtifacts");
  }

  // --------------------------------------------------------------- operación
  const operation = doc.operation;
  if (operation?.noLiveInference !== true || operation?.noServiceActivation !== true) {
    push("operation-incoherent", "operation debe declarar ausencia de inferencia real y de activación de servicio");
  }
  const gateIds = (operation?.gates ?? []).map((gate) => gate.id);
  if (!gateIds.includes("G-BROKER-LIVE") || !gateIds.includes("G-BROKER-SERVICE")) {
    push("operation-incoherent", "operation.gates debe enumerar G-BROKER-LIVE y G-BROKER-SERVICE como opt-in fuera del DoD");
  }
  if ((operation?.notPerformed ?? []).length === 0) {
    push("operation-incoherent", "operation.notPerformed debe enumerar la evidencia NO realizada");
  }
  if ((doc.limitations ?? []).length === 0) {
    push("consumption-incoherent", "limitations: el handoff debe declarar limitaciones honestas");
  }

  // ---------------------------------------------------------- trazabilidad
  const rows = doc.requirementsTraceability ?? [];
  const rowIds = new Set(rows.map((row) => row.id));
  for (const [id, title] of Object.entries(REQUIREMENT_TITLES)) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      push("traceability-incomplete", `falta la fila de trazabilidad "${id}"`);
      continue;
    }
    if (row.title !== title) push("traceability-incomplete", `${id}: título "${String(row.title)}" ≠ "${title}"`);
    if (!Array.isArray(row.suites) || row.suites.length === 0 || !row.suites.every((name) => (SUITE_NAMES as readonly string[]).includes(name))) {
      push("traceability-incomplete", `${id}: suites deben referenciar suites reales`);
    }
    if (row.result !== "pass" && row.result !== "partial") {
      push("traceability-incomplete", `${id}: result debe ser "pass" o "partial"`);
    }
    if (row.result === "partial" && (typeof row.notes !== "string" || row.notes.length === 0)) {
      push("traceability-incomplete", `${id}: result "partial" exige notas`);
    }
  }
  if (rowIds.size !== rows.length || rowIds.size !== Object.keys(REQUIREMENT_TITLES).length) {
    push("traceability-incomplete", "filas de trazabilidad duplicadas o incompletas");
  }

  return issues;
}

/**
 * Validación completa del árbol `docs/handoff`: existencia, parseo, coherencia
 * JSON↔MD, versión/exports/símbolos contra el repo, hash de fuente recomputado
 * y ausencia de rutas absolutas de máquina.
 */
export function validateHandoffTree(repoRoot: string, handoffDir: string): ValidationIssue[] {
  const jsonPath = join(handoffDir, HANDOFF_JSON_NAME);
  const mdPath = join(handoffDir, HANDOFF_MD_NAME);
  const missing = [jsonPath, mdPath].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    return missing.map((path) => ({
      code: "missing-artifact",
      message: `falta ${path}: ${HANDOFF_MISSING_MESSAGE}`,
    }));
  }
  const jsonText = readFileSync(jsonPath, "utf8");
  const mdText = readFileSync(mdPath, "utf8");
  let doc: HandoffDoc;
  try {
    doc = JSON.parse(jsonText) as HandoffDoc;
  } catch (error) {
    return [{ code: "schema-invalid", message: `${HANDOFF_JSON_NAME} no es JSON válido: ${String(error)}` }];
  }

  const facts = readRepoFacts(repoRoot);
  const sourceHash = computeSourceHash(repoRoot);
  const issues = validateHandoffDoc(doc, { facts, sourceHash, repoRoot });

  const rendered = renderHandoffMarkdown(doc);
  if (rendered !== mdText) {
    const renderedLines = rendered.split("\n");
    const mdLines = mdText.split("\n");
    let firstDiff = -1;
    for (let index = 0; index < Math.max(renderedLines.length, mdLines.length); index += 1) {
      if (renderedLines[index] !== mdLines[index]) {
        firstDiff = index + 1;
        break;
      }
    }
    issues.push({
      code: "md-incoherent",
      message: `${HANDOFF_MD_NAME} no coincide con la proyección del JSON (primera diferencia: línea ${String(firstDiff)}); regenera con el generator, no edites a mano`,
    });
  }

  for (const field of pathBearingFields(doc)) {
    const leaks = findMachinePathLeaks(field.text);
    if (leaks.length > 0) {
      issues.push({
        code: "machine-path-leak",
        message: `${field.label} contiene rutas de esta máquina (${leaks.join(", ")}): ${field.text}`,
      });
    }
  }
  for (const [label, text] of [
    [HANDOFF_JSON_NAME, jsonText],
    [HANDOFF_MD_NAME, mdText],
  ] as const) {
    const leaks = findMachinePathLeaks(text);
    if (leaks.length > 0) {
      issues.push({ code: "machine-path-leak", message: `${label} contiene rutas de esta máquina: ${leaks.join(", ")}` });
    }
  }

  return issues;
}
