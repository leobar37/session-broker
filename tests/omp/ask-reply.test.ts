/**
 * Criterios binarios (contratos 4-5, FR-006/FR-008): el ask broker se entrega
 * como prompt nativo `when_idle` (idle inicia turno; ocupado → `followUp` sin
 * interrumpir); `queued` durable ≠ `submitted` (solo tras la llamada nativa);
 * SOLO `session_reply` completa un ask (ni `agent_end` ni el siguiente texto);
 * duplicado/tardío/ajeno/instancia vieja se rechazan sin efectos.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { newInstanceId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createOmpAdapter, type OmpAdapter, type OmpToolResult } from "@session-broker/omp-adapter";
import {
  FakeOmpHost,
  assertModelUnused,
  freshIdentity,
  setupIsolation,
  sleep,
  startBroker,
  testGrant,
  waitForCondition,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";

let isolation: Isolation;
let broker: BrokerHandle;
let asker: BrokerClient;
const identity = freshIdentity();
const grantInput = testGrant({
  projectId: identity.projectId,
  capabilities: [
    "session.identity",
    "session.observe",
    "session.prompt.when_idle",
    "session.reply_tool",
    "session.notify",
    "root.binding",
  ],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grantInput["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("ask-reply");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
  asker = createClient({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await asker.connect();
});

afterAll(async () => {
  await asker.close();
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function targetOf(nativeSessionId: string): TargetRef {
  return {
    target: "omp",
    session: {
      projectId: identity.projectId,
      scope: "workspace",
      workspaceId: identity.workspaceId,
      target: "omp",
      nativeSessionId,
    },
  };
}

function makeAdapter(input: { nativeSessionId: string; instanceId?: string }): { adapter: OmpAdapter; host: FakeOmpHost } {
  const host = new FakeOmpHost({ sessionId: input.nativeSessionId, model: isolation.fakeModel });
  const adapter = createOmpAdapter({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: input.instanceId ?? identity.instanceId,
    nativeSessionId: input.nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    host,
    macKey: MAC_KEY,
    dataDir: isolation.userDataDir,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  return { adapter, host };
}

async function sendAsk(nativeSessionId: string, question: string, deadlineMs = 300_000): Promise<string> {
  const response = await asker.ask({ question, deadlineMs, policy: "when_idle" }, targetOf(nativeSessionId));
  if (response.error !== undefined) throw new Error(`ask rechazado: ${response.error.code}/${response.error.reason}`);
  // `queued` = commit durable del broker, NUNCA `submitted`.
  expect(response.state).toBe("queued");
  return response.requestId;
}

async function askState(nativeSessionId: string, requestId: string): Promise<string> {
  const response = await asker.inspect({}, targetOf(nativeSessionId));
  const detail = (response.result ?? {}) as { requests?: { requestId: string; state: string }[] };
  const record = (detail.requests ?? []).find((candidate) => candidate.requestId === requestId);
  return record?.state ?? "absent";
}

function toolError(result: OmpToolResult): { code?: string; reason?: string } {
  expect(result.isError).toBe(true);
  const details = result.details as { error?: { code?: string; reason?: string } };
  return details.error ?? {};
}

test("ask when_idle en sesión idle inicia turno nativo y pasa de queued a submitted", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-ask-idle" });
  await adapter.start();
  const requestId = await sendAsk("session-ask-idle", "¿cuál es el estado?");
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");
  // Mapping when_idle verificado: idle → sendUserMessage(pregunta) sin deliverAs.
  expect(host.sendUserMessageCalls[0]?.content).toBe("¿cuál es el estado?");
  expect(host.sendUserMessageCalls[0]?.options).toBeUndefined();
  await waitForCondition(async () => (await askState("session-ask-idle", requestId)) === "submitted", "ask reportado como submitted");
  // Queued ≠ submitted: el recibo local también refleja la entrega efectiva.
  const pending = adapter.pendingAsks();
  expect(pending.map((ask) => ask.requestId)).toContain(requestId);
  expect(pending.find((ask) => ask.requestId === requestId)?.state).toBe("submitted");
  await adapter.stop();
});

test("ask when_idle con agente ocupado usa followUp sin interrumpir", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-ask-busy" });
  await adapter.start();
  host.setStreaming(true);
  const requestId = await sendAsk("session-ask-busy", "pregunta en turno ocupado");
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask (busy)");
  // Ocupado → deliverAs followUp (cola nativa): jamás steer/interrupción.
  expect(host.sendUserMessageCalls[0]?.options).toEqual({ deliverAs: "followUp" });
  // El turno ocupado sigue ocupado: la entrega no interrumpe ni cae a fallback.
  expect(host.streaming).toBe(true);
  expect(await askState("session-ask-busy", requestId)).toBe("submitted");
  await adapter.stop();
});

test("solo session_reply completa un ask: agent_end y el siguiente texto no", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-ask-reply" });
  await adapter.start();
  const requestId = await sendAsk("session-ask-reply", "responde con session_reply");
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");

  // Fin de turno y siguiente texto del modelo: CERO transiciones de estado.
  host.emit("agent_end", { reason: "done" });
  host.emit("message_end", { role: "assistant", text: "fin de turno sin responder" });
  host.emit("turn_end", {});
  await sleep(100);
  expect(await askState("session-ask-reply", requestId)).toBe("submitted");
  expect(adapter.pendingAsks().map((ask) => ask.requestId)).toContain(requestId);

  // Única vía de completar: la herramienta explícita con replyTo exacto.
  const reply = (await host.callTool("session_reply", {
    replyTo: requestId,
    body: { answer: 42 },
    summary: "respuesta 42",
  })) as OmpToolResult;
  expect(reply.isError).toBeUndefined();
  const details = reply.details as { ok: boolean; askState: string };
  expect(details.ok).toBe(true);
  expect(details.askState).toBe("completed");
  await waitForCondition(async () => (await askState("session-ask-reply", requestId)) === "completed", "ask completado por reply explícito");
  expect(adapter.pendingAsks()).toEqual([]);
  // La herramienta NO dispara inferencia por sí misma.
  expect(host.sendUserMessageCalls.length).toBe(1);
  await adapter.stop();
});

test("reply duplicado se rechaza sin efectos", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-ask-dup" });
  await adapter.start();
  const requestId = await sendAsk("session-ask-dup", "una sola respuesta");
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");
  const first = (await host.callTool("session_reply", { replyTo: requestId, body: { n: 1 } })) as OmpToolResult;
  expect(first.isError).toBeUndefined();
  // Duplicado: mismo replyTo ya resuelto → sin segundo envío ni transición.
  const second = (await host.callTool("session_reply", { replyTo: requestId, body: { n: 2 } })) as OmpToolResult;
  const error = toolError(second);
  expect(error.code).toBe("INVALID_INPUT");
  expect(error.reason).toBe("terminal_state");
  const response = await asker.inspect({}, targetOf("session-ask-dup"));
  const detail = (response.result ?? {}) as { requests?: { operation: string }[] };
  expect((detail.requests ?? []).filter((record) => record.operation === "reply").length).toBe(1);
  expect(await askState("session-ask-dup", requestId)).toBe("completed");
  await adapter.stop();
});

test("reply tardío se rechaza sin efectos", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-ask-late" });
  await adapter.start();
  const requestId = await sendAsk("session-ask-late", "plazo corto", 1_000);
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");
  isolation.clock.advance(60_000);
  const late = (await host.callTool("session_reply", { replyTo: requestId, body: { n: 1 } })) as OmpToolResult;
  const error = toolError(late);
  expect(error.code).toBe("EXPIRED");
  expect(error.reason).toBe("deadline_out_of_bounds");
  // Sin efectos: ni reply enviado ni completado inventado.
  const response = await asker.inspect({}, targetOf("session-ask-late"));
  const detail = (response.result ?? {}) as { requests?: { operation: string; state: string }[] };
  const askRecord = (detail.requests ?? []).find((record) => record.operation === "ask");
  expect(askRecord?.state === "completed").toBe(false);
  expect((detail.requests ?? []).filter((record) => record.operation === "reply").length).toBe(0);
  await adapter.stop();
});

test("reply ajeno (otra sesión o desconocido) se rechaza sin efectos", async () => {
  const victim = makeAdapter({ nativeSessionId: "session-ask-foreign" });
  const intruder = makeAdapter({ nativeSessionId: "session-ask-intruder" });
  await victim.adapter.start();
  await intruder.adapter.start();
  // Ask legítimo para OTRA sesión: el intruso no tiene ese ask en su ámbito.
  const foreignRequestId = await sendAsk("session-ask-foreign", "para la otra sesión");
  await waitForValue(() => (victim.host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa al dueño");

  const foreign = (await intruder.host.callTool("session_reply", { replyTo: foreignRequestId, body: {} })) as OmpToolResult;
  const foreignError = toolError(foreign);
  expect(foreignError.code).toBe("NOT_FOUND_OR_FORBIDDEN");
  expect(foreignError.reason).toBe("unauthorized_scope");

  const unknown = (await intruder.host.callTool("session_reply", { replyTo: `req_${"c".repeat(32)}`, body: {} })) as OmpToolResult;
  const unknownError = toolError(unknown);
  expect(unknownError.code).toBe("NOT_FOUND_OR_FORBIDDEN");

  // Sin efectos: el ask sigue abierto en su sesión y no hubo prompts extra.
  expect(await askState("session-ask-foreign", foreignRequestId)).toBe("submitted");
  expect(victim.host.sendUserMessageCalls.length).toBe(1);
  expect(intruder.host.sendUserMessageCalls.length).toBe(0);
  await victim.adapter.stop();
  await intruder.adapter.stop();
});

test("instancia vieja no recibe entregas nuevas ni completa asks con reply", async () => {
  const oldOwner = makeAdapter({ nativeSessionId: "session-ask-takeover", instanceId: newInstanceId() });
  await oldOwner.adapter.start();
  const requestId = await sendAsk("session-ask-takeover", "pregunta al dueño original");
  await waitForValue(() => (oldOwner.host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa al dueño original");

  // Proceso nuevo sobre la misma sesión: takeover (owner/epoch sin heredar).
  const newOwner = makeAdapter({ nativeSessionId: "session-ask-takeover", instanceId: newInstanceId() });
  await newOwner.adapter.start();

  // La instancia vieja no recibe el evento nuevo; el nuevo dueño sí.
  const secondRequestId = await sendAsk("session-ask-takeover", "pregunta al nuevo dueño");
  await waitForValue(() => (newOwner.host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa al nuevo dueño");
  expect(oldOwner.host.sendUserMessageCalls.length).toBe(1);

  // El reply de la instancia vieja no tiene efectos (stale_instance).
  const stale = (await oldOwner.host.callTool("session_reply", { replyTo: requestId, body: { n: 1 } })) as OmpToolResult;
  const staleError = toolError(stale);
  expect(["STALE_INSTANCE", "OUTCOME_UNKNOWN"]).toContain(staleError.code ?? "(sin code)");
  expect(await askState("session-ask-takeover", requestId)).not.toBe("completed");

  // El nuevo dueño tampoco responde asks que no recibió (ajeno).
  const foreign = (await newOwner.host.callTool("session_reply", { replyTo: requestId, body: { n: 2 } })) as OmpToolResult;
  expect(toolError(foreign).code).toBe("NOT_FOUND_OR_FORBIDDEN");
  expect(await askState("session-ask-takeover", secondRequestId)).toBe("submitted");

  await oldOwner.adapter.stop();
  await newOwner.adapter.stop();
});
