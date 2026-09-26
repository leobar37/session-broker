/**
 * Canal «holder» del adaptador (P-004): la conexión WS que **registra la
 * sesión** (hello → `bind_root`) y sostiene la autoridad del titular.
 *
 * ¿Por qué un canal propio además de `@session-broker/client`? La superficie
 * congelada del cliente (`docs/contracts/packages.md`, P-003, read-only para
 * P-004) no expone `bind_root` ni `report`, y el broker exige que `reply` y la
 * declaración de `runState` viajen por el peer YA REGISTRADO (`peer.bound`,
 * `apps/broker/src/server.ts`: handlers `#runReply` / `#declareRunState`). Este
 * canal implementa SOLO los frames de interop que el cliente no puede emitir y
 * las requests ligadas a la autoridad del titular; el resto de operaciones
 * (lecturas, `subscribe` de journal, `ask`/`notify` salientes) viajan por
 * `@session-broker/client`.
 *
 * Frames (interop arbitrado por el coordinador; docblock de
 * `apps/broker/src/server.ts`):
 * - error  → `{ kind: "error", error }`
 * - hello  → `HelloMessage`; welcome → `WelcomeMessage`
 * - bind_root → `{ kind: "bind_root", v, claim, target, sessionRef? }`
 * - report → `{ kind: "report", v, requestId, state, result?, error?, atMs }`
 * - request/response/event → envelopes congelados de `@session-broker/protocol`
 */

import {
  LIMITS,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  isPlainObject,
  newRequestId,
  protocolError,
  validateEventEnvelope,
  validateResponseEnvelope,
  validateWelcome,
  type Capability,
  type EventEnvelope,
  type GrantId,
  type InstanceId,
  type NativeSessionId,
  type ProjectId,
  type ProtocolError,
  type RequestEnvelope,
  type RequestId,
  type RequestState,
  type ResponseEnvelope,
  type SessionRef,
  type TargetId,
  type TargetRef,
  type WelcomeMessage,
  type WorkspaceId,
} from "@session-broker/protocol";

const CLIENT_NAME = "@session-broker/omp-adapter";
const CLIENT_VERSION = "0.1.0";

/** Hosts loopback permitidos con política local para `ws://`. */
const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
  "::1": true,
};

/** Error local del canal (espera agotada/conexión/protocolo). No afirma estado remoto. */
export class OmpChannelError extends Error {
  readonly kind: "timeout" | "connection" | "protocol";
  readonly requestId?: RequestId;
  readonly protocolError?: ProtocolError;

  constructor(input: {
    kind: "timeout" | "connection" | "protocol";
    message: string;
    requestId?: RequestId;
    protocolError?: ProtocolError;
  }) {
    super(input.message);
    this.name = "OmpChannelError";
    this.kind = input.kind;
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.protocolError !== undefined) this.protocolError = input.protocolError;
  }
}

export interface HolderChannelOptions {
  endpoint: string;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  instanceId: InstanceId;
  nativeSessionId: NativeSessionId;
  grantId: GrantId;
  credential: string;
  capabilities: readonly Capability[];
  now: () => number;
  /** Entregas `broker.ask`/`broker.notify`/`broker.control` del broker. */
  onEvent: (event: EventEnvelope) => void;
  /** Conexión perdida: el adaptador invalida su binding (sin relanzar nada). */
  onConnectionLost: (reason: string) => void;
  /** Política LOCAL explícita para `ws://` (solo loopback/fixtures). */
  allowInsecureWs?: boolean;
  requestTimeoutMs?: number;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: OmpChannelError): void;
}

interface PendingWait extends Waiter<ResponseEnvelope> {
  readonly timer: Timer;
}

interface ReportWait extends Waiter<ResponseEnvelope> {
  readonly requestId: RequestId;
}

/**
 * Misma política de transporte que `@session-broker/client`: `wss://` siempre;
 * `ws://` solo con política local explícita y loopback. Jamás se degrada a
 * transporte inseguro ni se «mejora» a otro esquema automáticamente.
 */
export function checkEndpointPolicy(endpoint: string, allowInsecureWs: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OmpChannelError({ kind: "protocol", message: "endpoint no interpretable (se espera ws:// o wss://)" });
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:") {
    if (!allowInsecureWs) {
      throw new OmpChannelError({
        kind: "protocol",
        message: "endpoint ws:// requiere política local explícita (allowInsecureWs); jamás se degrada a transporte inseguro",
      });
    }
    if (LOOPBACK_HOSTS[url.hostname] !== true) {
      throw new OmpChannelError({ kind: "protocol", message: "endpoint ws:// solo se permite en loopback con política explícita" });
    }
    return url;
  }
  throw new OmpChannelError({ kind: "protocol", message: `esquema de endpoint no soportado: ${url.protocol} (usa wss://)` });
}

/** Canal holder: hello/bind_root/report + requests del titular sobre un único WS. */
export class HolderChannel {
  readonly #options: HolderChannelOptions;
  readonly #endpointUrl: URL;
  readonly #timeoutMs: number;
  #socket: WebSocket | undefined;
  #welcome: WelcomeMessage | undefined;
  #bindWait: Waiter<EventEnvelope> | undefined;
  readonly #pending = new Map<string, PendingWait>();
  #reportWait: ReportWait | undefined;
  /** Reportes serializados: sus fallos llegan como frame `error` sin correlación. */
  #reportTail: Promise<void> = Promise.resolve();
  #welcomeWaiters: Waiter<WelcomeMessage>[] = [];
  #closed = false;

  constructor(options: HolderChannelOptions) {
    this.#options = options;
    this.#endpointUrl = checkEndpointPolicy(options.endpoint, options.allowInsecureWs === true);
    this.#timeoutMs = options.requestTimeoutMs ?? LIMITS.requestTimeoutMsDefault;
  }

  get welcome(): WelcomeMessage | undefined {
    return this.#welcome;
  }

  /** Conecta y completa el handshake `hello` → `welcome`. */
  connect(): Promise<WelcomeMessage> {
    if (this.#closed) {
      return Promise.reject(new OmpChannelError({ kind: "connection", message: "canal cerrado" }));
    }
    const waiter = Promise.withResolvers<WelcomeMessage>();
    let settled = false;
    const socket = new WebSocket(this.#endpointUrl.href);
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => this.#onClose("socket cerrado"));
    socket.addEventListener("error", () => this.#onClose("error de socket"));
    socket.addEventListener("open", () => {
      try {
        socket.send(
          JSON.stringify({
            kind: "hello",
            v: PROTOCOL_MAJOR,
            protocolVersions: [PROTOCOL_VERSION],
            clientName: CLIENT_NAME,
            clientVersion: CLIENT_VERSION,
            projectId: this.#options.projectId,
            workspaceId: this.#options.workspaceId,
            instanceId: this.#options.instanceId,
            nativeSessionId: this.#options.nativeSessionId,
            grantId: this.#options.grantId,
            credential: this.#options.credential,
            capabilities: [...this.#options.capabilities],
          }),
        );
      } catch (sendError) {
        waiter.reject(new OmpChannelError({ kind: "connection", message: `no se pudo enviar hello: ${String(sendError)}` }));
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      waiter.reject(new OmpChannelError({ kind: "timeout", message: "handshake agotado sin welcome" }));
    }, this.#timeoutMs);
    const bound: Waiter<WelcomeMessage> = {
      resolve: (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiter.resolve(value);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiter.reject(error);
      },
    };
    this.#welcomeWaiters.push(bound);
    return waiter.promise;
  }

  /**
   * Registro raíz con root proof. La confirmación del broker es el evento de
   * registro (`broker.presence`); un frame `error` rechaza el bind.
   */
  bindRoot(input: { claim: unknown; target: TargetId; sessionRef?: SessionRef }): Promise<EventEnvelope> {
    const socket = this.#socket;
    if (socket === undefined || this.#welcome === undefined) {
      return Promise.reject(new OmpChannelError({ kind: "connection", message: "bind_root sin conexión establecida" }));
    }
    const waiter = Promise.withResolvers<EventEnvelope>();
    const timer = setTimeout(() => {
      this.#bindWait = undefined;
      waiter.reject(new OmpChannelError({ kind: "timeout", message: "bind_root agotado sin confirmación" }));
    }, this.#timeoutMs);
    this.#bindWait = {
      resolve: (event) => {
        clearTimeout(timer);
        waiter.resolve(event);
      },
      reject: (error) => {
        clearTimeout(timer);
        waiter.reject(error);
      },
    };
    socket.send(
      JSON.stringify({
        kind: "bind_root",
        v: PROTOCOL_MAJOR,
        claim: input.claim,
        target: input.target,
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      }),
    );
    return waiter.promise;
  }

  /** Reporte de ciclo de vida (`received`/`submitted`/…); serializado. */
  report(requestId: RequestId, state: RequestState, extra?: { result?: unknown; error?: ProtocolError }): Promise<ResponseEnvelope> {
    const send = async (): Promise<ResponseEnvelope> => {
      const socket = this.#socket;
      if (socket === undefined || this.#welcome === undefined) {
        throw new OmpChannelError({ kind: "connection", message: "report sin conexión establecida", requestId });
      }
      const waiter = Promise.withResolvers<ResponseEnvelope>();
      const timer = setTimeout(() => {
        this.#reportWait = undefined;
        waiter.reject(new OmpChannelError({ kind: "timeout", message: `report ${state} agotado`, requestId }));
      }, this.#timeoutMs);
      this.#reportWait = {
        requestId,
        resolve: (response) => {
          clearTimeout(timer);
          waiter.resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          waiter.reject(error);
        },
      };
      socket.send(
        JSON.stringify({
          kind: "report",
          v: PROTOCOL_MAJOR,
          requestId,
          state,
          atMs: this.#options.now(),
          ...(extra?.result === undefined ? {} : { result: extra.result }),
          ...(extra?.error === undefined ? {} : { error: extra.error }),
        }),
      );
      return await waiter.promise;
    };
    const chained = this.#reportTail.then(send, send);
    this.#reportTail = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  /** Request del titular (`reply`, `notify` de runState). */
  request(input: {
    operation: "reply" | "notify";
    target: TargetRef;
    payload: unknown;
    requestId?: RequestId;
    deadlineMs?: number;
  }): Promise<ResponseEnvelope> {
    const socket = this.#socket;
    if (socket === undefined || this.#welcome === undefined) {
      return Promise.reject(new OmpChannelError({ kind: "connection", message: "request sin conexión establecida" }));
    }
    const requestId = input.requestId ?? newRequestId();
    const envelope: RequestEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "request",
      requestId,
      operation: input.operation,
      target: input.target,
      payload: input.payload,
      grantId: this.#options.grantId,
      sentAtMs: this.#options.now(),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    };
    const waiter = Promise.withResolvers<ResponseEnvelope>();
    const timer = setTimeout(() => {
      this.#pending.delete(requestId);
      waiter.reject(new OmpChannelError({ kind: "timeout", message: `request ${input.operation} agotado sin respuesta`, requestId }));
    }, input.deadlineMs ?? this.#timeoutMs);
    this.#pending.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        waiter.resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        waiter.reject(error);
      },
      timer,
    });
    socket.send(JSON.stringify(envelope));
    return waiter.promise;
  }

  /** Cierra el canal y libera timers/esperas; idempotente. */
  close(): void {
    if (this.#closed) return;
    const socket = this.#socket;
    this.#shutdown("canal cerrado");
    try {
      socket?.close();
    } catch {
      // best-effort
    }
    this.#options.onConnectionLost("canal cerrado");
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#shutdown(reason);
    this.#options.onConnectionLost(reason);
  }

  #shutdown(reason: string): void {
    this.#closed = true;
    this.#socket = undefined;
    this.#welcome = undefined;
    const error = new OmpChannelError({ kind: "connection", message: `conexión no disponible: ${reason}` });
    for (const wait of this.#pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(error);
    }
    this.#pending.clear();
    const reportWait = this.#reportWait;
    this.#reportWait = undefined;
    reportWait?.reject(error);
    const bindWait = this.#bindWait;
    this.#bindWait = undefined;
    bindWait?.reject(error);
    for (const waiter of this.#welcomeWaiters) {
      waiter.reject(error);
    }
    this.#welcomeWaiters = [];
  }

  #onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const kind = parsed["kind"];
    if (kind === "welcome") {
      const validated = validateWelcome(parsed);
      if (!validated.ok) return;
      this.#welcome = validated.value;
      for (const waiter of this.#welcomeWaiters.splice(0)) {
        waiter.resolve(validated.value);
      }
      return;
    }
    if (kind === "event") {
      const event = validateEventEnvelope(parsed);
      if (!event.ok) return;
      const bindWait = this.#bindWait;
      if (bindWait !== undefined) {
        this.#bindWait = undefined;
        bindWait.resolve(event.value);
        return;
      }
      this.#options.onEvent(event.value);
      return;
    }
    if (kind === "response") {
      const response = validateResponseEnvelope(parsed);
      if (!response.ok) return;
      const pending = this.#pending.get(response.value.requestId);
      if (pending !== undefined) {
        this.#pending.delete(response.value.requestId);
        pending.resolve(response.value);
        return;
      }
      const reportWait = this.#reportWait;
      if (reportWait !== undefined && reportWait.requestId === response.value.requestId) {
        this.#reportWait = undefined;
        reportWait.resolve(response.value);
      }
      return;
    }
    if (kind === "error") {
      const rawError: unknown = parsed["error"];
      const error =
        isPlainObject(rawError) && typeof rawError["code"] === "string" && typeof rawError["reason"] === "string"
          ? protocolError(
              rawError["code"] as ProtocolError["code"],
              rawError["reason"] as ProtocolError["reason"],
              typeof rawError["message"] === "string" ? rawError["message"] : "error del broker",
              typeof rawError["path"] === "string" ? rawError["path"] : undefined,
            )
          : protocolError("INVALID_INPUT", "schema_malformed", "frame de error malformado", "error");
      const failure = new OmpChannelError({ kind: "protocol", message: error.message, protocolError: error });
      const bindWait = this.#bindWait;
      if (bindWait !== undefined) {
        this.#bindWait = undefined;
        bindWait.reject(failure);
        return;
      }
      const reportWait = this.#reportWait;
      if (reportWait !== undefined) {
        this.#reportWait = undefined;
        reportWait.reject(new OmpChannelError({ kind: "protocol", message: error.message, requestId: reportWait.requestId, protocolError: error }));
        return;
      }
      const first = this.#pending.entries().next();
      if (first.done !== true && first.value !== undefined) {
        const [requestId, wait] = first.value;
        this.#pending.delete(requestId);
        wait.reject(new OmpChannelError({ kind: "protocol", message: error.message, requestId, protocolError: error }));
      }
    }
  }
}
