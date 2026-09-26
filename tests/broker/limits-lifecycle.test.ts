/**
 * Criterios binarios: límites y cuotas acotados (RATE_LIMITED, QUEUE_FULL sin
 * descartar durables), consumidor lento cortado con error tipado, health sin
 * secretos ni inferencia, y shutdown ordenado que no completa requests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LIMITS, newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  expectError,
  expectResponseError,
  freshIdentity,
  makeRootProof,
  openPeer,
  sessionRefFor,
  setupIsolation,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type FakePeer,
  type Frame,
  type Isolation,
} from "./helpers";

let isolation: Isolation;
let broker: BrokerHandle;

const identity = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const CREDENTIAL_RATE = "fixture-credential-rate-limited";
const grant = testGrant({
  grantId: `grt_${"9".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const rateGrant = testGrant({
  grantId: `grt_${"8".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: ["session.identity", "session.observe"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grant["grantId"]);
const rateGrantId = String(rateGrant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("limits-lifecycle");
  writeGrants(isolation.dataDir, [
    { credential: CREDENTIAL, grant },
    { credential: CREDENTIAL_RATE, grant: rateGrant },
  ]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

async function adapter(instanceId: string, nativeSessionId: string): Promise<FakePeer> {
  return await openPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId,
    nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    capabilities: ALL_ADAPTER_CAPABILITIES,
  });
}

async function register(peer: FakePeer): Promise<void> {
  const proof = makeRootProof({
    macKey: MAC_KEY,
    instanceId: peer.input.instanceId,
    nativeSessionId: peer.input.nativeSessionId ?? "",
    challenge: String(peer.welcome?.["serverChallenge"] ?? ""),
    audience: String(peer.welcome?.["connectionId"] ?? ""),
    nowMs: isolation.clock.nowMs,
  });
  const mark = peer.mark();
  peer.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof }, target: "omp" });
  const frame = await peer.nextFrame(mark, "registro raíz");
  expect(frame.kind).toBe("event");
}

describe("cuotas, backpressure y health", () => {
  test("la cuota de tasa por grant se acota con RATE_LIMITED", async () => {
    const ratePeer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: rateGrantId,
      credential: CREDENTIAL_RATE,
      capabilities: ["session.identity", "session.observe"],
    });
    let limited: Frame | undefined;
    for (let i = 0; i <= LIMITS.maxRequestsPerMinutePerGrant; i += 1) {
      const response = await ratePeer.request({
        operation: "list",
        target: { target: "omp" },
        payload: {},
        requestId: newRequestId(),
      });
      if (response["error"] !== undefined) {
        limited = response;
        break;
      }
    }
    expect(limited).toBeDefined();
    if (limited !== undefined) {
      expectResponseError(limited, "RATE_LIMITED", "rate_limited");
    }
    ratePeer.close();
  });

  test("la cola de asks por sesión se acota con QUEUE_FULL sin descartar durables", async () => {
    const sessionId = `session-queue-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);
    const asker = await adapter(newInstanceId(), sessionId);

    for (let i = 0; i < LIMITS.maxQueuedAsksPerSession; i += 1) {
      const queued = await asker.request({
        operation: "ask",
        target: targetOf(sessionId),
        payload: { question: `pregunta ${i}`, deadlineMs: 300_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
      expect(queued["state"]).toBe("queued");
    }
    const overflow = await asker.request({
      operation: "ask",
      target: targetOf(sessionId),
      payload: { question: "una de más", deadlineMs: 300_000, policy: "when_idle" },
      requestId: newRequestId(),
    });
    expectResponseError(overflow, "QUEUE_FULL", "queue_full");

    // Nada se descarta: siguen las 8 preguntas durables en cola.
    const inspect = await asker.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    expect(detail["queuedAsks"]).toBe(LIMITS.maxQueuedAsksPerSession);

    asker.close();
    holder.close();
  });

  test("consumidor lento: la suscripción se corta con QUEUE_FULL acotado", async () => {
    const sessionId = `session-slow-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);
    // El titular se retira: las entregas quedan durables sin llenar sockets.
    holder.close();

    const producer = await adapter(newInstanceId(), sessionId);
    const bulk = "x".repeat(500_000);
    for (let i = 0; i < 10; i += 1) {
      const queued = await producer.request({
        operation: "notify",
        target: targetOf(sessionId),
        payload: { topic: "bulk", data: bulk },
        requestId: newRequestId(),
      });
      expect(queued["state"]).toBe("queued");
    }

    const observer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe"],
    });
    const subscribe = await observer.request({
      operation: "subscribe",
      target: targetOf(sessionId),
      payload: { topics: ["broker.notify"], fromEventSeq: 1 },
    });
    // El ack del alta llega; el corte se surfacea como error tipado.
    expect(subscribe["state"]).toBe("completed");
    const cut = await waitForValue(() => observer.errors[0], "corte por consumidor lento");
    expectError(cut, "QUEUE_FULL", "queue_full");

    observer.close();
    producer.close();
  });

  test("health expone proceso/store/schema/peers sin secretos ni inferencia", async () => {
    const response = await fetch(`http://127.0.0.1:${broker.port}/health`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload["process"]).toBeDefined();
    expect(payload["store"]).toBeDefined();
    expect(payload["schema"]).toBeDefined();
    expect(payload["peers"]).toBeDefined();
    const serialized = JSON.stringify(payload);
    expect(serialized.includes(CREDENTIAL)).toBe(false);
    expect(serialized.includes(CREDENTIAL_RATE)).toBe(false);
    expect(serialized.includes(MAC_KEY)).toBe(false);
    expect(isolation.fakeModel.calls).toEqual([]);
  });

  test("shutdown ordenado cierra todo sin completar requests artificialmente", async () => {
    const dataDir = join(isolation.tmpDir, "shutdown-data");
    writeGrants(dataDir, [{ credential: CREDENTIAL, grant }]);
    const local = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    const sessionId = `session-shutdown-${Date.now().toString(16)}`;
    const peer = await openPeer({
      url: local.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    await register(peer);
    const askId = newRequestId();
    const queued = await peer.request({
      operation: "ask",
      target: targetOf(sessionId),
      payload: { question: "¿y ahora?", deadlineMs: 300_000, policy: "when_idle" },
      requestId: askId,
    });
    expect(queued["state"]).toBe("queued");
    peer.close();
    await local.close();
    expect(local.server.activeConnections).toBe(0);

    // El estado durable sigue ahí tras el shutdown: nada se completó solo.
    const reopened = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    const reader = await openPeer({
      url: reopened.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    await register(reader);
    const inspect = await reader.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    const requests = detail["requests"] as Record<string, unknown>[];
    const record = requests.find((entry) => entry["requestId"] === askId);
    expect(record?.["state"]).toBe("queued");
    reader.close();
    await reopened.close();
  });
});
