/**
 * Criterios binarios (contrato 6, FR-007): restart del broker no relanza OMP ni
 * replica herramientas; la ventana de crash conserva `outcome_unknown` sin
 * replay ciego; un reply sin ACK conocido jamás se reintenta; el teardown
 * desuscribe recursos sin destruir la TUI; los recibos viven en user data
 * (fuera de worktrees).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newInstanceId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createOmpAdapter, type OmpAdapter, type OmpToolResult } from "@session-broker/omp-adapter";
import {
  FakeOmpHost,
  assertModelUnused,
  freshIdentity,
  setupIsolation,
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
const identity = freshIdentity();
const grantInput = testGrant({
  projectId: identity.projectId,
  capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool", "session.notify", "root.binding"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grantInput["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("lifecycle");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
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

async function newClient(): Promise<BrokerClient> {
  const client = createClient({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await client.connect();
  return client;
}

async function askState(client: BrokerClient, nativeSessionId: string, requestId: string): Promise<string> {
  const response = await client.inspect({}, targetOf(nativeSessionId));
  const detail = (response.result ?? {}) as { requests?: { requestId: string; state: string }[] };
  return (detail.requests ?? []).find((candidate) => candidate.requestId === requestId)?.state ?? "absent";
}

/** Artefacto de crash: journal de recibos local dejado por un proceso caído. */
function writeCrashReceipts(input: {
  nativeSessionId: string;
  requestId: string;
  instanceId: string;
  state: "received" | "submitting" | "submitted";
  replyState?: "none" | "in_flight" | "done" | "failed";
  question: string;
}): void {
  const dir = join(isolation.userDataDir, "omp-adapter-receipts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `omp__${input.nativeSessionId}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        schemaVersion: 1,
        entries: [
          {
            requestId: input.requestId,
            kind: "ask",
            instanceId: input.instanceId,
            state: input.state,
            replyState: input.replyState ?? "none",
            question: input.question,
            deadlineAtMs: null,
            updatedAtMs: isolation.clock.nowMs,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

test("restart del broker no relanza OMP ni replica herramientas", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-restart" });
  await adapter.start();
  const before = await newClient();
  const firstResponse = await before.ask({ question: "pregunta uno", deadlineMs: 300_000, policy: "when_idle" }, targetOf("session-restart"));
  const firstRequestId = firstResponse.requestId;
  await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del primer ask");
  const reply = (await host.callTool("session_reply", { replyTo: firstRequestId, body: { n: 1 } })) as OmpToolResult;
  expect(reply.isError).toBeUndefined();
  await before.close();

  // Restart del broker sobre el mismo puerto y dataDir (almacenamiento durable).
  const port = broker.port;
  await broker.close();
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY, port });

  // Reconexión del mismo proceso (instanceId conservada) tras el restart.
  await adapter.stop();
  await adapter.start();
  expect(host.registerToolCalls).toBe(1);
  // El ask completado NO se re-entrega ni se re-ejecuta: sin duplicar inferencia.
  expect(host.sendUserMessageCalls.length).toBe(1);

  // Un ask nuevo se entrega exactamente una vez.
  const after = await newClient();
  const secondResponse = await after.ask({ question: "pregunta dos", deadlineMs: 300_000, policy: "when_idle" }, targetOf("session-restart"));
  await waitForValue(() => (host.sendUserMessageCalls.length === 2 ? true : undefined), "entrega nativa del segundo ask");
  expect(host.sendUserMessageCalls.length).toBe(2);
  await waitForCondition(async () => (await askState(after, "session-restart", secondResponse.requestId)) === "submitted", "segundo ask submitted");
  await after.close();
  await adapter.stop();
});

test("la ventana de crash conserva outcome_unknown sin replay ciego", async () => {
  const session = "session-crash-window";
  const first = makeAdapter({ nativeSessionId: session });
  await first.adapter.start();
  await first.adapter.stop();

  const client = await newClient();
  const response = await client.ask({ question: "pregunta con crash", deadlineMs: 300_000, policy: "when_idle" }, targetOf(session));
  const requestId = response.requestId;

  // El proceso quedó caído en `submitting` (llamada nativa de resultado incierto).
  writeCrashReceipts({
    nativeSessionId: session,
    requestId,
    instanceId: identity.instanceId,
    state: "submitting",
    question: "pregunta con crash",
  });

  // Reconexión del mismo proceso (instanceId conservada): conservación honesta.
  const second = makeAdapter({ nativeSessionId: session });
  await second.adapter.start();
  // Jamás repite la llamada nativa incierta ni inventa success/failure.
  expect(second.host.sendUserMessageCalls).toEqual([]);
  await waitForCondition(async () => (await askState(client, session, requestId)) === "outcome_unknown", "ask en outcome_unknown");

  // Un segundo arranque tampoco re-ejecuta nada.
  await second.adapter.stop();
  await second.adapter.start();
  expect(second.host.sendUserMessageCalls).toEqual([]);
  expect(await askState(client, session, requestId)).toBe("outcome_unknown");
  assertModelUnused(isolation.fakeModel);
  await client.close();
  await second.adapter.stop();
});

test("un reply sin ACK conocido jamás se reintenta ni duplica efectos", async () => {
  const session = "session-ack-lost";
  const first = makeAdapter({ nativeSessionId: session });
  await first.adapter.start();
  await first.adapter.stop();

  const client = await newClient();
  const response = await client.ask({ question: "pregunta sin ack", deadlineMs: 300_000, policy: "when_idle" }, targetOf(session));
  const requestId = response.requestId;

  // El proceso murió con el reply en vuelo: resultado del envío desconocido.
  writeCrashReceipts({
    nativeSessionId: session,
    requestId,
    instanceId: identity.instanceId,
    state: "submitted",
    replyState: "in_flight",
    question: "pregunta sin ack",
  });

  const second = makeAdapter({ nativeSessionId: session });
  await second.adapter.start();
  // Ask ya entregado: no se re-entrega ni se re-ejecuta.
  expect(second.host.sendUserMessageCalls).toEqual([]);
  // El reply en vuelo bloquea cualquier reintento ciego (duplicado).
  const replay = (await second.host.callTool("session_reply", { replyTo: requestId, body: { n: 2 } })) as OmpToolResult;
  expect(replay.isError).toBe(true);
  const details = replay.details as { error?: { code?: string; reason?: string } };
  expect(details.error?.reason).toBe("terminal_state");
  // Ni un solo request `reply` salió del adaptador en recuperación.
  const detail = await client.inspect({}, targetOf(session));
  const records = ((detail.result ?? {}) as { requests?: { operation: string }[] }).requests ?? [];
  expect(records.filter((record) => record.operation === "reply").length).toBe(0);
  expect(second.host.sendUserMessageCalls).toEqual([]);
  await client.close();
  await second.adapter.stop();
});

test("el teardown desuscribe recursos sin destruir la TUI y los recibos viven en user data", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-cleanup" });
  await adapter.start();
  await adapter.stop();
  // Hooks desuscritos: los eventos nativos ya no se observan tras stop().
  const observed = adapter.snapshot().events.length;
  host.emit("agent_end", {});
  host.emit("message_end", {});
  expect(adapter.snapshot().events.length).toBe(observed);
  expect(adapter.snapshot().bound).toBe(false);
  // Conexiones cerradas en el broker.
  await waitForCondition(() => broker.server.activeConnections === 0, "conexiones del broker liberadas");
  // Re-arranque: la herramienta jamás se replica.
  await adapter.start();
  expect(host.registerToolCalls).toBe(1);
  await adapter.stop();
  // La TUI sigue viva: el usuario teclea sin que el adaptador interfiera.
  host.typeLocal("la TUI sigue viva");
  expect(host.inputBuffer).toEqual(["la TUI sigue viva"]);
  // Recibos en user data (TMP del harness), fuera de worktrees.
  const receiptsFile = join(isolation.userDataDir, "omp-adapter-receipts", "omp__session-restart.json");
  expect(existsSync(receiptsFile)).toBe(true);
  expect(receiptsFile.startsWith(isolation.tmpDir)).toBe(true);
});
