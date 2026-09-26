/**
 * Operación, health, shutdown y logs redactados (FR-010 / NFR-001).
 *
 *   - health DISTINGUE proceso accesible, store utilizable, schema compatible
 *     y disponibilidad de peers; sin inferencia ni secretos/historial privado;
 *   - el shutdown ordenado cierra conexiones/timers/DB sin completar requests
 *     artificialmente;
 *   - los logs estructurados están redactados por defecto (IDs scoped, jamás
 *     credenciales, MAC keys ni payloads);
 *   - el segundo escritor sobre el mismo store se RECHAZA;
 *   - los fallos de disco/permiso son errores observables, nunca recibos
 *     falsos de durabilidad.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
import { createBrokerServer, createLogger, redactLogValue, type LogFields } from "@session-broker/server";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  freshIdentity,
  healthOf,
  openPeer,
  sessionRefFor,
  setupIsolation,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const QUESTION = "pregunta privada que jamás debe aparecer en un log";

const identity = freshIdentity();
let isolation: Isolation;

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  isolation = setupIsolation("recovery-operation");
});

afterAll(async () => {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch {
      // teardown best-effort
    }
  }
  cleanups.length = 0;
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

/** Espera un rechazo explícito y devuelve el error (sin depender de matchers). */
async function captureRejection(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("se esperaba un rechazo y la operación resolvió");
}

async function fixtureWithGrants(name: string): Promise<{ dataDir: string; grantId: string }> {
  const dataDir = join(isolation.tmpDir, `data-${name}`);
  mkdirSync(dataDir, { recursive: true });
  const grant = testGrant({
    projectId: identity.projectId,
    capabilities: [...ALL_ADAPTER_CAPABILITIES],
    issuedAtMs: isolation.clock.nowMs - 60_000,
    expiresAtMs: isolation.clock.nowMs + 86_400_000,
  });
  writeGrants(dataDir, [{ credential: CREDENTIAL, grant }]);
  return { dataDir, grantId: String(grant["grantId"]) };
}

describe("health: dimensiones separadas y sin secretos", () => {
  test("proceso, store, schema y peers se distinguen; nada de secretos ni inferencia", async () => {
    const { dataDir, grantId } = await fixtureWithGrants("health");
    const broker = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => broker.close());

    const before = await healthOf(broker.port);
    expect(before["ok"]).toBe(true);
    const process = before["process"] as Record<string, unknown>;
    expect(process["listening"]).toBe(true);
    expect(Number(process["uptimeMs"])).toBeGreaterThanOrEqual(0);
    const store = before["store"] as Record<string, unknown>;
    expect(store["usable"]).toBe(true);
    expect(store["writer"]).toBe(true);
    const schema = before["schema"] as Record<string, unknown>;
    expect(schema["compatible"]).toBe(true);
    expect(schema["expected"]).toBe(1);
    const peers = before["peers"] as Record<string, unknown>;
    expect(peers["available"]).toBe(true);
    expect(Number(peers["connections"])).toBe(0);

    // Con un titular conectado la disponibilidad de peers cambia, sin mezclar
    // presencia con estado de tarea ni con inferencia alguna.
    const holder = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: "session-health",
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const after = await healthOf(broker.port);
    const peersAfter = after["peers"] as Record<string, unknown>;
    expect(Number(peersAfter["connections"])).toBe(1);
    expect(Number(peersAfter["sessionsOnline"])).toBe(1);
    const serialized = JSON.stringify(after);
    expect(serialized.includes(CREDENTIAL)).toBe(false);
    expect(serialized.includes(MAC_KEY)).toBe(false);
    expect(serialized.includes(QUESTION)).toBe(false);
    expect(isolation.fakeModel.calls).toEqual([]);
  });
});

describe("shutdown ordenado y segundo escritor", () => {
  test("el shutdown cierra todo sin completar requests artificialmente", async () => {
    const { dataDir, grantId } = await fixtureWithGrants("shutdown");
    const broker = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => broker.close());
    const sessionId = "session-shutdown";
    const holder = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const askId = newRequestId();
    const payload = { question: QUESTION, deadlineMs: 300_000, policy: "when_idle" };
    const queued = await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");

    await broker.close();
    expect(broker.server.activeConnections).toBe(0);
    await waitForValue(() => holder.closeCode, "cierre del peer notificado por el shutdown");
    // El proceso deja de responder: nada sigue "vivo" en puertas falsas.
    const unreachable = await captureRejection(() => fetch(`http://127.0.0.1:${broker.port}/health`));
    expect(unreachable).toBeDefined();
    // Close es idempotente y no fabrica estados.
    await broker.close();

    // El estado durable sobrevive: el request sigue queued, jamás completado.
    const reopened = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => reopened.close());
    const reader = await openPeer({
      url: reopened.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => reader.close());
    const replay = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    const record = (replay["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(record["state"]).toBe("queued");
  });

  test("el segundo escritor sobre el mismo store se rechaza (un solo escritor)", async () => {
    const { dataDir } = await fixtureWithGrants("second-writer");
    const first = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => first.close());
    const second = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      macKey: MAC_KEY,
      now: isolation.clock.now,
    });
    const rejection = await captureRejection(() => second.listen());
    expect(rejection.message.includes("escritor")).toBe(true);
    await second.close();
  });

  test("los fallos de disco/permiso son errores observables, no salud falsa", async () => {
    // El data dir no puede crearse porque un ARCHIVO ocupa su ruta: fallo
    // determinista de IO, sin depender de permisos de uid.
    const blocked = join(isolation.tmpDir, "blocked");
    writeFileSync(blocked, "esto es un archivo, no un directorio", "utf8");
    const broken = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: join(blocked, "store"),
      now: isolation.clock.now,
    });
    const rejection = await captureRejection(() => broken.listen());
    expect(rejection.message.length).toBeGreaterThan(0);
    await broken.close();
  });
});

describe("logs estructurados y redactados", () => {
  test("los logs del broker son JSON redactados (IDs scoped, sin secretos)", async () => {
    const lines: string[] = [];
    const { dataDir, grantId } = await fixtureWithGrants("logs");
    const server = createBrokerServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      macKey: MAC_KEY,
      now: isolation.clock.now,
      logSink: (line: string) => {
        lines.push(line);
      },
    });
    cleanups.push(() => server.close());
    const address = await server.listen();

    const holder = await openPeer({
      url: `ws://127.0.0.1:${address.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: "session-logs",
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    await holder.request({
      operation: "ask",
      target: targetOf("session-logs"),
      payload: { question: QUESTION, deadlineMs: 300_000, policy: "when_idle" },
      requestId: newRequestId(),
    });
    // Handshake fallido: la causa se registra SIN credenciales.
    const denied = await openPeer({
      url: `ws://127.0.0.1:${address.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: "credencial-fallida-que-no-debe-loguearse",
      capabilities: ["session.identity"],
    });
    cleanups.push(() => denied.close());
    await waitForValue(() => denied.closeCode, "cierre del handshake denegado");

    await server.close();
    expect(lines.length).toBeGreaterThan(3);
    const events = lines.map((line) => {
      const parsed = JSON.parse(line) as { ts?: unknown; level?: unknown; event?: unknown };
      expect(typeof parsed.ts).toBe("number");
      expect(typeof parsed.level).toBe("string");
      expect(typeof parsed.event).toBe("string");
      return String(parsed.event);
    });
    expect(events).toContain("broker.listening");
    expect(events).toContain("peer.connected");
    expect(events).toContain("session.bound");
    expect(events).toContain("request.queued");
    expect(events).toContain("peer.handshake_rejected");
    expect(events).toContain("broker.shutdown");
    for (const line of lines) {
      expect(line.includes(CREDENTIAL)).toBe(false);
      expect(line.includes(MAC_KEY)).toBe(false);
      expect(line.includes(QUESTION)).toBe(false);
      expect(line.includes("credencial-fallida-que-no-debe-loguearse")).toBe(false);
    }
  });

  test("la redacción es la política por defecto del logger", () => {
    const secrets = ["secreto-valor"];
    const fields: LogFields = {
      credential: "secreto-valor",
      macKey: "otro-secreto",
      payload: { question: "texto privado", nested: { result: "dato privado" } },
      dataDir: "/var/lib/session-broker",
      requestId: "req_00000000000000000000000000000000",
      note: "la credencial secreto-valor no debe filtrarse",
    };
    const redacted = redactLogValue(fields, secrets) as Record<string, unknown>;
    expect(redacted["credential"]).toBe("[REDACTED]");
    expect(redacted["macKey"]).toBe("[REDACTED]");
    expect(redacted["payload"]).toBe("[REDACTED]");
    expect(redacted["dataDir"]).toBe("/var/lib/session-broker");
    expect(redacted["requestId"]).toBe("req_00000000000000000000000000000000");
    expect(String(redacted["note"]).includes("secreto-valor")).toBe(false);

    // El logger completo tampoco filtra por accidente.
    const sinkLines: string[] = [];
    const logger = createLogger({
      sink: (line: string) => {
        sinkLines.push(line);
      },
      minLevel: "debug",
      secrets: () => secrets,
      now: () => 1_700_000_000_000,
    });
    logger.log("info", "test.event", fields);
    expect(sinkLines.length).toBe(1);
    const line = sinkLines[0] ?? "";
    expect(line.includes("secreto-valor")).toBe(false);
    expect(line.includes("texto privado")).toBe(false);
    expect(line.includes("dato privado")).toBe(false);
    expect(line.includes("[REDACTED]")).toBe(true);
  });
});
