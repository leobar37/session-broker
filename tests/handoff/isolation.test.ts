/**
 * Suite `test:handoff` — guardas de aislamiento (P-006 / NFR-002).
 *
 * DoD: «nada fuera de TMP, fake model, red bloqueada, teardown total». Estas
 * guardas se comprueban como comportamiento del harness: prefijo reservado de
 * temporales, guardas de red (loopback únicamente), fake model declarado en el
 * consumidor y — de forma global — que la suite NO escribe en el repo (el
 * inventario del conjunto fuente y de `docs/handoff` se captura al cargar la
 * librería del harness y se compara al ejecutar el test). Única excepción
 * documentada: `docs/handoff/evidence/consumer.fragment.json` (evidencia real
 * del consumidor, excluida del source hash y de esta guarda).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertUrlAllowed, installNetworkGuard, makeTmpDir, removeTmpDir, TMP_PREFIX } from "./lib/isolation";
import { repoChangesSinceSuiteStart } from "./lib/source-hash";

const repoRoot = join(import.meta.dir, "..", "..");

describe("guardas de aislamiento del harness de handoff", () => {
  test("temporales con prefijo reservado y teardown total", () => {
    const dir = makeTmpDir("isolation");
    expect(basename(dir).startsWith(TMP_PREFIX)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    removeTmpDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test("red externa bloqueada; loopback permitido para los fixtures", () => {
    expect(() => assertUrlAllowed("https://example.org/api", "test")).toThrow("red externa bloqueada");
    expect(() => assertUrlAllowed("ws://10.0.0.5:8791", "test")).toThrow("red externa bloqueada");
    expect(() => assertUrlAllowed("ws://127.0.0.1:8791", "test")).not.toThrow();
    const restore = installNetworkGuard();
    try {
      expect(() => {
        void globalThis.fetch("https://example.org/registro");
      }).toThrow("red externa bloqueada");
    } finally {
      restore();
    }
  });

  test("el consumidor declara fake model que FALLA si se invoca", () => {
    const smokeSource = readFileSync(join(repoRoot, "tests", "handoff", "consumer-smoke", "smoke.template.ts"), "utf8");
    expect(smokeSource).toContain("inferencia real prohibida");
    expect(smokeSource).toContain("expect(model.calls).toEqual([])");
  });

  test("la suite no escribe fuera de TMP salvo el fragmento documentado", () => {
    // Excepción única y declarada: docs/handoff/evidence/consumer.fragment.json
    // (evidencia real del consumidor, excluida del source hash). Todo lo demás
    // del repo debe quedar intacto.
    expect(repoChangesSinceSuiteStart()).toEqual([]);
  });
});
