/**
 * Helpers aislados de `tests/broker` (NFR-002).
 *
 * Cada suite crea un TMP con el prefijo reservado `omp-session-broker-test-`,
 * desvía HOME/config/data hacia él, instala guardas que FALLAN ante red
 * externa (solo loopback para fixtures) y usa fake model que lanza si se le
 * invoca. Los peers falsos hablan SOLO `@session-broker/protocol` (jamás
 * `@session-broker/client` ni código de P-003). Teardown en `afterAll` aunque
 * la suite falle.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import {
  computeRootProofMac,
  newInstanceId,
  newProjectId,
  newRequestId,
  newWorkspaceId,
  type Capability,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolErrorReason,
  type RootProof,
} from "@session-broker/protocol";
import { createBrokerServer, type BrokerServer } from "@session-broker/server";

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

/** Fake model: cualquier inferencia real FALLA el test. */
export class FakeModel {
  readonly calls: string[] = [];

  complete(prompt: string): string {
    this.calls.push(prompt);
    throw new Error("fake model invocado: tests/broker no deben llamar modelos ni proveedores");
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
  readonly clock: FakeClock;
  readonly fakeModel: FakeModel;
  teardown(): void;
}

export function setupIsolation(name: string): Isolation {
  const tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const home = join(tmpDir, "home");
  const dataDir = join(tmpDir, "broker-data");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(tmpDir, "config"), { recursive: true });
  mkdirSync(join(tmpDir, "data"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
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
  notBeforeMs?: number;
  revokedAtMs?: number;
}

export function testGrant(input: TestGrantInput): Record<string, unknown> {
  return {
    grantId: input.grantId ?? `grt_${randomBytes(16).toString("hex")}`,
    subject: "test-subject",
    scope: {
      projectId: input.projectId,
      workspaceIds: input.workspaceIds ?? "*",
      targets: input.targets ?? "*",
      sessions: input.sessions ?? "*",
      capabilities: input.capabilities,
    },
    issuedBy: "tests/broker",
    issuedAtMs: input.issuedAtMs,
    ...(input.notBeforeMs === undefined ? {} : { notBeforeMs: input.notBeforeMs }),
    expiresAtMs: input.expiresAtMs,
    ...(input.revokedAtMs === undefined ? {} : { revokedAtMs: input.revokedAtMs }),
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

// -------------------------------------------------------------- root proof

export interface RootProofInput {
  macKey: string;
  instanceId: string;
  nativeSessionId: string;
  challenge: string;
  audience: string;
  nowMs: number;
  ttlMs?: number;
  proofId?: string;
  issuer?: string;
  pid?: number;
}

export function makeRootProof(input: RootProofInput): RootProof {
  const proofId = input.proofId ?? `rp_${randomBytes(16).toString("hex")}`;
  const issuedAtMs = input.nowMs - 1_000;
  const expiresAtMs = input.nowMs + (input.ttlMs ?? 299_000);
  const macInput = {
    proofVersion: 1,
    proofId,
    issuer: input.issuer ?? `test-adapter:${input.instanceId}`,
    subject: {
      instanceId: input.instanceId,
      nativeSessionId: input.nativeSessionId,
      ...(input.pid === undefined ? {} : { pid: input.pid }),
    },
    challenge: input.challenge,
    audience: input.audience,
    issuedAtMs,
    expiresAtMs,
  };
  return { ...macInput, mac: computeRootProofMac(macInput, input.macKey) };
}

// ------------------------------------------------------------------ peers

export interface Frame {
  readonly kind: string;
  readonly [key: string]: unknown;
}

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

export interface OpenPeerInput {
  url: string;
  projectId: string;
  workspaceId: string;
  instanceId: string;
  nativeSessionId?: string;
  grantId: string;
  credential: string;
  capabilities?: readonly Capability[];
  protocolVersions?: readonly string[];
  clientName?: string;
}

/** Peer falso: cliente WS que habla solo el protocolo congelado. */
export class FakePeer {
  readonly raw: WebSocket;
  readonly frames: Frame[] = [];
  readonly responses: Frame[] = [];
  readonly events: Frame[] = [];
  readonly errors: Frame[] = [];
  welcome: Frame | undefined;
  closeCode: number | undefined;
  readonly input: OpenPeerInput;

  constructor(raw: WebSocket, input: OpenPeerInput) {
    this.raw = raw;
    this.input = input;
    raw.onmessage = (event: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(event.data)) as Frame;
      } catch {
        return;
      }
      this.frames.push(frame);
      if (frame.kind === "response") this.responses.push(frame);
      else if (frame.kind === "event") this.events.push(frame);
      else if (frame.kind === "error") this.errors.push(frame);
      if (frame.kind === "welcome") this.welcome = frame;
    };
    raw.onclose = (event: CloseEvent) => {
      this.closeCode = event.code;
    };
  }

  mark(): number {
    return this.frames.length;
  }

  nextFrame(mark: number, label: string): Promise<Frame> {
    return waitForValue(() => this.frames[mark], label);
  }

  responseFor(requestId: string): Frame | undefined {
    return this.responses.find((frame) => frame["requestId"] === requestId);
  }

  send(message: unknown): void {
    this.raw.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.raw.send(text);
  }

  hello(extra?: Record<string, unknown>): void {
    this.send({
      kind: "hello",
      v: 1,
      protocolVersions: this.input.protocolVersions ?? ["1.0.0"],
      clientName: this.input.clientName ?? "tests-broker-peer",
      clientVersion: "0.1.0",
      projectId: this.input.projectId,
      workspaceId: this.input.workspaceId,
      instanceId: this.input.instanceId,
      ...(this.input.nativeSessionId === undefined ? {} : { nativeSessionId: this.input.nativeSessionId }),
      grantId: this.input.grantId,
      credential: this.input.credential,
      capabilities: [...(this.input.capabilities ?? ["session.identity", "session.observe"])],
      ...extra,
    });
  }

  /** Envía una request y espera su `response` correlacionada. */
  async request(input: {
    operation: string;
    target: Record<string, unknown>;
    payload: unknown;
    requestId?: string;
    grantId?: string;
    controlEpoch?: number;
    deadlineMs?: number;
    requiredCapabilities?: string[];
    sentAtMs?: number;
  }): Promise<Frame> {
    const requestId = input.requestId ?? newRequestId();
    // Correlación por respuesta NUEVA (post-envío): los reintentos comparten
    // requestId por diseño (dedup) y jamás deben devolver respuestas previas.
    const mark = this.responses.length;
    this.send({
      v: 1,
      kind: "request",
      requestId,
      operation: input.operation,
      target: input.target,
      payload: input.payload,
      grantId: input.grantId ?? this.input.grantId,
      sentAtMs: input.sentAtMs ?? Date.now(),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      ...(input.controlEpoch === undefined ? {} : { controlEpoch: input.controlEpoch }),
      ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: input.requiredCapabilities }),
    });
    return await waitForValue(
      () => this.responses.slice(mark).find((frame) => frame["requestId"] === requestId),
      `response ${input.operation}/${requestId}`,
    );
  }

  /** Reporte de ciclo de vida (interop: ver docblock de apps/broker/src/server.ts). */
  async report(requestId: string, state: string, extra?: { result?: unknown; error?: ProtocolError }): Promise<Frame> {
    const mark = this.mark();
    this.send({ kind: "report", v: 1, requestId, state, atMs: Date.now(), ...extra });
    return await this.nextFrame(mark, `report ${state} de ${requestId}`);
  }

  /** `notify` con tema reservado: declara runState del titular. */
  async declareRunState(runState: "idle" | "busy"): Promise<Frame> {
    return await this.request({
      operation: "notify",
      target: { target: "omp", session: sessionRefFor(this.input) },
      payload: { topic: "broker.session.status", data: { runState } },
    });
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      // best-effort
    }
  }
}

export function sessionRefFor(input: {
  projectId: string;
  workspaceId: string;
  nativeSessionId?: string;
}, overrides?: { target?: string; scope?: "project" | "workspace"; nativeSessionId?: string }): Record<string, unknown> {
  const scope = overrides?.scope ?? "workspace";
  return {
    projectId: input.projectId,
    scope,
    ...(scope === "workspace" ? { workspaceId: input.workspaceId } : {}),
    target: overrides?.target ?? "omp",
    nativeSessionId: overrides?.nativeSessionId ?? input.nativeSessionId ?? "session-0001",
  };
}

export async function openPeer(input: OpenPeerInput): Promise<FakePeer> {
  const raw = new WebSocket(input.url);
  const peer = new FakePeer(raw, input);
  await waitForValue(() => (raw.readyState === 1 ? true : undefined), `conexión WS abierta a ${input.url}`);
  peer.hello();
  // Obtención DETERMINISTA del welcome: se espera el frame (o el error/cierre
  // tipado) con timeout acotado; jamás se resuelve "al abrir el socket".
  await waitForValue(
    () => (peer.welcome !== undefined || peer.errors.length > 0 || peer.closeCode !== undefined ? true : undefined),
    `welcome o error de handshake en ${input.url}`,
  );
  return peer;
}

export function expectWelcome(peer: FakePeer): Frame {
  if (peer.welcome === undefined) {
    throw new Error(
      `esperaba welcome; errores=${JSON.stringify(peer.errors)} closeCode=${String(peer.closeCode)} frames=${JSON.stringify(peer.frames)}`,
    );
  }
  return peer.welcome;
}

export function expectError(frame: Frame, code: ProtocolErrorCode, reason: ProtocolErrorReason): ProtocolError {
  expect(frame.kind).toBe("error");
  const error = frame["error"] as ProtocolError | undefined;
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("sin error tipado");
  expect(error.code).toBe(code);
  expect(error.reason).toBe(reason);
  return error;
}

export function expectResponseError(frame: Frame, code: ProtocolErrorCode, reason: ProtocolErrorReason): void {
  expect(frame.kind).toBe("response");
  const error = frame["error"] as ProtocolError | undefined;
  expect(error).toBeDefined();
  if (error === undefined) throw new Error("sin error tipado en response");
  expect(error.code).toBe(code);
  expect(error.reason).toBe(reason);
}

// ---------------------------------------------------------- bind_root util

export async function bindRoot(
  peer: FakePeer,
  input: {
    macKey: string;
    target: string;
    sessionRef?: Record<string, unknown>;
    proof?: RootProof;
    claim?: unknown;
    nowMs: number;
  },
): Promise<Frame> {
  const welcome = expectWelcome(peer);
  const proof =
    input.proof ??
    makeRootProof({
      macKey: input.macKey,
      instanceId: peer.input.instanceId,
      nativeSessionId: peer.input.nativeSessionId ?? "session-0001",
      challenge: String(welcome["serverChallenge"]),
      audience: String(welcome["connectionId"]),
      nowMs: input.nowMs,
    });
  const mark = peer.mark();
  peer.send({
    kind: "bind_root",
    v: 1,
    claim: input.claim ?? { kind: "root_proof", proof },
    target: input.target,
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
  });
  return await peer.nextFrame(mark, "respuesta de bind_root");
}

// -------------------------------------------------------- broker + proceso

export interface BrokerHandle {
  readonly server: BrokerServer;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startBroker(input: {
  dataDir: string;
  clock: FakeClock;
  macKey?: string;
}): Promise<BrokerHandle> {
  const server = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
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

export interface ChildBroker {
  readonly port: number;
  readonly pid: number;
  kill(): Promise<void>;
}

/**
 * Proceso hijo real para crash fiel (SIGKILL): el lock de escritor único vive
 * por pid, así que la reconexión/reclamación tras crash es determinista.
 *
 * `nowMs` inyecta el MISMO reloj de la suite en el hijo: sin él, el hijo
 * valida grants/pruebas con el reloj real y todo handshake falla por vigencia.
 */
export async function spawnBrokerProcess(input: {
  tmpDir: string;
  home: string;
  dataDir: string;
  macKey: string;
  entryPath: string;
  nowMs: number;
}): Promise<ChildBroker> {
  const scriptPath = join(input.tmpDir, "broker-child.ts");
  writeFileSync(
    scriptPath,
    [
      `// Import dinámico justificado: el entrypoint es una ruta runtime (env del`,
      `// proceso hijo) para poder matar el proceso con SIGKILL sin tocar el repo.`,
      `const entry = process.env.BROKER_ENTRY ?? "";`,
      `const mod = await import(entry);`,
      `const server = mod.createBrokerServer({`,
      `  host: "127.0.0.1",`,
      `  port: 0,`,
      `  dataDir: process.env.BROKER_DATA_DIR ?? "",`,
      `  macKey: process.env.BROKER_MAC_KEY,`,
      `  now: () => Number(process.env.BROKER_NOW_MS ?? Date.now()),`,
      `});`,
      `const address = await server.listen();`,
      `process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\\n");`,
    ].join("\n"),
    "utf8",
  );
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", scriptPath],
    cwd: input.tmpDir,
    env: {
      ...process.env,
      HOME: input.home,
      BROKER_ENTRY: input.entryPath,
      BROKER_DATA_DIR: input.dataDir,
      BROKER_MAC_KEY: input.macKey,
      BROKER_NOW_MS: String(input.nowMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = await readReadyPort(proc.stdout);
  // Barrera de readiness: el hijo debe estar respondiendo /health antes de
  // devolver el control (espera por condición acotada, sin sleeps arbitrarios).
  await waitForHealth(port);
  return {
    port,
    pid: proc.pid,
    kill: async () => {
      try {
        proc.kill(9);
      } catch {
        // best-effort
      }
      await proc.exited;
    },
  };
}

/** Espera acotada a que el /health del proceso responda `ok` (loopback). */
async function waitForHealth(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const payload = (await response.json()) as { ok?: boolean };
      if (payload.ok === true) return;
    } catch {
      // aún no escucha: se reintenta por condición
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando /health del broker hijo en puerto ${port}`);
    }
    await sleep(20);
  }
}

async function readReadyPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timeout esperando broker hijo; buffer=${buffer}`);
    const readResult = await Promise.race([
      reader.read(),
      sleep(15_000).then(() => ({ done: true, value: undefined })),
    ]);
    if (readResult.done) {
      if (buffer.length === 0) throw new Error("broker hijo terminó sin anunciar puerto");
      break;
    }
    if (readResult.value !== undefined) buffer += decoder.decode(readResult.value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline);
      const parsed = JSON.parse(line) as { ready?: boolean; port?: number };
      if (parsed.ready === true && typeof parsed.port === "number") return parsed.port;
      throw new Error(`línea inesperada del broker hijo: ${line}`);
    }
  }
  throw new Error(`broker hijo sin puerto; buffer=${buffer}`);
}

// ------------------------------------------------------------- identidades

export function freshIdentity(): {
  projectId: string;
  workspaceId: string;
  instanceId: string;
  nativeSessionId: string;
} {
  return {
    projectId: newProjectId(),
    workspaceId: newWorkspaceId(),
    instanceId: newInstanceId(),
    nativeSessionId: `session-${randomBytes(4).toString("hex")}`,
  };
}

export const ALL_ADAPTER_CAPABILITIES: readonly Capability[] = [
  "session.identity",
  "session.observe",
  "session.prompt.when_idle",
  "session.reply_tool",
  "session.notify",
  "session.control.prompt",
  "session.control.steer",
  "session.control.follow_up",
  "session.control.abort",
];
