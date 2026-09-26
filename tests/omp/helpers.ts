/**
 * Helpers aislados de `tests/omp` (NFR-002).
 *
 * Cada suite crea un TMP con el prefijo reservado `omp-session-broker-test-`,
 * desvía HOME/config/data hacia él, instala guardas que FALLAN ante red
 * externa (solo loopback para fixtures) y usa fake model que lanza si se le
 * invoca. El **fake host** implementa los puertos estructurales de
 * `@session-broker/omp-adapter` contrastados con la API pública OMP instalada
 * (`docs/compatibility/omp-api-matrix.md`) y mantiene contadores de efectos
 * (prompt nativo, registro de herramientas, abort) y el estado de la TUI
 * (input local, timeline, historial). Broker y cliente son REALES
 * (`@session-broker/server` + `@session-broker/client`). Teardown en
 * `afterAll` aunque la suite falle.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import {
  newInstanceId,
  newProjectId,
  newWorkspaceId,
  type Capability,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolErrorReason,
} from "@session-broker/protocol";
import { createBrokerServer, type BrokerServer } from "@session-broker/server";
import type {
  OmpExtensionHost,
  OmpHostEvent,
  OmpRunState,
  OmpSendUserMessageOptions,
  OmpToolContext,
  OmpToolDefinition,
  OmpToolResult,
  OmpToolSessionEvent,
  OmpUnsubscribe,
} from "@session-broker/omp-adapter";

export const TMP_PREFIX = "omp-session-broker-test-";

// ------------------------------------------------------------- entorno fake

/** Reloj inyectable: los tests avanzan plazos/TTL sin esperas reales. */
export class FakeClock {
  nowMs: number;

  constructor(startMs = 1_700_000_000_000) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

/** Fake model: cualquier inferencia real FALLA el test (prohibida en esta fase). */
export class FakeModel {
  readonly calls: string[] = [];

  complete(prompt: string): string {
    this.calls.push(prompt);
    throw new Error("fake model invocado: tests/omp jamás deben llamar modelos ni proveedores");
  }
}

function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

/** Guarda de red: solo fixtures loopback; cualquier host externo lanza. */
export function installNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  (globalThis as Record<string, unknown>)["fetch"] = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isLoopback(url)) {
      throw new Error(`guarda de red externa activa: ${url}`);
    }
    return originalFetch(input, init);
  };
  (globalThis as Record<string, unknown>)["WebSocket"] = function GuardedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
    if (!isLoopback(String(url))) {
      throw new Error(`guarda de red externa activa: ${String(url)}`);
    }
    return protocols === undefined ? new originalWebSocket(url) : new originalWebSocket(url, protocols);
  };
  return () => {
    (globalThis as Record<string, unknown>)["fetch"] = originalFetch;
    (globalThis as Record<string, unknown>)["WebSocket"] = originalWebSocket;
  };
}

export interface Isolation {
  readonly tmpDir: string;
  readonly home: string;
  readonly dataDir: string;
  readonly userDataDir: string;
  readonly clock: FakeClock;
  readonly fakeModel: FakeModel;
  teardown(): void;
}

export function setupIsolation(name: string): Isolation {
  const tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const home = join(tmpDir, "home");
  const dataDir = join(tmpDir, "broker-data");
  const userDataDir = join(tmpDir, "user-data");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(tmpDir, "config"), { recursive: true });
  mkdirSync(join(tmpDir, "data"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  const originalHome = process.env.HOME;
  const originalXdgData = process.env.XDG_DATA_HOME;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(tmpDir, "data");
  process.env.XDG_CONFIG_HOME = join(tmpDir, "config");
  const restoreNetwork = installNetworkGuard();
  const clock = new FakeClock();
  const fakeModel = new FakeModel();
  let done = false;
  return {
    tmpDir,
    home,
    dataDir,
    userDataDir,
    clock,
    fakeModel,
    teardown(): void {
      if (done) return;
      done = true;
      restoreNetwork();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgData;
      if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfig;
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export function assertModelUnused(model: FakeModel): void {
  expect(model.calls).toEqual([]);
}

// ----------------------------------------------------------------- grants

export interface TestGrantInput {
  grantId?: string;
  projectId: string;
  workspaceIds?: string[] | "*";
  targets?: string[] | "*";
  sessions?: string[] | "*";
  capabilities: Capability[];
  issuedAtMs: number;
  expiresAtMs: number;
}

export function testGrant(input: TestGrantInput): Record<string, unknown> {
  return {
    grantId: input.grantId ?? `grt_${randomBytes(16).toString("hex")}`,
    subject: "tests-omp",
    scope: {
      projectId: input.projectId,
      workspaceIds: input.workspaceIds ?? "*",
      targets: input.targets ?? "*",
      sessions: input.sessions ?? "*",
      capabilities: input.capabilities,
    },
    issuedBy: "tests/omp",
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
  };
}

/** Provisión de grants: solo hash sha256 de la credencial, jamás la credencial. */
export function writeGrants(
  dataDir: string,
  entries: readonly { readonly credential: string; readonly grant: Record<string, unknown> }[],
): void {
  mkdirSync(dataDir, { recursive: true });
  const grants = entries.map((entry) => ({
    credentialHash: createHash("sha256").update(entry.credential, "utf8").digest("hex"),
    grant: entry.grant,
  }));
  writeFileSync(join(dataDir, "grants.json"), JSON.stringify({ schemaVersion: 1, grants }, null, 2), "utf8");
}

// ------------------------------------------------------------- esperas

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function waitForValue<T>(get: () => T | undefined, label: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await sleep(5);
  }
}

/** Espera una condición (posiblemente async) con timeout acotado. */
export async function waitForCondition(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${label}`);
    await sleep(5);
  }
}

// ------------------------------------------------------------- fake host OMP

interface TimelineEntry {
  readonly kind: "local_input" | "user_message";
  readonly text: string;
  readonly options?: OmpSendUserMessageOptions;
}

/**
 * Fake host OMP: implementa `OmpExtensionHost` con la forma documentada de la
 * API instalada y conserva el estado de la TUI (input local, timeline,
 * historial). Efectos contados: `sendUserMessage` (prompt nativo),
 * `registerTool`, `abort`. Cualquier inferencia del fake model lanza.
 */
export class FakeOmpHost implements OmpExtensionHost {
  sessionId: string;
  readonly sessionFile: string;
  streaming = false;
  queuedMessages = 0;
  registerToolCalls = 0;
  abortCalls = 0;
  readonly tools = new Map<string, OmpToolDefinition>();
  readonly sendUserMessageCalls: { readonly content: string; readonly options?: OmpSendUserMessageOptions }[] = [];
  readonly timeline: TimelineEntry[] = [];
  readonly inputBuffer: string[] = [];
  readonly history: string[] = [];
  readonly model: FakeModel;
  readonly #handlers = new Map<string, ((payload: unknown) => void)[]>();
  readonly #runStateListeners = new Set<(state: OmpRunState) => void>();
  #toolCallSeq = 0;

  constructor(input: { sessionId: string; sessionFile?: string; model: FakeModel }) {
    this.sessionId = input.sessionId;
    this.sessionFile = input.sessionFile ?? `/tmp/fake-session/${input.sessionId}.jsonl`;
    this.model = input.model;
  }

  // ------------------------------------------------------- puertos OMP

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
    this.timeline.push(options === undefined ? { kind: "user_message", text: content } : { kind: "user_message", text: content, options });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  isIdle(): boolean {
    return !this.streaming;
  }

  hasPendingMessages(): boolean {
    return this.queuedMessages > 0;
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

  // ------------------------------------------------------- harness

  /** El usuario teclea en la TUI local: el adaptador jamás debe tocar esto. */
  typeLocal(text: string): void {
    this.inputBuffer.push(text);
    this.timeline.push({ kind: "local_input", text });
  }

  /** El usuario completa su historial nativo. */
  appendHistory(entry: string): void {
    this.history.push(entry);
  }

  /** Cambia el estado de trabajo nativo (turno del agente en curso o no). */
  setStreaming(value: boolean): void {
    this.streaming = value;
    for (const listener of this.#runStateListeners) listener(value ? "running" : "idle");
  }

  /** Emite un evento de los hooks `on(...)` (p. ej. fin de turno sin responder). */
  emit(event: OmpHostEvent, payload: unknown = {}): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(payload);
  }

  /** Lifecycle de sesión de la herramienta (`ToolDefinition.onSession`). */
  emitSessionLifecycle(reason: OmpToolSessionEvent["reason"], previousSessionFile?: string): void {
    for (const tool of this.tools.values()) {
      void tool.onSession?.({ reason, previousSessionFile }, this.toolContext());
    }
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

// ------------------------------------------------------------- broker real

export interface BrokerHandle {
  readonly server: BrokerServer;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startBroker(input: { dataDir: string; clock: FakeClock; macKey?: string; port?: number }): Promise<BrokerHandle> {
  const server = createBrokerServer({
    host: "127.0.0.1",
    port: input.port ?? 0,
    dataDir: input.dataDir,
    ...(input.macKey === undefined ? {} : { macKey: input.macKey }),
    now: input.clock.now,
  });
  const address = await server.listen();
  return {
    server,
    port: address.port,
    url: `ws://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

// -------------------------------------------------- peer crudo (root claims)

export interface RawFrame {
  readonly kind: string;
  readonly [key: string]: unknown;
}

/**
 * Peer crudo que habla SOLO `@session-broker/protocol`: registra identidad y
 * envía `bind_root` con claims arbitrarios (environment/PID/cwd/IDs/token o
 * root proofs copiadas) para probar la no-heredabilidad del binding raíz.
 */
export class RootClaimPeer {
  readonly raw: WebSocket;
  readonly frames: RawFrame[] = [];
  welcome: RawFrame | undefined;
  readonly input: {
    url: string;
    projectId: string;
    workspaceId: string;
    instanceId: string;
    nativeSessionId: string;
    grantId: string;
    credential: string;
  };

  constructor(raw: WebSocket, input: RootClaimPeer["input"]) {
    this.raw = raw;
    this.input = input;
    raw.onmessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as RawFrame;
      this.frames.push(frame);
      if (frame.kind === "welcome") this.welcome = frame;
    };
  }

  send(frame: unknown): void {
    this.raw.send(JSON.stringify(frame));
  }

  hello(): void {
    this.send({
      kind: "hello",
      v: 1,
      protocolVersions: ["1.0.0"],
      clientName: "tests-omp-root-claim",
      clientVersion: "0.1.0",
      projectId: this.input.projectId,
      workspaceId: this.input.workspaceId,
      instanceId: this.input.instanceId,
      nativeSessionId: this.input.nativeSessionId,
      grantId: this.input.grantId,
      credential: this.input.credential,
      capabilities: ["session.identity", "session.observe"],
    });
  }

  mark(): number {
    return this.frames.length;
  }

  /** Request con envelope congelado; devuelve el `response` correlacionado. */
  async request(input: { operation: string; payload: unknown; target?: unknown; controlEpoch?: number }): Promise<RawFrame> {
    const requestId = `req_${randomBytes(16).toString("hex")}`;
    const mark = this.mark();
    this.send({
      v: 1,
      kind: "request",
      requestId,
      operation: input.operation,
      target: input.target ?? { target: "omp" },
      payload: input.payload,
      grantId: this.input.grantId,
      sentAtMs: Date.now(),
      ...(input.controlEpoch === undefined ? {} : { controlEpoch: input.controlEpoch }),
    });
    return await waitForValue(
      () => this.frames.slice(mark).find((frame) => frame.kind === "response" && frame["requestId"] === requestId),
      `response ${input.operation}/${requestId}`,
    );
  }

  /** `bind_root` con un claim arbitrario; devuelve el frame de respuesta. */
  async bindRoot(claim: unknown, target = "omp"): Promise<RawFrame> {
    const mark = this.mark();
    this.send({ kind: "bind_root", v: 1, claim, target });
    return await waitForValue(() => this.frames[mark], "respuesta de bind_root");
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      // best-effort
    }
  }
}

export async function openRootClaimPeer(input: RootClaimPeer["input"]): Promise<RootClaimPeer> {
  const raw = new WebSocket(input.url);
  const peer = new RootClaimPeer(raw, input);
  await waitForValue(() => (raw.readyState === 1 ? true : undefined), `conexión WS abierta a ${input.url}`);
  peer.hello();
  await waitForValue(() => peer.welcome, "welcome del handshake");
  return peer;
}

export function expectFrameError(frame: RawFrame, code: ProtocolErrorCode, reason: ProtocolErrorReason): ProtocolError {
  expect(frame.kind).toBe("error");
  const error = frame["error"] as ProtocolError | undefined;
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("sin error tipado");
  expect(error.code).toBe(code);
  expect(error.reason).toBe(reason);
  return error;
}

/** Identidad fresca por test (proyecto/workspace/instancia disjuntos). */
export function freshIdentity(): { projectId: string; workspaceId: string; instanceId: string } {
  return {
    projectId: newProjectId(),
    workspaceId: newWorkspaceId(),
    instanceId: newInstanceId(),
  };
}
