/**
 * Criterios binarios: list/inspect/history/query/subscribe no incrementan
 * inferencia ni envíos (fake model intacto); presencia, estado de entrega y
 * job status nativo son dimensiones separadas; desconexión solo cambia
 * presencia; cursores inválidos/expirados se resuelven con CURSOR_EXPIRED.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LIMITS, newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  expectResponseError,
  expectWelcome,
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
  type Isolation,
} from "./helpers";

let isolation: Isolation;
let broker: BrokerHandle;

const identity = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const grant = testGrant({
  grantId: `grt_${"e".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grant["grantId"]);
const sessionId = `session-reads-${Date.now().toString(16)}`;

beforeAll(async () => {
  isolation = setupIsolation("reads");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function targetOf(nativeSessionId: string = sessionId): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId }) };
}

async function registerHolder(nativeSessionId: string = sessionId): Promise<FakePeer> {
  const holder = await openPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    capabilities: ALL_ADAPTER_CAPABILITIES,
  });
  const welcome = expectWelcome(holder);
  const proof = makeRootProof({
    macKey: MAC_KEY,
    instanceId: holder.input.instanceId,
    nativeSessionId,
    challenge: String(welcome["serverChallenge"] ?? ""),
    audience: String(welcome["connectionId"] ?? ""),
    nowMs: isolation.clock.nowMs,
  });
  const mark = holder.mark();
  holder.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof }, target: "omp" });
  await holder.nextFrame(mark, "registro raíz");
  return holder;
}

describe("lecturas sin inferencia y dimensiones separadas", () => {
  test("lecturas no invocan el modelo ni generan entregas", async () => {
    const holder = await registerHolder();
    const reader = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe"],
    });

    const holderFramesBefore = holder.frames.length;
    const list = await reader.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expect(list["state"]).toBe("completed");
    const items = (list["result"] as Record<string, unknown>)["items"] as Record<string, unknown>[];
    expect(items.length).toBe(1);

    const inspect = await reader.request({ operation: "inspect", target: targetOf(), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    // Dimensiones separadas: presencia ≠ estado de entrega ≠ job nativo.
    expect(detail["presence"]).toBe("online");
    expect(detail["nativeJobStatus"]).toBe("unknown");
    expect(detail["controlEpoch"]).toBeGreaterThan(0);

    const query = await reader.request({ operation: "query", target: { target: "omp" }, payload: { query: "no-existe" } });
    expect(query["state"]).toBe("completed");

    const history = await reader.request({ operation: "history", target: targetOf(), payload: {} });
    expect(history["state"]).toBe("completed");
    const historyItems = (history["result"] as Record<string, unknown>)["items"] as unknown[];
    expect(historyItems.length).toBeGreaterThan(0);

    const subscribe = await reader.request({
      operation: "subscribe",
      target: targetOf(),
      payload: { topics: ["broker.state"] },
    });
    expect(subscribe["state"]).toBe("completed");
    const subscription = subscribe["result"] as Record<string, unknown>;
    expect(subscription["subscriptionId"]).toBeDefined();

    // Las lecturas no generan entregas al titular.
    expect(holder.frames.length).toBe(holderFramesBefore);
    expect(isolation.fakeModel.calls).toEqual([]);
    reader.close();
    holder.close();
  });

  test("desconexión cambia presencia sin completar/cancelar requests ni jobs", async () => {
    const holder = await registerHolder();
    const reader = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });
    const askId = newRequestId();
    const ask = await reader.request({
      operation: "ask",
      target: targetOf(),
      payload: { question: "¿sigues ahí?", deadlineMs: 300_000, policy: "when_idle" },
      requestId: askId,
    });
    expect(ask["state"]).toBe("queued");

    holder.close();
    // La presencia baja; el pedido sigue en cola y el job nativo sigue siendo
    // desconocido (jamás se deduce completado/cancelado por desconexión).
    let detail: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50 && detail === undefined; attempt += 1) {
      const inspect = await reader.request({ operation: "inspect", target: targetOf(), payload: {} });
      const candidate = inspect["result"] as Record<string, unknown>;
      if (candidate["presence"] === "offline") detail = candidate;
    }
    expect(detail).toBeDefined();
    const requests = detail?.["requests"] as Record<string, unknown>[];
    const pending = requests.find((record) => record["requestId"] === askId);
    expect(pending?.["state"]).toBe("queued");
    expect(detail?.["nativeJobStatus"]).toBe("unknown");
    reader.close();
  });

  test("subscribe recibe eventos vivos y su ack llega antes que los eventos", async () => {
    // Stream limpio (sesión propia): el evento vivo es inequívoco y el
    // requestId del evento debe ser el del ask que lo originó.
    const liveSession = `session-subscribe-${Date.now().toString(16)}`;
    const holder = await registerHolder(liveSession);
    const observer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });
    const asker = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });

    const subscribe = await observer.request({
      operation: "subscribe",
      target: targetOf(liveSession),
      payload: { topics: ["broker.ask"], fromEventSeq: 1 },
    });
    expect(subscribe["state"]).toBe("completed");
    const ackIndex = observer.frames.indexOf(subscribe);

    const askId = newRequestId();
    await asker.request({
      operation: "ask",
      target: targetOf(liveSession),
      payload: { question: "evento vivo", deadlineMs: 300_000, policy: "when_idle" },
      requestId: askId,
    });
    const live = await waitForValue(
      () => observer.events.find((frame) => frame["topic"] === "broker.ask" && frame["eventId"] !== undefined),
      "evento vivo de suscripción",
    );
    expect(observer.frames.indexOf(live)).toBeGreaterThan(ackIndex);
    const data = live["data"] as Record<string, unknown>;
    expect(data["requestId"]).toBe(askId);

    observer.close();
    asker.close();
    holder.close();
  });
});

describe("cursores acotados", () => {
  test("paginación por cursor y rechazo explícito de cursor inválido/ajeno/expirado", async () => {
    const holder = await registerHolder();
    const reader = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });

    // Genera algunos eventos durables en el stream de la sesión.
    for (let i = 0; i < 3; i += 1) {
      await reader.request({
        operation: "ask",
        target: targetOf(),
        payload: { question: `pregunta ${i}`, deadlineMs: 300_000, policy: "when_idle" },
        requestId: newRequestId(),
      });
    }

    const page1 = await reader.request({ operation: "history", target: targetOf(), payload: { limit: 1 } });
    const result1 = page1["result"] as Record<string, unknown>;
    expect((result1["items"] as unknown[]).length).toBe(1);
    const nextCursor = result1["nextCursor"];
    expect(typeof nextCursor).toBe("string");

    const page2 = await reader.request({ operation: "history", target: targetOf(), payload: { cursor: String(nextCursor) } });
    expect(page2["state"]).toBe("completed");
    const result2 = page2["result"] as Record<string, unknown>;
    const first2 = (result2["items"] as Record<string, unknown>[])[0];
    expect(first2).toBeDefined();
    const first1 = (result1["items"] as Record<string, unknown>[])[0];
    expect(first2?.["eventSeq"]).toBeGreaterThan(Number(first1?.["eventSeq"] ?? 0));

    // Cursor ilegible: exige snapshot explícito (CURSOR_EXPIRED).
    const garbage = await reader.request({ operation: "history", target: targetOf(), payload: { cursor: "cur_nope" } });
    expectResponseError(garbage, "CURSOR_EXPIRED", "cursor_expired");

    // Cursor sintácticamente válido pero de OTRO ámbito: jamás se reutiliza.
    const foreign = await reader.request({
      operation: "history",
      target: targetOf(),
      payload: { cursor: encodeForeignCursor() },
    });
    expectResponseError(foreign, "CURSOR_EXPIRED", "cursor_expired");

    // Cursor vencido por TTL: resync explícito.
    isolation.clock.advance(LIMITS.cursorTtlMs + 1_000);
    const expired = await reader.request({ operation: "history", target: targetOf(), payload: { cursor: String(nextCursor) } });
    expectResponseError(expired, "CURSOR_EXPIRED", "cursor_expired");

    reader.close();
    holder.close();
  });
});

/** Cursor legítimo de OTRO stream (otro proyecto/target/sesión). */
function encodeForeignCursor(): string {
  const payload = `history|prj_${"f".repeat(32)}|omp|otra-sesion|1|${isolation.clock.nowMs}`;
  return `cur_${Buffer.from(payload, "utf8").toString("base64url")}`;
}
