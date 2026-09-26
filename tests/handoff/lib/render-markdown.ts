/**
 * Proyección determinista Markdown del handoff (`omp-broker-v1.md`).
 *
 * El Markdown se RENDERIZA desde `HandoffDoc` (el JSON es la fuente única):
 * la suite de handoff re-renderiza y compara bytes para probar la coherencia
 * JSON↔MD. Mismo doc ⇒ mismos bytes, sin relojes ni rutas absolutas.
 */

import type { HandoffDoc } from "./handoff-schema";
import { PENDING_RENDER_TEXT } from "./handoff-schema";

function cell(value: unknown): string {
  return String(value)
    .split("|").join("\\|")
    .split("\n").join("<br>");
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function exitCell(status: "ok" | "pending", exitCode: number | null): string {
  return status === "pending" ? PENDING_RENDER_TEXT : String(exitCode);
}

/** Renderiza el Markdown completo del handoff (termina en `\n`). */
export function renderHandoffMarkdown(doc: HandoffDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.identification.title}`);
  lines.push("");
  lines.push("> Archivo GENERADO por `bun tests/handoff/build-handoff.ts` a partir de evidencia real.");
  lines.push("> No editar a mano: la suite `tests/handoff` compara este Markdown byte a byte con la");
  lines.push("> proyección del JSON y re-valida hashes/exports contra el repo vivo.");
  lines.push("");
  lines.push(`- Schema del handoff: \`${doc.schema}\` (\`${doc.handoffId}\`)`);
  lines.push(`- Stage de evidencia: \`${doc.verification.stage}\` (pre-gate = resultados aún no observados marcados como pending; final = todo observado)`);
  lines.push(`- Fecha de evidencia: ${doc.identification.evidenceDate}`);
  lines.push(`- Generado desde evidencia: \`${doc.generatedFrom.evidenceSchema}\` (operador: ${doc.generatedFrom.operator})`);
  lines.push("");

  // ---------------------------------------------- 1. identificación
  lines.push("## 1. Identificación");
  lines.push("");
  lines.push(`- Versión de protocolo: \`${doc.identification.protocolVersion}\``);
  lines.push(`- Origen del bundle: ${doc.identification.origin.kind}, npm publicado: ${doc.identification.origin.npmPublished}, secretos: ${doc.identification.origin.secrets}, rutas de máquina: ${doc.identification.origin.machinePaths}`);
  lines.push("");
  lines.push("| Paquete | Versión | Workspace | Export map | Símbolos públicos clave |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const pkg of doc.identification.packages) {
    const exports = Object.entries(pkg.exports)
      .map(([key, target]) => `${key} → ${target}`)
      .join(" ; ");
    lines.push(`| \`${pkg.name}\` | ${pkg.version} | \`${pkg.dir}\` | ${cell(exports)} | ${cell(pkg.publicSymbols.join(", "))} |`);
  }
  lines.push("");

  // ---------------------------------------------- 2. trazabilidad
  lines.push("## 2. Trazabilidad de código");
  lines.push("");
  lines.push(`- VCS: ${doc.codeTraceability.revision.vcs}; commits: ${doc.codeTraceability.revision.commits}; commit declarado: ${String(doc.codeTraceability.revision.commit)}`);
  lines.push(`- ${doc.codeTraceability.revision.note}`);
  lines.push("");
  lines.push(`- Algoritmo del source hash: \`${doc.codeTraceability.sourceHash.algorithm}\``);
  lines.push(`- Source hash: \`${doc.codeTraceability.sourceHash.hash}\` (archivos incluidos: ${doc.codeTraceability.sourceHash.fileCount})`);
  lines.push("");
  lines.push("Reglas de inclusión del hash:");
  lines.push(bullets(doc.codeTraceability.sourceHash.include));
  lines.push("");
  lines.push("Reglas de exclusión del hash:");
  lines.push(bullets(doc.codeTraceability.sourceHash.exclude));
  lines.push("");

  // ---------------------------------------------- 3. verificación
  lines.push("## 3. Verificación");
  lines.push("");
  lines.push(`- Entorno observado: bun ${doc.verification.environment.bun}${doc.verification.environment.typescript === undefined ? "" : `, typescript ${doc.verification.environment.typescript}`}, os ${doc.verification.environment.os}`);
  if (doc.verification.environment.notes !== undefined) {
    lines.push(`- Notas de entorno: ${doc.verification.environment.notes}`);
  }
  lines.push("");
  lines.push("| id | comando exacto | cwd | exit code observado | notas |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const command of doc.verification.commands) {
    lines.push(`| \`${command.id}\` | \`${cell(command.command)}\` | \`${cell(command.cwd)}\` | ${exitCell(command.status, command.exitCode)} | ${cell(command.notes ?? "")} |`);
  }
  lines.push("");
  lines.push("| suite | status | tests | failures | skipped | exit code | notas |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const suite of doc.verification.suites) {
    const pending = suite.status === "pending";
    const numbers = pending
      ? `${PENDING_RENDER_TEXT} | ${PENDING_RENDER_TEXT} | ${PENDING_RENDER_TEXT} | ${PENDING_RENDER_TEXT}`
      : `${suite.tests} | ${suite.failures} | ${suite.skipped} | ${suite.exitCode}`;
    lines.push(`| tests/${suite.suite} | ${suite.status} | ${numbers} | ${cell(suite.notes ?? "")} |`);
  }
  lines.push("");
  lines.push(`- Teardown observado: ${doc.verification.teardown}`);
  lines.push(`- Smoke consumidor (fuera del repo): exit ${doc.verification.consumer.smokeExitCode}; relocalización a segundo TMP: exit ${doc.verification.consumer.relocationExitCode}`);
  lines.push("");
  lines.push("Artefactos empaquetados observados (bundle hash por corrida):");
  lines.push("");
  lines.push("| archivo | sha256 | bytes |");
  lines.push("| --- | --- | --- |");
  for (const artifact of doc.verification.consumer.vendorArtifacts) {
    lines.push(`| \`vendor/${artifact.file}\` | \`${artifact.sha256}\` | ${artifact.bytes} |`);
  }
  lines.push("");

  // ---------------------------------------------- 4. capacidades
  lines.push("## 4. Capacidades y limitaciones");
  lines.push("");
  lines.push(`- Versión OMP evidenciada: ${doc.capabilities.ompVersion}`);
  lines.push("");
  lines.push("| capability | estado | evidencia |");
  lines.push("| --- | --- | --- |");
  for (const entry of doc.capabilities.matrix) {
    lines.push(`| \`${entry.name}\` | ${entry.status} | ${cell(entry.evidence)} |`);
  }
  lines.push("");
  lines.push("Limitaciones declaradas:");
  lines.push(bullets(doc.limitations));
  lines.push("");
  lines.push("El core ask/reply (`session.prompt.when_idle` + `session.reply_tool` + `root.binding`) se declara cubierto SOLO con evidencia de herramienta explícita `session_reply` (`replyTo = requestId`): ni `agent_end` ni el siguiente texto del modelo completan un ask. `presence` ≠ `request state` ≠ `job status` nativo, y `session.control.*` queda `unsupported` explícito.");
  lines.push("");

  // ---------------------------------------------- 5. consumo
  lines.push("## 5. Consumo reproducible offline/local");
  lines.push("");
  lines.push(bullets(doc.consumption.recipe));
  lines.push("");
  lines.push("Layout del snapshot:");
  lines.push("");
  lines.push("```text");
  lines.push(...doc.consumption.snapshotLayout);
  lines.push("```");
  lines.push("");
  lines.push(`- ${doc.consumption.adapterReuse}`);
  lines.push("");
  lines.push("Prohibiciones verificables:");
  lines.push(bullets(doc.consumption.prohibitions));
  lines.push("");
  lines.push("Bundle hash (mismos artefactos de la sección 3):");
  lines.push("");
  lines.push("| archivo | sha256 | bytes |");
  lines.push("| --- | --- | --- |");
  for (const artifact of doc.consumption.vendorArtifacts) {
    lines.push(`| \`vendor/${artifact.file}\` | \`${artifact.sha256}\` | ${artifact.bytes} |`);
  }
  lines.push("");

  // ---------------------------------------------- 6. operación
  lines.push("## 6. Operación y gates");
  lines.push("");
  lines.push(`- Rutas config/data: ${doc.operation.configAndData}`);
  lines.push(`- Backup/restore: ${doc.operation.backupRestore}`);
  lines.push(`- Inferencia real: ${doc.operation.noLiveInference ? "ausente (fake model que lanza si se invoca)" : "revisar"}`);
  lines.push(`- Activación de servicio: ${doc.operation.noServiceActivation ? "ausente (solo artefactos de ejemplo y service manager fake)" : "revisar"}`);
  lines.push("");
  lines.push("| gate | estado | nota |");
  lines.push("| --- | --- | --- |");
  for (const gate of doc.operation.gates) {
    lines.push(`| ${gate.id} | ${gate.status} | ${cell(gate.note)} |`);
  }
  lines.push("");
  lines.push("Evidencia NO realizada (enumerada honestamente):");
  lines.push(bullets(doc.operation.notPerformed));
  lines.push("");

  // ---------------------------------------------- 7. trazabilidad
  lines.push("## 7. Trazabilidad requisitos → suite → resultado");
  lines.push("");
  lines.push("| requisito | título | suites | resultado | notas |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of doc.requirementsTraceability) {
    lines.push(`| ${row.id} | ${cell(row.title)} | ${cell(row.suites.join(", "))} | ${row.result} | ${cell(row.notes ?? "")} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
