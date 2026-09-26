/**
 * Criterios binarios (contrato 3, FR-005/FR-008): lecturas de identidad,
 * estado, historial y eventos vía hooks/API nativa sin inferencia; `subscribe`
 * no inicia turnos; la TUI nativa (input local, timeline, historial) queda
 * intacta bajo harness; el fake model jamás se invoca.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { newInstanceId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient, type Subscription } from "@session-broker/client";
import { createOmpAdapter, type OmpAdapter, type OmpToolResult } from "@session-broker/omp-adapter";
import {
  FakeOmpHost,
  assertModelUnused,
  freshIdentity,
  setupIsolation,
  sleep,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";

let isolation: Isolation;
let broker: BrokerHandle;
let reader: BrokerClient;
const identity = freshIdentity();
const grantInput = testGrant({
  projectId: identity.projectId,
  capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool", "session.notify", "root.binding"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grantInput["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("reads-observation");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
  reader = createClient({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await reader.connect();
});

afterAll(async () => {
  await reader.close();
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

function makeAdapter(input: { nativeSessionId: string }): { adapter: OmpAdapter; host: FakeOmpHost } {
  const host = new FakeOmpHost({ sessionId: input.nativeSessionId, model: isolation.fakeModel });
  const adapter = createOmpAdapter({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: identity.instanceId,
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

test("snapshot e hooks leen identidad/estado/eventos sin inferencia", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-reads" });
  await adapter.start();
  // Eventos nativos observados por hooks: cero llamadas al modelo y cero prompts.
  host.emit("message_end", { role: "assistant", text: "texto del modelo" });
  host.emit("agent_end", {});
  host.emit("turn_end", {});
  const snapshot = adapter.snapshot();
  expect(snapshot.sessionId).toBe("session-reads");
  expect(snapshot.sessionFile).toContain("session-reads");
  expect(snapshot.bound).toBe(true);
  expect(snapshot.runState).toBe("idle");
  expect(snapshot.events.map((entry) => entry.event)).toEqual(["message_end", "agent_end", "turn_end"]);
  // Lectura sin inferencia: ni modelo, ni prompt nativo, ni nueva sesión.
  assertModelUnused(isolation.fakeModel);
  expect(host.sendUserMessageCalls).toEqual([]);
  expect(host.registerToolCalls).toBe(1);
  await adapter.stop();
});

test("lecturas y subscribe del broker no inician turnos ni tocan el runtime", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-subscribe" });
  await adapter.start();
  const ops = await adapter.openBroker();
  const received: string[] = [];
  const subscription: Subscription = ops.subscribe(
    { topics: ["broker.state", "broker.presence", "broker.ask", "broker.notify", "broker.control"] },
    targetOf("session-subscribe"),
    (event) => {
      received.push(event.topic);
    },
  );
  const ack = await subscription.ack;
  expect(ack.result !== undefined).toBe(true);
  // Lecturas: query/list/inspect/history vía cliente público, sin inferencia.
  const query = await ops.query({ query: "session-subscribe" }, { target: "omp" });
  expect(query.error).toBeUndefined();
  const list = await ops.list({}, { target: "omp" });
  expect(list.error).toBeUndefined();
  const inspect = await ops.inspect({}, targetOf("session-subscribe"));
  expect(inspect.error).toBeUndefined();
  const history = await ops.history({}, targetOf("session-subscribe"));
  expect(history.error).toBeUndefined();
  // El journal fluye a la suscripción cuando el propio titular declara runState.
  host.setStreaming(true);
  await waitForValue(() => (received.length > 0 ? true : undefined), "eventos de journal en la suscripción");
  subscription.close();
  await sleep(50);
  // Suscribir/leer NO inicia turnos ni toca la TUI.
  expect(host.sendUserMessageCalls).toEqual([]);
  expect(host.inputBuffer).toEqual([]);
  assertModelUnused(isolation.fakeModel);
  await adapter.stop();
});

test("la TUI nativa conserva input local, timeline e historial bajo el flujo ask/reply", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-tui" });
  await adapter.start();
  host.typeLocal("entrada local previa");
  host.appendHistory("historial previo del usuario");
  const response = await reader.ask({ question: "pregunta del broker", deadlineMs: 300_000, policy: "when_idle" }, targetOf("session-tui"));
  const requestId = response.requestId;
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");
  const reply = (await host.callTool("session_reply", { replyTo: requestId, body: { ok: true } })) as OmpToolResult;
  expect(reply.isError).toBeUndefined();
  // El usuario sigue tecleando durante el flujo: su input jamás se toca.
  host.typeLocal("entrada local posterior");
  // Input local intacto (solo lo escrito por el usuario).
  expect(host.inputBuffer).toEqual(["entrada local previa", "entrada local posterior"]);
  // Historial nativo intacto (solo lo añadido por el propio host).
  expect(host.history).toEqual(["historial previo del usuario"]);
  // Timeline: solo eventos locales y el prompt nativo legítimo; jamás eventos
  // falsos de modelo fabricados por el adaptador.
  for (const entry of host.timeline) {
    expect(["local_input", "user_message"]).toContain(entry.kind);
  }
  expect(host.timeline.filter((entry) => entry.kind === "user_message").length).toBe(1);
  // Sin inferencia: el fake model jamás se invocó.
  assertModelUnused(isolation.fakeModel);
  await adapter.stop();
});
