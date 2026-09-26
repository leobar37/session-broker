/**
 * Cursores, retención, backpressure y límites (FR-009 / NFR-004).
 *
 * Semánticas DISTINTAS y verificables por separado:
 *   - cursor/retención vigente: reanuda sin perder ni inventar eventos;
 *   - fuera de retención: `CURSOR_EXPIRED` (gap/resync explícito) y, en el
 *     snapshot, `gap: true` declarado — la CLI jamás lo oculta;
 *   - consumidor lento/detenido: corte explícito `QUEUE_FULL` con contadores
 *     acotados (nunca descarte silencioso);
 *   - frames extremos: rechazo explícito con el error congelado;
 *   - tormenta de reconexión: backoff+jitter acotados por contadores, sin
 *     benchmarks de wall time.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, LIMITS, newInstanceId, newRequestId } from "@session-broker/protocol";
import { reconnectDelayMs } from "@session-broker/client";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  captureCli,
  closePeers,
  expectError,
  expectResponseError,
  freshIdentity,
  healthOf,
  jsonOutput,
  openPeer,
  sessionRefFor,
  setupIsolation,
  sleep,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  writeUserConfigFile,
  type BrokerHandle,
  type FakePeer,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const CREDENTIAL_READER = "fixture-reader-credential-not-a-real-secret";
/** TTL largo para los fixtures que avanzan el reloj más allá de la retención. */
const LONG_TTL_MS = 2_000_000_000;

const identity = freshIdentity();
let isolation: Isolation;

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  isolation = setupIsolation("recovery-cursors");
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

interface Fixture {
  readonly broker: BrokerHandle;
  readonly dataDir: string;
  readonly grant: Record<string, unknown>;
  readonly readerGrant: Record<string, unknown>;
  openHolder(sessionId: string): Promise<FakePeer>;
  openReader(): Promise<FakePeer>;
}

async function startFixture(name: string, options?: { longTtl?: boolean }): Promise<Fixture> {
  const dataDir = join(isolation.tmpDir, `data-${name}`);
  mkdirSync(dataDir, { recursive: true });
  const ttl = options?.longTtl === true ? LONG_TTL_MS : 86_400_000;
  const grant = testGrant({
    projectId: identity.projectId,
    capabilities: [...ALL_ADAPTER_CAPABILITIES],
    issuedAtMs: isolation.clock.nowMs - 60_000,
    expiresAtMs: isolation.clock.nowMs + ttl,
  });
  const readerGrant = testGrant({
    projectId: identity.projectId,
    capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    issuedAtMs: isolation.clock.nowMs - 60_000,
    expiresAtMs: isolation.clock.nowMs + ttl,
  });
  writeGrants(dataDir, [
    { credential: CREDENTIAL, grant },
    { credential: CREDENTIAL_READER, grant: readerGrant },
  ]);
  const broker = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
  cleanups.push(() => broker.close());
  return {
    broker,
    dataDir,
    grant,
    readerGrant,
    async openHolder(sessionId: string): Promise<FakePeer> {
      const peer = await openPeer({
        url: broker.url,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        instanceId: newInstanceId(),
        nativeSessionId: sessionId,
        grantId: String(grant["grantId"]),
        credential: CREDENTIAL,
        capabilities: [...ALL_ADAPTER_CAPABILITIES],
      });
      cleanups.push(() => peer.close());
      return peer;
    },
    async openReader(): Promise<FakePeer> {
      const peer = await openPeer({
        url: broker.url,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        instanceId: newInstanceId(),
        grantId: String(readerGrant["grantId"]),
        credential: CREDENTIAL_READER,
        capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
      });
      cleanups.push(() => peer.close());
      return peer;
    },
  };
}

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

describe("cursores y retención (semánticas distintas)", () => {
  test("cursor vigente reanuda sin perder ni inventar eventos", async () => {
    const fixture = await startFixture("cursor-resume");
    const sessionId = "session-cursor";
    const holder = await fixture.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const reader = await fixture.openReader();
    const observer = await fixture.openReader();

    const subscribe = await observer.request({
      operation: "subscribe",
      target: targetOf(sessionId),
      payload: { topics: ["broker.ask"], fromEventSeq: 1 },
    });
    expect(subscribe["state"]).toBe("completed");

    // Primera tanda de eventos durables.
    for (let index = 0; index < 3; index += 1) {
      await reader.request({
        operation: "ask",
        target: targetOf(sessionId),
        payload: { question: `pregunta ${index}`, deadlineMs: 300_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
    }
    await waitForValue(
      () => (observer.events.filter((event) => event["topic"] === "broker.ask").length >= 3 ? true : undefined),
      "primera tanda de eventos",
    );
    const firstBatch = observer.events.filter((event) => event["topic"] === "broker.ask");
    const lastSeq = Math.max(...firstBatch.map((event) => Number(event["eventSeq"])));
    observer.close();

    // Segunda tanda mientras el consumidor está desconectado.
    for (let index = 3; index < 5; index += 1) {
      await reader.request({
        operation: "ask",
        target: targetOf(sessionId),
        payload: { question: `pregunta ${index}`, deadlineMs: 300_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
    }

    // Reanudación con cursor: lo ya entregado NO se repite y nada se pierde.
    const resumed = await fixture.openReader();
    const resubscribe = await resumed.request({
      operation: "subscribe",
      target: targetOf(sessionId),
      payload: { topics: ["broker.ask"], fromEventSeq: lastSeq + 1 },
    });
    expect(resubscribe["state"]).toBe("completed");
    await waitForValue(
      () => (resumed.events.filter((event) => event["topic"] === "broker.ask").length >= 2 ? true : undefined),
      "segunda tanda tras reanudar",
    );
    const secondBatch = resumed.events.filter((event) => event["topic"] === "broker.ask");
    expect(secondBatch.length).toBe(2);
    for (const event of secondBatch) {
      expect(Number(event["eventSeq"])).toBeGreaterThan(lastSeq);
    }
    // Sin invención: ningún evento de la primera tanda vuelve a aparecer.
    const seenIds = new Set(firstBatch.map((event) => String(event["eventId"])));
    for (const event of secondBatch) {
      expect(seenIds.has(String(event["eventId"]))).toBe(false);
    }
    await closePeers([reader, observer, resumed, holder]);
  });

  test("fuera de retención: gap explícito CURSOR_EXPIRED y snapshot declarado", async () => {
    const fixture = await startFixture("cursor-expired", { longTtl: true });
    const sessionId = "session-expired";
    const holder = await fixture.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const reader = await fixture.openReader();
    for (let index = 0; index < 3; index += 1) {
      await reader.request({
        operation: "ask",
        target: targetOf(sessionId),
        payload: { question: `vieja ${index}`, deadlineMs: 3_600_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
    }
    const page = await reader.request({
      operation: "history",
      target: targetOf(sessionId),
      payload: { fromEventSeq: 1, limit: 1 },
    });
    const nextCursor = (page["result"] as Record<string, unknown>)["nextCursor"];

    // El reloj avanza MÁS allá de la retención de eventos (7 d).
    isolation.clock.advance(LIMITS.eventRetentionMs + 60_000);

    // Reanudar por debajo del journal retenido es un hueco: nunca página vacía.
    const resume = await reader.request({
      operation: "history",
      target: targetOf(sessionId),
      payload: { fromEventSeq: 2, limit: 50 },
    });
    expectResponseError(resume, "CURSOR_EXPIRED", "cursor_expired");
    const resubscribe = await reader.request({
      operation: "subscribe",
      target: targetOf(sessionId),
      payload: { topics: ["broker.ask"], fromEventSeq: 2 },
    });
    expectResponseError(resubscribe, "CURSOR_EXPIRED", "cursor_expired");

    // El snapshot explícito no falla, pero DECLARA el hueco (no lo esconde).
    const snapshot = await reader.request({
      operation: "history",
      target: targetOf(sessionId),
      payload: { fromEventSeq: 1, limit: 50 },
    });
    expect(snapshot["state"]).toBe("completed");
    const result = snapshot["result"] as Record<string, unknown>;
    expect(result["gap"]).toBe(true);

    // Un cursor emitido antes de la ventana también exige resync explícito.
    if (typeof nextCursor === "string") {
      const stale = await reader.request({
        operation: "history",
        target: targetOf(sessionId),
        payload: { cursor: nextCursor },
      });
      expectResponseError(stale, "CURSOR_EXPIRED", "cursor_expired");
    }
    await closePeers([reader, holder]);
  });

  test("la CLI no oculta el hueco: exit CURSOR_EXPIRED y gap declarado", async () => {
    // La CLI usa la identidad del checkout: los grants se provisionan contra
    // el projectId REAL que devuelve `init` (jamás se infiere).
    const checkout = join(isolation.tmpDir, "checkout-cli");
    mkdirSync(checkout, { recursive: true });
    const initRun = await captureCli(["init", "--root", checkout, "--json"]);
    expect(initRun.code).toBe(0);
    const initOutput = jsonOutput(initRun);
    const cliProjectId = String(initOutput["projectId"]);
    const cliWorkspaceId = String(initOutput["workspaceId"]);

    const dataDir = join(isolation.tmpDir, "data-cli");
    mkdirSync(dataDir, { recursive: true });
    const grant = testGrant({
      projectId: cliProjectId,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
      issuedAtMs: isolation.clock.nowMs - 60_000,
      expiresAtMs: isolation.clock.nowMs + LONG_TTL_MS,
    });
    writeGrants(dataDir, [{ credential: CREDENTIAL, grant }]);
    const broker = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => broker.close());
    writeUserConfigFile(join(isolation.tmpDir, "config"), {
      endpoint: broker.url,
      grantId: String(grant["grantId"]),
      credential: CREDENTIAL,
      allowInsecureWs: true,
    });

    const sessionId = "session-cli";
    const holder = await openPeer({
      url: broker.url,
      projectId: cliProjectId,
      workspaceId: cliWorkspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId: String(grant["grantId"]),
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const mark = holder.mark();
    await holder.request({
      operation: "ask",
      target: { target: "omp", session: sessionRefFor({ projectId: cliProjectId, workspaceId: cliWorkspaceId }, { nativeSessionId: sessionId }) },
      payload: { question: "para la CLI", deadlineMs: 3_600_000, policy: "when_idle" },
      requestId: newRequestId(),
    });
    await holder.nextFrame(mark, "entrega del ask");
    isolation.clock.advance(LIMITS.eventRetentionMs + 60_000);

    const gapRun = await captureCli([
      "sessions",
      "history",
      "--root",
      checkout,
      "--target",
      "omp",
      "--session",
      sessionId,
      "--from-seq",
      "2",
      "--json",
    ]);
    expect(gapRun.code).toBe(EXIT_CODES.CURSOR_EXPIRED);
    expect(gapRun.stdout.includes("CURSOR_EXPIRED") || gapRun.stderr.includes("CURSOR_EXPIRED")).toBe(true);

    const snapshotRun = await captureCli([
      "sessions",
      "history",
      "--root",
      checkout,
      "--target",
      "omp",
      "--session",
      sessionId,
      "--from-seq",
      "1",
      "--json",
    ]);
    expect(snapshotRun.code).toBe(EXIT_CODES.OK);
    const snapshotOutput = jsonOutput(snapshotRun);
    const result = snapshotOutput["result"] as Record<string, unknown>;
    expect(result["gap"]).toBe(true);
    await closePeers([holder]);
  });
});

describe("límites, backpressure y frames extremos (contadores acotados)", () => {
  test("la cola de asks por sesión se acota con QUEUE_FULL sin descartar durables", async () => {
    const fixture = await startFixture("limits-asks");
    const sessionId = "session-limits";
    const holder = await fixture.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const reader = await fixture.openReader();
    expect(LIMITS.maxQueuedAsksPerSession).toBe(8);

    let accepted = 0;
    let rejected: string | undefined;
    for (let index = 0; index <= LIMITS.maxQueuedAsksPerSession; index += 1) {
      const response = await reader.request({
        operation: "ask",
        target: targetOf(sessionId),
        payload: { question: `cola ${index}`, deadlineMs: 300_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
      if (response["state"] === "queued") accepted += 1;
      else {
        const error = response["error"] as { code?: string; reason?: string } | undefined;
        rejected = `${String(error?.code)}/${String(error?.reason)}`;
      }
    }
    expect(accepted).toBe(LIMITS.maxQueuedAsksPerSession);
    expect(rejected).toBe("QUEUE_FULL/queue_full");
    // Los durables aceptados siguen ahí (nada se descarta en silencio).
    const inspected = await reader.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const summary = inspected["result"] as Record<string, unknown>;
    expect(Number(summary["queuedAsks"])).toBe(LIMITS.maxQueuedAsksPerSession);
    await closePeers([reader, holder]);
  });

  test("consumidor detenido: corte explícito QUEUE_FULL con cola acotada", async () => {
    const fixture = await startFixture("limits-slow");
    const sessionId = "session-slow";
    const holder = await fixture.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    // El titular se retira: las entregas quedan durables sin llenar sockets.
    holder.close();
    const producer = await fixture.openHolder(sessionId);

    // Producción durable ANTES del alta: el replay del journal desborda la
    // cola de la suscripción de forma determinista (contadores, no wall time).
    const bulk = "x".repeat(500_000);
    for (let index = 0; index < 10; index += 1) {
      await producer.request({
        operation: "notify",
        target: targetOf(sessionId),
        payload: { topic: "broker.notify", data: bulk },
        requestId: newRequestId(),
      });
    }

    const observer = await fixture.openReader();
    const subscribe = await observer.request({
      operation: "subscribe",
      target: targetOf(sessionId),
      payload: { topics: ["broker.notify"], fromEventSeq: 1 },
    });
    // El ack del alta llega; el corte se surfacea como error tipado.
    expect(subscribe["state"]).toBe("completed");
    const cut = await waitForValue(() => observer.errors[0], "corte por consumidor lento");
    expectError(cut, "QUEUE_FULL", "queue_full");
    expect(LIMITS.maxEventQueueBytesPerSubscription).toBe(4_194_304);
    // Sin descarte silencioso: la suscripción queda cortada y no "sigue".
    const deliveredAfterCut = observer.events.length;
    await sleep(50);
    expect(observer.events.length).toBe(deliveredAfterCut);
    await closePeers([observer, producer]);
  });

  test("frames extremos: rechazo explícito con los errores congelados", async () => {
    const fixture = await startFixture("limits-frames");
    const sessionId = "session-frames";
    const holder = await fixture.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const reader = await fixture.openReader();

    // Payload canónico por encima de maxPayloadBytes: el motivo CONGELADO es
    // `payload_too_large` (docs/contracts/limits.md). El caso se construye con
    // `notify` porque su campo `data` es opaco; un `question` gigante quedaría
    // antes por la regla esquemática congelada de `ask` (`invalid_field`).
    const huge = await reader.request({
      operation: "notify",
      target: targetOf(sessionId),
      payload: { topic: "bulk", data: "y".repeat(LIMITS.maxPayloadBytes + 1_000) },
      requestId: newRequestId(),
    });
    expect(huge["state"]).toBe("rejected");
    expectResponseError(huge, "INVALID_INPUT", "payload_too_large");

    // Frame por encima de maxFrameBytes: cierre acotado, sin reinterpretarse.
    const oversized = await fixture.openReader();
    oversized.sendRaw("z".repeat(LIMITS.maxFrameBytes + 4_096));
    const tooLarge = await waitForValue(() => oversized.errors[0], "frame demasiado grande");
    expectError(tooLarge, "INVALID_INPUT", "frame_too_large");
    await waitForValue(() => oversized.closeCode, "cierre acotado del peer con frame gigante");
    await closePeers([reader, holder, oversized]);
  });

  test("tormenta de reconexión: backoff+jitter acotados y conexiones sin fuga", async () => {
    // Límites del backoff: base exponencial acotada + jitter simétrico.
    for (let attempt = 0; attempt <= 30; attempt += 1) {
      const base = Math.min(LIMITS.reconnectBackoffMsInitial * 2 ** attempt, LIMITS.reconnectBackoffMsMax);
      for (const random of [0, 0.5, 1]) {
        const delay = reconnectDelayMs(attempt, random);
        const jitter = base * LIMITS.reconnectJitterRatio;
        expect(delay).toBeGreaterThanOrEqual(Math.max(0, Math.round(base - jitter)));
        expect(delay).toBeLessThanOrEqual(Math.round(base + jitter));
      }
    }
    expect(reconnectDelayMs(10_000, 0.5)).toBeLessThanOrEqual(
      Math.round(LIMITS.reconnectBackoffMsMax * (1 + LIMITS.reconnectJitterRatio)),
    );
    expect(reconnectDelayMs(-3, 0.5)).toBeGreaterThanOrEqual(0);

    // Tormenta real sobre el broker: contadores de conexiones acotados.
    const fixture = await startFixture("limits-storm");
    for (let round = 0; round < 8; round += 1) {
      const peer = await fixture.openReader();
      peer.close();
      await waitForValue(() => peer.closeCode, `cierre de la ronda ${round}`);
    }
    await waitForValue(
      () => (fixture.broker.server.activeConnections === 0 ? true : undefined),
      "conexiones del servidor drenadas tras la tormenta",
    );
    const health = await healthOf(fixture.broker.port);
    expect(health["ok"]).toBe(true);
  });
});
