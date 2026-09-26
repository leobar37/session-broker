/**
 * Suite `test:handoff` — casos NEGATIVOS sobre copias en TMP (P-006).
 *
 * DoD binario: «un source modificado después, hash corrupto, export faltante
 * o incompatibilidad produce exit no cero y bloquea integración». Cada caso
 * copia el conjunto fuente + artefactos a un TMP con el prefijo reservado,
 * TAMPERA SOLO la copia (el repo jamás se toca) y exige el issue esperado del
 * validador. Si los artefactos aún no están materializados, FALLA con el
 * mensaje claro del generator (nunca se saltan tests).
 *
 * Principio de estos negativos: UN tamper ⇒ UN motivo ⇒ SU issue. Cada caso es
 * autocontenido respecto al stage base de los artefactos materializados
 * (pre-gate con pendientes o final todo observado): si un tamper necesita
 * forzar un campo para ser inconsistente en ambos stages, lo fuerza
 * explícitamente y documenta por qué, y jamás exige issues de otros motivos
 * (p. ej. `stage-incoherent` se prueba en su propio tamper de desincronización).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOFF_JSON_NAME, HANDOFF_MD_NAME, type HandoffDoc } from "./lib/handoff-schema";
import { makeTmpDir, removeTmpDir } from "./lib/isolation";
import { copySourceTree } from "./lib/source-hash";
import { HANDOFF_MISSING_MESSAGE, validateHandoffTree, type ValidationIssue } from "./lib/validate-handoff";

const repoRoot = join(import.meta.dir, "..", "..");
const handoffDir = join(repoRoot, "docs", "handoff");

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots) removeTmpDir(dir);
});

/** Copia fuente + artefactos a un TMP; la copia es el único sujeto de tamper. */
function makeTamperedRepo(label: string): string {
  const jsonSource = join(handoffDir, HANDOFF_JSON_NAME);
  const mdSource = join(handoffDir, HANDOFF_MD_NAME);
  for (const path of [jsonSource, mdSource]) {
    if (!existsSync(path)) throw new Error(`falta ${path}: ${HANDOFF_MISSING_MESSAGE}`);
  }
  const tmp = makeTmpDir(`handoff-tamper-${label}`);
  tmpRoots.push(tmp);
  const root = join(tmp, "repo");
  copySourceTree(repoRoot, root);
  const target = join(root, "docs", "handoff");
  mkdirSync(target, { recursive: true });
  copyFileSync(jsonSource, join(target, HANDOFF_JSON_NAME));
  copyFileSync(mdSource, join(target, HANDOFF_MD_NAME));
  return root;
}

function issuesFor(root: string): ValidationIssue[] {
  return validateHandoffTree(root, join(root, "docs", "handoff"));
}

function expectIssue(issues: readonly ValidationIssue[], code: string): void {
  const matched = issues.some((issue) => issue.code === code);
  if (!matched) {
    throw new Error(
      `se esperaba el issue "${code}"; observados: ${JSON.stringify(issues.map((issue) => `[${issue.code}] ${issue.message}`), null, 2)}`,
    );
  }
}

describe("detección de handoff inválido (copias tampered en TMP)", () => {
  test("una copia intacta valida limpia (control del control)", () => {
    const root = makeTamperedRepo("control");
    expect(issuesFor(root)).toEqual([]);
  });

  test("fuente modificada tras generar ⇒ source-hash-mismatch ⇒ fallo", () => {
    const root = makeTamperedRepo("source");
    appendFileSync(join(root, "packages", "protocol", "src", "version.ts"), "\n// modificado tras generar el handoff\n", "utf8");
    expectIssue(issuesFor(root), "source-hash-mismatch");
  });

  test("hash corrupto en el JSON ⇒ source-hash-mismatch ⇒ fallo", () => {
    const root = makeTamperedRepo("hash");
    const jsonPath = join(root, "docs", "handoff", HANDOFF_JSON_NAME);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as HandoffDoc;
    const tampered = doc.codeTraceability.sourceHash as { hash: string };
    tampered.hash = `sha256:${"0".repeat(64)}`;
    writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "source-hash-mismatch");
  });

  test("export faltante en un manifest ⇒ export-mismatch ⇒ fallo", () => {
    const root = makeTamperedRepo("export");
    const manifestPath = join(root, "packages", "protocol", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports: Record<string, string> };
    delete manifest.exports["./fixtures"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "export-mismatch");
  });

  test("JSON y MD incoherentes ⇒ md-incoherent ⇒ fallo", () => {
    const root = makeTamperedRepo("md");
    const mdPath = join(root, "docs", "handoff", HANDOFF_MD_NAME);
    appendFileSync(mdPath, "\nTexto editado a mano que el JSON no respalda.\n", "utf8");
    expectIssue(issuesFor(root), "md-incoherent");
  });

  test("comando base marcado pending ⇒ commands-incoherent ⇒ fallo", () => {
    // Autocontenido respecto al stage base de los artefactos: `pending` solo se
    // permite para los comandos autorreferenciales y solo en stage "pre-gate",
    // así que un comando base en pending es inconsistente con pre-gate y con
    // final por igual. Se exige SOLO su motivo (sin depender de stage-incoherent).
    const root = makeTamperedRepo("pending-base");
    const jsonPath = join(root, "docs", "handoff", HANDOFF_JSON_NAME);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      verification: { commands: Array<{ id: string; status: string; exitCode: number | null }> };
    };
    const typecheck = doc.verification.commands.find((command) => command.id === "typecheck");
    if (typecheck !== undefined) {
      typecheck.status = "pending";
      typecheck.exitCode = null;
    }
    writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "commands-incoherent");
  });

  test("comando autorreferencial pending en stage final ⇒ commands-incoherent ⇒ fallo", () => {
    // Autocontenido respecto al stage base: se fija verification.stage="final"
    // y se inyecta un pending, lo que es inconsistente tanto si los artefactos
    // base son pre-gate como final. Se exige SOLO commands-incoherent; la
    // desincronización de stages se prueba aparte (tamper siguiente).
    const root = makeTamperedRepo("pending-final");
    const jsonPath = join(root, "docs", "handoff", HANDOFF_JSON_NAME);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      verification: { stage: string; commands: Array<{ id: string; status: string; exitCode: number | null }> };
    };
    doc.verification.stage = "final";
    const verifyCommand = doc.verification.commands.find((command) => command.id === "verify");
    if (verifyCommand !== undefined) {
      verifyCommand.status = "pending";
      verifyCommand.exitCode = null;
    }
    writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "commands-incoherent");
  });

  test("stages desincronizados ⇒ stage-incoherent ⇒ fallo", () => {
    // Tamper SEPARADO y explícito: generatedFrom.stage ≠ verification.stage,
    // sin inyectar pendientes. Independiente del stage base de los artefactos.
    const root = makeTamperedRepo("stage-desync");
    const jsonPath = join(root, "docs", "handoff", HANDOFF_JSON_NAME);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      generatedFrom: { stage: string };
      verification: { stage: string };
    };
    doc.generatedFrom.stage = "pre-gate";
    doc.verification.stage = "final";
    writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "stage-incoherent");
  });

  test("exit code no-0 en un comando ⇒ commands-incoherent ⇒ fallo", () => {
    const root = makeTamperedRepo("exitcode");
    const jsonPath = join(root, "docs", "handoff", HANDOFF_JSON_NAME);
    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      verification: { commands: Array<{ id: string; status: string; exitCode: number | null }> };
    };
    const typecheck = doc.verification.commands.find((command) => command.id === "typecheck");
    if (typecheck !== undefined) {
      typecheck.status = "ok";
      typecheck.exitCode = 3;
    }
    writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    expectIssue(issuesFor(root), "commands-incoherent");
  });

  test("artefactos ausentes ⇒ missing-artifact con mensaje del generator ⇒ fallo", () => {
    const root = makeTamperedRepo("missing");
    rmSync(join(root, "docs", "handoff", HANDOFF_MD_NAME), { force: true });
    const issues = issuesFor(root);
    expectIssue(issues, "missing-artifact");
    expect(issues.map((issue) => issue.message).join("\n")).toContain("materializa el handoff con el generator");
  });
});
