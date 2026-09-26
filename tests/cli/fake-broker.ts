/**
 * Broker falso de `tests/cli` (P-003 / G-001).
 *
 * Implementado SOLO sobre `@session-broker/protocol` (validadores, grants,
 * dedup, máquina de estados) + `Bun.serve` con WebSockets en loopback. NO
 * importa `@session-broker/server` ni código de P-002: la suite debe pasar
 * antes de integrar el broker real.
 *
 * Modela el contrato congelado: handshake `hello`/`welcome` con negociación de
 * versión, auth scoped por grant, dedup durable por (projectId, requestId),
 * estados únicos, `controlEpoch`, cursores, backpressure y corte de
 * suscripciones. La credencial del `hello` NUNCA se conserva (se redacta al
 * entrar).
 */

import {
  LIMITS,
  PROTOCOL_MAJOR,
  applyRequestEvent,
  checkOperationSupport,
  classifyAskCompletion,
  evaluateDedup,
  evaluateGrant,
  isRequestId,
  newChallenge,
  newConnectionId,
  newEventId,
  negotiateHelloVersion,
  operationCategory,
  protocolError,
  requiredCapabilitiesFor,
  validateHello,
  validateRequestEnvelope,
  type Capability,
  type EventEnvelope,
  type Grant,
  type GrantAction,
  type HelloMessage,
  type NativeAskSignal,
  type Operation,
  type ProtocolError,
  type RequestEnvelope,
  type RequestEventType,
  type RequestRecord,
  type RequestState,
  type ResponseEnvelope,
} from "@session-broker/protocol";

export const FIXTURE_CREDENTIAL = "fixture-credential-not-a-real-secret";

interface FbConn {
  socket: FbSocket;
  hello: HelloMessage | undefined;
}

interface FbSocket {
  data: FbConn;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface FbServer {
  port: number;
  stop(force?: boolean): void;
}

interface SubscriptionEntry {
  socket: FbSocket;
  requestId: string;
  topics: readonly string[];
  fromEventSeq: number;
}

export interface FakeBrokerOptions {
  grant: Grant;
  credential?: string;
  capabilities?: readonly Capability[];
  serverProtocolVersions?: readonly string[];
  now?: () => number;
}

/**
 * Valores tal y como viajan en el frame. JSON no transporta `undefined`, pero
 * `validateRequestEnvelope`/`validateOperationPayload` normalizan inyectando
 * claves con valor `undefined` (p. ej. `target.instanceId`, `payload.maxTurns`)
 * que `canonicalJson` rechaza (`INVALID_INPUT/invalid_field`). El hash de dedup
 * se define sobre la serialización de los valores del wire: es exactamente lo
 * que hashea `idempotentReplayExample()` de `@session-broker/protocol/fixtures`
 * (objetos planos sin claves undefined).
 */
function wireValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

export class FakeBroker {
  readonly busyOperations = new Set<Operation>();
  readonly ambiguousTargets = new Set<string>();
  readonly staleInstanceIds = new Set<string>();
  /** `true`: procesa y registra efectos pero NO responde (ACK perdido / timeout). */
  silent = false;
  rateLimitAfter: number | undefined;

  private readonly server: FbServer;
  private readonly grant: Grant;
  private readonly credential: string;
  private readonly capabilities: readonly Capability[];
  private readonly serverVersions: readonly string[];
  private readonly nowFn: () => number;
  private readonly connections: FbConn[] = [];
  private readonly subs: SubscriptionEntry[] = [];
  private readonly records = new Map<string, RequestRecord>();
  private readonly hellosSeen: HelloMessage[] = [];
  private readonly requestsSeen: RequestEnvelope[] = [];
  private readonly countsByOperation = new Map<Operation, number>();
  private seq = 0;
  private handledCount = 0;
  private executions = 0;
  private replayCount = 0;
  private controlEpochValue = 0;
  private leaseInstanceId: string | undefined;
  private closedFlag = false;

  private constructor(options: FakeBrokerOptions) {
    this.grant = options.grant;
    this.credential = options.credential ?? FIXTURE_CREDENTIAL;
    this.capabilities = options.capabilities ?? [
      "session.identity",
      "session.observe",
      "session.prompt.when_idle",
      "session.reply_tool",
      "session.notify",
      "session.control.prompt",
      "session.control.steer",
      "session.control.follow_up",
      "session.control.abort",
      "root.binding",
    ];
    this.serverVersions = options.serverProtocolVersions ?? ["1.0.0"];
    this.nowFn = options.now ?? Date.now;
    const serve = Bun.serve as unknown as (options: Record<string, unknown>) => FbServer;
    this.server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req: Request, srv: { upgrade(request: Request): boolean }) => {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("fake broker: solo websocket", { status: 426 });
      },
      websocket: {
        open: (socket: FbSocket) => {
          const conn: FbConn = { socket, hello: undefined };
          socket.data = conn;
          this.connections.push(conn);
        },
        message: (socket: FbSocket, message: string | Buffer) => {
          this.handleMessage(socket.data, typeof message === "string" ? message : message.toString());
        },
        close: (socket: FbSocket) => {
          this.dropConn(socket.data);
        },
      },
    });
  }

  static start(options: FakeBrokerOptions): FakeBroker {
    return new FakeBroker(options);
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.server.port}`;
  }

  get port(): number {
    return this.server.port;
  }

  /** Hellos recibidos con la credencial YA redactada; jamás se conserva en claro. */
  get hellos(): readonly HelloMessage[] {
    return this.hellosSeen;
  }

  get requests(): readonly RequestEnvelope[] {
    return this.requestsSeen;
  }

  get executionCount(): number {
    return this.executions;
  }

  get replays(): number {
    return this.replayCount;
  }

  get operationCounts(): ReadonlyMap<Operation, number> {
    return this.countsByOperation;
  }

  get subscriptionCount(): number {
    return this.subs.length;
  }

  setControlEpoch(epoch: number): void {
    this.controlEpochValue = epoch;
  }

  /** Instancia vigente del lease de control (para `STALE_INSTANCE`). */
  setLeaseInstance(instanceId: string): void {
    this.leaseInstanceId = instanceId;
  }

  record(requestId: string): RequestRecord | undefined {
    return this.records.get(requestId);
  }

  /** Ventana de crash: el registro pasa a `outcome_unknown` (exige reconciliación). */
  crashWindow(requestId: string): void {
    this.advanceRecord(requestId, "crash_window");
  }

  cancelRequest(requestId: string): void {
    this.advanceRecord(requestId, "cancel");
  }

  /**
   * Señal nativa frente a un ask. `agent_end`/`next_text` NUNCA completan el
   * ask (devuelven "ignored"); solo la herramienta explícita de reply transita.
   */
  simulateNativeSignal(requestId: string, kind: "agent_end" | "next_text"): "ignored" | "unknown" | "rejected" {
    const record = this.records.get(requestId);
    if (record === undefined) return "unknown";
    const signal: NativeAskSignal = kind === "agent_end" ? { kind: "agent_end" } : { kind: "next_text" };
    const classified = classifyAskCompletion(signal, record.requestId);
    if (!classified.ok) return "rejected";
    if (classified.value === null) return "ignored";
    return "rejected";
  }

  emitEvent(topic: string, data: unknown): void {
    for (const sub of [...this.subs]) {
      if (!sub.topics.includes(topic)) continue;
      const event: EventEnvelope = {
        v: PROTOCOL_MAJOR,
        kind: "event",
        eventId: newEventId(),
        eventSeq: this.nextSeq(),
        topic,
        data,
        atMs: this.nowFn(),
      };
      sub.socket.send(JSON.stringify(event));
    }
  }

  /** Backpressure: corta toda suscripción con `QUEUE_FULL` (sin eventos inventados). */
  overflowSubscriptions(): void {
    for (const sub of this.subs.splice(0)) {
      this.respondError(
        sub.socket,
        sub.requestId,
        "failed",
        protocolError("QUEUE_FULL", "queue_full", "cola de eventos de la suscripción llena; suscripción cortada", "subscription"),
      );
    }
  }

  dropConnections(): void {
    for (const conn of [...this.connections]) {
      conn.socket.close();
    }
    this.connections.length = 0;
    this.subs.length = 0;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.server.stop(true);
    this.connections.length = 0;
    this.subs.length = 0;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private dropConn(conn: FbConn): void {
    const index = this.connections.indexOf(conn);
    if (index >= 0) this.connections.splice(index, 1);
    for (let i = this.subs.length - 1; i >= 0; i -= 1) {
      const sub = this.subs[i];
      if (sub !== undefined && sub.socket === conn.socket) this.subs.splice(i, 1);
    }
  }

  private handleMessage(conn: FbConn, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(conn.socket, protocolError("INVALID_INPUT", "schema_malformed", "frame no interpretable", "frame"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.sendError(conn.socket, protocolError("INVALID_INPUT", "schema_malformed", "frame debe ser un objeto", "frame"));
      return;
    }
    const raw = parsed as Record<string, unknown>;
    if (raw.kind === "hello") {
      this.handleHello(conn, raw);
      return;
    }
    if (raw.kind === "request") {
      if (!conn.hello) {
        this.sendError(conn.socket, protocolError("UNAUTHORIZED", "unauthorized_scope", "solicitud sin handshake previo"));
        return;
      }
      this.handleRequest(conn, raw);
      return;
    }
    this.sendError(conn.socket, protocolError("INVALID_INPUT", "schema_malformed", `kind desconocido: ${String(raw.kind)}`, "kind"));
  }

  private handleHello(conn: FbConn, raw: Record<string, unknown>): void {
    const validated = validateHello(raw);
    if (!validated.ok) {
      this.sendError(conn.socket, validated.error);
      conn.socket.close();
      return;
    }
    const hello = validated.value;
    if (hello.grantId !== this.grant.grantId || hello.credential !== this.credential) {
      this.sendError(conn.socket, protocolError("UNAUTHORIZED", "unauthorized_scope", "credencial/grant inválidos"));
      conn.socket.close();
      return;
    }
    const negotiated = negotiateHelloVersion(hello, this.serverVersions);
    if (!negotiated.ok) {
      this.sendError(conn.socket, negotiated.error);
      conn.socket.close();
      return;
    }
    // Redacción al entrar: la credencial jamás se conserva ni se registra.
    const redacted: HelloMessage = { ...hello, credential: "[redacted]" };
    conn.hello = redacted;
    this.hellosSeen.push(redacted);
    const welcome = {
      kind: "welcome",
      v: PROTOCOL_MAJOR,
      protocolVersion: negotiated.value,
      connectionId: newConnectionId(),
      serverChallenge: newChallenge(),
      serverCapabilities: [...this.capabilities],
      maxFrameBytes: LIMITS.maxFrameBytes,
      heartbeatMs: LIMITS.heartbeatMs,
    };
    conn.socket.send(JSON.stringify(welcome));
  }

  private handleRequest(conn: FbConn, raw: Record<string, unknown>): void {
    const frameJson = JSON.stringify(raw);
    const validated = validateRequestEnvelope(raw, { frameJson });
    const rawRequestId = typeof raw.requestId === "string" ? raw.requestId : undefined;
    if (!validated.ok) {
      if (rawRequestId !== undefined && isRequestId(rawRequestId)) {
        this.respondError(conn.socket, rawRequestId, "rejected", validated.error);
      } else {
        this.sendError(conn.socket, validated.error);
      }
      return;
    }
    const envelope = validated.value;
    this.requestsSeen.push(envelope);
    const hello = conn.hello;
    if (hello === undefined) {
      this.sendError(conn.socket, protocolError("UNAUTHORIZED", "unauthorized_scope", "solicitud sin handshake previo"));
      return;
    }
    let controlVerb: string | undefined;
    if (envelope.operation === "control") {
      const controlPayload: unknown = envelope.payload;
      if (typeof controlPayload === "object" && controlPayload !== null && "verb" in controlPayload) {
        const rawVerb: unknown = controlPayload.verb;
        controlVerb = typeof rawVerb === "string" ? rawVerb : undefined;
      }
    }
    const required = requiredCapabilitiesFor(envelope.operation, controlVerb);
    if (required === undefined) {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", `operación desconocida: ${envelope.operation}`, "operation"),
      );
      return;
    }
    const support = checkOperationSupport(envelope.operation, controlVerb, this.capabilities);
    if (!support.ok) {
      this.respondError(conn.socket, envelope.requestId, "rejected", support.error);
      return;
    }
    const session = envelope.target.session;
    for (const capability of required) {
      const action: GrantAction = {
        projectId: hello.projectId,
        workspaceId: session?.workspaceId ?? hello.workspaceId,
        target: envelope.target.target,
        nativeSessionId: session?.nativeSessionId,
        capability,
      };
      const decision = evaluateGrant(this.grant, action, this.nowFn());
      if (!decision.ok) {
        const mapped: ProtocolError =
          decision.error.reason === "unauthorized_scope"
            ? protocolError(
                "NOT_FOUND_OR_FORBIDDEN",
                "unauthorized_scope",
                "recurso fuera del ámbito del grant (no se filtra existencia)",
                decision.error.path,
              )
            : decision.error;
        this.respondError(conn.socket, envelope.requestId, "rejected", mapped);
        return;
      }
    }

    // Rechazos pre-commit: sin registro durable, un retry con el mismo
    // requestId sigue siendo viable (retrySafe) y no hay efectos.
    if (this.ambiguousTargets.has(envelope.target.target)) {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("AMBIGUOUS_TARGET", "ambiguous_target", "el selector resuelve a varios objetivos; no se elige en silencio", "target.target"),
      );
      return;
    }
    if (envelope.target.instanceId !== undefined && this.staleInstanceIds.has(envelope.target.instanceId)) {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("STALE_INSTANCE", "stale_instance", "la instancia referida ya no es la vigente", "target.instanceId"),
      );
      return;
    }
    if (this.busyOperations.has(envelope.operation)) {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("TARGET_BUSY", "target_busy", "el objetivo está ocupado y la política no interrumpe", "target"),
      );
      return;
    }
    if (this.rateLimitAfter !== undefined && this.handledCount >= this.rateLimitAfter) {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("RATE_LIMITED", "rate_limited", "cuota de tasa por grant superada", "grant"),
      );
      return;
    }
    this.handledCount += 1;

    if (envelope.operation === "control") {
      if (this.leaseInstanceId !== undefined && hello.instanceId !== this.leaseInstanceId) {
        this.respondError(
          conn.socket,
          envelope.requestId,
          "rejected",
          protocolError("STALE_INSTANCE", "stale_instance", "la instancia del lease de control no coincide", "target.instanceId"),
        );
        return;
      }
      if (envelope.controlEpoch !== this.controlEpochValue) {
        this.respondError(
          conn.socket,
          envelope.requestId,
          "rejected",
          protocolError(
            "STALE_CONTROL_EPOCH",
            "stale_control_epoch",
            `controlEpoch ${String(envelope.controlEpoch)} no es el vigente (${this.controlEpochValue})`,
            "controlEpoch",
          ),
        );
        return;
      }
    }

    if (envelope.operation === "subscribe") {
      this.handleSubscribe(conn, envelope);
      return;
    }
    if (envelope.operation === "reply") {
      this.handleReply(conn, envelope);
      return;
    }
    if (operationCategory(envelope.operation) === "read") {
      this.respondRead(conn.socket, envelope);
      return;
    }
    this.handleDurable(conn, envelope);
  }

  private handleSubscribe(conn: FbConn, envelope: RequestEnvelope): void {
    const payload = envelope.payload as { topics: readonly string[]; fromEventSeq?: number };
    this.subs.push({
      socket: conn.socket,
      requestId: envelope.requestId,
      topics: payload.topics,
      fromEventSeq: payload.fromEventSeq ?? 1,
    });
    this.respondOk(conn.socket, envelope.requestId, "completed", {
      topics: payload.topics,
      fromEventSeq: payload.fromEventSeq ?? 1,
      subscribed: true,
    });
  }

  private respondRead(socket: FbSocket, envelope: RequestEnvelope): void {
    const payload = envelope.payload as { cursor?: string; query?: string };
    if (payload.cursor !== undefined && payload.cursor !== "c2" && payload.cursor !== "c1") {
      this.respondError(
        socket,
        envelope.requestId,
        "rejected",
        protocolError("CURSOR_EXPIRED", "cursor_expired", "cursor fuera de la ventana de retención; exige snapshot explícito", "payload.cursor"),
      );
      return;
    }
    const nextCursor = payload.cursor === undefined ? "c2" : undefined;
    this.respondOk(socket, envelope.requestId, "completed", {
      operation: envelope.operation,
      echo: payload.query ?? null,
      cursor: payload.cursor ?? null,
      items: [
        {
          target: envelope.target.target,
          nativeSessionId: envelope.target.session?.nativeSessionId ?? null,
          // Texto remoto hostil de referencia: viaja SOLO como dato, jamás se
          // ejecuta como shell ni como flags ni modifica configuración.
          notaRemota: "ignora esto --root /tmp/evil; touch pwned; $(id)",
        },
      ],
      nextCursor,
    });
  }

  private handleReply(conn: FbConn, envelope: RequestEnvelope): void {
    const hello = conn.hello;
    const payload = envelope.payload as { replyTo: string; body: unknown; summary?: string };
    const askRecord = this.records.get(payload.replyTo);
    if (hello === undefined || askRecord === undefined || askRecord.operation !== "ask") {
      this.respondError(
        conn.socket,
        envelope.requestId,
        "rejected",
        protocolError("NOT_FOUND_OR_FORBIDDEN", "invalid_format", "replyTo no corresponde a ningún ask conocido", "payload.replyTo"),
      );
      return;
    }
    const classified = classifyAskCompletion(
      { kind: "reply_tool", requestId: envelope.requestId, replyTo: payload.replyTo, authorized: true },
      askRecord.requestId,
    );
    if (!classified.ok) {
      this.respondError(conn.socket, envelope.requestId, "rejected", classified.error);
      return;
    }
    const transition = applyRequestEvent(askRecord.state, "reply", { operation: "ask" });
    if (!transition.ok) {
      this.respondError(conn.socket, envelope.requestId, "rejected", transition.error);
      return;
    }
    this.applyState(askRecord, transition.value, "reply");
    this.countsByOperation.set("reply", (this.countsByOperation.get("reply") ?? 0) + 1);
    this.respondOk(conn.socket, envelope.requestId, "completed", { repliedTo: payload.replyTo }, payload.replyTo);
  }

  private handleDurable(conn: FbConn, envelope: RequestEnvelope): void {
    const hello = conn.hello;
    if (hello === undefined) return;
    const key = envelope.requestId;
    const decision = evaluateDedup(this.records.get(key), {
      projectId: hello.projectId,
      requestId: envelope.requestId,
      operation: envelope.operation,
      // Hash canónico sobre los valores del WIRE (ver `wireValue`).
      target: wireValue(envelope.target),
      payload: wireValue(envelope.payload),
      nowMs: this.nowFn(),
    });
    if (!decision.ok) {
      this.respondError(conn.socket, envelope.requestId, "rejected", decision.error);
      return;
    }
    if (decision.value.kind === "idempotent_replay") {
      // Replay idempotente: recupera el registro SIN nuevos efectos ni IDs.
      this.replayCount += 1;
      const record = decision.value.record;
      this.respondOk(conn.socket, envelope.requestId, record.state, {
        replay: true,
        operation: record.operation,
        state: record.state,
        receipts: record.receipts,
      });
      return;
    }
    if (decision.value.kind === "conflict") {
      // Hash distinto bajo el mismo requestId: PAYLOAD_CONFLICT sin efectos.
      this.respondError(conn.socket, envelope.requestId, "rejected", decision.value.error);
      return;
    }
    const record = decision.value.record;
    this.records.set(key, record);
    this.executions += 1;
    this.countsByOperation.set(envelope.operation, (this.countsByOperation.get(envelope.operation) ?? 0) + 1);
    if (envelope.operation === "ask") {
      // Recibo tras commit durable; el ask solo se completa con reply explícito.
      this.respondOk(conn.socket, envelope.requestId, "queued", { queued: true });
      this.advanceRecord(envelope.requestId, "receive");
      this.advanceRecord(envelope.requestId, "submit");
      return;
    }
    this.advanceRecord(envelope.requestId, "receive");
    this.advanceRecord(envelope.requestId, "submit");
    const completed = this.advanceRecord(envelope.requestId, "complete");
    this.respondOk(conn.socket, envelope.requestId, completed?.state ?? "completed", {
      applied: true,
      operation: envelope.operation,
    });
  }

  private advanceRecord(requestId: string, event: RequestEventType): RequestRecord | undefined {
    const record = this.records.get(requestId);
    if (record === undefined) return undefined;
    const transition = applyRequestEvent(record.state, event, { operation: record.operation });
    if (!transition.ok) return undefined;
    return this.applyState(record, transition.value, event);
  }

  private applyState(record: RequestRecord, state: RequestState, detail: string): RequestRecord {
    const updated: RequestRecord = {
      ...record,
      state,
      updatedAtMs: this.nowFn(),
      receipts: [
        ...record.receipts,
        { state, atMs: this.nowFn(), eventId: newEventId(), eventSeq: this.nextSeq(), detail },
      ],
    };
    this.records.set(record.requestId, updated);
    return updated;
  }

  private sendError(socket: FbSocket, error: ProtocolError): void {
    socket.send(JSON.stringify({ kind: "error", error }));
  }

  private respondOk(
    socket: FbSocket,
    requestId: string,
    state: RequestState,
    result: unknown,
    replyTo?: string,
  ): void {
    // `silent` simula ACK perdido: el broker procesa y registra efectos pero
    // NINGÚN ResponseEnvelope llega al cliente.
    if (this.silent) return;
    const response: ResponseEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "response",
      requestId,
      ...(replyTo !== undefined ? { replyTo } : {}),
      state,
      eventId: newEventId(),
      eventSeq: this.nextSeq(),
      atMs: this.nowFn(),
      result,
    };
    socket.send(JSON.stringify(response));
  }

  private respondError(socket: FbSocket, requestId: string, state: RequestState, error: ProtocolError): void {
    if (this.silent) return;
    const response: ResponseEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "response",
      requestId,
      state,
      eventId: newEventId(),
      eventSeq: this.nextSeq(),
      atMs: this.nowFn(),
      error,
    };
    socket.send(JSON.stringify(response));
  }
}
