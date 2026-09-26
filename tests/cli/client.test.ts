/**
 * Cliente público reutilizable (FR-001/004/006/007/011 / P-003) — suite
 * `test:cli` (incluye pruebas de LIBRERÍA aunque el script se llame test:cli).
 *
 * Todo contra el broker falso de `./fake-broker` (solo `@session-broker/protocol`),
 * sin `@session-broker/server` y sin código de P-002.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ALL_CAPABILITIES,
  LIMITS,
  PROTOCOL_MAJOR,
  cliExitCodeForError,
  newInstanceId,
  type EventEnvelope,
  type Grant,
  type GrantScope,
  type ProjectId,
  type RequestEnvelope,
  type TargetRef,
  type WorkspaceId,
} from "@session-broker/protocol";
import {
  createClient,
  isBrokerClientError,
  type BrokerClient,
  type ClientOptions,
} from "@session-broker/client";
import { FakeBroker, FIXTURE_CREDENTIAL, type FakeBrokerOptions } from "./fake-broker";
import { assertModelUnused, captureCli, jsonOutput, setupCliIsolation, waitFor, type Isolation } from "./helpers";

const GRANT_ID = "grt_abababababababababababababababab";

let isolation: Isolation;
let projectId: ProjectId;
let workspaceId: WorkspaceId;
const brokers: FakeBroker[] = [];
const clients: BrokerClient[] = [];
let requestCounter = 0;

beforeAll(async () => {
  isolation = setupCliIsolation();
  const init = await captureCli(["init", "--root", isolation.checkout, "--json"]);
  if (init.code !== 0) throw new Error(`init de fixture falló: ${init.stderr}`);
  const identity = jsonOutput(init);
  projectId = identity.projectId as ProjectId;
  workspaceId = identity.workspaceId as WorkspaceId;
});

afterAll(async () => {
  for (const client of clients) await client.close();
  for (const broker of brokers) broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function makeGrant(scopeOverrides?: Partial<GrantScope>, expiresAtMs?: number): Grant {
  return {
    grantId: GRANT_ID,
    subject: "tests/cli",
    scope: {
      projectId,
      workspaceIds: "*",
      targets: "*",
      sessions: "*",
      capabilities: ALL_CAPABILITIES,
      ...scopeOverrides,
    },
    issuedBy: "tests/cli",
    issuedAtMs: Date.now() - 60_000,
    expiresAtMs: expiresAtMs ?? Date.now() + 3_600_000,
  };
}

function startBroker(options: Partial<FakeBrokerOptions> = {}): FakeBroker {
  const broker = FakeBroker.start({ grant: makeGrant(), ...options });
  brokers.push(broker);
  return broker;
}

function makeClient(broker: FakeBroker, overrides: Partial<ClientOptions> = {}): BrokerClient {
  const client = createClient({
    endpoint: broker.endpoint,
    projectId,
    workspaceId,
    instanceId: newInstanceId(),
    grantId: GRANT_ID,
    credential: FIXTURE_CREDENTIAL,
    allowInsecureWs: true,
    requestTimeoutMs: 2000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

function targetRef(instanceId?: string): TargetRef {
  return {
    target: "omp",
    session: {
      projectId,
      scope: "workspace",
      workspaceId,
      target: "omp",
      nativeSessionId: "session-0001",
    },
    ...(instanceId !== undefined ? { instanceId } : {}),
  };
}

function nextRequestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(16).padStart(32, "0")}`;
}

function askEnvelope(requestId: string, question: string, waitMs: number): RequestEnvelope {
  return {
    v: PROTOCOL_MAJOR,
    kind: "request",
    requestId,
    operation: "ask",
    target: targetRef(),
    payload: { question, deadlineMs: 300_000, policy: "when_idle" },
    grantId: GRANT_ID,
    sentAtMs: Date.now(),
    deadlineMs: waitMs,
  };
}

describe("cliente público", () => {
  test("importar/instanciar no conecta ni dispara inferencia", () => {
    const globals = globalThis as Record<string, unknown>;
    const original = globals.WebSocket;
    const originalCtor = original as new (url: string) => unknown;
    let constructions = 0;
    globals.WebSocket = function CountingWebSocket(url: string): unknown {
      constructions += 1;
      return new originalCtor(url);
    };
    try {
      const client = createClient({
        endpoint: "wss://broker.invalid",
        projectId,
        workspaceId,
        instanceId: newInstanceId(),
        grantId: GRANT_ID,
        credential: FIXTURE_CREDENTIAL,
      });
      expect(constructions).toBe(0);
      void client.close();
    } finally {
      globals.WebSocket = original;
    }
    expect(constructions).toBe(0);
  });

  test("connect() completa el handshake y devuelve WelcomeMessage", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    const welcome = await client.connect();
    expect(welcome.kind).toBe("welcome");
    expect(welcome.protocolVersion).toBe("1.0.0");
    expect(welcome.serverCapabilities).toContain("session.observe");
    expect(welcome.connectionId).toMatch(/^con_[0-9a-f]{32}$/);
    expect(broker.hellos.length).toBe(1);
    await client.close();
  });

  test("la credencial del hello jamás se conserva por el broker falso", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const hello = broker.hellos[0];
    if (hello === undefined) throw new Error("falta hello");
    expect(hello.credential).toBe("[redacted]");
    expect(JSON.stringify(broker.hellos)).not.toContain(FIXTURE_CREDENTIAL);
    await client.close();
  });

  test("versión no negociable → INCOMPATIBLE_VERSION (exit 5), sin degradación", async () => {
    const broker = startBroker({ serverProtocolVersions: ["0.9.0"] });
    const client = makeClient(broker);
    let caught: unknown;
    try {
      await client.connect();
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.protocolError?.code).toBe("INCOMPATIBLE_VERSION");
      expect(caught.exitCode).toBe(5);
    }
    await client.close();
  });

  test("auth scoped: fuera del ámbito → NOT_FOUND_OR_FORBIDDEN y sin retry privilegiado", async () => {
    const broker = startBroker({ grant: makeGrant({ targets: ["otro"] }) });
    const client = makeClient(broker);
    await client.connect();
    const response = await client.query({ query: "hola" }, targetRef());
    expect(response.error?.code).toBe("NOT_FOUND_OR_FORBIDDEN");
    expect(response.error?.reason).toBe("unauthorized_scope");
    expect(response.error && cliExitCodeForError(response.error)).toBe(4);
    // el cliente NO reintenta errores de auth: un solo request observado
    expect(broker.requests.length).toBe(1);
    await client.close();
  });

  test("credencial incorrecta → UNAUTHORIZED (exit 3)", async () => {
    const broker = startBroker();
    const client = makeClient(broker, { credential: "credencial-equivocada" });
    let caught: unknown;
    try {
      await client.connect();
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.protocolError?.code).toBe("UNAUTHORIZED");
      expect(caught.exitCode).toBe(3);
    }
    await client.close();
  });

  test("control exige controlEpoch explícito y lo propaga; el obsoleto es STALE_CONTROL_EPOCH", async () => {
    const broker = startBroker();
    broker.setControlEpoch(7);
    const client = makeClient(broker);
    await client.connect();
    const applied = await client.control({ verb: "abort" }, targetRef(), 7);
    expect(applied.error).toBeUndefined();
    const seen = broker.requests.find((request) => request.operation === "control");
    if (seen === undefined) throw new Error("falta la solicitud de control");
    expect(seen.controlEpoch).toBe(7);

    const stale = await client.control({ verb: "abort" }, targetRef(), 3);
    expect(stale.error?.code).toBe("STALE_CONTROL_EPOCH");
    expect(stale.error && cliExitCodeForError(stale.error)).toBe(10);

    let caught: unknown;
    try {
      await client.control({ verb: "abort" }, targetRef(), Number.NaN);
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.protocolError?.code).toBe("STALE_CONTROL_EPOCH");
      expect(caught.exitCode).toBe(10);
    }
    await client.close();
  });

  test("la instancia distinta a la del lease de control → STALE_INSTANCE (exit 9)", async () => {
    const broker = startBroker();
    broker.setLeaseInstance("ins_99999999999999999999999999999999");
    const client = makeClient(broker);
    await client.connect();
    const response = await client.control({ verb: "steer" }, targetRef(), 0);
    expect(response.error?.code).toBe("STALE_INSTANCE");
    expect(response.error && cliExitCodeForError(response.error)).toBe(9);
    await client.close();
  });

  test("ask produce requestId y solo el reply explícito lo completa", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const ask = await client.ask({ question: "¿estado?", deadlineMs: 300_000, policy: "when_idle" }, targetRef());
    expect(ask.requestId).toMatch(/^req_[0-9a-f]{32}$/);
    expect(ask.error).toBeUndefined();
    expect(broker.record(ask.requestId)?.state).toBe("submitted");

    // ni agent_end ni el siguiente texto completan el ask
    expect(broker.simulateNativeSignal(ask.requestId, "agent_end")).toBe("ignored");
    expect(broker.simulateNativeSignal(ask.requestId, "next_text")).toBe("ignored");
    expect(broker.record(ask.requestId)?.state).toBe("submitted");

    const reply = await client.reply({ replyTo: ask.requestId, body: "listo" }, targetRef());
    expect(reply.error).toBeUndefined();
    expect(reply.replyTo).toBe(ask.requestId);
    expect(broker.record(ask.requestId)?.state).toBe("completed");
    await client.close();
  });

  test("reply con replyTo erróneo o ambiguo se rechaza sin completar el ask", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const ask = await client.ask({ question: "¿estado?", deadlineMs: 300_000, policy: "when_idle" }, targetRef());

    const wrong = await client.reply({ replyTo: nextRequestId(), body: "x" }, targetRef());
    expect(wrong.error?.code).toBe("NOT_FOUND_OR_FORBIDDEN");
    expect(broker.record(ask.requestId)?.state).toBe("submitted");

    // replyTo === requestId de la propia reply: rechazo de contrato
    const selfId = nextRequestId();
    const selfEnvelope: RequestEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "request",
      requestId: selfId,
      operation: "reply",
      target: targetRef(),
      payload: { replyTo: selfId, body: "x" },
      grantId: GRANT_ID,
      sentAtMs: Date.now(),
      deadlineMs: 2000,
    };
    let caught: unknown;
    try {
      await client.request(selfEnvelope);
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.protocolError?.reason).toBe("reply_to_mismatch");
      expect(caught.exitCode).toBe(2);
    }
    expect(broker.record(ask.requestId)?.state).toBe("submitted");
    await client.close();
  });

  test("notify/control unsupported no se convierten en ask ni en shell", async () => {
    const broker = startBroker({
      grant: makeGrant(),
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });
    const client = makeClient(broker);
    await client.connect();

    let notifyError: unknown;
    try {
      await client.notify({ topic: "tema", data: null }, targetRef());
    } catch (error) {
      notifyError = error;
    }
    expect(isBrokerClientError(notifyError)).toBe(true);
    if (isBrokerClientError(notifyError)) {
      expect(notifyError.protocolError?.code).toBe("UNSUPPORTED_CAPABILITY");
      expect(notifyError.exitCode).toBe(6);
    }

    let controlError: unknown;
    try {
      await client.control({ verb: "abort" }, targetRef(), 0);
    } catch (error) {
      controlError = error;
    }
    expect(isBrokerClientError(controlError)).toBe(true);
    if (isBrokerClientError(controlError)) {
      expect(controlError.protocolError?.code).toBe("UNSUPPORTED_CAPABILITY");
      expect(controlError.exitCode).toBe(6);
    }

    expect(broker.operationCounts.get("ask")).toBeUndefined();
    expect(broker.operationCounts.get("notify")).toBeUndefined();
    await client.close();
  });

  test("ACK perdido conserva requestId y la consulta por estado no reejecuta", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const requestId = nextRequestId();
    broker.silent = true;
    let caught: unknown;
    try {
      await client.request(askEnvelope(requestId, "pregunta original", 150));
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.kind).toBe("timeout");
      expect(caught.requestId).toBe(requestId);
      expect(caught.endsLocalWaitOnly).toBe(true);
    }
    expect(broker.executionCount).toBe(1);

    // el broker cae en la ventana de crash: estado durable outcome_unknown
    broker.crashWindow(requestId);
    broker.silent = false;
    const consult = await client.request(askEnvelope(requestId, "pregunta original", 2000));
    expect(consult.requestId).toBe(requestId);
    expect(consult.state).toBe("outcome_unknown");
    expect(broker.executionCount).toBe(1);
    expect(broker.replays).toBe(1);
    await client.close();
  });

  test("mismo requestId con hash distinto → PAYLOAD_CONFLICT sin efectos", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const requestId = nextRequestId();
    const first = await client.request(askEnvelope(requestId, "pregunta original", 2000));
    expect(first.error).toBeUndefined();
    const conflict = await client.request(askEnvelope(requestId, "pregunta DISTINTA", 2000));
    expect(conflict.error?.code).toBe("PAYLOAD_CONFLICT");
    expect(conflict.error && cliExitCodeForError(conflict.error)).toBe(11);
    expect(broker.executionCount).toBe(1);
    await client.close();
  });

  test("abort/timeout terminan la espera local y jamás afirman cancelación remota", async () => {
    const broker = startBroker();
    const client = makeClient(broker, { requestTimeoutMs: 5000 });
    await client.connect();
    broker.silent = true;
    const requestId = nextRequestId();
    const pending = client.request(askEnvelope(requestId, "trabajo largo", 5000));
    void pending.catch(() => undefined);
    await waitFor(() => broker.requests.length === 1);
    await client.close();
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.kind).toBe("aborted");
      expect(caught.endsLocalWaitOnly).toBe(true);
      expect(caught.requestId).toBe(requestId);
      expect(caught.message).toContain("NO fue cancelado");
    }

    // la cancelación REMOTA es un estado del broker, distinto del error local
    broker.silent = false;
    broker.cancelRequest(requestId);
    const other = makeClient(broker);
    await other.connect();
    const consult = await other.request(askEnvelope(requestId, "trabajo largo", 2000));
    expect(consult.state).toBe("cancelled");
    expect(broker.executionCount).toBe(1);
    await other.close();
  });

  test("server offline ≠ request/job fallido", async () => {
    const dead = startBroker();
    const endpoint = dead.endpoint;
    dead.close();
    const client = createClient({
      endpoint,
      projectId,
      workspaceId,
      instanceId: newInstanceId(),
      grantId: GRANT_ID,
      credential: FIXTURE_CREDENTIAL,
      allowInsecureWs: true,
      requestTimeoutMs: 1000,
    });
    clients.push(client);
    let caught: unknown;
    try {
      await client.connect();
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.kind).toBe("connection");
      expect(caught.exitCode).toBe(7);
    }

    // desconexión en vuelo: el error conserva el requestId y no marca fallo remoto
    const broker = startBroker();
    const live = makeClient(broker, { requestTimeoutMs: 5000 });
    await live.connect();
    broker.silent = true;
    const requestId = nextRequestId();
    const pending = live.request(askEnvelope(requestId, "en vuelo", 5000));
    void pending.catch(() => undefined);
    await waitFor(() => broker.requests.length === 1);
    broker.dropConnections();
    let midFlight: unknown;
    try {
      await pending;
    } catch (error) {
      midFlight = error;
    }
    expect(isBrokerClientError(midFlight)).toBe(true);
    if (isBrokerClientError(midFlight)) {
      expect(midFlight.kind).toBe("connection");
      expect(midFlight.requestId).toBe(requestId);
      expect(midFlight.message).toContain("NO se marca fallido");
      expect(midFlight.exitCode).toBe(7);
    }
    await live.close();
  });

  test("reconexión con backoff reanuda la suscripción por cursor sin duplicar eventos", async () => {
    const broker = startBroker();
    const client = makeClient(broker, { requestTimeoutMs: 3000 });
    await client.connect();
    const events: EventEnvelope[] = [];
    const subscription = client.subscribe({ topics: ["topic-a"], fromEventSeq: 1 }, targetRef(), (event) => {
      events.push(event);
    });
    await subscription.ack;
    broker.emitEvent("topic-a", { n: 1 });
    broker.emitEvent("topic-a", { n: 2 });
    await waitFor(() => events.length === 2);

    broker.dropConnections();
    await waitFor(() => broker.hellos.length === 2, 8000);
    await waitFor(() => broker.requests.filter((request) => request.operation === "subscribe").length === 2);
    const subscribes = broker.requests.filter((request) => request.operation === "subscribe");
    const last = subscribes[subscribes.length - 1];
    if (last === undefined) throw new Error("falta la re-suscripción tras reconexión");
    // El cursor reanuda EXACTAMENTE después del último evento entregado: sin
    // repetir eventos ya vistos ni saltarse eventos pendientes. El stream de
    // `eventSeq` es único y estrictamente creciente (los recibos de respuesta
    // también son eventos del journal, ver durability.md), por lo que el valor
    // absoluto se deriva de lo entregado en vez de fijarse a mano.
    const lastDeliveredSeq = Math.max(...events.map((event) => event.eventSeq));
    expect(lastDeliveredSeq).toBeGreaterThan(0);
    const resumePayload: unknown = last.payload;
    if (typeof resumePayload !== "object" || resumePayload === null || !("fromEventSeq" in resumePayload)) {
      throw new Error("la re-suscripción no llevó cursor fromEventSeq");
    }
    expect(resumePayload.fromEventSeq).toBe(lastDeliveredSeq + 1);

    broker.emitEvent("topic-a", { n: 3 });
    await waitFor(() => events.length === 3);
    const seqs = events.map((event) => event.eventSeq);
    // sin duplicados (dedup por eventSeq) y en orden estrictamente creciente
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events.length).toBe(3);
    subscription.close();
    await client.close();
  });

  test("backpressure corta la suscripción con QUEUE_FULL (sin eventos inventados)", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const events: EventEnvelope[] = [];
    const subscription = client.subscribe({ topics: ["topic-b"] }, targetRef(), (event) => {
      events.push(event);
    });
    await subscription.ack;
    broker.overflowSubscriptions();
    const closed = await subscription.closed;
    expect(closed).not.toBeNull();
    if (closed !== null) {
      expect(closed.protocolError?.code).toBe("QUEUE_FULL");
      expect(closed.exitCode).toBe(14);
    }
    expect(events.length).toBe(0);
    await client.close();
  });

  test("cursor expirado → CURSOR_EXPIRED (exit 15) con snapshot explícito", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const response = await client.history({ cursor: "caducado" }, targetRef());
    expect(response.error?.code).toBe("CURSOR_EXPIRED");
    expect(response.error && cliExitCodeForError(response.error)).toBe(15);
    await client.close();
  });

  test("ws:// exige política local explícita y loopback; nunca se degrada", async () => {
    let noPolicy: unknown;
    try {
      createClient({
        endpoint: "ws://127.0.0.1:1",
        projectId,
        workspaceId,
        instanceId: newInstanceId(),
        grantId: GRANT_ID,
        credential: FIXTURE_CREDENTIAL,
      });
    } catch (error) {
      noPolicy = error;
    }
    expect(isBrokerClientError(noPolicy)).toBe(true);

    let notLoopback: unknown;
    try {
      createClient({
        endpoint: "ws://10.1.2.3:9999",
        projectId,
        workspaceId,
        instanceId: newInstanceId(),
        grantId: GRANT_ID,
        credential: FIXTURE_CREDENTIAL,
        allowInsecureWs: true,
      });
    } catch (error) {
      notLoopback = error;
    }
    expect(isBrokerClientError(notLoopback)).toBe(true);

    const broker = startBroker();
    const client = makeClient(broker);
    const welcome = await client.connect();
    expect(welcome.kind).toBe("welcome");
    await client.close();
  });

  test("request sin conexión no envía nada y distingue espera de ejecución", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    let caught: unknown;
    try {
      await client.request(askEnvelope(nextRequestId(), "sin conexión", 1000));
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
    if (isBrokerClientError(caught)) {
      expect(caught.kind).toBe("connection");
      expect(caught.message).toContain("NO fue enviada ni ejecutada");
    }
    expect(broker.requests.length).toBe(0);
  });

  test("operaciones tipadas leen sin crear sesiones ni prompts", async () => {
    const broker = startBroker();
    const client = makeClient(broker);
    await client.connect();
    const listed = await client.list({ limit: 10 }, targetRef());
    expect(listed.error).toBeUndefined();
    const queried = await client.query({ query: "estado" }, targetRef());
    expect(queried.error).toBeUndefined();
    const inspected = await client.inspect({ fields: ["state"] }, targetRef());
    expect(inspected.error).toBeUndefined();
    const history = await client.history({ fromEventSeq: 1, limit: 5 }, targetRef());
    expect(history.error).toBeUndefined();
    expect(broker.operationCounts.get("ask")).toBeUndefined();
    await client.close();
  });

  test("LIMITS congelados gobiernan la espera por defecto", () => {
    expect(LIMITS.requestTimeoutMsDefault).toBe(30000);
    const brokerless = startBroker();
    let caught: unknown;
    try {
      createClient({
        endpoint: brokerless.endpoint,
        projectId,
        workspaceId,
        instanceId: newInstanceId(),
        grantId: GRANT_ID,
        credential: FIXTURE_CREDENTIAL,
        allowInsecureWs: true,
        requestTimeoutMs: LIMITS.requestTimeoutMsMax + 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(isBrokerClientError(caught)).toBe(true);
  });
});
