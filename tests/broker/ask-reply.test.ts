/**
 * Criterios binarios: ask crea pregunta durable con entrega when_idle; notify
 * no es ask; reply exige replyTo + autoridad del destinatario (ni agent_end ni
 * siguiente texto completan); reply erróneo/tardío/ajeno no tiene efectos y el
 * reply válido completa el ask exacto.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
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
  grantId: `grt_${"f".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("ask-reply");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant }]);
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
  const welcome = expectWelcome(peer);
  const proof = makeRootProof({
    macKey: MAC_KEY,
    instanceId: peer.input.instanceId,
    nativeSessionId: peer.input.nativeSessionId ?? "",
    challenge: String(welcome["serverChallenge"] ?? ""),
    audience: String(welcome["connectionId"] ?? ""),
    nowMs: isolation.clock.nowMs,
  });
  const mark = peer.mark();
  peer.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof }, target: "omp" });
  const frame = await peer.nextFrame(mark, "registro raíz");
  expect(frame.kind).toBe("event");
}

function askOf(question: string): Record<string, unknown> {
  return { question, deadlineMs: 300_000, policy: "when_idle" };
}

describe("ask/reply correlacionados", () => {
  test("ask es durable when_idle y notify no se convierte en ask", async () => {
    const sessionId = `session-ask-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);
    const asker = await adapter(newInstanceId(), sessionId);

    const askId = newRequestId();
    const ask = await asker.request({ operation: "ask", target: targetOf(sessionId), payload: askOf("¿estado?"), requestId: askId });
    expect(ask["state"]).toBe("queued");
    const askResult = ask["result"] as Record<string, unknown>;
    expect(askResult["policy"]).toBe("when_idle");
    const delivery = holder.events.find((frame) => frame["topic"] === "broker.ask");
    const deliveryData = delivery?.["data"] as Record<string, unknown>;
    expect(deliveryData?.["requestId"]).toBe(askId);
    expect(deliveryData?.["policy"]).toBe("when_idle");

    const notify = await asker.request({
      operation: "notify",
      target: targetOf(sessionId),
      payload: { topic: "session.status", data: { state: "idle" } },
      requestId: newRequestId(),
    });
    expect(notify["state"]).toBe("queued");
    expect(holder.events.filter((frame) => frame["topic"] === "broker.notify").length).toBe(1);

    const inspect = await asker.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    // Un solo ask encolado: notify jamás crea preguntas.
    expect(detail["queuedAsks"]).toBe(1);

    asker.close();
    holder.close();
  });

  test("replyTo erróneo (a sí mismo / inexistente) no tiene efectos", async () => {
    const sessionId = `session-reply-bad-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);

    const selfId = newRequestId();
    const self = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: selfId, body: { answer: "x" } },
      requestId: selfId,
    });
    expectResponseError(self, "INVALID_INPUT", "reply_to_mismatch");

    const unknown = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: newRequestId(), body: { answer: "x" } },
    });
    expectResponseError(unknown, "NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope");
    holder.close();
  });

  test("reply ajeno y reply tardío no completan nada", async () => {
    const sessionId = `session-reply-late-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);
    const asker = await adapter(newInstanceId(), sessionId);
    const foreign = await adapter(newInstanceId(), `session-otra-${Date.now().toString(16)}`);
    await register(foreign);

    const askId = newRequestId();
    await asker.request({ operation: "ask", target: targetOf(sessionId), payload: askOf("¿cuánto falta?"), requestId: askId });

    // Autoridad ajena: otra sesión no puede entregar el reply.
    const fromForeign = await foreign.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askId, body: { answer: "suplantado" } },
    });
    expectResponseError(fromForeign, "UNAUTHORIZED", "unauthorized_scope");

    // Tardío: el plazo venció y el ask expira sin completarse.
    isolation.clock.advance(400_000);
    const late = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askId, body: { answer: "tarde" } },
    });
    expectResponseError(late, "EXPIRED", "deadline_out_of_bounds");

    const inspect = await asker.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    const requests = detail["requests"] as Record<string, unknown>[];
    const record = requests.find((entry) => entry["requestId"] === askId);
    expect(record?.["state"]).toBe("expired");

    asker.close();
    holder.close();
    foreign.close();
  });

  test("agent_end/siguiente texto no completan ask; solo el reply explícito completa el ask exacto", async () => {
    const sessionId = `session-reply-ok-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);
    const asker = await adapter(newInstanceId(), sessionId);

    const askA = newRequestId();
    const askB = newRequestId();
    await asker.request({ operation: "ask", target: targetOf(sessionId), payload: askOf("pregunta A"), requestId: askA });
    await asker.request({ operation: "ask", target: targetOf(sessionId), payload: askOf("pregunta B"), requestId: askB });

    // Fin de turno del agente (reporte genérico): NO completa el ask.
    const agentEnd = await holder.report(askA, "completed", { result: { text: "fin de turno" } });
    expect(agentEnd.kind).toBe("error");
    const agentEndError = agentEnd["error"] as { code?: string; reason?: string };
    expect(agentEndError.code).toBe("INVALID_INPUT");
    expect(agentEndError.reason).toBe("ask_requires_explicit_reply");

    // Reply válido con replyTo exacto: completa SOLO el ask A.
    const reply = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askA, body: { answer: "respuesta A" }, summary: "ok" },
    });
    expect(reply["state"]).toBe("completed");
    expect(reply["replyTo"]).toBe(askA);

    const inspect = await asker.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    const requests = detail["requests"] as Record<string, unknown>[];
    const recordA = requests.find((entry) => entry["requestId"] === askA);
    const recordB = requests.find((entry) => entry["requestId"] === askB);
    expect(recordA?.["state"]).toBe("completed");
    expect(recordB?.["state"]).toBe("queued");
    const completedResult = recordA?.["result"] as Record<string, unknown>;
    expect((completedResult?.["body"] as Record<string, unknown>)?.["answer"]).toBe("respuesta A");

    // Un segundo reply (otro requestId) sobre el ask ya completado: sin efectos.
    const duplicate = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askA, body: { answer: "segunda" } },
    });
    expect(duplicate["error"]).toBeDefined();

    asker.close();
    holder.close();
  });

  test("reply sobre un requestId que no es ask tampoco filtra existencia", async () => {
    const sessionId = `session-reply-nonask-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);

    const notifyId = newRequestId();
    await holder.request({
      operation: "notify",
      target: targetOf(sessionId),
      payload: { topic: "session.status", data: { ok: true } },
      requestId: notifyId,
    });
    const reply = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: notifyId, body: { answer: "x" } },
    });
    expectResponseError(reply, "NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope");
    holder.close();
  });
});
