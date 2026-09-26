/**
 * Helpers aislados de `tests/protocol` (NFR-002).
 *
 * Cada archivo de prueba crea un TMP con el prefijo reservado
 * `omp-session-broker-test-`, desvía HOME/config/data hacia ese TMP, instala
 * guardas que FALLAN si se toca red/proveedores y usa fake transport/model.
 * El teardown corre en `afterAll` incluso ante fallo.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import type { ProtocolError, ProtocolErrorCode, ProtocolErrorReason, Result } from "@session-broker/protocol";

export const TMP_PREFIX = "omp-session-broker-test-";

/**
 * Aserción de rechazo estable: exige exactamente `code` + `reason` esperados
 * (nada de "cualquier error sirve").
 */
export function expectRejection<T>(
  result: Result<T, ProtocolError>,
  code: ProtocolErrorCode,
  reason: ProtocolErrorReason,
): void {
  if (result.ok) {
    throw new Error(`esperaba rechazo ${code}/${reason}, pero fue aceptado`);
  }
  expect(result.error.code).toBe(code);
  expect(result.error.reason).toBe(reason);
}

/** Aserción de aceptación; devuelve el valor validado. */
export function expectAccepted<T>(result: Result<T, ProtocolError>): T {
  if (!result.ok) {
    throw new Error(`esperaba aceptación, fue rechazado: ${result.error.code}/${result.error.reason} (${result.error.message})`);
  }
  return result.value;
}

export interface Isolation {
  readonly tmpDir: string;
  readonly fakeTransport: FakeTransport;
  readonly fakeModel: FakeModel;
  /** Restaura entorno/global y borra el TMP; idempotente. */
  teardown(): void;
}

/**
 * Fake transport: registra frames enviados/recibidos sin tocar la red.
 * Los tests de dedup cuentan efectos sobre esta lista.
 */
export class FakeTransport {
  readonly sent: unknown[] = [];
  readonly received: unknown[] = [];

  send(frame: unknown): void {
    this.sent.push(frame);
  }

  deliver(frame: unknown): void {
    this.received.push(frame);
  }

  get effectsCount(): number {
    return this.sent.length + this.received.length;
  }
}

/**
 * Fake model: cualquier intento de inferencia real FALLA el test. Ninguna
 * prueba del contrato debe invocar modelos ni proveedores.
 */
export class FakeModel {
  readonly calls: string[] = [];

  complete(prompt: string): string {
    this.calls.push(prompt);
    throw new Error("fake model invocado: tests/protocol no deben llamar modelos ni proveedores");
  }
}

type GuardTarget = "fetch" | "WebSocket";

const guardedGlobals: GuardTarget[] = ["fetch", "WebSocket"];

function installNetworkGuard(): () => void {
  const originals = new Map<GuardTarget, unknown>();
  for (const name of guardedGlobals) {
    originals.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = () => {
      throw new Error(`guarda de red activa: ${name} no debe usarse en tests/protocol`);
    };
  }
  return () => {
    for (const [name, value] of originals) {
      (globalThis as Record<string, unknown>)[name] = value;
    }
  };
}

/**
 * Aislamiento completo de una suite: TMP propio, HOME efímero, guardas de red
 * y fakes. `teardown()` se ejecuta desde `afterAll` aunque la suite falle.
 */
export function setupIsolation(): Isolation {
  const tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const originalHome = process.env.HOME;
  const originalXdgData = process.env.XDG_DATA_HOME;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpDir;
  process.env.XDG_DATA_HOME = join(tmpDir, "data");
  process.env.XDG_CONFIG_HOME = join(tmpDir, "config");
  const restoreNetwork = installNetworkGuard();
  const fakeTransport = new FakeTransport();
  const fakeModel = new FakeModel();
  let done = false;
  return {
    tmpDir,
    fakeTransport,
    fakeModel,
    teardown(): void {
      if (done) return;
      done = true;
      restoreNetwork();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgData;
      if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfig;
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Guarda defensiva: ninguna suite debe haber invocado el fake model. */
export function assertModelUnused(fakeModel: FakeModel): void {
  if (fakeModel.calls.length > 0) {
    throw new Error(`fake model invocado ${fakeModel.calls.length} vez/veces`);
  }
}
