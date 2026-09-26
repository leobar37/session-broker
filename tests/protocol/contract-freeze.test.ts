/**
 * Criterio binario: el contrato documentado y el código coinciden. Compara
 * `docs/contracts/freeze.json` (fuente legible por máquinas del freeze) con
 * las constantes realmente exportadas por `@session-broker/protocol` y con el
 * manifest real de `packages/protocol/package.json`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_CAPABILITIES,
  CORE_CAPABILITIES,
  EXIT_CODES,
  LIMITS,
  OPTIONAL_CAPABILITIES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_ERROR_TABLE,
  PROTOCOL_VERSION,
} from "@session-broker/protocol";
import { assertModelUnused, setupIsolation, type Isolation } from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

interface FreezePackage {
  name: string;
  version: string;
  dir: string;
  exports: string[];
}

interface FreezeDoc {
  protocolVersion: string;
  packages: FreezePackage[];
  errorCodes: Array<{ code: string; terminal: boolean; retrySafe: boolean; exitCode: number }>;
  exitCodes: Record<string, number>;
  limits: Record<string, number>;
  capabilities: string[];
  coreCapabilities: string[];
  optionalCapabilities: string[];
}

const repoRoot = join(import.meta.dir, "..", "..");
const freeze = JSON.parse(readFileSync(join(repoRoot, "docs", "contracts", "freeze.json"), "utf8")) as FreezeDoc;

describe("freeze.json == código exportado", () => {
  test("versión del protocolo", () => {
    expect(freeze.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("tabla de errores: códigos, terminalidad, retrySafe y exit codes", () => {
    expect(freeze.errorCodes.map((entry) => entry.code)).toEqual([...PROTOCOL_ERROR_CODES]);
    expect(freeze.errorCodes.length).toBe(PROTOCOL_ERROR_CODES.length);
    for (const entry of freeze.errorCodes) {
      const tableEntry = PROTOCOL_ERROR_TABLE[entry.code as (typeof PROTOCOL_ERROR_CODES)[number]];
      expect(tableEntry).toBeDefined();
      expect(entry.terminal).toBe(tableEntry.terminal);
      expect(entry.retrySafe).toBe(tableEntry.retrySafe);
      expect(entry.exitCode).toBe(tableEntry.exitCode);
    }
  });

  test("exit codes numéricos de la CLI", () => {
    expect(freeze.exitCodes).toEqual({ ...EXIT_CODES });
  });

  test("límites numéricos", () => {
    expect(freeze.limits).toEqual({ ...LIMITS });
  });

  test("capacidades core/opcionales", () => {
    expect([...freeze.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
    expect(freeze.coreCapabilities).toEqual([...CORE_CAPABILITIES]);
    expect(freeze.optionalCapabilities).toEqual([...OPTIONAL_CAPABILITIES]);
  });

  test("los cinco paquetes congelados: nombres, versiones, dirs y export maps", () => {
    expect(freeze.packages.map((entry) => entry.name)).toEqual([
      "@session-broker/protocol",
      "@session-broker/client",
      "@session-broker/server",
      "@session-broker/cli",
      "@session-broker/omp-adapter",
    ]);
    for (const entry of freeze.packages) {
      expect(entry.version).toBe("0.1.0");
      expect(entry.exports.length).toBeGreaterThanOrEqual(1);
      expect(entry.exports[0]).toBe(".");
    }
  });

  test("packages/protocol/package.json real coincide con su entrada del freeze", () => {
    const entry = freeze.packages.find((candidate) => candidate.name === "@session-broker/protocol");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("freeze entry @session-broker/protocol ausente");
    const manifestPath = join(repoRoot, "packages", "protocol", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      version: string;
      exports: Record<string, string>;
    };
    expect(manifest.name).toBe(entry.name);
    expect(manifest.version).toBe(entry.version);
    expect(Object.keys(manifest.exports).sort()).toEqual([...entry.exports].sort());
    // Export map source-first exigido por el contrato de wiring raíz.
    expect(manifest.exports["."] ?? null).toBe("./src/index.ts");
    expect(manifest.exports["./fixtures"] ?? null).toBe("./src/fixtures.ts");
  });
});
