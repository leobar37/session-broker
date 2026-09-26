/**
 * Consumidor externo portable del omp-session-broker (P-006 / FR-011).
 *
 * Este archivo es la PLANTILLA del smoke: el harness `tests/handoff` lo copia
 * al snapshot como `consumer-smoke/smoke.test.ts` y lo ejecuta FUERA del repo,
 * resolviendo los cinco paquetes por nombre desde los tarballs `file:../vendor`
 * instalados offline. Solo consume exports públicos:
 *
 *   `@session-broker/protocol` (+ `@session-broker/protocol/fixtures`),
 *   `@session-broker/client`, `@session-broker/server`,
 *   `@session-broker/cli`, `@session-broker/omp-adapter`.
 *
 * Composición demostrada: `createBrokerServer` + `createClient` +
 * `createOmpAdapter`/`issueRootProof` con FakeOmpHost y fake model (cualquier
 * inferencia real FALLA). Ciclo correlacionado: el ask se entrega como prompt
 * nativo `when_idle` y SOLO la herramienta explícita `session_reply` con
 * `replyTo = requestId` lo completa; `agent_end` y el siguiente texto del
 * modelo no. Las lecturas no disparan inferencia (contador en 0) y
 * `outcome_unknown` queda visible sin reejecución. Sin red externa, sin
 * proveedores, sin secretos reales.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES,
  EXIT_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  allowsAutomaticReExecution,
  newGrantId,
  newInstanceId,
  newProjectId,
  newWorkspaceId,
  sha256Hex,
  verifyRootProof,
  type Capability,
  type TargetRef,
} from "@session-broker/protocol";
import { FIXTURE_VALID_NAMES, checkValidFixture, referenceFixtures } from "@session-broker/protocol/fixtures";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createBrokerServer, type BrokerServer } from "@session-broker/server";
import { runCli } from "@session-broker/cli";
import {
  createOmpAdapter,
  issueRootProof,
  type OmpAdapter,
  type OmpExtensionHost,
  type OmpHostEvent,
  type OmpRunState,
  type OmpSendUserMessageOptions,
  type OmpToolContext,
  type OmpToolDefinition,
  type OmpToolResult,
  type OmpUnsubscribe,
} from "@session-broker/omp-adapter";

// ------------------------------------------------------------ aislamiento

const TMP_PREFIX = "omp-session-broker-test-";
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const NATIVE_SESSION = "smoke-session-0001";
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };

function assertUrlAllowed(raw: string | URL, context: string): void {
  const url = typeof raw === "string" ? new URL(raw) : new URL(raw.href);
  const remote = url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:";
  if (remote && LOOPBACK_HOSTS[url.hostname] !== true) {
    throw new Error(`red externa bloqueada (${context}): ${url.protocol}//${url.hostname}`);
  }
}

function installNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  (globalThis as Record<string, unknown>)["fetch"] = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    assertUrlAllowed(href, "fetch");
    return originalFetch(input, init);
  };
  (globalThis as Record<string, unknown>)["WebSocket"] = function GuardedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
    assertUrlAllowed(String(url), "WebSocket");
    return protocols === undefined ? new originalWebSocket(url) : new originalWebSocket(url, protocols);
  };
  return () => {
    (globalThis as Record<string, unknown>)["fetch"] = originalFetch;
    (globalThis as Record<string, unknown>)["WebSocket"] = originalWebSocket;
  };
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForValue<T>(get: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await sleep(10);
  }
}

// ------------------------------------------------- fake model / fake host

/** Fake model: cualquier inferencia real FALLA el smoke (prohibida en esta fase). */
class FakeModel {
  readonly calls: string[] = [];
  invoke(prompt: string): never {
    this.calls.push(prompt);
    throw new Error("inferencia real prohibida en esta fase (fake model)");
  }
}

interface SendUserMessageCall {
  readonly content: string;
  readonly options?: OmpSendUserMessageOptions;
}

/**
 * Fake host OMP: implementa los puertos estructurales públicos
 * (`OmpExtensionHost`) sin runtime nativo. Efectos contados: `sendUserMessage`
 * (entrega del ask), `registerTool` (registro de `session_reply`) y `abort`.
 */
class FakeOmpHost implements OmpExtensionHost {
  readonly sessionId: string;
  readonly model: FakeModel;
  streaming = false;
  registerToolCalls = 0;
  abortCalls = 0;
  readonly tools = new Map<string, OmpToolDefinition>();
  readonly sendUserMessageCalls: SendUserMessageCall[] = [];
  readonly #handlers = new Map<string, Array<(payload: unknown) => void>>();
  readonly #runStateListeners = new Set<(state: OmpRunState) => void>();
  #toolCallSeq = 0;

  constructor(input: { sessionId: string; model: FakeModel }) {
    this.sessionId = input.sessionId;
    this.model = input.model;
  }

  on(event: OmpHostEvent, handler: (payload: unknown) => void): OmpUnsubscribe {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return () => {
      const current = this.#handlers.get(event) ?? [];
      this.#handlers.set(
        event,
        current.filter((candidate) => candidate !== handler),
      );
    };
  }

  registerTool(tool: OmpToolDefinition): void {
    this.registerToolCalls += 1;
    this.tools.set(tool.name, tool);
  }

  sendUserMessage(content: string, options?: OmpSendUserMessageOptions): void {
    this.sendUserMessageCalls.push(options === undefined ? { content } : { content, options });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return undefined;
  }

  isIdle(): boolean {
    return !this.streaming;
  }

  hasPendingMessages(): boolean {
    return false;
  }

  subscribeRunState(listener: (state: OmpRunState) => void): OmpUnsubscribe {
    this.#runStateListeners.add(listener);
    return () => {
      this.#runStateListeners.delete(listener);
    };
  }

  abort(): void {
    this.abortCalls += 1;
    this.streaming = false;
    for (const listener of this.#runStateListeners) listener("idle");
  }

  /** Emite un evento de los hooks `on(...)` (fin de turno sin responder). */
  emit(event: OmpHostEvent, payload: unknown = {}): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(payload);
  }

  toolContext(): OmpToolContext {
    return {
      isIdle: () => this.isIdle(),
      hasPendingMessages: () => this.hasPendingMessages(),
      abort: () => this.abort(),
    };
  }

  /** Invoca la herramienta como lo haría el agente nativo. */
  async callTool(name: string, params: Record<string, unknown>): Promise<OmpToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`herramienta no registrada: ${name}`);
    this.#toolCallSeq += 1;
    return await tool.execute(`tool-call-${this.#toolCallSeq}`, params, undefined, undefined, this.toolContext());
  }
}

// --------------------------------------------------------------- escenario

const model = new FakeModel();
const projectId = newProjectId();
const workspaceId = newWorkspaceId();
const instanceId = newInstanceId();
const grantId = newGrantId();
const grantCapabilities: Capability[] = [
  CAPABILITIES.identity,
  CAPABILITIES.observe,
  CAPABILITIES.promptWhenIdle,
  CAPABILITIES.replyTool,
  CAPABILITIES.notify,
  CAPABILITIES.rootBinding,
];

let tmpDir = "";
let restoreNetwork: (() => void) | undefined;
let broker: BrokerServer;
let asker: BrokerClient;
let host: FakeOmpHost;
let adapter: OmpAdapter;

/** Provisión de grants por la vía documentada del operador (solo hash sha256). */
function writeGrants(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const grant = {
    grantId,
    subject: "consumer-smoke",
    scope: {
      projectId,
      workspaceIds: "*",
      targets: "*",
      sessions: "*",
      capabilities: grantCapabilities,
    },
    issuedBy: "consumer-smoke",
    issuedAtMs: Date.now() - 60_000,
    expiresAtMs: Date.now() + 3_600_000,
  };
  const record = { credentialHash: sha256Hex(CREDENTIAL), grant };
  writeFileSync(join(dataDir, "grants.json"), JSON.stringify({ schemaVersion: 1, grants: [record] }, null, 2), "utf8");
}

function targetOf(nativeSessionId: string): TargetRef {
  return {
    target: "omp",
    session: {
      projectId,
      scope: "workspace",
      workspaceId,
      target: "omp",
      nativeSessionId,
    },
  };
}

interface AskRecord {
  readonly requestId: string;
  readonly state: string;
  readonly operation: string;
}

async function askRecords(nativeSessionId: string): Promise<AskRecord[]> {
  const response = await asker.inspect({}, targetOf(nativeSessionId));
  const detail = (response.result ?? {}) as { requests?: AskRecord[] };
  return detail.requests ?? [];
}

async function askState(nativeSessionId: string, requestId: string): Promise<string> {
  const record = (await askRecords(nativeSessionId)).find((candidate) => candidate.requestId === requestId);
  return record?.state ?? "absent";
}

async function waitForAskState(nativeSessionId: string, requestId: string, expected: readonly string[], label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const state = await askState(nativeSessionId, requestId);
    if (expected.includes(state)) return;
    if (Date.now() > deadline) throw new Error(`timeout esperando ${label}: estado observado=${state}`);
    await sleep(10);
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), `${TMP_PREFIX}smoke-`));
  restoreNetwork = installNetworkGuard();
  const dataDir = join(tmpDir, "broker-data");
  writeGrants(dataDir);
  broker = createBrokerServer({ host: "127.0.0.1", port: 0, dataDir, macKey: MAC_KEY });
  const address = await broker.listen();
  const brokerUrl = `ws://127.0.0.1:${address.port}`;
  asker = createClient({
    endpoint: brokerUrl,
    projectId,
    workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
  });
  await asker.connect();
  host = new FakeOmpHost({ sessionId: NATIVE_SESSION, model });
  adapter = createOmpAdapter({
    endpoint: brokerUrl,
    projectId,
    workspaceId,
    instanceId,
    nativeSessionId: NATIVE_SESSION,
    grantId,
    credential: CREDENTIAL,
    host,
    macKey: MAC_KEY,
    dataDir: join(tmpDir, "adapter-data"),
    allowInsecureWs: true,
  });
  await adapter.start();
});

afterAll(async () => {
  await adapter.stop();
  await asker.close();
  await broker.close();
  restoreNetwork?.();
  // El smoke completo no ejecutó NINGUNA inferencia.
  expect(model.calls).toEqual([]);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("consumo externo de los cinco paquetes públicos", () => {
  test("superficie pública congelada presente y CLI con exit codes reales", async () => {
    expect(PROTOCOL_VERSION).toBe("1.0.0");
    expect(EXIT_CODES.OUTCOME_UNKNOWN).toBe(16);
    expect(LIMITS.maxFrameBytes).toBe(1048576);
    const fixtures = referenceFixtures();
    for (const name of FIXTURE_VALID_NAMES) {
      expect(checkValidFixture(name, fixtures).ok).toBe(true);
    }
    expect(await runCli(["--version"])).toBe(EXIT_CODES.OK);
    expect(await runCli(["--help"])).toBe(EXIT_CODES.OK);
    const surface = createClient({
      endpoint: "ws://127.0.0.1:1",
      projectId,
      workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      allowInsecureWs: true,
    }) as unknown as Record<string, unknown>;
    for (const name of ["connect", "close", "request", "query", "list", "inspect", "history", "subscribe", "ask", "reply", "notify", "control"]) {
      expect(typeof surface[name]).toBe("function");
    }
  });

  test("issueRootProof es verificable y no heredable por copia", () => {
    const challenge = `chal_${"a".repeat(32)}`;
    const audience = "con_smoke_audience";
    const proof = issueRootProof({
      macKey: MAC_KEY,
      issuer: `omp-adapter:${instanceId}`,
      instanceId,
      nativeSessionId: NATIVE_SESSION,
      challenge,
      audience,
      nowMs: Date.now(),
    });
    expect(proof.proofVersion).toBe(1);
    expect(proof.subject.instanceId).toBe(instanceId);
    const verified = verifyRootProof(proof, {
      nowMs: Date.now(),
      challenge,
      audience,
      instanceId,
      macKey: MAC_KEY,
      isProofConsumed: () => false,
    });
    expect(verified.ok).toBe(true);
    // Copia a otro challenge: la prueba es de un solo intercambio.
    const replayed = verifyRootProof(proof, {
      nowMs: Date.now(),
      challenge: `chal_${"b".repeat(32)}`,
      audience,
      instanceId,
      macKey: MAC_KEY,
      isProofConsumed: () => false,
    });
    expect(replayed.ok).toBe(false);
    // MAC key distinta: el binding no se sostiene sin la posesión del secreto.
    const foreign = verifyRootProof(proof, {
      nowMs: Date.now(),
      challenge,
      audience,
      instanceId,
      macKey: "otra-mac-key-no-real",
      isProofConsumed: () => false,
    });
    expect(foreign.ok).toBe(false);
  });

  test("ask → prompt when_idle → session_reply correlacionado completa el ciclo", async () => {
    expect(adapter.snapshot().bound).toBe(true);
    expect(adapter.capabilities).toContain(CAPABILITIES.replyTool);
    const asked = await asker.ask(
      { question: "estado del smoke", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(NATIVE_SESSION),
    );
    expect(asked.error).toBeUndefined();
    expect(asked.state).toBe("queued");
    const requestId = asked.requestId;

    // Entrega when_idle en sesión idle: un solo prompt nativo, sin deliverAs.
    await waitForValue(() => (host.sendUserMessageCalls.length === 1 ? true : undefined), "entrega nativa del ask");
    expect(host.sendUserMessageCalls[0]?.content).toBe("estado del smoke");
    expect(host.sendUserMessageCalls[0]?.options).toBeUndefined();
    await waitForAskState(NATIVE_SESSION, requestId, ["submitted"], "ask submitted");
    expect(host.registerToolCalls).toBe(1);

    // Ni `agent_end` ni el siguiente texto del modelo completan el ask.
    host.emit("agent_end", { reason: "done" });
    host.emit("message_end", { role: "assistant", text: "texto libre que no es respuesta" });
    host.emit("turn_end", {});
    await sleep(100);
    expect(await askState(NATIVE_SESSION, requestId)).toBe("submitted");

    // Lecturas sin inferencia: el contador del fake model sigue en 0.
    const query = await asker.query({ query: NATIVE_SESSION }, { target: "omp" });
    expect(query.error).toBeUndefined();
    const list = await asker.list({}, { target: "omp" });
    expect(list.error).toBeUndefined();
    const history = await asker.history({}, targetOf(NATIVE_SESSION));
    expect(history.error).toBeUndefined();
    expect(model.calls).toEqual([]);

    // Única vía de completar: herramienta explícita con replyTo = requestId.
    const reply = await host.callTool("session_reply", {
      replyTo: requestId,
      body: { answer: 42 },
      summary: "respuesta 42",
    });
    expect(reply.isError).toBeUndefined();
    const details = reply.details as { ok: boolean; askState: string };
    expect(details.ok).toBe(true);
    expect(details.askState).toBe("completed");
    await waitForAskState(NATIVE_SESSION, requestId, ["completed"], "ask completado por reply explícito");

    // Reply duplicado: rechazado sin efectos ni segundo reply en el broker.
    const duplicate = await host.callTool("session_reply", { replyTo: requestId, body: { answer: 43 } });
    expect(duplicate.isError).toBe(true);
    const records = await askRecords(NATIVE_SESSION);
    expect(records.filter((record) => record.operation === "reply").length).toBe(1);

    // La herramienta no dispara inferencia y no hay prompts extra.
    expect(model.calls).toEqual([]);
    expect(host.sendUserMessageCalls.length).toBe(1);
  });

  test("outcome_unknown visible sin reejecución cuando el holder se desconecta", async () => {
    const asked = await asker.ask(
      { question: "pregunta sin respuesta", deadlineMs: 300_000, policy: "when_idle" },
      targetOf(NATIVE_SESSION),
    );
    expect(asked.error).toBeUndefined();
    const requestId = asked.requestId;
    await waitForValue(() => (host.sendUserMessageCalls.length === 2 ? true : undefined), "segunda entrega nativa");
    await waitForAskState(NATIVE_SESSION, requestId, ["submitted"], "segundo ask submitted");

    // La sesión nativa se cae con el ask sin resultado durable: la política
    // congelada deja `outcome_unknown`, nunca un completado inventado.
    await adapter.stop();
    await waitForAskState(NATIVE_SESSION, requestId, ["outcome_unknown"], "outcome_unknown visible");
    expect(allowsAutomaticReExecution("outcome_unknown")).toBe(false);

    // Reunión de la MISMA instancia: sin re-entrega, sin segunda llamada nativa.
    await adapter.start();
    await sleep(100);
    expect(host.sendUserMessageCalls.length).toBe(2);
    const late = await host.callTool("session_reply", { replyTo: requestId, body: { n: 1 } });
    expect(late.isError).toBe(true);
    expect(await askState(NATIVE_SESSION, requestId)).toBe("outcome_unknown");
    expect(model.calls).toEqual([]);
  });
});
