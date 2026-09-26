/**
 * Recuperación del adaptador OMP: recibos/lifecycle SIN relaunch (FR-007/FR-008).
 *
 * Invariantes verificadas:
 *   - el journal de recibos es la verdad durable: `submitting` (ventana de
 *     crash) => `outcome_unknown` y JAMÁS una segunda llamada nativa;
 *   - `received` sin `submitting` => la entrega se reanuda UNA sola vez;
 *   - reinicio del broker no relanza OMP, no replica la herramienta
 *     `session_reply` y no reejecuta tools;
 *   - sin confirmación del journal incoming no hay llamada nativa;
 *   - la instancia vieja que vuelve tarde no relanza nada y su reply se
 *     rechaza por fencing (`STALE_INSTANCE`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newInstanceId, newRequestId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createBrokerServer } from "@session-broker/server";
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

const identity = freshIdentity();
let isolation: Isolation;
let broker: BrokerHandle;
let adapterDataDir: string;
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

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  isolation = setupIsolation("recovery-omp");
  adapterDataDir = join(isolation.tmpDir, "adapter-data");
  mkdirSync(adapterDataDir, { recursive: true });
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
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

/**
 * Reinicia el broker en el MISMO puerto: el endpoint del adaptador es fijo por
 * construcción (misma semántica que reiniciar el servicio systemd del broker).
 */
async function startBrokerOn(port: number): Promise<BrokerHandle> {
  const server = createBrokerServer({
    host: "127.0.0.1",
    port,
    dataDir: isolation.dataDir,
    macKey: MAC_KEY,
    now: isolation.clock.now,
  });
  const address = await server.listen();
  return {
    server,
    port: address.port,
    url: `ws://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

function makeAdapter(input: { nativeSessionId: string; instanceId?: string }): { adapter: OmpAdapter; host: FakeOmpHost } {
  const host = new FakeOmpHost({ sessionId: input.nativeSessionId, model: isolation.fakeModel });
  const adapter = createOmpAdapter({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: input.instanceId ?? newInstanceId(),
    nativeSessionId: input.nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    host,
    macKey: MAC_KEY,
    dataDir: adapterDataDir,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  cleanups.push(async () => {
    await adapter.stop();
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
  cleanups.push(() => client.close());
  return client;
}

async function askState(client: BrokerClient, nativeSessionId: string, requestId: string): Promise<string> {
  const response = await client.inspect({}, targetOf(nativeSessionId));
  const detail = (response.result ?? {}) as { requests?: { requestId: string; state: string }[] };
  return (detail.requests ?? []).find((candidate) => candidate.requestId === requestId)?.state ?? "absent";
}

/** Espera acotada a que el estado durable alcance uno de los esperados. */
async function waitForAskState(
  client: BrokerClient,
  nativeSessionId: string,
  requestId: string,
  expected: readonly string[],
): Promise<string> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const state = await askState(client, nativeSessionId, requestId);
    if (expected.includes(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando estado ${expected.join("|")} de ${requestId}; observado ${state}`);
    }
    await sleep(10);
  }
}

/** Artefacto de crash: journal de recibos dejado por un proceso caído. */
function writeCrashReceipts(input: {
  nativeSessionId: string;
  requestId: string;
  instanceId: string;
  state: "received" | "submitting" | "submitted";
  question: string;
}): void {
  const dir = join(adapterDataDir, "omp-adapter-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `omp__${input.nativeSessionId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        entries: [
          {
            requestId: input.requestId,
            kind: "ask",
            instanceId: input.instanceId,
            state: input.state,
            replyState: "none",
            question: input.question,
            deadlineAtMs: null,
            updatedAtMs: isolation.clock.nowMs,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("recuperación del adaptador sin relaunch ni replay", () => {
  test("journal `submitting`: outcome_unknown y jamás una segunda llamada nativa", async () => {
    const nativeSessionId = "session-submitting";
    const instanceId = newInstanceId();
    const client = await newClient();
    // La sesión se registra primero (el broker solo encola contra sesiones
    // registradas); después el proceso "cae" y deja su journal de recibos.
    const primer = makeAdapter({ nativeSessionId, instanceId });
    await primer.adapter.start();
    await primer.adapter.stop();
    const asked = await client.ask(
      { question: "ventana de crash", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(nativeSessionId),
    );
    expect(asked.state).toBe("queued");
    const askId = asked.requestId;

    // El proceso murió con el marcador `submitting` persistido: el resultado
    // de la llamada nativa es INCIERTO (pudo llegar a OMP o no).
    writeCrashReceipts({ nativeSessionId, requestId: askId, instanceId, state: "submitting", question: "ventana de crash" });
    const { adapter, host } = makeAdapter({ nativeSessionId, instanceId });
    await adapter.start();
    // Sin evidencia NO hay repetición: cero llamadas nativas nuevas.
    await waitForAskState(client, nativeSessionId, askId, ["outcome_unknown"]);
    expect(host.sendUserMessageCalls.length).toBe(0);
    expect(host.registerToolCalls).toBe(1);
  });

  test("journal `received`: la entrega se reanuda UNA sola vez y el tool no se replica", async () => {
    const nativeSessionId = "session-received";
    const instanceId = newInstanceId();
    const client = await newClient();
    const primer = makeAdapter({ nativeSessionId, instanceId });
    await primer.adapter.start();
    await primer.adapter.stop();
    const asked = await client.ask(
      { question: "reanudable", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(nativeSessionId),
    );
    expect(asked.state).toBe("queued");
    const askId = asked.requestId;

    // `received` sin `submitting`: la llamada nativa es probablemente NO hecha.
    writeCrashReceipts({ nativeSessionId, requestId: askId, instanceId, state: "received", question: "reanudable" });
    const { adapter, host } = makeAdapter({ nativeSessionId, instanceId });
    await adapter.start();
    await waitForValue(() => (host.sendUserMessageCalls.length >= 1 ? true : undefined), "entrega nativa reanudada");
    expect(host.sendUserMessageCalls.length).toBe(1);
    expect(host.sendUserMessageCalls[0]?.content).toBe("reanudable");
    expect(host.registerToolCalls).toBe(1);
    // Reanudación con evidencia suficiente (journal `received` sin `submitting`
    // prueba que la llamada nativa no se hizo): produce `submitted` — MISMA
    // identidad, UNA sola entrega, tool no replicada (fila received→ACK).
    await waitForAskState(client, nativeSessionId, askId, ["submitted"]);

    // Reinicio del proceso: la recuperación NO vuelve a llamar a la API nativa.
    await adapter.stop();
    await adapter.start();
    await sleep(50);
    expect(host.sendUserMessageCalls.length).toBe(1);
    expect(host.registerToolCalls).toBe(1);
    // La desconexión del titular aplica la política CONGELADA de
    // `markInstanceOffline` (P-002, docs/contracts/durability.md): lo entregado
    // sin resultado durable queda `outcome_unknown` y exige reconciliación
    // explícita. `outcome_unknown` aquí NO proviene de falta de evidencia de la
    // reanudación (esa sí produjo `submitted`), sino de la caída posterior.
    await waitForAskState(client, nativeSessionId, askId, ["outcome_unknown"]);
  });

  test("sin confirmación del journal incoming no hay llamada nativa", async () => {
    const nativeSessionId = "session-no-ack";
    const instanceId = newInstanceId();
    const client = await newClient();
    // Recibo local para un ask que el broker NO conoce: el reporte falla y el
    // adaptador NO entrega nada (sin journal incoming confirmado no hay efecto).
    const orphanId = newRequestId();
    writeCrashReceipts({ nativeSessionId, requestId: orphanId, instanceId, state: "received", question: "huérfana" });
    const { adapter, host } = makeAdapter({ nativeSessionId, instanceId });
    await adapter.start();
    await sleep(50);
    expect(host.sendUserMessageCalls.length).toBe(0);
    // La identidad es consultable y sigue sin efectos.
    expect(await askState(client, nativeSessionId, orphanId)).toBe("absent");
  });

  test("el restart del broker no relanza OMP ni replica herramientas", async () => {
    const nativeSessionId = "session-restart";
    const client = await newClient();
    const { adapter, host } = makeAdapter({ nativeSessionId });
    await adapter.start();
    const asked = await client.ask(
      { question: "única", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(nativeSessionId),
    );
    const askId = asked.requestId;
    await waitForValue(() => (host.sendUserMessageCalls.length >= 1 ? true : undefined), "entrega nativa del ask");
    expect(host.sendUserMessageCalls.length).toBe(1);

    // Caída del broker: el adaptador degrada a «desconectado/offline» de forma
    // MANEJADA (sin excepción no controlada) y sin relanzar OMP. Una llamada
    // local de la tool durante la caída se rechaza sin efectos y sin repetir.
    const port = broker.port;
    await broker.close();
    await sleep(50);
    expect(adapter.snapshot().bound).toBe(false);
    const offlineReply = (await host.callTool("session_reply", {
      replyTo: askId,
      body: { text: "desconectado" },
    })) as OmpToolResult;
    expect(offlineReply.isError).toBe(true);
    expect(host.sendUserMessageCalls.length).toBe(1);
    expect(host.registerToolCalls).toBe(1);

    // El servicio vuelve en el MISMO puerto (como hace la unidad del broker al
    // reiniciarse): el runtime nativo NO se relanza y la tool NO se replica.
    broker = await startBrokerOn(port);
    await adapter.stop();
    await adapter.start();
    await sleep(50);
    expect(host.sendUserMessageCalls.length).toBe(1);
    expect(host.registerToolCalls).toBe(1);
    expect(host.abortCalls).toBe(0);
    // El shutdown del broker conserva la incertidumbre: nada se completó solo.
    const clientAfter = await newClient();
    await waitForAskState(clientAfter, nativeSessionId, askId, ["outcome_unknown"]);
  });

  test("la instancia vieja que vuelve tarde no relanza nada y su reply se rechaza", async () => {
    const nativeSessionId = "session-stale";
    const client = await newClient();
    const first = makeAdapter({ nativeSessionId });
    await first.adapter.start();
    const asked = await client.ask(
      { question: "para el dueño", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(nativeSessionId),
    );
    const askId = asked.requestId;
    await waitForValue(() => (first.host.sendUserMessageCalls.length >= 1 ? true : undefined), "entrega al dueño original");
    expect(first.host.sendUserMessageCalls.length).toBe(1);

    // Takeover: una instancia NUEVA toma la sesión (fencing por epoch).
    const second = makeAdapter({ nativeSessionId });
    await second.adapter.start();
    await sleep(50);
    expect(second.host.sendUserMessageCalls.length).toBe(0);

    // La instancia vieja responde tarde: su reply no tiene efectos.
    const late = (await first.host.callTool("session_reply", {
      replyTo: askId,
      body: { text: "tarde" },
    })) as OmpToolResult;
    expect(late.isError).toBe(true);
    expect(first.host.sendUserMessageCalls.length).toBe(1);
    expect(second.host.sendUserMessageCalls.length).toBe(0);
    // El takeover deja la incertidumbre explícita; jamás un completado inventado.
    await waitForAskState(client, nativeSessionId, askId, ["outcome_unknown"]);
  });
});
