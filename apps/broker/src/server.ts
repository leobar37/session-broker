/**
 * Servidor lógico del broker (P-002). Privado: la superficie pública del
 * paquete vive en `index.ts` (firma congelada en docs/contracts/packages.md).
 *
 * Un único listener WS acepta conexiones outbound de clientes y adaptadores
 * (no hay listeners por sesión). Sin inferencia, sin scheduler de jobs, sin
 * proveedores: este proceso solo enruta, autoriza y persiste.
 *
 * ## Decisiones de interop (el freeze calla; coordinador las arbitra)
 *
 * 1. **Frame de error** `{ kind: "error", error: ProtocolError }` — forma
 *    acordada con P-003 (el freeze solo dice "welcome … o error").
 * 2. **`bind_root`** `{ kind, v, claim, target, sessionRef? }` — protocol.md
 *    nombra `bind_root` (opcional, ligado al challenge) sin esquema literal.
 *    Registro raíz autenticado: la root proof va ligada al `serverChallenge`
 *    del `welcome` y su **audiencia es el `connectionId`** de la conexión que
 *    la presenta (identidad del broker destinatario para ese intercambio).
 * 3. **`report`** `{ kind, v, requestId, state, result?, error?, atMs }` —
 *    avance de ciclo de vida (`received`/`submitted`/`completed`/…). GAP DE
 *    CONTRATO: la máquina congelada exige que el adaptador reporte
 *    `received` (journal incoming) y `submitted` (API nativa) pero el freeze
 *    no define mensaje para ello. Sin este mensaje esos estados serían
 *    inalcanzables por diseño.
 * 4. **Sin frame de heartbeat propio** — GAP DE CONTRATO: `heartbeatMs` está
 *    congelado pero no existe frame de heartbeat. La presencia vive de
 *    `bind_root`/cierre de conexión y de `lastSeenMs` (cualquier frame entrante
 *    del titular); la vida de transporte usa los pings WS del propio runtime.
 *    El estado ocupado/idle del objetivo viaja en el `notify` congelado con el
 *    tema reservado `broker.session.status` (convención de datos, no de frame)
 *    y solo afecta al gate `TARGET_BUSY` de `control {verb:"prompt"}`.
 * 5. **Temas de journal** (`broker.state`, `broker.presence`, `broker.ask`,
 *    `broker.notify`, `broker.control`, `broker.registered`): nombres de dato
 *    dentro del envelope `event` congelado. Los eventos de entrega/estado
 *    llevan `data.requestId` = el `requestId` de la petición que originó el
 *    evento (el `EventEnvelope` congelado no tiene campo `requestId`); el ack
 *    de `subscribe` es el `response` correlacionado con el `requestId` de la
 *    propia suscripción. Convención de datos reportada al coordinador.
 * 6. **Alta/corte de `subscribe`**: ack = `response` (estado `completed`);
 *    cortes = errores tipados (`QUEUE_FULL`, `CURSOR_EXPIRED`) en frame de
 *    error o en el `response`; nunca eventos inventados.
 * 7. **Provisión de grants**: `<dataDir>/grants.json` con
 *    `{ schemaVersion: 1, grants: GrantTokenRecord[] }` (solo hash de
 *    credencial). Es el único canal de entrada de credenciales.
 * 8. **`GET /health`** en el mismo puerto (proceso/store/schema/peers; sin
 *    secretos ni inferencia).
 * 9. **Respuesta de replay idempotente**: `result: { replay: true, operation,
 *    state, receipts, record }` — registro completo (estado + recibos) con los
 *    campos clave también aplanados (forma ya usada por el fake de P-003), sin
 *    re-despacho jamás.
 * 10. **Errores pre-efecto**: `response` con `state: "rejected"` y `eventId`
 *    efímero (no hay registro durable: un retry con mismo `requestId`+hash
 *    debe poder re-procesarse, como exige `retrySafe`).
 *
 * ## Mapa de rechazos (tabla congelada + regla de no filtrado)
 *
 * | Situación | code/reason |
 * | --- | --- |
 * | credencial/grant desconocido o credencial errónea | `UNAUTHORIZED/unauthorized_scope` |
 * | grant revocado / aún no vigente / expirado | `UNAUTHORIZED/grant_revoked` / `grant_not_yet_valid` / `EXPIRED/grant_expired` |
 * | acción fuera del scope del grant (cualquier dimensión) | `UNAUTHORIZED/unauthorized_scope` (literal de `evaluateGrant`) |
 * | recurso inexistente o de otro ámbito | `NOT_FOUND_OR_FORBIDDEN/unauthorized_scope` (nunca filtra existencia) |
 * | requestId de otro proyecto (dedup) | `UNAUTHORIZED/unauthorized_scope` (`evaluateDedup`) |
 * | plazo vencido (ask tardío, request vencido) | `EXPIRED/deadline_out_of_bounds` |
 *
 * Sin logs por defecto: ni credenciales, ni MAC keys, ni payloads sensibles.
 */

import type { Server, ServerWebSocket } from "bun";
import {
  CAPABILITIES,
  LIMITS,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  assertControlEpoch,
  checkFrameSize,
  checkOperationSupport,
  classifyAskCompletion,
  computeRequestPayloadHash,
  evaluateDedup,
  evaluateRootBindingClaim,
  isPlainObject,
  isRequestId,
  isSafeInteger,
  isString,
  isTargetId,
  newChallenge,
  newConnectionId,
  newEventId,
  negotiateHelloVersion,
  protocolError,
  requiredCapabilitiesFor,
  validateHello,
  validateRequestEnvelope,
  validateSessionRef,
  type Capability,
  type ConnectionId,
  type EventEnvelope,
  type GrantAction,
  type GrantId,
  type InstanceId,
  type NativeSessionId,
  type ProjectId,
  type ProtocolError,
  type ReplyPayload,
  type RequestEnvelope,
  type RequestId,
  type RequestRecord,
  type RequestState,
  type ResponseEnvelope,
  type SessionRef,
  type TargetId,
  type WorkspaceId,
} from "@session-broker/protocol";
import type { BrokerServer, BrokerServerOptions } from "./index";
import { STORE_SCHEMA_VERSION, Store, wireValue, type EventRow, type SessionKey, type SessionRow, type StoredRecord } from "./store";
import { decodeCursor, encodeCursor, isCursorExpired } from "./cursor";
import { createLogger, type Logger } from "./log";

const SERVER_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];
const LEASE_TTL_MS = 86_400_000;
const SWEEP_INTERVAL_MS = LIMITS.heartbeatMs;
const DELIVERY_TOPICS: Record<string, true> = { "broker.ask": true, "broker.notify": true, "broker.control": true };
/** Tema reservado (convención de datos dentro del `notify` congelado). */
const RUN_STATE_TOPIC = "broker.session.status";
const REPORT_STATES: readonly RequestState[] = [
  "received",
  "submitted",
  "completed",
  "rejected",
  "failed",
  "expired",
  "cancelled",
  "outcome_unknown",
];

type RunState = "idle" | "busy" | "unknown";

interface SubscriptionState {
  readonly id: string;
  readonly stream: SessionKey;
  readonly topics: readonly string[];
  readonly pending: EventRow[];
  queuedBytes: number;
}

interface PeerState {
  readonly connectionId: ConnectionId;
  ws: ServerWebSocket<PeerState> | undefined;
  handshaked: boolean;
  challenge: string;
  projectId: ProjectId | undefined;
  workspaceId: WorkspaceId | undefined;
  instanceId: InstanceId | undefined;
  nativeSessionId: NativeSessionId | undefined;
  grantId: GrantId | undefined;
  clientCapabilities: readonly Capability[];
  bound: SessionKey | undefined;
  subscriptions: Map<string, SubscriptionState>;
  invalidateControlOnClose: boolean;
}

interface ResolvedTarget {
  readonly key: SessionKey;
  readonly session: SessionRow | undefined;
}

function newPeer(connectionId: ConnectionId): PeerState {
  return {
    connectionId,
    ws: undefined,
    handshaked: false,
    challenge: newChallenge(),
    projectId: undefined,
    workspaceId: undefined,
    instanceId: undefined,
    nativeSessionId: undefined,
    grantId: undefined,
    clientCapabilities: [],
    bound: undefined,
    subscriptions: new Map(),
    invalidateControlOnClose: false,
  };
}

function eventFrame(event: EventRow): EventEnvelope {
  return {
    v: PROTOCOL_MAJOR,
    kind: "event",
    eventId: event.eventId,
    eventSeq: event.eventSeq,
    topic: event.topic,
    data: event.data,
    atMs: event.atMs,
  };
}

function responseFrame(record: StoredRecord, extra?: { replyTo?: RequestId; result?: unknown }): ResponseEnvelope {
  const receipts = record.receipts;
  const last = receipts.length > 0 ? receipts[receipts.length - 1] : undefined;
  return {
    v: PROTOCOL_MAJOR,
    kind: "response",
    requestId: record.requestId,
    replyTo: extra?.replyTo,
    state: record.state,
    eventId: last?.eventId ?? newEventId(),
    eventSeq: last?.eventSeq ?? 1,
    atMs: record.updatedAtMs,
    result: extra?.result ?? record.result,
    error: record.error,
  };
}

function rejectedFrame(requestId: RequestId, error: ProtocolError, atMs: number): ResponseEnvelope {
  return {
    v: PROTOCOL_MAJOR,
    kind: "response",
    requestId,
    state: "rejected",
    eventId: newEventId(),
    eventSeq: 1,
    atMs,
    error,
  };
}

function errorFrame(error: ProtocolError): { kind: "error"; error: ProtocolError } {
  return { kind: "error", error };
}

export class BrokerServerImpl implements BrokerServer {
  readonly #options: BrokerServerOptions;
  readonly #host: string;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #log: Logger;
  #store: Store | undefined;
  #http: Server<PeerState> | undefined;
  #sweepTimer: Timer | undefined;
  #closed = false;
  #listening = false;
  readonly #connections = new Set<PeerState>();
  readonly #rateWindows = new Map<string, number[]>();

  constructor(options: BrokerServerOptions) {
    this.#options = options;
    this.#host = options.host ?? "127.0.0.1";
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
    // Logs estructurados y redactados (FR-010): sin sink explícito solo
    // `warn`/`error`; jamás credenciales, MAC keys ni payloads.
    this.#log = createLogger({
      sink: options.logSink,
      minLevel: options.logSink === undefined ? "warn" : "info",
      secrets: () => (options.macKey === undefined ? [] : [options.macKey]),
      now: this.#now,
    });
  }

  get activeConnections(): number {
    return this.#connections.size;
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.#listening) throw new Error("broker ya está escuchando");
    if (this.#closed) throw new Error("broker cerrado");
    const store = Store.open({ dataDir: this.#options.dataDir, now: this.#now });
    store.listener = (stream, event) => this.#onStoreEvent(stream, event);
    this.#store = store;
    try {
      const http = Bun.serve<PeerState>({
        hostname: this.#host,
        port: this.#options.port,
        fetch: (req, server) => {
          const url = new URL(req.url);
          if (url.pathname === "/health") {
            return Response.json(this.#healthPayload());
          }
          const peer = newPeer(newConnectionId());
          const upgraded = server.upgrade(req, { data: peer });
          if (upgraded) return undefined;
          return new Response("session-broker: endpoint WS (o /health)", { status: 426 });
        },
        websocket: {
          data: {} as PeerState,
          maxPayloadLength: LIMITS.maxFrameBytes * 2 + 4096,
          backpressureLimit: LIMITS.maxEventQueueBytesPerSubscription,
          closeOnBackpressureLimit: false,
          open: (ws) => {
            const peer = ws.data;
            peer.ws = ws;
            this.#connections.add(peer);
          },
          message: (ws, message) => {
            this.#onMessage(ws.data, message);
          },
          close: (ws) => {
            this.#onClose(ws.data);
          },
          drain: (ws) => {
            for (const subscription of ws.data.subscriptions.values()) {
              this.#flushSubscription(ws.data, subscription);
            }
          },
        },
      });
      this.#http = http;
    } catch (error) {
      store.close();
      this.#store = undefined;
      throw error;
    }
    this.#listening = true;
    this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    const address = { host: this.#host, port: this.#http.port ?? this.#options.port };
    this.#log.log("info", "broker.listening", {
      host: address.host,
      port: address.port,
      dataDir: this.#options.dataDir,
      rootBinding: this.#options.macKey !== undefined,
    });
    return address;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    const store = this.#store;
    for (const peer of [...this.#connections]) {
      const ws = peer.ws;
      peer.ws = undefined;
      if (peer.bound !== undefined && store !== undefined && peer.instanceId !== undefined) {
        store.markInstanceOffline(peer.bound, peer.instanceId, this.#now(), {
          invalidateControl: peer.invalidateControlOnClose,
        });
      }
      peer.subscriptions.clear();
      try {
        ws?.close(1001, "broker shutdown");
      } catch {
        // best-effort
      }
    }
    this.#connections.clear();
    const http = this.#http;
    this.#http = undefined;
    if (http !== undefined) await http.stop(true);
    if (store !== undefined) {
      store.listener = undefined;
      store.close();
      this.#store = undefined;
    }
    // Shutdown ordenado: conexiones/timers/DB cerrados sin completar requests.
    this.#log.log("info", "broker.shutdown", {
      uptimeMs: Math.max(0, this.#now() - this.#startedAtMs),
      storeClosed: store !== undefined,
    });
  }

  // ------------------------------------------------------------ transporte

  #onMessage(peer: PeerState, message: unknown): void {
    const store = this.#store;
    if (store === undefined || peer.ws === undefined) return;
    if (typeof message !== "string") {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", "solo frames JSON de texto", "frame")));
      peer.ws.close(1003, "unsupported frame");
      return;
    }
    const frameSize = checkFrameSize(message);
    if (!frameSize.ok) {
      this.#send(peer, errorFrame(frameSize.error));
      peer.ws.close(1009, "frame too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", "frame no es JSON válido", "frame")));
      return;
    }
    if (!isPlainObject(parsed)) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", "mensaje debe ser un objeto", "frame")));
      return;
    }
    const kind: unknown = parsed["kind"];
    if (!peer.handshaked) {
      if (kind !== "hello") {
        this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", "el primer mensaje debe ser hello", "kind")));
        peer.ws.close(1008, "handshake required");
        return;
      }
      this.#handleHello(peer, parsed);
      return;
    }
    switch (kind) {
      case "hello":
        this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", "hello duplicado", "kind")));
        return;
      case "bind_root":
        this.#handleBindRoot(peer, parsed);
        return;
      case "request":
        this.#handleRequest(peer, parsed, message);
        return;
      case "report":
        this.#handleReport(peer, parsed);
        return;
      default:
        this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "schema_malformed", `kind desconocido: ${String(kind)}`, "kind")));
    }
  }

  #send(peer: PeerState, frame: unknown): boolean {
    const ws = peer.ws;
    if (ws === undefined) return false;
    if (ws.getBufferedAmount() > LIMITS.maxEventQueueBytesPerSubscription) {
      // Consumidor lento: acotado y desconectado, sin descartar durables.
      this.#sendRaw(peer, errorFrame(protocolError("QUEUE_FULL", "queue_full", "consumidor lento: cola de conexión saturada", "connection")));
      ws.close(1013, "slow consumer");
      return false;
    }
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  #sendRaw(peer: PeerState, frame: unknown): void {
    try {
      peer.ws?.send(JSON.stringify(frame));
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------- handshake

  #handleHello(peer: PeerState, parsed: Record<string, unknown>): void {
    const store = this.#store;
    if (store === undefined) return;
    const hello = validateHello(parsed);
    if (!hello.ok) {
      this.#send(peer, errorFrame(hello.error));
      this.#rejectHandshake(peer, "hello_schema", "invalid hello");
      return;
    }
    const negotiated = negotiateHelloVersion(hello.value, SERVER_PROTOCOL_VERSIONS);
    if (!negotiated.ok) {
      this.#send(peer, errorFrame(negotiated.error));
      this.#rejectHandshake(peer, "protocol_version", "incompatible version");
      return;
    }
    const record = store.grants.find(hello.value.grantId);
    const identity = {
      projectId: hello.value.projectId,
      workspaceId: hello.value.workspaceId,
      nativeSessionId: hello.value.nativeSessionId,
    };
    if (record === undefined) {
      this.#send(peer, errorFrame(protocolError("UNAUTHORIZED", "unauthorized_scope", "grant desconocido", "grantId")));
      this.#rejectHandshake(peer, "grant_unknown", "unauthorized");
      return;
    }
    const credential = store.grants.verifyCredential(record, hello.value.credential);
    if (!credential.ok) {
      this.#send(peer, errorFrame(credential.error));
      this.#rejectHandshake(peer, "credential_mismatch", "unauthorized");
      return;
    }
    const allowed = store.grants.evaluateHandshake(record, identity, this.#now());
    if (!allowed.ok) {
      this.#send(peer, errorFrame(allowed.error));
      this.#rejectHandshake(peer, `grant_${allowed.error.reason}`, "unauthorized");
      return;
    }
    peer.handshaked = true;
    peer.projectId = hello.value.projectId;
    peer.workspaceId = hello.value.workspaceId;
    peer.instanceId = hello.value.instanceId;
    peer.nativeSessionId = hello.value.nativeSessionId;
    peer.grantId = hello.value.grantId;
    peer.clientCapabilities = hello.value.capabilities;
    peer.challenge = newChallenge();
    // Superficie completa del broker; el soporte por objetivo se valida contra
    // las capacidades declaradas por la sesión registrada.
    const serverCapabilities: Capability[] = [
      CAPABILITIES.identity,
      CAPABILITIES.observe,
      CAPABILITIES.promptWhenIdle,
      CAPABILITIES.replyTool,
      CAPABILITIES.notify,
      CAPABILITIES.controlPrompt,
      CAPABILITIES.controlSteer,
      CAPABILITIES.controlFollowUp,
      CAPABILITIES.controlAbort,
    ];
    if (this.#options.macKey !== undefined) serverCapabilities.push(CAPABILITIES.rootBinding);
    this.#send(peer, {
      kind: "welcome",
      v: PROTOCOL_MAJOR,
      protocolVersion: negotiated.value,
      connectionId: peer.connectionId,
      serverChallenge: peer.challenge,
      serverCapabilities,
      maxFrameBytes: LIMITS.maxFrameBytes,
      heartbeatMs: LIMITS.heartbeatMs,
    });
    this.#log.log("info", "peer.connected", {
      connectionId: peer.connectionId,
      projectId: peer.projectId,
      workspaceId: peer.workspaceId,
      instanceId: peer.instanceId,
      nativeSessionId: peer.nativeSessionId,
      grantId: peer.grantId,
    });
  }

  /** Rechazo de handshake: registra la causa (IDs scoped, sin secretos) y corta. */
  #rejectHandshake(peer: PeerState, stage: string, closeReason: string): void {
    this.#log.log("warn", "peer.handshake_rejected", {
      connectionId: peer.connectionId,
      stage,
    });
    peer.ws?.close(1008, closeReason);
  }

  // ------------------------------------------------------------- bind_root

  #handleBindRoot(peer: PeerState, parsed: Record<string, unknown>): void {
    const store = this.#store;
    if (store === undefined) return;
    const unknown = Object.keys(parsed).filter(
      (key) => key !== "kind" && key !== "v" && key !== "claim" && key !== "target" && key !== "sessionRef",
    );
    if (unknown.length > 0) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "bind_root")));
      return;
    }
    if (parsed["v"] !== PROTOCOL_MAJOR) {
      this.#send(peer, errorFrame(protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "major de protocolo no soportado", "v")));
      return;
    }
    if (this.#options.macKey === undefined) {
      this.#send(
        peer,
        errorFrame(protocolError("UNSUPPORTED_CAPABILITY", "missing_capability", "root.binding no está soportado por este broker", "capabilities")),
      );
      return;
    }
    if (!isTargetId(parsed["target"])) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "invalid_format", "target inválido", "target")));
      return;
    }
    const target = parsed["target"] as TargetId;
    let sessionRef: SessionRef | undefined;
    if (parsed["sessionRef"] !== undefined) {
      const validated = validateSessionRef(parsed["sessionRef"]);
      if (!validated.ok) {
        this.#send(peer, errorFrame(validated.error));
        return;
      }
      sessionRef = validated.value;
    }
    if (
      peer.nativeSessionId === undefined ||
      peer.instanceId === undefined ||
      peer.projectId === undefined ||
      peer.workspaceId === undefined
    ) {
      this.#send(
        peer,
        errorFrame(protocolError("INVALID_INPUT", "invalid_field", "bind_root exige nativeSessionId/instanceId en hello", "hello")),
      );
      return;
    }
    // Identidad asociada sin colapsar: projectId/workspaceId/nativeSessionId/
    // sessionRef/instanceId; una sesión o workspace falsificados no acreditan.
    const effective: SessionRef = sessionRef ?? {
      projectId: peer.projectId,
      scope: "workspace",
      workspaceId: peer.workspaceId,
      target,
      nativeSessionId: peer.nativeSessionId,
    };
    const consistent =
      effective.projectId === peer.projectId &&
      effective.target === target &&
      effective.nativeSessionId === peer.nativeSessionId &&
      (effective.scope !== "workspace" || effective.workspaceId === peer.workspaceId);
    if (!consistent) {
      this.#send(
        peer,
        errorFrame(
          protocolError("UNAUTHORIZED", "root_claim_not_proven", "workspace/sesión declarados no coinciden con la conexión", "bind_root.sessionRef"),
        ),
      );
      return;
    }
    const verified = evaluateRootBindingClaim(parsed["claim"], {
      nowMs: this.#now(),
      challenge: peer.challenge,
      audience: peer.connectionId,
      instanceId: peer.instanceId,
      macKey: this.#options.macKey ?? "",
      isProofConsumed: (proofId: string) => store.isProofConsumed(proofId),
    });
    if (!verified.ok) {
      this.#send(peer, errorFrame(verified.error));
      return;
    }
    if (verified.value.subject.nativeSessionId !== peer.nativeSessionId) {
      this.#send(
        peer,
        errorFrame(
          protocolError("UNAUTHORIZED", "root_proof_subject_mismatch", "la prueba no pertenece a la sesión declarada", "rootProof.subject.nativeSessionId"),
        ),
      );
      return;
    }
    // Consumo único ANTES de registrar: una prueba jamás vale dos registros.
    const consumed = store.consumeProof(verified.value.proofId, verified.value.expiresAtMs);
    if (!consumed.ok) {
      this.#send(peer, errorFrame(consumed.error));
      return;
    }
    const key: SessionKey = {
      projectId: effective.projectId,
      target: effective.target,
      nativeSessionId: effective.nativeSessionId,
    };
    const registration = store.registerSession({
      key,
      workspaceId: peer.workspaceId,
      instanceId: peer.instanceId,
      capabilities: peer.clientCapabilities,
      nowMs: this.#now(),
      leaseTtlMs: LEASE_TTL_MS,
    });
    peer.bound = key;
    // Nonce de un solo intercambio: el challenge queda consumido; re-registrar
    // exige reconectar (cada conexión exige su propio challenge).
    peer.challenge = newChallenge();
    this.#send(peer, eventFrame(registration.event));
    this.#log.log("info", "session.bound", {
      connectionId: peer.connectionId,
      projectId: key.projectId,
      target: key.target,
      nativeSessionId: key.nativeSessionId,
      instanceId: peer.instanceId,
      controlEpoch: registration.epoch,
      takeover: registration.takeover,
    });
    // Re-entrega idempotente de lo durable pendiente (mismos eventId/eventSeq).
    for (const pending of store.pendingDeliveries(key)) {
      this.#send(peer, eventFrame(pending.event));
    }
  }

  // --------------------------------------------------------------- requests

  #handleRequest(peer: PeerState, parsed: Record<string, unknown>, frameJson: string): void {
    const store = this.#store;
    if (store === undefined) return;
    const requestIdRaw: unknown = parsed["requestId"];
    const correlated = isRequestId(requestIdRaw);
    const request = validateRequestEnvelope(parsed, { frameJson });
    if (!request.ok) {
      if (correlated) {
        this.#send(peer, rejectedFrame(requestIdRaw as RequestId, request.error, this.#now()));
      } else {
        this.#send(peer, errorFrame(request.error));
      }
      return;
    }
    this.#processRequest(peer, store, request.value);
  }

  #processRequest(peer: PeerState, store: Store, request: RequestEnvelope): void {
    const nowMs = this.#now();
    const projectId = peer.projectId;
    if (projectId === undefined) {
      this.#send(
        peer,
        rejectedFrame(request.requestId, protocolError("UNAUTHORIZED", "unauthorized_scope", "conexión sin proyecto autenticado", "grant"), nowMs),
      );
      return;
    }
    const grantRecord = store.grants.find(request.grantId);
    if (grantRecord === undefined || peer.grantId === undefined || request.grantId !== peer.grantId) {
      this.#send(
        peer,
        rejectedFrame(request.requestId, protocolError("UNAUTHORIZED", "unauthorized_scope", "grant no corresponde a esta conexión", "grantId"), nowMs),
      );
      return;
    }
    const identity = {
      projectId,
      workspaceId: peer.workspaceId ?? "",
      nativeSessionId: peer.nativeSessionId,
    };
    const revalidated = store.grants.revalidate(grantRecord, identity, nowMs);
    if (!revalidated.ok) {
      // Revocación/expiración revalida la conexión completa.
      peer.invalidateControlOnClose = true;
      this.#send(peer, rejectedFrame(request.requestId, revalidated.error, nowMs));
      peer.ws?.close(1008, "grant invalidated");
      return;
    }
    const sessionRef = request.target.session;
    if (sessionRef !== undefined && sessionRef.projectId !== projectId) {
      this.#send(
        peer,
        rejectedFrame(
          request.requestId,
          protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "recurso no disponible en este ámbito", "target.session.projectId"),
          nowMs,
        ),
      );
      return;
    }
    if (sessionRef !== undefined && sessionRef.target !== request.target.target) {
      this.#send(
        peer,
        rejectedFrame(
          request.requestId,
          protocolError("INVALID_INPUT", "invalid_field", "sessionRef.target debe coincidir con target.target", "target.session.target"),
          nowMs,
        ),
      );
      return;
    }
    // Capacidad por operación/verbo: separa lectura, envío y control.
    const verb =
      request.operation === "control" && isPlainObject(request.payload) && isString((request.payload as Record<string, unknown>)["verb"])
        ? ((request.payload as Record<string, unknown>)["verb"] as string)
        : undefined;
    const required = requiredCapabilitiesFor(request.operation, verb);
    if (required === undefined) {
      this.#send(
        peer,
        rejectedFrame(
          request.requestId,
          protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", `operación desconocida: ${request.operation}`, "operation"),
          nowMs,
        ),
      );
      return;
    }
    const capabilitiesToCheck: Capability[] = [...required];
    for (const capability of request.requiredCapabilities ?? []) {
      if (!capabilitiesToCheck.includes(capability)) capabilitiesToCheck.push(capability);
    }
    for (const capability of capabilitiesToCheck) {
      const action: GrantAction = {
        projectId,
        workspaceId: sessionRef?.workspaceId,
        target: request.target.target,
        nativeSessionId: sessionRef?.nativeSessionId,
        capability,
      };
      const allowed = store.grants.evaluateAction(grantRecord, action, nowMs);
      if (!allowed.ok) {
        this.#send(peer, rejectedFrame(request.requestId, allowed.error, nowMs));
        return;
      }
    }
    // Dedup: replay idempotente y conflicto se resuelven SIN efectos. El hash
    // canónico cubre la forma de WIRE de {operation, target, payload}.
    const wireTarget = wireValue(request.target);
    const wirePayload = wireValue(request.payload);
    const hash = computeRequestPayloadHash({
      operation: request.operation,
      target: wireTarget,
      payload: wirePayload,
    });
    if (!hash.ok) {
      this.#send(peer, rejectedFrame(request.requestId, hash.error, nowMs));
      return;
    }
    const existing = store.getRequest(request.requestId);
    const decision = evaluateDedup(existing as RequestRecord | undefined, {
      projectId,
      requestId: request.requestId,
      operation: request.operation,
      target: wireTarget,
      payload: wirePayload,
      nowMs,
    });
    if (!decision.ok) {
      this.#send(peer, rejectedFrame(request.requestId, decision.error, nowMs));
      return;
    }
    const verdict = decision.value;
    if (verdict.kind === "conflict") {
      this.#send(peer, rejectedFrame(request.requestId, verdict.error, nowMs));
      return;
    }
    if (verdict.kind === "idempotent_replay" && existing !== undefined) {
      this.#send(peer, responseFrame(existing, { result: this.#replayResult(existing) }));
      return;
    }
    // Cuotas por grant.
    const rate = this.#rateWindows.get(request.grantId) ?? [];
    while (rate.length > 0 && nowMs - (rate[0] ?? 0) > 60_000) rate.shift();
    if (rate.length >= LIMITS.maxRequestsPerMinutePerGrant) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("RATE_LIMITED", "rate_limited", "cuota de tasa por grant superada", "grantId"), nowMs));
      return;
    }
    if (store.countInFlight(request.grantId) >= LIMITS.maxInFlightRequestsPerGrant) {
      this.#send(
        peer,
        rejectedFrame(request.requestId, protocolError("QUEUE_FULL", "queue_full", "demasiadas solicitudes en vuelo para este grant", "grantId"), nowMs),
      );
      return;
    }
    rate.push(nowMs);
    this.#rateWindows.set(request.grantId, rate);
    this.#dispatchOperation(peer, store, request, nowMs);
  }

  #dispatchOperation(peer: PeerState, store: Store, request: RequestEnvelope, nowMs: number): void {
    switch (request.operation) {
      case "list":
      case "query":
        this.#runRead(peer, store, request, nowMs, false);
        return;
      case "inspect":
      case "history":
      case "subscribe":
        this.#runRead(peer, store, request, nowMs, true);
        return;
      case "ask":
      case "notify":
        this.#runSend(peer, store, request, nowMs);
        return;
      case "control":
        this.#runControl(peer, store, request, nowMs);
        return;
      case "reply":
        this.#runReply(peer, store, request, nowMs);
        return;
    }
  }

  /** Resuelve el selector a una sesión concreta; jamás elige en silencio. */
  #resolveTarget(peer: PeerState, store: Store, request: RequestEnvelope): { ok: true; resolved: ResolvedTarget } | { ok: false; error: ProtocolError } {
    const sessionRef = request.target.session;
    if (sessionRef !== undefined) {
      const key: SessionKey = {
        projectId: sessionRef.projectId,
        target: sessionRef.target,
        nativeSessionId: sessionRef.nativeSessionId,
      };
      return { ok: true, resolved: { key, session: store.getSession(key) } };
    }
    const projectId = peer.projectId ?? "";
    const candidates = store.listSessions(projectId).filter((session) => session.key.target === request.target.target);
    if (candidates.length > 1) {
      return { ok: false, error: protocolError("AMBIGUOUS_TARGET", "ambiguous_target", "el selector resuelve a varias sesiones", "target") };
    }
    const only = candidates[0];
    if (only === undefined) {
      return { ok: false, error: protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "recurso no disponible en este ámbito", "target") };
    }
    return { ok: true, resolved: { key: only.key, session: only } };
  }

  #sessionlessStream(peer: PeerState, request: RequestEnvelope): ResolvedTarget {
    return {
      key: { projectId: peer.projectId ?? "", target: request.target.target, nativeSessionId: "" },
      session: undefined,
    };
  }

  // ------------------------------------------------------------ operaciones

  #runRead(peer: PeerState, store: Store, request: RequestEnvelope, nowMs: number, needsSession: boolean): void {
    const resolvedOrError = needsSession
      ? this.#resolveTarget(peer, store, request)
      : { ok: true as const, resolved: this.#sessionlessStream(peer, request) };
    if (!resolvedOrError.ok) {
      this.#send(peer, rejectedFrame(request.requestId, resolvedOrError.error, nowMs));
      return;
    }
    const resolved = resolvedOrError.resolved;
    const deadlineAtMs = request.deadlineMs === undefined ? null : nowMs + request.deadlineMs;
    const commit = store.commitRequest({
      requestId: request.requestId,
      projectId: peer.projectId ?? "",
      operation: request.operation,
      target: request.target,
      payload: request.payload,
      grantId: request.grantId,
      stream: resolved.key,
      nowMs,
      deadlineAtMs,
    });
    if (commit.kind === "error") {
      this.#send(peer, rejectedFrame(request.requestId, commit.error, nowMs));
      return;
    }
    if (commit.kind === "idempotent_replay") {
      this.#send(peer, responseFrame(commit.record, { result: this.#replayResult(commit.record) }));
      return;
    }
    // Lecturas sin inferencia: el broker es el procesador y su journal durable
    // cubre la frontera incoming; nunca se llama a modelos ni se envían prompts.
    store.transition(request.requestId, "receive", { nowMs, detail: "journal incoming del broker" });
    store.transition(request.requestId, "submit", { nowMs, detail: "proyección del broker (sin inferencia)" });
    const resultOrError = this.#readResult(peer, store, request, resolved, nowMs);
    if (!resultOrError.ok) {
      store.transition(request.requestId, "fail", { nowMs, error: resultOrError.error, detail: "lectura fallida" });
      const failed = store.getRequest(request.requestId);
      if (failed !== undefined) this.#send(peer, responseFrame(failed));
      return;
    }
    const completed = store.transition(request.requestId, "complete", { nowMs, result: resultOrError.value.result, detail: "lectura completada" });
    if (!completed.ok) {
      this.#send(peer, rejectedFrame(request.requestId, completed.error, nowMs));
      return;
    }
    this.#send(peer, responseFrame(completed.record, { result: resultOrError.value.result }));
    if (resultOrError.value.subscription !== undefined) {
      this.#attachSubscription(peer, resultOrError.value.subscription, resultOrError.value.replay ?? []);
    }
  }

  #readResult(
    peer: PeerState,
    store: Store,
    request: RequestEnvelope,
    resolved: ResolvedTarget,
    nowMs: number,
  ):
    | { ok: true; value: { result: unknown; subscription?: SubscriptionState; replay?: EventRow[] } }
    | { ok: false; error: ProtocolError } {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    switch (request.operation) {
      case "list": {
        const visible = store
          .listSessions(peer.projectId ?? "")
          .filter((session) => this.#sessionVisible(peer, session))
          .map((session) => this.#sessionSummary(session, nowMs));
        const limit = typeof payload["limit"] === "number" ? payload["limit"] : LIMITS.maxHistoryPageItems;
        let offset = 0;
        const cursorRaw = payload["cursor"];
        if (typeof cursorRaw === "string") {
          const cursor = decodeCursor(cursorRaw);
          if (cursor === undefined || cursor.kind !== "list" || cursor.key !== request.target.target || isCursorExpired(cursor, nowMs)) {
            return {
              ok: false,
              error: protocolError("CURSOR_EXPIRED", "cursor_expired", "cursor de listado inválido o fuera de vigencia", "payload.cursor"),
            };
          }
          offset = cursor.pos;
        }
        const page = visible.slice(offset, offset + limit);
        const hasMore = visible.length > offset + limit;
        return {
          ok: true,
          value: {
            result: {
              items: page,
              observedAtMs: nowMs,
              availability: "available",
              nextCursor: hasMore
                ? encodeCursor({ kind: "list", key: request.target.target, pos: offset + limit, issuedAtMs: nowMs })
                : undefined,
            },
          },
        };
      }
      case "query": {
        const query = typeof payload["query"] === "string" ? payload["query"] : "";
        const limit = typeof payload["limit"] === "number" ? payload["limit"] : LIMITS.maxHistoryPageItems;
        const matches: unknown[] = [];
        for (const session of store.listSessions(peer.projectId ?? "")) {
          if (!this.#sessionVisible(peer, session)) continue;
          for (const record of store.requestsForStream(session.key)) {
            const haystack = JSON.stringify({ requestId: record.requestId, payload: record.payload });
            if (!haystack.includes(query)) continue;
            matches.push(this.#publicRecord(record));
            if (matches.length >= limit) break;
          }
          if (matches.length >= limit) break;
        }
        return { ok: true, value: { result: { items: matches, observedAtMs: nowMs, availability: "available" } } };
      }
      case "inspect": {
        const fields = Array.isArray(payload["fields"]) ? (payload["fields"] as string[]) : undefined;
        const summary =
          resolved.session === undefined
            ? { availability: "unavailable", observedAtMs: nowMs, ageMs: 0 }
            : this.#sessionDetail(store, resolved.session, nowMs);
        return { ok: true, value: { result: fields === undefined ? summary : this.#pickFields(summary, fields) } };
      }
      case "history":
        return this.#historyResult(store, request, resolved, nowMs);
      case "subscribe": {
        const topics = Array.isArray(payload["topics"]) ? (payload["topics"] as string[]) : [];
        const fromEventSeq = typeof payload["fromEventSeq"] === "number" ? payload["fromEventSeq"] : 1;
        const gap = this.#retentionGap(store, resolved, fromEventSeq, nowMs);
        if (gap.expired) {
          return {
            ok: false,
            error: protocolError("CURSOR_EXPIRED", "cursor_expired", "el punto de reanudación quedó fuera de retención", "payload.fromEventSeq"),
          };
        }
        const replay = store
          .historyPage(resolved.key, fromEventSeq, LIMITS.maxHistoryPageItems, nowMs, LIMITS.eventRetentionMs)
          .filter((event) => topics.includes(event.topic));
        const subscription: SubscriptionState = {
          id: newEventId(),
          stream: resolved.key,
          topics,
          pending: [],
          queuedBytes: 0,
        };
        return {
          ok: true,
          value: {
            result: {
              subscriptionId: subscription.id,
              topics,
              fromEventSeq,
              observedAtMs: nowMs,
              // El hueco de retención se DECLARA; jamás se esconde en una
              // página vacía ni en un replay incompleto.
              ...(gap.gap ? { gap: true } : {}),
            },
            subscription,
            replay,
          },
        };
      }
      default:
        return {
          ok: false,
          error: protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", `operación sin lectura: ${request.operation}`, "operation"),
        };
    }
  }

  #sessionVisible(peer: PeerState, session: SessionRow): boolean {
    const store = this.#store;
    if (store === undefined || peer.grantId === undefined) return false;
    const record = store.grants.find(peer.grantId);
    if (record === undefined) return false;
    const action: GrantAction = {
      projectId: session.key.projectId,
      workspaceId: session.workspaceId,
      target: session.key.target,
      nativeSessionId: session.key.nativeSessionId,
      capability: CAPABILITIES.observe,
    };
    return store.grants.evaluateAction(record, action, this.#now()).ok;
  }

  #sessionSummary(session: SessionRow, nowMs: number): Record<string, unknown> {
    return {
      sessionRef: {
        projectId: session.key.projectId,
        scope: "workspace",
        workspaceId: session.workspaceId,
        target: session.key.target,
        nativeSessionId: session.key.nativeSessionId,
      },
      presence: session.presence,
      runState: session.runState,
      instanceId: session.holderInstanceId,
      registeredAtMs: session.registeredAtMs,
      lastSeenMs: session.lastSeenMs,
      observedAtMs: nowMs,
    };
  }

  #sessionDetail(store: Store, session: SessionRow, nowMs: number): Record<string, unknown> {
    const requests = store.requestsForStream(session.key).map((record) => this.#publicRecord(record));
    return {
      ...this.#sessionSummary(session, nowMs),
      controlEpoch: session.controlEpoch,
      availability: "available",
      ageMs: Math.max(0, nowMs - session.registeredAtMs),
      capabilities: [...session.capabilities],
      requests,
      queuedAsks: store.countQueuedAsks(session.key),
      // Dimensión nativa separada: el broker nunca conoce el job status real.
      nativeJobStatus: "unknown",
    };
  }

  #pickFields(summary: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in summary) out[field] = summary[field];
    }
    return out;
  }

  /**
   * Respuesta de replay idempotente (durability.md: devuelve el registro
   * completo —estado y recibos— y JAMÁS re-despacha). Se aplanan también
   * `operation`/`state`/`receipts` al máximo nivel para interoperar con la
   * forma que ya usa el fake de P-003; `record` conserva el registro completo.
   */
  #replayResult(record: StoredRecord): Record<string, unknown> {
    const complete = this.#publicRecord(record);
    return {
      replay: true,
      operation: record.operation,
      state: record.state,
      receipts: complete["receipts"],
      record: complete,
    };
  }

  #publicRecord(record: StoredRecord): Record<string, unknown> {
    return {
      requestId: record.requestId,
      projectId: record.projectId,
      operation: record.operation,
      target: record.target,
      payloadHash: record.payloadHash,
      state: record.state,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      deadlineAtMs: record.deadlineAtMs,
      receipts: record.receipts.map((receipt) => ({ ...receipt })),
      result: record.result,
      error: record.error,
    };
  }

  /**
   * Hueco explícito de reanudación (FR-009): si el punto pedido cae por
   * debajo del journal retenido (recortado o envejecido), la reanudación se
   * resuelve `CURSOR_EXPIRED` — nunca una página vacía que esconda el hueco.
   * `fromSeq <= 1` es snapshot explícito: no falla, pero el hueco se declara
   * en el resultado (`gap`) para que el consumidor lo vea, incluso cuando el
   * recorte ya borró por completo el origen del stream.
   */
  #retentionGap(
    store: Store,
    resolved: ResolvedTarget,
    fromSeq: number,
    nowMs: number,
  ): { expired: boolean; gap: boolean } {
    const oldest = store.oldestEventSeq(resolved.key);
    const assigned = store.streamNextSeq(resolved.key) - 1;
    const lastUnretained = store.lastUnretainedSeq(resolved.key, nowMs, LIMITS.eventRetentionMs);
    // El inicio de la historia ya no está completo (recorte por retención).
    const missingBefore = oldest === undefined ? assigned > 0 : oldest > 1;
    const belowFloor = oldest !== undefined && fromSeq < oldest;
    const wouldHide = lastUnretained !== undefined && lastUnretained >= fromSeq;
    return { expired: fromSeq > 1 && (belowFloor || wouldHide), gap: missingBefore || belowFloor || wouldHide };
  }

  #historyResult(
    store: Store,
    request: RequestEnvelope,
    resolved: ResolvedTarget,
    nowMs: number,
  ): { ok: true; value: { result: unknown } } | { ok: false; error: ProtocolError } {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const streamKey = `${resolved.key.projectId}|${resolved.key.target}|${resolved.key.nativeSessionId}`;
    let fromSeq = typeof payload["fromEventSeq"] === "number" ? payload["fromEventSeq"] : 1;
    const cursorRaw = payload["cursor"];
    if (typeof cursorRaw === "string") {
      const cursor = decodeCursor(cursorRaw);
      if (cursor === undefined || cursor.kind !== "history" || cursor.key !== streamKey || isCursorExpired(cursor, nowMs)) {
        return {
          ok: false,
          error: protocolError("CURSOR_EXPIRED", "cursor_expired", "cursor inválido o fuera de vigencia; exige snapshot explícito", "payload.cursor"),
        };
      }
      fromSeq = cursor.pos;
    }
    const gap = this.#retentionGap(store, resolved, fromSeq, nowMs);
    if (gap.expired) {
      return {
        ok: false,
        error: protocolError("CURSOR_EXPIRED", "cursor_expired", "el origen del historial quedó fuera de retención", "payload.fromEventSeq"),
      };
    }
    const limit = typeof payload["limit"] === "number" ? payload["limit"] : LIMITS.maxHistoryPageItems;
    const page = store.historyPage(resolved.key, fromSeq, limit + 1, nowMs, LIMITS.eventRetentionMs);
    const items = page.slice(0, limit);
    let bytes = 0;
    for (const item of items) bytes += item.bytes;
    if (bytes > LIMITS.maxHistoryPageBytes) {
      return {
        ok: false,
        error: protocolError("INVALID_INPUT", "payload_too_large", "la página de historial excede maxHistoryPageBytes", "payload.limit"),
      };
    }
    const hasMore = page.length > limit;
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    const hasAny = store.hasEventsFrom(resolved.key, 1);
    return {
      ok: true,
      value: {
        result: {
          items: items.map((item) => eventFrame(item)),
          fromEventSeq: fromSeq,
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({ kind: "history", key: streamKey, pos: last.eventSeq + 1, issuedAtMs: nowMs })
              : undefined,
          observedAtMs: nowMs,
          // Historial ausente => unavailable; nunca se inventa continuidad.
          availability: hasAny && resolved.session !== undefined ? "available" : "unavailable",
          ageMs: resolved.session === undefined ? 0 : Math.max(0, nowMs - resolved.session.lastSeenMs),
          // Hueco de retención declarado explícitamente (jamás oculto).
          ...(gap.gap ? { gap: true } : {}),
        },
      },
    };
  }

  #attachSubscription(peer: PeerState, subscription: SubscriptionState, replay: readonly EventRow[]): void {
    peer.subscriptions.set(subscription.id, subscription);
    for (const event of replay) {
      if (!this.#enqueueEvent(peer, subscription, event)) return;
    }
    this.#flushSubscription(peer, subscription);
  }

  /** Encola con acotación dura; overflow => QUEUE_FULL y la suscripción se corta. */
  #enqueueEvent(peer: PeerState, subscription: SubscriptionState, event: EventRow): boolean {
    subscription.pending.push(event);
    subscription.queuedBytes += event.bytes + 128;
    if (
      subscription.pending.length > LIMITS.maxEventQueueItemsPerSubscription ||
      subscription.queuedBytes > LIMITS.maxEventQueueBytesPerSubscription
    ) {
      peer.subscriptions.delete(subscription.id);
      this.#log.log("warn", "subscription.queue_full", {
        connectionId: peer.connectionId,
        subscriptionId: subscription.id,
        pending: subscription.pending.length,
        queuedBytes: subscription.queuedBytes,
      });
      this.#send(peer, errorFrame(protocolError("QUEUE_FULL", "queue_full", "cola de suscripción desbordada: consumidor lento", "subscription")));
      return false;
    }
    return true;
  }

  #flushSubscription(peer: PeerState, subscription: SubscriptionState): void {
    while (subscription.pending.length > 0) {
      const event = subscription.pending[0];
      if (event === undefined) break;
      const ws = peer.ws;
      if (ws === undefined) return;
      if (ws.getBufferedAmount() > LIMITS.maxEventQueueBytesPerSubscription / 2) return;
      subscription.pending.shift();
      subscription.queuedBytes = Math.max(0, subscription.queuedBytes - event.bytes - 128);
      this.#send(peer, eventFrame(event));
    }
  }

  #runSend(peer: PeerState, store: Store, request: RequestEnvelope, nowMs: number): void {
    const resolvedOrError = this.#resolveTarget(peer, store, request);
    if (!resolvedOrError.ok) {
      this.#send(peer, rejectedFrame(request.requestId, resolvedOrError.error, nowMs));
      return;
    }
    const resolved = resolvedOrError.resolved;
    const session = resolved.session;
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    // Convención de datos: `notify` con tema reservado declara runState del
    // titular (sin frame inventado); solo el titular actual puede declararlo.
    if (
      request.operation === "notify" &&
      payload["topic"] === RUN_STATE_TOPIC &&
      session !== undefined &&
      peer.bound !== undefined &&
      peer.bound.target === resolved.key.target &&
      peer.bound.nativeSessionId === resolved.key.nativeSessionId &&
      peer.instanceId === session.holderInstanceId
    ) {
      // El tema reservado sigue exigiendo la capability del objetivo (fail-closed).
      const statusSupport = checkOperationSupport("notify", undefined, session.capabilities);
      if (!statusSupport.ok) {
        this.#send(peer, rejectedFrame(request.requestId, statusSupport.error, nowMs));
        return;
      }
      this.#declareRunState(peer, store, request, resolved, payload, nowMs);
      return;
    }
    if (session === undefined) {
      // Semántica de cola: solo se encola contra una sesión registrada; un
      // objetivo desconocido se reintenta con backoff.
      this.#send(peer, rejectedFrame(request.requestId, protocolError("TARGET_OFFLINE", "target_offline", "el objetivo no está registrado/conectado", "target"), nowMs));
      return;
    }
    const support = checkOperationSupport(request.operation, undefined, session.capabilities);
    if (!support.ok) {
      this.#send(peer, rejectedFrame(request.requestId, support.error, nowMs));
      return;
    }
    for (const capability of request.requiredCapabilities ?? []) {
      if (!session.capabilities.includes(capability)) {
        this.#send(
          peer,
          rejectedFrame(
            request.requestId,
            protocolError("UNSUPPORTED_CAPABILITY", "missing_capability", `capacidad no soportada por el objetivo: ${capability}`, "capabilities"),
            nowMs,
          ),
        );
        return;
      }
    }
    const isAsk = request.operation === "ask";
    if (isAsk && store.countQueuedAsks(resolved.key) >= LIMITS.maxQueuedAsksPerSession) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("QUEUE_FULL", "queue_full", "cola de asks de la sesión llena", "target"), nowMs));
      return;
    }
    const deadlineAtMs =
      isAsk && isSafeInteger(payload["deadlineMs"])
        ? nowMs + (payload["deadlineMs"] as number)
        : request.deadlineMs === undefined
          ? null
          : nowMs + request.deadlineMs;
    const deliveryTopic = isAsk ? "broker.ask" : "broker.notify";
    const deliveryData = isAsk
      ? {
          requestId: request.requestId,
          question: payload["question"],
          deadlineAtMs,
          maxTurns: payload["maxTurns"],
          depth: payload["depth"],
          policy: payload["policy"],
        }
      : { requestId: request.requestId, topic: payload["topic"], data: payload["data"] };
    const commit = store.commitRequest({
      requestId: request.requestId,
      projectId: peer.projectId ?? "",
      operation: request.operation,
      target: request.target,
      payload: request.payload,
      grantId: request.grantId,
      stream: resolved.key,
      nowMs,
      deadlineAtMs,
      delivery: { topic: deliveryTopic, data: deliveryData },
    });
    if (commit.kind === "error") {
      this.#send(peer, rejectedFrame(request.requestId, commit.error, nowMs));
      return;
    }
    if (commit.kind === "idempotent_replay") {
      this.#log.log("info", "request.replayed", {
        connectionId: peer.connectionId,
        requestId: request.requestId,
        operation: request.operation,
        state: commit.record.state,
      });
      this.#send(peer, responseFrame(commit.record, { result: this.#replayResult(commit.record) }));
      return;
    }
    this.#log.log("info", "request.queued", {
      connectionId: peer.connectionId,
      requestId: request.requestId,
      operation: request.operation,
      grantId: request.grantId,
      target: resolved.key.target,
      nativeSessionId: resolved.key.nativeSessionId,
    });
    this.#send(
      peer,
      responseFrame(commit.record, {
        result: { requestId: request.requestId, queuedAtMs: nowMs, deadlineAtMs, policy: isAsk ? "when_idle" : undefined },
      }),
    );
  }

  /** `notify` reservado: declara runState (dimensión aparte de presencia/entrega). */
  #declareRunState(
    peer: PeerState,
    store: Store,
    request: RequestEnvelope,
    resolved: ResolvedTarget,
    payload: Record<string, unknown>,
    nowMs: number,
  ): void {
    const data = payload["data"];
    const declared: RunState =
      isPlainObject(data) && ((data as Record<string, unknown>)["runState"] === "idle" || (data as Record<string, unknown>)["runState"] === "busy")
        ? ((data as Record<string, unknown>)["runState"] as RunState)
        : "unknown";
    store.heartbeat(resolved.key, peer.instanceId ?? "", declared, nowMs);
    const commit = store.commitRequest({
      requestId: request.requestId,
      projectId: peer.projectId ?? "",
      operation: "notify",
      target: request.target,
      payload: request.payload,
      grantId: request.grantId,
      stream: resolved.key,
      nowMs,
      deadlineAtMs: null,
    });
    if (commit.kind === "error") {
      this.#send(peer, rejectedFrame(request.requestId, commit.error, nowMs));
      return;
    }
    if (commit.kind === "idempotent_replay") {
      this.#send(peer, responseFrame(commit.record, { result: this.#replayResult(commit.record) }));
      return;
    }
    store.transition(request.requestId, "receive", { nowMs, detail: "runState consumido por el broker" });
    store.transition(request.requestId, "submit", { nowMs, detail: "runState aplicado" });
    const completed = store.transition(request.requestId, "complete", {
      nowMs,
      result: { runState: declared },
      detail: "runState declarado",
    });
    if (completed.ok) {
      this.#send(peer, responseFrame(completed.record, { result: { runState: declared } }));
    } else {
      this.#send(peer, rejectedFrame(request.requestId, completed.error, nowMs));
    }
  }

  #runControl(peer: PeerState, store: Store, request: RequestEnvelope, nowMs: number): void {
    const resolvedOrError = this.#resolveTarget(peer, store, request);
    if (!resolvedOrError.ok) {
      this.#send(peer, rejectedFrame(request.requestId, resolvedOrError.error, nowMs));
      return;
    }
    const resolved = resolvedOrError.resolved;
    const session = resolved.session;
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const verb = isString(payload["verb"]) ? payload["verb"] : "";
    if (session === undefined) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("TARGET_OFFLINE", "target_offline", "el objetivo no está registrado/conectado", "target"), nowMs));
      return;
    }
    // Capability soportada por el objetivo: sin mapping verificado => unsupported,
    // siempre antes de efectos.
    const support = checkOperationSupport("control", verb, session.capabilities);
    if (!support.ok) {
      this.#send(peer, rejectedFrame(request.requestId, support.error, nowMs));
      return;
    }
    for (const capability of request.requiredCapabilities ?? []) {
      if (!session.capabilities.includes(capability)) {
        this.#send(
          peer,
          rejectedFrame(
            request.requestId,
            protocolError("UNSUPPORTED_CAPABILITY", "missing_capability", `capacidad no soportada por el objetivo: ${capability}`, "capabilities"),
            nowMs,
          ),
        );
        return;
      }
    }
    // Comparación atómica del controlEpoch (mismo store/una transacción).
    const lease = store.leaseFor(session);
    const claimedInstance = request.target.instanceId ?? lease?.holderInstanceId ?? "";
    const checked = assertControlEpoch(lease, request.controlEpoch, claimedInstance, nowMs);
    if (!checked.ok) {
      this.#send(peer, rejectedFrame(request.requestId, checked.error, nowMs));
      return;
    }
    const holderOnline = session.presence === "online" && this.#holderConnection(resolved.key, session.holderInstanceId) !== undefined;
    if (!holderOnline) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("TARGET_OFFLINE", "target_offline", "el titular del objetivo no está conectado", "target"), nowMs));
      return;
    }
    if (verb === "prompt" && session.runState === "busy") {
      this.#send(
        peer,
        rejectedFrame(
          request.requestId,
          protocolError("TARGET_BUSY", "target_busy", "el objetivo está ocupado y la política no permite interrumpir", "payload.verb"),
          nowMs,
        ),
      );
      return;
    }
    const commit = store.commitRequest({
      requestId: request.requestId,
      projectId: peer.projectId ?? "",
      operation: "control",
      target: request.target,
      payload: request.payload,
      grantId: request.grantId,
      stream: resolved.key,
      nowMs,
      deadlineAtMs: request.deadlineMs === undefined ? null : nowMs + request.deadlineMs,
      delivery: { topic: "broker.control", data: { requestId: request.requestId, verb, instruction: payload["instruction"] } },
    });
    if (commit.kind === "error") {
      this.#send(peer, rejectedFrame(request.requestId, commit.error, nowMs));
      return;
    }
    if (commit.kind === "idempotent_replay") {
      this.#send(peer, responseFrame(commit.record, { result: this.#replayResult(commit.record) }));
      return;
    }
    this.#send(
      peer,
      responseFrame(commit.record, {
        result: { requestId: request.requestId, verb, queuedAtMs: nowMs, controlEpoch: request.controlEpoch ?? 0 },
      }),
    );
  }

  #runReply(peer: PeerState, store: Store, request: RequestEnvelope, nowMs: number): void {
    const payload = request.payload as ReplyPayload;
    const resolvedOrError = this.#resolveTarget(peer, store, request);
    if (!resolvedOrError.ok) {
      this.#send(peer, rejectedFrame(request.requestId, resolvedOrError.error, nowMs));
      return;
    }
    const resolved = resolvedOrError.resolved;
    const ask = store.getRequest(payload.replyTo);
    // ReplyTo ajeno/erróneo jamás filtra existencia fuera del ámbito.
    const askVisible =
      ask !== undefined &&
      ask.projectId === (peer.projectId ?? "") &&
      ask.operation === "ask" &&
      ask.stream.projectId === resolved.key.projectId &&
      ask.stream.target === resolved.key.target &&
      ask.stream.nativeSessionId === resolved.key.nativeSessionId;
    if (!askVisible || ask === undefined) {
      this.#send(
        peer,
        rejectedFrame(
          request.requestId,
          protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "ask referenciado no disponible en este ámbito", "payload.replyTo"),
          nowMs,
        ),
      );
      return;
    }
    // Autoridad del destinatario: solo el titular registrado de esa sesión
    // (herramienta explícita) entrega; el dueño viejo no puede hacerlo.
    const session = resolved.session;
    const boundToAsk =
      peer.bound !== undefined && peer.bound.target === ask.stream.target && peer.bound.nativeSessionId === ask.stream.nativeSessionId;
    if (!boundToAsk) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("UNAUTHORIZED", "unauthorized_scope", "reply sin autoridad del destinatario", "grant"), nowMs));
      return;
    }
    if (session !== undefined && session.holderInstanceId !== null && peer.instanceId !== session.holderInstanceId) {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("STALE_INSTANCE", "stale_instance", "la instancia ya no sostiene la sesión", "instanceId"), nowMs));
      return;
    }
    const authoritative = boundToAsk && (session === undefined || session.holderInstanceId === peer.instanceId);
    const verdict = classifyAskCompletion(
      { kind: "reply_tool", requestId: request.requestId, replyTo: payload.replyTo, authorized: authoritative },
      ask.requestId,
    );
    if (!verdict.ok) {
      this.#send(peer, rejectedFrame(request.requestId, verdict.error, nowMs));
      return;
    }
    if (verdict.value !== "reply") {
      this.#send(peer, rejectedFrame(request.requestId, protocolError("INVALID_INPUT", "reply_to_mismatch", "replyTo debe referenciar el ask exacto", "payload.replyTo"), nowMs));
      return;
    }
    // Tardío: plazo vencido => el ask expira y el reply no tiene efectos.
    if (ask.deadlineAtMs !== null && nowMs >= ask.deadlineAtMs) {
      store.transition(ask.requestId, "expire", {
        nowMs,
        detail: "plazo del ask vencido antes del reply",
        error: protocolError("EXPIRED", "deadline_out_of_bounds", "el plazo del ask venció", "deadlineMs"),
      });
      this.#send(peer, rejectedFrame(request.requestId, protocolError("EXPIRED", "deadline_out_of_bounds", "reply tardío: el plazo del ask venció", "payload.replyTo"), nowMs));
      return;
    }
    // El reply explícito del titular implica que el ask ya fue recibido y
    // entregado a la API nativa: se avanza con los eventos legales de la
    // máquina congelada (receive/submit) antes del `reply`; sin estados
    // alternos ni saltos inventados.
    let askState = store.getRequest(ask.requestId)?.state ?? ask.state;
    if (askState === "queued") {
      const received = store.transition(ask.requestId, "receive", {
        nowMs,
        detail: "recibido según el reply explícito del destinatario",
      });
      if (received.ok) askState = received.record.state;
    }
    if (askState === "received") {
      const submitted = store.transition(ask.requestId, "submit", {
        nowMs,
        detail: "entregado a la API nativa según el reply explícito del destinatario",
      });
      if (submitted.ok) askState = submitted.record.state;
    }
    const askCompletion = store.transition(ask.requestId, "reply", {
      nowMs,
      detail: "reply explícito del destinatario",
      result: { replyRequestId: request.requestId, body: payload.body, summary: payload.summary },
    });
    if (!askCompletion.ok) {
      // Estado terminal u outcome_unknown: sin efectos (nunca replay ciego).
      this.#send(peer, rejectedFrame(request.requestId, askCompletion.error, nowMs));
      return;
    }
    const commit = store.commitRequest({
      requestId: request.requestId,
      projectId: peer.projectId ?? "",
      operation: "reply",
      target: request.target,
      payload: request.payload,
      grantId: request.grantId,
      stream: resolved.key,
      nowMs,
      deadlineAtMs: request.deadlineMs === undefined ? null : nowMs + request.deadlineMs,
    });
    if (commit.kind === "error") {
      this.#send(peer, rejectedFrame(request.requestId, commit.error, nowMs));
      return;
    }
    if (commit.kind === "new") {
      store.transition(request.requestId, "receive", { nowMs, detail: "reply journaled en el broker" });
      store.transition(request.requestId, "submit", { nowMs, detail: "aplicado al ask correlacionado" });
      store.transition(request.requestId, "complete", {
        nowMs,
        result: { replyTo: payload.replyTo, askRequestId: ask.requestId, askState: "completed" },
        detail: "reply aplicado",
      });
    }
    const record = store.getRequest(request.requestId);
    if (record === undefined) return;
    this.#send(
      peer,
      responseFrame(record, {
        replyTo: ask.requestId,
        result: { replyTo: payload.replyTo, askRequestId: ask.requestId, askState: askCompletion.record.state },
      }),
    );
  }

  #holderConnection(key: SessionKey, instanceId: string | null): PeerState | undefined {
    for (const peer of this.#connections) {
      if (peer.bound === undefined) continue;
      if (
        peer.bound.projectId !== key.projectId ||
        peer.bound.target !== key.target ||
        peer.bound.nativeSessionId !== key.nativeSessionId
      ) {
        continue;
      }
      if (instanceId !== null && peer.instanceId !== instanceId) continue;
      return peer;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- reports

  #handleReport(peer: PeerState, parsed: Record<string, unknown>): void {
    const store = this.#store;
    if (store === undefined) return;
    const unknown = Object.keys(parsed).filter(
      (key) => key !== "kind" && key !== "v" && key !== "requestId" && key !== "state" && key !== "result" && key !== "error" && key !== "atMs",
    );
    if (unknown.length > 0) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "report")));
      return;
    }
    if (parsed["v"] !== PROTOCOL_MAJOR) {
      this.#send(peer, errorFrame(protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "major de protocolo no soportado", "v")));
      return;
    }
    const requestIdRaw: unknown = parsed["requestId"];
    if (!isRequestId(requestIdRaw)) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "invalid_format", "requestId inválido", "requestId")));
      return;
    }
    const stateRaw: unknown = parsed["state"];
    if (!isString(stateRaw) || !REPORT_STATES.includes(stateRaw as RequestState)) {
      this.#send(peer, errorFrame(protocolError("INVALID_INPUT", "invalid_field", "state de reporte inválido", "state")));
      return;
    }
    const state = stateRaw as RequestState;
    const nowMs = this.#now();
    const record = store.getRequest(requestIdRaw);
    if (record === undefined || record.projectId !== (peer.projectId ?? "")) {
      this.#send(peer, errorFrame(protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "solicitud no disponible en este ámbito", "requestId")));
      return;
    }
    // Solo el titular actual de la sesión reporta; el dueño viejo pierde autoridad.
    const session = store.getSession(record.stream);
    if (peer.bound === undefined || peer.bound.target !== record.stream.target || peer.bound.nativeSessionId !== record.stream.nativeSessionId) {
      this.#send(peer, errorFrame(protocolError("UNAUTHORIZED", "unauthorized_scope", "reporte sin autoridad sobre esta sesión", "grant")));
      return;
    }
    if (session !== undefined && session.holderInstanceId !== null && peer.instanceId !== session.holderInstanceId) {
      this.#send(peer, errorFrame(protocolError("STALE_INSTANCE", "stale_instance", "la instancia ya no sostiene la sesión", "instanceId")));
      return;
    }
    const result = parsed["result"];
    const error = parsed["error"];
    const outcome =
      record.state === "outcome_unknown" && (state === "completed" || state === "failed")
        ? store.reconcile(
            record.requestId,
            state === "completed" ? "completed" : "failed",
            { result, error: error as ProtocolError | undefined },
            nowMs,
          )
        : store.transition(record.requestId, reportEvent(state), {
            nowMs,
            detail: "reporte del adaptador",
            result,
            error: error as ProtocolError | undefined,
          });
    if (!outcome.ok) {
      this.#send(peer, errorFrame(outcome.error));
      return;
    }
    this.#log.log("info", "request.reported", {
      connectionId: peer.connectionId,
      requestId: record.requestId,
      operation: record.operation,
      state: outcome.record.state,
    });
    this.#send(peer, responseFrame(outcome.record));
  }

  // ---------------------------------------------------------- eventos/cola

  #onStoreEvent(stream: SessionKey, event: EventRow): void {
    const nowMs = this.#now();
    if (DELIVERY_TOPICS[event.topic] === true) {
      const store = this.#store;
      const session = store?.getSession(stream);
      const holder = this.#holderConnection(stream, session?.holderInstanceId ?? null);
      if (holder !== undefined && this.#peerGrantValid(holder, nowMs)) {
        this.#send(holder, eventFrame(event));
      }
    }
    for (const peer of this.#connections) {
      if (!peer.handshaked) continue;
      let peerValid = true;
      for (const subscription of peer.subscriptions.values()) {
        if (
          subscription.stream.projectId !== stream.projectId ||
          subscription.stream.target !== stream.target ||
          subscription.stream.nativeSessionId !== stream.nativeSessionId
        ) {
          continue;
        }
        if (!subscription.topics.includes(event.topic)) continue;
        if (peerValid && !this.#peerGrantValid(peer, nowMs)) peerValid = false;
        if (!peerValid) break;
        if (!this.#enqueueEvent(peer, subscription, event)) break;
        this.#flushSubscription(peer, subscription);
      }
    }
  }

  #onClose(peer: PeerState): void {
    const store = this.#store;
    this.#connections.delete(peer);
    peer.ws = undefined;
    peer.subscriptions.clear();
    if (store === undefined || peer.bound === undefined || peer.instanceId === undefined) return;
    // Desconexión: cambia presencia y deja outcome_unknown sobre lo entregado
    // sin confirmar; NO completa ni cancela requests ni jobs nativos.
    store.markInstanceOffline(peer.bound, peer.instanceId, this.#now(), {
      invalidateControl: peer.invalidateControlOnClose,
    });
  }

  #sweep(): void {
    const store = this.#store;
    if (store === undefined || this.#closed) return;
    // Barrido de retención/expiración. La revalidación de grants NO depende de
    // timers: ocurre en cada frame entrante y en cada entrega (determinista).
    store.sweep(this.#now(), {
      requestMs: LIMITS.requestRetentionMs,
      eventMs: LIMITS.eventRetentionMs,
      journalBytesPerProject: LIMITS.maxJournalBytesPerProject,
    });
  }

  /**
   * Revalida el grant de un peer vivo ante revocación/expiración. Si caducó,
   * la conexión se corta en el acto (sin secretos en el aviso).
   */
  #peerGrantValid(peer: PeerState, nowMs: number): boolean {
    const store = this.#store;
    if (store === undefined || !peer.handshaked || peer.grantId === undefined || peer.projectId === undefined) {
      return false;
    }
    const record = store.grants.find(peer.grantId);
    const identity = {
      projectId: peer.projectId,
      workspaceId: peer.workspaceId ?? "",
      nativeSessionId: peer.nativeSessionId,
    };
    const ok = record !== undefined && store.grants.revalidate(record, identity, nowMs).ok;
    if (ok) return true;
    peer.invalidateControlOnClose = true;
    this.#log.log("warn", "grant.invalidated", {
      connectionId: peer.connectionId,
      grantId: peer.grantId,
      projectId: peer.projectId,
    });
    this.#send(peer, errorFrame(protocolError("UNAUTHORIZED", "unauthorized_scope", "grant revocado o expirado: conexión revalidada", "grant")));
    try {
      peer.ws?.close(1008, "grant invalidated");
    } catch {
      // best-effort
    }
    return false;
  }

  #healthPayload(): Record<string, unknown> {
    const store = this.#store;
    const storeHealth = store?.health();
    let sessionsOnline = 0;
    let handshaked = 0;
    for (const peer of this.#connections) {
      if (peer.bound !== undefined) sessionsOnline += 1;
      if (peer.handshaked) handshaked += 1;
    }
    // Dimensiones separadas (FR-010): proceso accesible, store utilizable,
    // schema compatible y disponibilidad de peers. Sin inferencia ni secretos.
    const storeUsable = store !== undefined && storeHealth !== undefined && storeHealth.usable && storeHealth.writer;
    const schemaCompatible =
      storeHealth !== undefined && storeHealth.schemaCompatible && storeHealth.schemaVersion === STORE_SCHEMA_VERSION;
    return {
      ok: !this.#closed && this.#listening && storeUsable && schemaCompatible,
      process: {
        startedAtMs: this.#startedAtMs,
        uptimeMs: Math.max(0, this.#now() - this.#startedAtMs),
        listening: this.#listening && !this.#closed,
      },
      store: {
        usable: storeUsable,
        schemaVersion: storeHealth?.schemaVersion ?? 0,
        writer: storeHealth?.writer ?? false,
        grants: storeHealth?.grants ?? 0,
        requests: storeHealth?.requests ?? 0,
        events: storeHealth?.events ?? 0,
      },
      schema: {
        version: storeHealth?.schemaVersion ?? 0,
        expected: STORE_SCHEMA_VERSION,
        compatible: schemaCompatible,
      },
      peers: {
        available: this.#listening && !this.#closed,
        connections: this.#connections.size,
        handshaked,
        sessionsOnline,
        sessionsTotal: storeHealth?.sessions ?? 0,
      },
    };
  }
}

/** Mapa estado-reportado → evento de la máquina congelada. */
function reportEvent(state: RequestState): "receive" | "submit" | "complete" | "reject" | "fail" | "expire" | "cancel" | "crash_window" {
  switch (state) {
    case "received":
      return "receive";
    case "submitted":
      return "submit";
    case "completed":
      return "complete";
    case "rejected":
      return "reject";
    case "failed":
      return "fail";
    case "expired":
      return "expire";
    case "cancelled":
      return "cancel";
    default:
      return "crash_window";
  }
}
