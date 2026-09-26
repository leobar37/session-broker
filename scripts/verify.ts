/**
 * Agregador de verificación del proyecto (escritor único: coordinador).
 *
 * Contrato (fijado por P-001, integrado por el coordinador):
 *   bun run verify
 *     1. comprueba que las seis suites declaradas existen y no están vacías
 *        (si falta una suite o un directorio no contiene tests -> exit 2);
 *     2. ejecuta `bun run typecheck`;
 *     3. ejecuta cada suite en su propio proceso aislado;
 *     4. propaga fallos (cualquier suite o typecheck en rojo -> exit 1);
 *     5. barre temporales propios aunque haya errores (teardown best-effort;
 *        cada suite además limpia sus recursos con afterAll).
 *
 * Las suites usan directorios temporales con el prefijo reservado
 * `omp-session-broker-test-` bajo os.tmpdir(), HOME/config/data efímeros,
 * puertos efímeros y fake model. Ninguna suite usa red externa, proveedores
 * reales, estado de usuario ni servicios persistentes.
 */

import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SUITES = ["protocol", "broker", "cli", "omp", "recovery", "handoff"] as const;
const TEST_FILE = /\.(test|spec)\.ts$/;
const TMP_PREFIX = "omp-session-broker-test-";

const startedAt = Date.now();

function findTestFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function sweepTemporaries(): void {
  let names: string[] = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = join(tmpdir(), name);
    try {
      const st = statSync(full);
      // Solo basura propia de esta ejecución (o de ejecuciones ya muertas).
      if (st.mtimeMs + 60_000 < startedAt) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort: el teardown detallado vive en las suites
    }
  }
}

async function run(label: string, cmd: string[]): Promise<number> {
  process.stdout.write(`\n=== ${label}: ${cmd.join(" ")} ===\n`);
  const proc = Bun.spawn(cmd, {
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  const problems: string[] = [];

  // 1. Cobertura: ninguna suite ausente o vacía.
  for (const suite of SUITES) {
    const dir = join(import.meta.dir, "..", "tests", suite);
    const files = findTestFiles(dir);
    if (files.length === 0) {
      problems.push(`suite ausente o vacía: tests/${suite}`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`verify: ${p}\n`);
    process.stderr.write("verify: abortado antes de ejecutar (exit 2)\n");
    sweepTemporaries();
    process.exit(2);
  }

  // 2+3. typecheck y suites, en procesos separados y aislados.
  const results: Array<{ label: string; code: number }> = [];
  try {
    results.push({ label: "typecheck", code: await run("typecheck", ["bun", "run", "typecheck"]) });
    for (const suite of SUITES) {
      results.push({ label: `test:${suite}`, code: await run(`test:${suite}`, ["bun", "test", `tests/${suite}`]) });
    }
  } finally {
    // 5. teardown incluso ante errores.
    sweepTemporaries();
  }

  process.stdout.write("\n=== resumen verify ===\n");
  for (const r of results) {
    process.stdout.write(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.label}  (exit ${r.code})\n`);
  }

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    process.stderr.write(`verify: ${failed.length} paso(s) en rojo (exit 1)\n`);
    process.exit(1);
  }
  process.stdout.write("verify: todo verde (exit 0)\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`verify: error interno ${String(err)}\n`);
  sweepTemporaries();
  process.exit(1);
});
