/**
 * Cliente público reutilizable del session broker (P-003 / G-001).
 *
 * Superficie pública: `createClient` + `BrokerClient`/`ClientOptions`/`Subscription`
 * (firmas DEBIDAS de `docs/contracts/packages.md`) y los errores tipados de
 * `./errors`.
 *
 * Garantías:
 *  - Importar el módulo o crear el cliente NO conecta, NO abre sockets y NO
 *    ejecuta inferencia: todo efecto ocurre al llamar `connect()`.
 *  - `connect()` completa el handshake (`hello` → `welcome`) con negociación
 *    estricta de versión (`negotiateProtocolVersion`, sin fuzzy matching).
 *  - `request()` correlaciona por `requestId` y RESUELVE con el
 *    `ResponseEnvelope` del broker; los errores del protocolo viajan en
 *    `ResponseEnvelope.error` (tabla congelada) sin reintentos ciegos.
 *  - Timeout/abort terminan la ESPERA local (`BrokerClientError` con el
 *    `requestId` conservado) y jamás afirman cancelar trabajo remoto.
 *  - Reconexión con backoff + jitter (`LIMITS`) SOLO para suscripciones
 *    activas, reanudando por cursor `eventSeq`; cursor expirado y cortes por
 *    backpressure se reportan como error tipado, nunca con eventos inventados.
 *  - `ws://` exige política local explícita (`allowInsecureWs`) y loopback;
 *    nunca se degrada ni se mejora el transporte automáticamente.
 *
 * Sin SQLite, sin OMP, sin internals del servidor y sin dependencias externas:
 * usa el `WebSocket` global del runtime (Bun).
 */

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  LIMITS,
  PROTOCOL_MAJOR,
  checkFrameSize,
  checkOperationSupport,
  isPlainObject,
  isGrantId,
  isInstanceId,
  isProjectId,
  isWorkspaceId,
  isValidControlEpoch,
  newRequestId,
  negotiateProtocolVersion,
  protocolError,
  validateEventEnvelope,
  validateRequestEnvelope,
  validateResponseEnvelope,
  validateWelcome,
  type AskPayload,
  type Capability,
  type ControlEpoch,
  type ControlPayload,
  type EventEnvelope,
  type GrantId,
  type HelloMessage,
  type HistoryPayload,
  type InstanceId,
  type InspectPayload,
  type ListPayload,
  type NotifyPayload,
  type Operation,
  type ProjectId,
  type ProtocolError,
  type QueryPayload,
  type ReplyPayload,
  type RequestEnvelope,
  type RequestId,
  type ResponseEnvelope,
  type SubscribePayload,
  type TargetRef,
  type WelcomeMessage,
  type WorkspaceId,
} from "@session-broker/protocol";
import { BrokerClientError, errorMessage } from "./errors";

export interface ClientOptions {
  endpoint: string;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  instanceId: InstanceId;
  grantId: GrantId;
  credential: string;
  protocolVersions?: readonly string[];
  now?: () => number;
  /**
   * Política LOCAL explícita para endpoints `ws://` (fixtures/entornos locales
   * acordados). Sin ella, `ws://` se rechaza; nunca se degrada a inseguro ni
   * se mejora a `wss://` automáticamente. Aditivo P-003 sobre el freeze.
   */
  allowInsecureWs?: boolean;
  /**
   * Espera/deadline por defecto (ms) para operaciones tipadas y para
   * `request()` sin `deadlineMs`. Aditivo P-003 sobre el freeze.
   */
  requestTimeoutMs?: number;
}

export interface Subscription {
  readonly topic: string;
  /**
   * Aditivo P-003: resultado del alta de la suscripción (ack del broker o
   * rechazo tipado). Nunca queda como rechazo no observado.
   */
  readonly ack: Promise<ResponseEnvelope>;
  /**
   * Aditivo P-003: cierre de la suscripción. Resuelve con `null` si la cerró
   * el consumidor y con el error tipado (p. ej. `QUEUE_FULL`,
   * `CURSOR_EXPIRED`) si la cortó el broker. No se inventan eventos de cierre.
   */
  readonly closed: Promise<BrokerClientError | null>;
  close(): void;
}

export interface BrokerClient {
  connect(): Promise<WelcomeMessage>;
  close(): Promise<void>;
  request(envelope: RequestEnvelope): Promise<ResponseEnvelope>;
  query(payload: QueryPayload, target: TargetRef): Promise<ResponseEnvelope>;
  list(payload: ListPayload, target: TargetRef): Promise<ResponseEnvelope>;
  inspect(payload: InspectPayload, target: TargetRef): Promise<ResponseEnvelope>;
  history(payload: HistoryPayload, target: TargetRef): Promise<ResponseEnvelope>;
  subscribe(
    payload: SubscribePayload,
    target: TargetRef,
    onEvent: (event: EventEnvelope) => void,
  ): Subscription;
  ask(payload: AskPayload, target: TargetRef): Promise<ResponseEnvelope>;
  reply(payload: ReplyPayload, target: TargetRef): Promise<ResponseEnvelope>;
  notify(payload: NotifyPayload, target: TargetRef): Promise<ResponseEnvelope>;
  control(payload: ControlPayload, target: TargetRef, controlEpoch: ControlEpoch): Promise<ResponseEnvelope>;
}

/** Capacidades declaradas por este cliente en el `hello` (todo salvo root binding). */
const CLIENT_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => capability !== CAPABILITIES.rootBinding,
);

const CLIENT_NAME = "@session-broker/client";
const CLIENT_VERSION = "0.1.0";

/** Identidad opaca de un temporizador del runtime (no forma parte del contrato público). */
type TimerHandle = ReturnType<typeof setTimeout>;

type SocketListener = (event: { data?: unknown }) => void;

interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: SocketListener): void;
}

type SocketCtor = new (url: string) => SocketLike;

type ConnectionState = "idle" | "connecting" | "connected" | "closed";

interface PendingRequest {
  readonly requestId: RequestId;
  readonly operation: Operation;
  readonly resolve: (response: ResponseEnvelope) => void;
  readonly reject: (error: BrokerClientError) => void;
  readonly timer: TimerHandle;
}

interface HandshakeWait {
  readonly resolve: (welcome: WelcomeMessage) => void;
  readonly reject: (error: BrokerClientError) => void;
  readonly timer: TimerHandle;
}

interface SubscriptionState {
  readonly topics: readonly string[];
  readonly target: TargetRef;
  readonly onEvent: (event: EventEnvelope) => void;
  readonly ack: Promise<ResponseEnvelope>;
  readonly closed: Promise<BrokerClientError | null>;
  currentRequestId: RequestId;
  baseFromEventSeq: number;
  lastEventSeq: number;
  ackSettled: boolean;
  finished: boolean;
  resolveAck(response: ResponseEnvelope): void;
  rejectAck(error: BrokerClientError): void;
  finish(error: BrokerClientError | null): void;
}

function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/** Política de transporte: `wss://` siempre; `ws://` solo con política explícita y loopback. */
function checkEndpointPolicy(endpoint: string, allowInsecureWs: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BrokerClientError("invalid_input", "endpoint no interpretable (se espera una URL ws:// o wss://)");
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:") {
    if (!allowInsecureWs) {
      throw new BrokerClientError(
        "invalid_input",
        "endpoint ws:// requiere política local explícita (allowInsecureWs); el transporte inseguro nunca se acepta ni se degrada automáticamente",
      );
    }
    if (!loopbackHost(url.hostname)) {
      throw new BrokerClientError(
        "invalid_input",
        "endpoint ws:// solo se permite en loopback con política local explícita; para remoto usa wss://",
      );
    }
    return url;
  }
  throw new BrokerClientError("invalid_input", `esquema de endpoint no soportado: ${url.protocol} (usa wss://)`);
}

function createSubscriptionState(input: {
  topics: readonly string[];
  target: TargetRef;
  onEvent: (event: EventEnvelope) => void;
  requestId: RequestId;
  fromEventSeq: number;
}): SubscriptionState {
  const ack = Promise.withResolvers<ResponseEnvelope>();
  // El consumidor puede no observar `ack`; nunca debe quedar un rechazo sin manejar.
  void ack.promise.catch(() => undefined);
  const closed = Promise.withResolvers<BrokerClientError | null>();
  return {
    topics: input.topics,
    target: input.target,
    onEvent: input.onEvent,
    ack: ack.promise,
    closed: closed.promise,
    currentRequestId: input.requestId,
    baseFromEventSeq: input.fromEventSeq,
    lastEventSeq: 0,
    ackSettled: false,
    finished: false,
    resolveAck(response: ResponseEnvelope): void {
      ack.resolve(response);
    },
    rejectAck(error: BrokerClientError): void {
      ack.reject(error);
    },
    finish(error: BrokerClientError | null): void {
      closed.resolve(error);
    },
  };
}

/**
 * Backoff de reconexión (FR-009 / NFR-004): base exponencial acotada por
 * `reconnectBackoffMsMax` más jitter simétrico `reconnectJitterRatio`. Función
 * pura y determinista (`random` ∈ 0..1 inyectable) para poder verificar los
 * límites con contadores y reloj de fixture, sin tormentas de reconexión
 * reales ni benchmarks de wall time.
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  const base = Math.min(LIMITS.reconnectBackoffMsInitial * 2 ** safeAttempt, LIMITS.reconnectBackoffMsMax);
  const jitter = base * LIMITS.reconnectJitterRatio * (random * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

class WsBrokerClient implements BrokerClient {
  private readonly options: ClientOptions;
  private readonly protocolVersions: readonly string[];
  private readonly nowFn: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly endpointUrl: URL;
  private state: ConnectionState = "idle";
  private socket: SocketLike | undefined;
  private welcomeMessage: WelcomeMessage | undefined;
  private handshake: HandshakeWait | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions: SubscriptionState[] = [];
  private reconnectTimer: TimerHandle | undefined;
  private reconnectAttempt = 0;

  constructor(options: ClientOptions) {
    if (!isProjectId(options.projectId)) {
      throw new BrokerClientError("invalid_input", "projectId inválido", {
        protocolError: protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", "projectId"),
      });
    }
    if (!isWorkspaceId(options.workspaceId)) {
      throw new BrokerClientError("invalid_input", "workspaceId inválido", {
        protocolError: protocolError("INVALID_INPUT", "invalid_format", "workspaceId inválido", "workspaceId"),
      });
    }
    if (!isInstanceId(options.instanceId)) {
      throw new BrokerClientError("invalid_input", "instanceId inválido", {
        protocolError: protocolError("INVALID_INPUT", "invalid_format", "instanceId inválido", "instanceId"),
      });
    }
    if (!isGrantId(options.grantId)) {
      throw new BrokerClientError("invalid_input", "grantId inválido", {
        protocolError: protocolError("INVALID_INPUT", "invalid_format", "grantId inválido", "grantId"),
      });
    }
    if (typeof options.credential !== "string" || options.credential.length === 0) {
      throw new BrokerClientError("invalid_input", "credential ausente o inválida", {
        protocolError: protocolError("UNAUTHORIZED", "unauthorized_scope", "credencial ausente o inválida", "credential"),
      });
    }
    const versions = options.protocolVersions ?? ["1.0.0"];
    if (versions.length === 0) {
      throw new BrokerClientError("invalid_input", "protocolVersions no puede estar vacío", {
        protocolError: protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "protocolVersions inválido", "protocolVersions"),
      });
    }
    for (const version of versions) {
      const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (parsed === null) {
        throw new BrokerClientError("invalid_input", `versión de protocolo no interpretable: ${version}`, {
          protocolError: protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "versión no interpretable", "protocolVersions"),
        });
      }
    }
    const timeout = options.requestTimeoutMs ?? LIMITS.requestTimeoutMsDefault;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > LIMITS.requestTimeoutMsMax) {
      throw new BrokerClientError(
        "invalid_input",
        `requestTimeoutMs debe estar en 1..${LIMITS.requestTimeoutMsMax}`,
        {
          protocolError: protocolError(
            "INVALID_INPUT",
            "deadline_out_of_bounds",
            `requestTimeoutMs debe estar en 1..${LIMITS.requestTimeoutMsMax}`,
            "requestTimeoutMs",
          ),
        },
      );
    }
    this.options = options;
    this.protocolVersions = versions;
    this.nowFn = options.now ?? Date.now;
    this.defaultTimeoutMs = timeout;
    this.endpointUrl = checkEndpointPolicy(options.endpoint, options.allowInsecureWs === true);
  }

  async connect(): Promise<WelcomeMessage> {
    if (this.state === "closed") {
      throw new BrokerClientError("closed", "cliente cerrado; crea un cliente nuevo para reconectar");
    }
    if (this.state === "connected" && this.welcomeMessage !== undefined) {
      return this.welcomeMessage;
    }
    if (this.state === "connecting") {
      throw new BrokerClientError("invalid_input", "connect() ya está en curso");
    }
    return await this.openSocket();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const handshake = this.handshake;
    this.handshake = undefined;
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      handshake.reject(new BrokerClientError("aborted", "handshake abortado por close(); no se estableció conexión"));
    }
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(
        new BrokerClientError(
          "aborted",
          `espera local abortada (close) de ${entry.operation}; el trabajo remoto NO fue cancelado; conserva el requestId ${entry.requestId} para consultar su estado`,
          { requestId: entry.requestId },
        ),
      );
    }
    for (const sub of this.subscriptions) {
      if (!sub.finished) {
        sub.finished = true;
        sub.finish(null);
      }
    }
    this.subscriptions.length = 0;
    const socket = this.socket;
    this.socket = undefined;
    this.welcomeMessage = undefined;
    try {
      socket?.close();
    } catch {
      // el cierre ya estaba en curso
    }
  }

  async request(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    if (this.state === "closed") {
      throw new BrokerClientError("closed", "cliente cerrado; no se pueden enviar solicitudes", {
        requestId: envelope.requestId,
      });
    }
    const validated = validateRequestEnvelope(envelope);
    if (!validated.ok) {
      throw new BrokerClientError("invalid_input", validated.error.message, {
        protocolError: validated.error,
        requestId: envelope.requestId,
      });
    }
    const socket = this.socket;
    if (this.state !== "connected" || socket === undefined) {
      throw new BrokerClientError(
        "connection",
        "cliente no conectado; llama connect() antes de solicitar (la solicitud NO fue enviada ni ejecutada)",
        { requestId: validated.value.requestId },
      );
    }
    const requestId = validated.value.requestId;
    if (this.pending.has(requestId)) {
      throw new BrokerClientError(
        "invalid_input",
        `requestId ya en vuelo: ${requestId}; la correlación exige unicidad por proyecto`,
        {
          protocolError: protocolError("INVALID_INPUT", "invalid_field", "requestId duplicado en vuelo", "requestId"),
          requestId,
        },
      );
    }
    const frame = JSON.stringify(validated.value);
    const size = checkFrameSize(frame);
    if (!size.ok) {
      throw new BrokerClientError("invalid_input", size.error.message, { protocolError: size.error, requestId });
    }
    const waiter = Promise.withResolvers<ResponseEnvelope>();
    const timeoutMs = validated.value.deadlineMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      waiter.reject(
        new BrokerClientError(
          "timeout",
          `espera local agotada (${timeoutMs} ms) para ${validated.value.operation}; el trabajo remoto NO fue cancelado ni se reintentó; conserva el requestId ${requestId} para consultar su estado`,
          { requestId },
        ),
      );
    }, timeoutMs);
    this.pending.set(requestId, {
      requestId,
      operation: validated.value.operation,
      resolve: waiter.resolve,
      reject: waiter.reject,
      timer,
    });
    try {
      socket.send(frame);
    } catch (sendError) {
      this.pending.delete(requestId);
      clearTimeout(timer);
      waiter.reject(
        new BrokerClientError(
          "connection",
          `no se pudo enviar la solicitud: ${errorMessage(sendError)}; el trabajo remoto NO se ejecutó desde este envío`,
          { requestId },
        ),
      );
    }
    return await waiter.promise;
  }

  async query(payload: QueryPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("query", payload, target);
  }

  async list(payload: ListPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("list", payload, target);
  }

  async inspect(payload: InspectPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("inspect", payload, target);
  }

  async history(payload: HistoryPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("history", payload, target);
  }

  subscribe(
    payload: SubscribePayload,
    target: TargetRef,
    onEvent: (event: EventEnvelope) => void,
  ): Subscription {
    if (this.state === "closed") {
      throw new BrokerClientError("closed", "cliente cerrado; no se pueden abrir suscripciones");
    }
    if (this.state !== "connected" || this.socket === undefined) {
      throw new BrokerClientError(
        "connection",
        "cliente no conectado; llama connect() antes de suscribir (la suscripción NO fue enviada)",
      );
    }
    const envelope = this.buildEnvelope("subscribe", payload, target);
    const validated = validateRequestEnvelope(envelope);
    if (!validated.ok) {
      throw new BrokerClientError("invalid_input", validated.error.message, { protocolError: validated.error });
    }
    this.assertOperationSupported(validated.value);
    const topics = [...payload.topics];
    const state = createSubscriptionState({
      topics,
      target,
      onEvent,
      requestId: validated.value.requestId,
      fromEventSeq: payload.fromEventSeq ?? 1,
    });
    this.subscriptions.push(state);
    const frame = JSON.stringify(validated.value);
    const size = checkFrameSize(frame);
    if (!size.ok) {
      this.removeSubscription(state);
      throw new BrokerClientError("invalid_input", size.error.message, { protocolError: size.error });
    }
    try {
      this.socket.send(frame);
    } catch (sendError) {
      this.removeSubscription(state);
      throw new BrokerClientError(
        "connection",
        `no se pudo enviar la suscripción: ${errorMessage(sendError)}; la suscripción NO quedó activa`,
      );
    }
    return {
      topic: topics.join(","),
      ack: state.ack,
      closed: state.closed,
      close: () => {
        if (!state.finished) {
          state.finished = true;
          this.removeSubscription(state);
          state.finish(null);
        }
      },
    };
  }

  async ask(payload: AskPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("ask", payload, target);
  }

  async reply(payload: ReplyPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("reply", payload, target);
  }

  async notify(payload: NotifyPayload, target: TargetRef): Promise<ResponseEnvelope> {
    return await this.sendOperation("notify", payload, target);
  }

  async control(payload: ControlPayload, target: TargetRef, controlEpoch: ControlEpoch): Promise<ResponseEnvelope> {
    if (!isValidControlEpoch(controlEpoch)) {
      throw new BrokerClientError(
        "invalid_input",
        "control exige un controlEpoch explícito y vigente (entero seguro ≥ 0); no se infiere ni se reutiliza en silencio",
        {
          protocolError: protocolError(
            "STALE_CONTROL_EPOCH",
            "stale_control_epoch",
            "control requiere controlEpoch numérico vigente",
            "controlEpoch",
          ),
        },
      );
    }
    return await this.sendOperation("control", payload, target, controlEpoch);
  }

  private async sendOperation(
    operation: Operation,
    payload: unknown,
    target: TargetRef,
    controlEpoch?: ControlEpoch,
  ): Promise<ResponseEnvelope> {
    const envelope = this.buildEnvelope(operation, payload, target, controlEpoch);
    const validated = validateRequestEnvelope(envelope);
    if (!validated.ok) {
      throw new BrokerClientError("invalid_input", validated.error.message, {
        protocolError: validated.error,
        requestId: envelope.requestId,
      });
    }
    this.assertOperationSupported(validated.value);
    return await this.request(validated.value);
  }

  private buildEnvelope(
    operation: Operation,
    payload: unknown,
    target: TargetRef,
    controlEpoch?: ControlEpoch,
  ): RequestEnvelope {
    const envelope: RequestEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "request",
      requestId: newRequestId(),
      operation,
      target,
      payload,
      grantId: this.options.grantId,
      sentAtMs: this.nowFn(),
      deadlineMs: this.defaultTimeoutMs,
    };
    if (controlEpoch !== undefined) {
      return { ...envelope, controlEpoch };
    }
    return envelope;
  }

  /** Falla cerrada ante capacidades ausentes: `unsupported` nunca se convierte en otra operación. */
  private assertOperationSupported(envelope: RequestEnvelope): void {
    const welcome = this.welcomeMessage;
    if (welcome === undefined) return;
    let verb: string | undefined;
    if (envelope.operation === "control") {
      const controlPayload: unknown = envelope.payload;
      if (typeof controlPayload === "object" && controlPayload !== null && "verb" in controlPayload) {
        const rawVerb: unknown = controlPayload.verb;
        verb = typeof rawVerb === "string" ? rawVerb : undefined;
      }
    }
    const support = checkOperationSupport(envelope.operation, verb, welcome.serverCapabilities);
    if (!support.ok) {
      throw new BrokerClientError("protocol", support.error.message, {
        protocolError: support.error,
        requestId: envelope.requestId,
      });
    }
  }

  private openSocket(): Promise<WelcomeMessage> {
    const waiter = Promise.withResolvers<WelcomeMessage>();
    // `globalThis` no tipa el WebSocket del runtime de forma uniforme.
    const globals = globalThis as { WebSocket?: SocketCtor };
    const ctor = globals.WebSocket;
    if (typeof ctor !== "function") {
      waiter.reject(new BrokerClientError("connection", "este runtime no expone un WebSocket global"));
      return waiter.promise;
    }
    let socket: SocketLike;
    try {
      socket = new ctor(this.endpointUrl.toString());
    } catch (openError) {
      waiter.reject(new BrokerClientError("connection", `no se pudo abrir la conexión: ${errorMessage(openError)}`));
      return waiter.promise;
    }
    this.socket = socket;
    this.state = "connecting";
    const timer = setTimeout(() => {
      this.handshake = undefined;
      try {
        socket.close();
      } catch {
        // el socket ya estaba cerrado
      }
      waiter.reject(
        new BrokerClientError(
          "timeout",
          `handshake agotado (${this.defaultTimeoutMs} ms) sin welcome; no se estableció conexión`,
        ),
      );
    }, this.defaultTimeoutMs);
    this.handshake = { resolve: waiter.resolve, reject: waiter.reject, timer };
    socket.addEventListener("open", () => {
      this.sendHello(socket);
    });
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.handleSocketClosed();
    });
    return waiter.promise;
  }

  private sendHello(socket: SocketLike): void {
    const hello: HelloMessage = {
      kind: "hello",
      v: PROTOCOL_MAJOR,
      protocolVersions: [...this.protocolVersions],
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
      projectId: this.options.projectId,
      workspaceId: this.options.workspaceId,
      instanceId: this.options.instanceId,
      grantId: this.options.grantId,
      credential: this.options.credential,
      capabilities: CLIENT_CAPABILITIES,
    };
    try {
      socket.send(JSON.stringify(hello));
    } catch (sendError) {
      const handshake = this.handshake;
      this.handshake = undefined;
      if (handshake !== undefined) {
        clearTimeout(handshake.timer);
        handshake.reject(
          new BrokerClientError("connection", `no se pudo enviar el hello: ${errorMessage(sendError)}`),
        );
      }
    }
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.failProtocol(protocolError("INVALID_INPUT", "schema_malformed", "frame no interpretable (JSON inválido)", "frame"));
      return;
    }
    if (!isPlainObject(parsed)) {
      this.failProtocol(protocolError("INVALID_INPUT", "schema_malformed", "frame debe ser un objeto", "frame"));
      return;
    }
    const kind: unknown = parsed.kind;
    if (kind === "welcome") {
      this.handleWelcome(parsed);
      return;
    }
    if (kind === "error") {
      this.handleServerError(parsed);
      return;
    }
    if (kind === "response") {
      const validated = validateResponseEnvelope(parsed);
      if (!validated.ok) {
        this.failProtocol(validated.error);
        return;
      }
      this.handleResponse(validated.value);
      return;
    }
    if (kind === "event") {
      const validated = validateEventEnvelope(parsed);
      if (!validated.ok) {
        this.failProtocol(validated.error);
        return;
      }
      this.handleEvent(validated.value);
      return;
    }
    this.failProtocol(protocolError("INVALID_INPUT", "schema_malformed", `kind de frame desconocido: ${String(kind)}`, "kind"));
  }

  private handleWelcome(raw: Record<string, unknown>): void {
    const handshake = this.handshake;
    const validated = validateWelcome(raw);
    if (!validated.ok) {
      this.handshake = undefined;
      if (handshake !== undefined) {
        clearTimeout(handshake.timer);
        handshake.reject(new BrokerClientError("protocol", validated.error.message, { protocolError: validated.error }));
      }
      return;
    }
    const negotiated = negotiateProtocolVersion(this.protocolVersions, [validated.value.protocolVersion]);
    if (!negotiated.ok) {
      this.handshake = undefined;
      if (handshake !== undefined) {
        clearTimeout(handshake.timer);
        handshake.reject(new BrokerClientError("protocol", negotiated.error.message, { protocolError: negotiated.error }));
      }
      return;
    }
    this.welcomeMessage = validated.value;
    this.state = "connected";
    this.handshake = undefined;
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      handshake.resolve(validated.value);
    }
  }

  private handleServerError(raw: Record<string, unknown>): void {
    const rawError: unknown = raw.error;
    let error: ProtocolError;
    if (
      isPlainObject(rawError) &&
      typeof rawError.code === "string" &&
      typeof rawError.reason === "string" &&
      typeof rawError.message === "string"
    ) {
      error = protocolError(
        rawError.code as ProtocolError["code"],
        rawError.reason as ProtocolError["reason"],
        rawError.message,
        typeof rawError.path === "string" ? rawError.path : undefined,
      );
    } else {
      error = protocolError("INVALID_INPUT", "schema_malformed", "frame de error del servidor malformado", "error");
    }
    const handshake = this.handshake;
    this.handshake = undefined;
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      handshake.reject(new BrokerClientError("protocol", error.message, { protocolError: error }));
      return;
    }
    this.failProtocol(error);
  }

  private handleResponse(response: ResponseEnvelope): void {
    const pending = this.pending.get(response.requestId);
    if (pending !== undefined) {
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
      return;
    }
    for (const sub of this.subscriptions) {
      if (!sub.finished && sub.currentRequestId === response.requestId) {
        this.handleSubscriptionResponse(sub, response);
        return;
      }
    }
    // Respuesta sin correlación conocida: se ignora sin inventar eventos ni efectos.
  }

  private handleSubscriptionResponse(sub: SubscriptionState, response: ResponseEnvelope): void {
    if (response.error !== undefined) {
      const error = new BrokerClientError("protocol", response.error.message, {
        protocolError: response.error,
        requestId: sub.currentRequestId,
      });
      if (!sub.ackSettled) {
        sub.ackSettled = true;
        sub.rejectAck(error);
      }
      if (!sub.finished) {
        sub.finished = true;
        this.removeSubscription(sub);
        sub.finish(error);
      }
      return;
    }
    if (!sub.ackSettled) {
      sub.ackSettled = true;
      sub.resolveAck(response);
    }
  }

  private handleEvent(event: EventEnvelope): void {
    for (const sub of this.subscriptions) {
      if (sub.finished) continue;
      if (!sub.topics.includes(event.topic)) continue;
      if (event.eventSeq <= sub.lastEventSeq) continue;
      sub.lastEventSeq = event.eventSeq;
      try {
        sub.onEvent(event);
      } catch {
        // un error del consumidor no corrige ni rompe la conexión
      }
    }
  }

  private failProtocol(error: ProtocolError): void {
    const handshake = this.handshake;
    this.handshake = undefined;
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      handshake.reject(new BrokerClientError("protocol", error.message, { protocolError: error }));
    }
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(
        new BrokerClientError(
          "protocol",
          `${error.message}; solicitud ${entry.requestId} sin respuesta correlacionada`,
          { protocolError: error, requestId: entry.requestId },
        ),
      );
    }
  }

  private handleSocketClosed(): void {
    this.socket = undefined;
    this.welcomeMessage = undefined;
    const handshake = this.handshake;
    this.handshake = undefined;
    if (handshake !== undefined) {
      clearTimeout(handshake.timer);
      handshake.reject(
        new BrokerClientError("connection", "conexión cerrada antes de completar el handshake; no se estableció conexión"),
      );
    }
    if (this.state === "closed") return;
    this.state = "idle";
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(
        new BrokerClientError(
          "connection",
          `conexión perdida antes de la respuesta de ${entry.operation}; el trabajo remoto NO se marca fallido ni cancelado y NO se reintenta; conserva el requestId ${entry.requestId} para consultar su estado`,
          { requestId: entry.requestId },
        ),
      );
    }
    if (this.subscriptions.some((sub) => !sub.finished)) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.state === "closed" || this.reconnectTimer !== undefined) return;
    const delay = reconnectDelayMs(this.reconnectAttempt, Math.random());
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.state === "closed") return;
    try {
      await this.openSocket();
      this.reconnectAttempt = 0;
      this.resubscribeAll();
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Reanuda suscripciones conservando el cursor `eventSeq`; nunca repite eventos ya entregados. */
  private resubscribeAll(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    for (const sub of this.subscriptions) {
      if (sub.finished) continue;
      const envelope = this.buildEnvelope(
        "subscribe",
        {
          topics: sub.topics,
          fromEventSeq: sub.lastEventSeq > 0 ? sub.lastEventSeq + 1 : sub.baseFromEventSeq,
        },
        sub.target,
      );
      sub.currentRequestId = envelope.requestId;
      try {
        socket.send(JSON.stringify(envelope));
      } catch {
        this.scheduleReconnect();
        return;
      }
    }
  }

  private removeSubscription(state: SubscriptionState): void {
    const index = this.subscriptions.indexOf(state);
    if (index >= 0) this.subscriptions.splice(index, 1);
  }
}

/**
 * Crea un cliente sin efectos laterales: no conecta, no abre sockets ni ejecuta
 * inferencia. Los efectos ocurren solo al llamar `connect()`.
 */
export function createClient(options: ClientOptions): BrokerClient {
  return new WsBrokerClient(options);
}
