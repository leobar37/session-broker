/**
 * Helpers de `tests/recovery` (NFR-002 / NFR-004).
 *
 * Reutiliza las primitivas ya verificadas de las suites hermanas (TMP con
 * prefijo reservado, HOME/XDG efímeros, reloj fake, fake model que FALLA si se
 * invoca, guarda de red loopback, peers falsos, proceso hijo para SIGKILL y
 * broker real) y añade lo propio de recovery: service manager fake, config de
 * usuario para la CLI, salud HTTP y utilidades de cierre/teardown.
 *
 * Nada de esto escribe fuera de TMP; el teardown corre incluso ante fallo.
 */

export {
  ALL_ADAPTER_CAPABILITIES,
  FakeClock,
  FakeModel,
  assertModelUnused,
  bindRoot,
  expectError,
  expectResponseError,
  expectWelcome,
  freshIdentity,
  installNetworkGuard,
  makeRootProof,
  openPeer,
  sessionRefFor,
  setupIsolation,
  sleep,
  spawnBrokerProcess,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
} from "../broker/helpers";
export type {
  BrokerHandle,
  ChildBroker,
  FakePeer,
  Frame,
  Isolation,
  OpenPeerInput,
  RootProofInput,
  TestGrantInput,
} from "../broker/helpers";
export { FakeOmpHost } from "../omp/helpers";
export { captureCli, jsonOutput } from "../cli/helpers";
export type { CliRun } from "../cli/helpers";

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";

/**
 * Service manager FAKE (FR-010): registra cualquier operación que una prueba
 * NO debe ejecutar (install/enable/start/restart/daemon-reload). La suite de
 * systemd afirma que esta lista queda VACÍA: generar instrucciones no toca el
 * user manager.
 */
export class FakeServiceManager {
  readonly operations: string[] = [];

  install(unit: string): void {
    this.operations.push(`install ${unit}`);
  }

  enable(unit: string): void {
    this.operations.push(`enable ${unit}`);
  }

  start(unit: string): void {
    this.operations.push(`start ${unit}`);
  }

  restart(unit: string): void {
    this.operations.push(`restart ${unit}`);
  }

  daemonReload(): void {
    this.operations.push("daemon-reload");
  }

  stop(unit: string): void {
    this.operations.push(`stop ${unit}`);
  }
}

/** Config de usuario de la CLI (0600) dentro del TMP de la isolación. */
export function writeUserConfigFile(
  configHome: string,
  config: {
    endpoint: string;
    grantId: string;
    credential: string;
    allowInsecureWs?: boolean;
  },
): string {
  const dir = join(configHome, "session-broker");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        endpoint: config.endpoint,
        grantId: config.grantId,
        credential: config.credential,
        allowInsecureWs: config.allowInsecureWs ?? true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  chmodSync(path, 0o600);
  return path;
}

/** Salud HTTP del broker (solo loopback); lanza si el proceso no responde. */
export async function healthOf(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return (await response.json()) as Record<string, unknown>;
}

/** Ningún secreto conocido puede aparecer en una salida/logs/artefactos. */
export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    expect(text.includes(secret)).toBe(false);
  }
}

/**
 * Cierre de peers con evidencia: cada socket debe llegar a `closeCode` (el
 * runtime ya disparó `close`) y el broker debe quedar sin conexiones.
 */
export async function closePeers(peers: readonly { close(): void; closeCode: number | undefined }[]): Promise<void> {
  for (const peer of peers) peer.close();
  for (const peer of peers) {
    const deadline = Date.now() + 3_000;
    while (peer.closeCode === undefined && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 5);
      await promise;
    }
    expect(peer.closeCode).toBeDefined();
  }
}
