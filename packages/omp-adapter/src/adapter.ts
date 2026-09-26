/**
 * Adaptador OMP nativo (P-004 / G-001): primer puente entre una sesión OMP y
 * el broker SIN sustituir la TUI nativa.
 *
 * Frontera única con APIs OMP: los puertos estructurales de `./ports` se
 * inyectan por constructor (dependency inversion); este paquete jamás importa
 * el paquete global del host ni sus privados. Toda lectura es sin inferencia
 * (`on`/`isIdle`/`getSessionId`/`subscribeRunState`); el único prompt nativo se
 * emite para entregar un `ask` broker con la política congelada `when_idle`.
 *
 * Capacidades declaradas (evidencia en `docs/compatibility/omp-api-matrix.md`):
 *
 * | Capability | Estado | Mapping implementado |
 * | --- | --- | --- |
 * | `session.identity` | supported | `getSessionId`/`getSessionFile` |
 * | `session.observe` | supported | `on(...)`/`isIdle`/`subscribeRunState`, sin `sendUserMessage` |
 * | `session.prompt.when_idle` | supported | idle → `sendUserMessage(q)`; ocupado → `sendUserMessage(q, {deliverAs:"followUp"})` |
 * | `session.reply_tool` | supported | `registerTool` + herramienta `session_reply` |
 * | `root.binding` | supported | `issueRootProof` + `bind_root` (no heredable; matriz §6) |
 * | `session.notify` | parcial | SOLO tema reservado `broker.session.status` (runState); otros temas → `UNSUPPORTED_CAPABILITY` |
 * | `session.control.*` | unsupported | sin mapping verificado → `UNSUPPORTED_CAPABILITY` antes de efectos |
 *
 * Máquina local de un ask: `received` (journal incoming) → `submitting`
 * (marcador previo a la llamada nativa) → `submitted` (llamada hecha) →
 * `completed` SOLO con el reply explícito de `session_reply`. Ni `agent_end` ni
 * el siguiente texto del modelo completan un ask. Ver `./receipts`.
 */

import {
  CAPABILITIES,
  LIMITS,
  classifyAskCompletion,
  isPlainObject,
  isRequestId,
  newRequestId,
  protocolError,
  type Capability,
  type EventEnvelope,
  type GrantId,
  type InstanceId,
  type NativeSessionId,
  type ProjectId,
  type ProtocolError,
  type ReplyPayload,
  type RequestId,
  type ResponseEnvelope,
  type SessionRef,
  type TargetId,
  type TargetRef,
  type WorkspaceId,
} from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { HolderChannel, OmpChannelError, checkEndpointPolicy } from "./channel";
import { ReceiptsJournal, receiptsPathFor, type AskReceipt, type AskReceiptState } from "./receipts";
import { issueRootProof } from "./root-proof";
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
} from "./ports";

export interface OmpAdapterOptions {
  endpoint: string;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  instanceId: InstanceId;
  nativeSessionId: NativeSessionId;
  grantId: GrantId;
  credential: string;
  /** Nombre de la herramienta de reply; default `session_reply` (congelado). */
  replyToolName?: string;
  now?: () => number;
  // ---- aditivos P-004 (el freeze de packages.md calla sobre ellos) ----
  /** Puertos estructurales OMP (dependency inversion). Obligatorio. */
  host: OmpExtensionHost;
  /** MAC key del usuario para emitir la root proof. Nunca se persiste/loguea. */
  macKey: string;
  /** User data dir para el journal de recibos (fuera de worktrees). Obligatorio. */
  dataDir: string;
  /** Objetivo broker de la sesión; default `omp`. */
  target?: TargetId;
  /** Política LOCAL explícita para `ws://` (solo loopback/fixtures). */
  allowInsecureWs?: boolean;
}

/** Operaciones broker delegadas a `@session-broker/client` (sin autoridad de titular). */
export type OmpBrokerOps = Pick<BrokerClient, "query" | "list" | "inspect" | "history" | "subscribe" | "ask" | "notify">;

export interface OmpObservedEvent {
  readonly event: OmpHostEvent;
  readonly atMs: number;
}

/** Lectura nativa sin inferencia (solo puertos; jamás `sendUserMessage`). */
export interface OmpNativeSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly runState: OmpRunState;
  readonly hasPendingMessages: boolean;
  readonly bound: boolean;
  readonly nativeSessionId: NativeSessionId;
  readonly events: readonly OmpObservedEvent[];
}

export interface PendingAskView {
  readonly requestId: RequestId;
  readonly state: AskReceiptState;
  readonly replyState: AskReceipt["replyState"];
  readonly deadlineAtMs: number | null;
}

export interface OmpAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Capacidades realmente soportadas por esta versión OMP (evidencia en docs/compatibility). */
  readonly capabilities: readonly Capability[];
  // ---- aditivos P-004 (superficie de integración; el freeze solo exige las tres de arriba) ----
  /** Identidad/estado/eventos nativos vía hooks/API nativa, sin inferencia. */
  snapshot(): OmpNativeSnapshot;
  /** Asks recibidos aún no terminales (visibilidad de `queued ≠ submitted`). */
  pendingAsks(): readonly PendingAskView[];
  /** Rebind explícito: SIEMPRE conexión + challenge + root proof nuevas. */
  rebind(input?: { nativeSessionId?: NativeSessionId }): Promise<void>;
  /** Cliente público del broker (lecturas/journal/ask/notify salientes). */
  openBroker(): Promise<OmpBrokerOps>;
}

const ADAPTER_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.identity,
  CAPABILITIES.observe,
  CAPABILITIES.promptWhenIdle,
  CAPABILITIES.replyTool,
  // Alcance restringido: solo el tema reservado de runState (convención INTEROP
  // `broker.session.status`; sin mapping nativo de temas arbitrarios).
  CAPABILITIES.notify,
  CAPABILITIES.rootBinding,
];

/** Tema reservado INTEROP para el estado de trabajo nativo (data `{runState}`). */
const RUN_STATE_TOPIC = "broker.session.status";
const DEFAULT_REPLY_TOOL = "session_reply";
const DEFAULT_TARGET: TargetId = "omp";
const MAX_OBSERVED_EVENTS = 256;

/** Estados de recibo terminales: nunca vuelven a entregarse ni se repiten. */
const TERMINAL_RECEIPT_STATES: Record<string, true> = {
  completed: true,
  rejected: true,
  failed: true,
  expired: true,
  cancelled: true,
  outcome_unknown: true,
};

/** Rechazos de reporte que significan «ya avanzado» (re-report idempotente). */
const ALREADY_ADVANCED_REASONS: Record<string, true> = {
  invalid_transition: true,
  terminal_state: true,
};

interface AskDelivery {
  readonly requestId: RequestId;
  readonly question: string;
  readonly deadlineAtMs: number | null;
  readonly policy: string;
}

function failInput(message: string): never {
  throw new Error(`createOmpAdapter: ${message}`);
}

function parseAskDelivery(raw: unknown): AskDelivery | undefined {
  if (!isPlainObject(raw)) return undefined;
  const requestId: unknown = raw["requestId"];
  const question: unknown = raw["question"];
  const policy: unknown = raw["policy"];
  if (typeof requestId !== "string" || !isRequestId(requestId)) return undefined;
  if (typeof question !== "string") return undefined;
  const deadline: unknown = raw["deadlineAtMs"];
  return {
    requestId,
    question,
    deadlineAtMs: typeof deadline === "number" ? deadline : null,
    policy: typeof policy === "string" ? policy : "when_idle",
  };
}

export function createOmpAdapter(options: OmpAdapterOptions): OmpAdapter {
  return new OmpAdapterImpl(options);
}

class OmpAdapterImpl implements OmpAdapter {
  readonly #options: OmpAdapterOptions;
  readonly #now: () => number;
  readonly #target: TargetId;
  readonly #replyToolName: string;
  readonly #receipts: ReceiptsJournal;
  readonly #hostUnsubs: OmpUnsubscribe[] = [];
  readonly #observedEvents: OmpObservedEvent[] = [];
  /** Entregas nativas en curso: jamás dos llamadas nativas por el mismo ask. */
  readonly #inFlight = new Set<RequestId>();
  #channel: HolderChannel | undefined;
  #client: BrokerClient | undefined;
  #nativeSessionId: NativeSessionId;
  #runState: OmpRunState = "idle";
  #bound = false;
  #bindingValid = false;
  #toolRegistered = false;
  #hooksWired = false;
  #state: "idle" | "starting" | "running" | "stopped" = "idle";

  constructor(options: OmpAdapterOptions) {
    if (options.host === undefined) failInput("host (puertos OMP) es obligatorio");
    if (typeof options.macKey !== "string" || options.macKey.length === 0) failInput("macKey ausente (config de usuario)");
    if (typeof options.dataDir !== "string" || options.dataDir.length === 0 || !options.dataDir.startsWith("/")) {
      failInput("dataDir debe ser una ruta absoluta de user data (fuera de worktrees)");
    }
    if (typeof options.credential !== "string" || options.credential.length === 0) failInput("credential ausente");
    if (typeof options.replyToolName === "string" && options.replyToolName.length === 0) failInput("replyToolName inválido");
    // Valida la política de transporte en la construcción (fail-closed temprano).
    checkEndpointPolicy(options.endpoint, options.allowInsecureWs === true);
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#target = options.target ?? DEFAULT_TARGET;
    this.#replyToolName = options.replyToolName ?? DEFAULT_REPLY_TOOL;
    this.#nativeSessionId = options.nativeSessionId;
    this.#receipts = new ReceiptsJournal({
      filePath: receiptsPathFor(options.dataDir, this.#target, this.#nativeSessionId),
      now: this.#now,
    });
  }

  get capabilities(): readonly Capability[] {
    return ADAPTER_CAPABILITIES;
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.#state === "starting" || this.#state === "running") return;
    this.#state = "starting";
    try {
      this.#registerToolOnce();
      this.#wireHostOnce();
      const channel = this.#openChannel(this.#nativeSessionId);
      this.#channel = channel;
      const welcome = await channel.connect();
      await this.#bindRoot(channel, welcome.serverChallenge, welcome.connectionId);
      this.#bound = true;
      this.#bindingValid = true;
      await this.#recoverReceipts();
      this.#declareRunState(this.#runState).catch(() => undefined);
      this.#state = "running";
    } catch (error) {
      this.#channel?.close();
      this.#channel = undefined;
      this.#bound = false;
      this.#bindingValid = false;
      this.#state = "idle";
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.#hostUnsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // best-effort: jamás destruye la TUI
      }
    }
    this.#hooksWired = false;
    this.#channel?.close();
    this.#channel = undefined;
    const client = this.#client;
    this.#client = undefined;
    await client?.close().catch(() => undefined);
    this.#bound = false;
    this.#bindingValid = false;
    this.#state = "stopped";
    // La herramienta registrada NO se replica ni se re-registra en el próximo
    // start: el runtime nativo conserva una sola copia (restart ≠ relanzar OMP).
  }

  async rebind(input?: { nativeSessionId?: NativeSessionId }): Promise<void> {
    const nextSession = input?.nativeSessionId ?? this.#options.host.getSessionId();
    // Cambio de sesión invalida el binding anterior; el rebind exige SIEMPRE
    // conexión + challenge + root proof nuevas (el challenge rota tras bind).
    this.#bindingValid = false;
    this.#channel?.close();
    this.#channel = undefined;
    this.#bound = false;
    this.#nativeSessionId = nextSession;
    this.#receipts.switchTo(receiptsPathFor(this.#options.dataDir, this.#target, nextSession));
    const channel = this.#openChannel(nextSession);
    this.#channel = channel;
    const welcome = await channel.connect();
    await this.#bindRoot(channel, welcome.serverChallenge, welcome.connectionId);
    this.#bound = true;
    this.#bindingValid = true;
    this.#state = "running";
    await this.#recoverReceipts();
    this.#declareRunState(this.#runState).catch(() => undefined);
  }

  #openChannel(nativeSessionId: NativeSessionId): HolderChannel {
    return new HolderChannel({
      endpoint: this.#options.endpoint,
      projectId: this.#options.projectId,
      workspaceId: this.#options.workspaceId,
      instanceId: this.#options.instanceId,
      nativeSessionId,
      grantId: this.#options.grantId,
      credential: this.#options.credential,
      capabilities: ADAPTER_CAPABILITIES,
      now: this.#now,
      onEvent: (event) => this.#onDelivery(event),
      onConnectionLost: () => {
        // La presencia la decide el broker; aquí solo se invalida la autoridad.
        this.#bound = false;
      },
      ...(this.#options.allowInsecureWs === undefined ? {} : { allowInsecureWs: this.#options.allowInsecureWs }),
    });
  }

  async #bindRoot(channel: HolderChannel, challenge: string, audience: string): Promise<void> {
    // Root proof de un solo uso: audience = connectionId, challenge = welcome.
    const proof = issueRootProof({
      macKey: this.#options.macKey,
      issuer: `omp-adapter:${this.#options.instanceId}`,
      instanceId: this.#options.instanceId,
      nativeSessionId: this.#nativeSessionId,
      challenge,
      audience,
      nowMs: this.#now(),
      ttlMs: LIMITS.rootProofTtlMsMax,
    });
    const sessionRef: SessionRef = {
      projectId: this.#options.projectId,
      scope: "workspace",
      workspaceId: this.#options.workspaceId,
      target: this.#target,
      nativeSessionId: this.#nativeSessionId,
    };
    await channel.bindRoot({ claim: { kind: "root_proof", proof }, target: this.#target, sessionRef });
  }

  // ------------------------------------------------------- puertos OMP

  #registerToolOnce(): void {
    if (this.#toolRegistered) return;
    this.#toolRegistered = true;
    const tool: OmpToolDefinition = {
      name: this.#replyToolName,
      description:
        "Envía al session broker la respuesta estructurada a una pregunta (ask) correlacionada. " +
        "Única forma de completar un ask: usa replyTo=requestId exacto.",
      parameters: {
        type: "object",
        properties: {
          replyTo: { type: "string", description: "requestId del ask que se responde" },
          body: { description: "cuerpo estructurado de la respuesta" },
          summary: { type: "string", description: "resumen corto opcional" },
        },
        required: ["replyTo", "body"],
      },
      execute: (_toolCallId, params, _signal, _onUpdate, ctx) => this.#executeReplyTool(params, ctx),
      onSession: (event, ctx) => this.#onToolSession(event, ctx),
    };
    this.#options.host.registerTool(tool);
  }

  #wireHostOnce(): void {
    if (this.#hooksWired) return;
    this.#hooksWired = true;
    const host = this.#options.host;
    const observed: OmpHostEvent[] = [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ];
    for (const event of observed) {
      const unsub = host.on(event, () => this.#observe(event));
      if (typeof unsub === "function") this.#hostUnsubs.push(unsub);
    }
    // `agent_end`/`message_end` jamás tocan el estado de los asks (solo se
    // observan): solo `session_reply` completa un ask. El cierre nativo
    // degrada a offline de forma manejada: jamás una excepción no controlada.
    const unsubShutdown = host.on("session_shutdown", () => {
      void this.stop().catch(() => undefined);
    });
    if (typeof unsubShutdown === "function") this.#hostUnsubs.push(unsubShutdown);
    this.#hostUnsubs.push(
      host.subscribeRunState((state) => {
        this.#runState = state;
        this.#declareRunState(state).catch(() => undefined);
      }),
    );
    this.#runState = host.isIdle() ? "idle" : "running";
  }

  #observe(event: OmpHostEvent): void {
    this.#observedEvents.push({ event, atMs: this.#now() });
    if (this.#observedEvents.length > MAX_OBSERVED_EVENTS) this.#observedEvents.shift();
  }

  #onToolSession(event: OmpToolSessionEvent, _ctx: OmpToolContext): void {
    if (event.reason === "switch" || event.reason === "branch" || event.reason === "tree") {
      // Cambio de sesión nativa: el binding anterior queda inválido y la
      // reanudación exige `rebind()` con root proof nueva (nunca heredada).
      this.#bindingValid = false;
      return;
    }
    if (event.reason === "shutdown") {
      void this.stop().catch(() => undefined);
    }
  }

  snapshot(): OmpNativeSnapshot {
    const host = this.#options.host;
    return {
      sessionId: host.getSessionId(),
      sessionFile: host.getSessionFile?.(),
      runState: host.isIdle() ? "idle" : "running",
      hasPendingMessages: host.hasPendingMessages?.() ?? false,
      bound: this.#bound && this.#bindingValid,
      nativeSessionId: this.#nativeSessionId,
      events: [...this.#observedEvents],
    };
  }

  pendingAsks(): readonly PendingAskView[] {
    return this.#receipts
      .all()
      .filter((receipt) => receipt.kind === "ask" && TERMINAL_RECEIPT_STATES[receipt.state] !== true)
      .map((receipt) => ({
        requestId: receipt.requestId,
        state: receipt.state,
        replyState: receipt.replyState,
        deadlineAtMs: receipt.deadlineAtMs,
      }));
  }

  // --------------------------------------------------------- broker ops

  async openBroker(): Promise<OmpBrokerOps> {
    if (this.#client !== undefined) return this.#client;
    const client = createClient({
      endpoint: this.#options.endpoint,
      projectId: this.#options.projectId,
      workspaceId: this.#options.workspaceId,
      instanceId: this.#options.instanceId,
      grantId: this.#options.grantId,
      credential: this.#options.credential,
      now: this.#now,
      ...(this.#options.allowInsecureWs === undefined ? {} : { allowInsecureWs: this.#options.allowInsecureWs }),
    });
    await client.connect();
    this.#client = client;
    return client;
  }

  // -------------------------------------------------- entregas del broker

  #onDelivery(event: EventEnvelope): void {
    if (event.topic === "broker.ask") {
      this.#handleAskDelivery(event.data);
      return;
    }
    if (event.topic === "broker.notify" || event.topic === "broker.control") {
      this.#handleUnsupportedDelivery(event.data);
      return;
    }
    // Otros temas solo llegan por suscripción (canal del cliente).
  }

  #handleAskDelivery(raw: unknown): void {
    const delivery = parseAskDelivery(raw);
    if (delivery === undefined) return;
    const existing = this.#receipts.get(delivery.requestId);
    if (existing !== undefined) {
      // Nunca duplica inferencia: la re-entrega idempotente se ignora o se
      // reanuda según la ventana de crash registrada.
      if (existing.state === "received" && existing.replyState === "none") {
        void this.#deliverAsk(existing).catch(() => undefined);
      } else if (existing.state === "submitting") {
        this.#markOutcomeUnknown(existing);
      }
      return;
    }
    if (!this.#bindingValid) return;
    if (delivery.policy !== "when_idle") {
      this.#rejectDelivery({
        requestId: delivery.requestId,
        kind: "ask",
        error: protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", "política de ask distinta de when_idle", "payload.policy"),
      });
      return;
    }
    if (delivery.deadlineAtMs !== null && this.#now() >= delivery.deadlineAtMs) {
      this.#rejectDelivery({
        requestId: delivery.requestId,
        kind: "ask",
        error: protocolError("EXPIRED", "deadline_out_of_bounds", "el plazo del ask venció antes de la entrega", "deadlineMs"),
      });
      return;
    }
    const receipt = this.#receipts.put({
      requestId: delivery.requestId,
      kind: "ask",
      instanceId: this.#options.instanceId,
      state: "received",
      question: delivery.question,
      deadlineAtMs: delivery.deadlineAtMs,
    });
    void this.#deliverAsk(receipt).catch(() => undefined);
  }

  /**
   * `received` → report `received` → `submitting` (marcador) → llamada nativa →
   * `submitted` → report `submitted`. Una sola llamada nativa por ask (guarda
   * `#inFlight`): la re-entrega jamás duplica inferencia.
   */
  async #deliverAsk(receipt: AskReceipt): Promise<void> {
    if (this.#inFlight.has(receipt.requestId)) return;
    if (!this.#bindingValid || receipt.kind !== "ask" || receipt.question === null) return;
    if (TERMINAL_RECEIPT_STATES[receipt.state] === true || receipt.replyState !== "none") return;
    if (receipt.deadlineAtMs !== null && this.#now() >= receipt.deadlineAtMs) {
      this.#rejectDelivery({
        requestId: receipt.requestId,
        kind: "ask",
        error: protocolError("EXPIRED", "deadline_out_of_bounds", "el plazo del ask venció antes de la entrega", "deadlineMs"),
      });
      return;
    }
    this.#inFlight.add(receipt.requestId);
    try {
      try {
        await this.#reportState(receipt.requestId, "received");
      } catch (error) {
        if (!isAlreadyAdvanced(error)) {
          // Sin journal incoming confirmado no hay entrega nativa: el recibo
          // queda en `received` y la reanudación es segura (sin llamada previa).
          return;
        }
      }
      const mark = this.#receipts.put({
        requestId: receipt.requestId,
        kind: "ask",
        instanceId: this.#options.instanceId,
        state: "submitting",
        question: receipt.question,
        deadlineAtMs: receipt.deadlineAtMs,
      });
      try {
        // Mapping `when_idle` verificado (matriz §3 / agent-session.ts 18.3.1):
        // idle → inicia turno; ocupado → followUp nativo (encola sin interrumpir).
        const deliverAs: OmpSendUserMessageOptions | undefined = this.#options.host.isIdle() ? undefined : { deliverAs: "followUp" };
        this.#options.host.sendUserMessage(mark.question ?? "", deliverAs);
      } catch (error) {
        this.#rejectDelivery({
          requestId: mark.requestId,
          kind: "ask",
          error: protocolError("INVALID_INPUT", "invalid_field", `entrega nativa fallida: ${String(error)}`, "host.sendUserMessage"),
        });
        return;
      }
      this.#receipts.put({
        requestId: mark.requestId,
        kind: "ask",
        instanceId: this.#options.instanceId,
        state: "submitted",
        question: mark.question,
        deadlineAtMs: mark.deadlineAtMs,
      });
      try {
        await this.#reportState(mark.requestId, "submitted");
      } catch {
        // El recibo local es la verdad: se re-reporta en la próxima recuperación.
      }
    } finally {
      this.#inFlight.delete(receipt.requestId);
    }
  }

  /** `notify`/`control` sin mapping verificado: rechazo explícito sin efectos. */
  #handleUnsupportedDelivery(raw: unknown): void {
    const data = isPlainObject(raw) ? raw : {};
    const rawId: unknown = data["requestId"];
    if (typeof rawId !== "string" || !isRequestId(rawId)) return;
    this.#rejectDelivery({
      requestId: rawId,
      kind: "notify",
      error: protocolError("UNSUPPORTED_CAPABILITY", "missing_capability", "notify/control sin mapping nativo verificado: no soportado", "payload.topic"),
    });
  }

  #rejectDelivery(input: { requestId: RequestId; kind: "ask" | "notify"; error: ProtocolError }): void {
    const state: AskReceiptState = input.error.code === "EXPIRED" ? "expired" : "rejected";
    this.#receipts.put({
      requestId: input.requestId,
      kind: input.kind,
      instanceId: this.#options.instanceId,
      state,
      question: null,
      error: input.error,
    });
    void this.#reportState(input.requestId, state === "expired" ? "expired" : "rejected", { error: input.error }).catch(() => undefined);
  }

  /** Ventana de crash (`submitting`): `outcome_unknown`, sin replay ciego. */
  #markOutcomeUnknown(receipt: AskReceipt): void {
    this.#receipts.put({
      requestId: receipt.requestId,
      kind: receipt.kind,
      instanceId: this.#options.instanceId,
      state: "outcome_unknown",
      question: receipt.question,
      deadlineAtMs: receipt.deadlineAtMs,
    });
    void this.#reportState(receipt.requestId, "outcome_unknown").catch(() => undefined);
  }

  /** Recuperación tras (re)conexión: sin repetir jamás una llamada nativa. */
  async #recoverReceipts(): Promise<void> {
    for (const receipt of this.#receipts.all()) {
      if (receipt.instanceId !== this.#options.instanceId) continue;
      if (receipt.state === "received" && receipt.kind === "ask" && receipt.replyState === "none") {
        await this.#deliverAsk(receipt);
        continue;
      }
      if (receipt.state === "submitting") {
        this.#markOutcomeUnknown(receipt);
        continue;
      }
      if (receipt.state === "submitted") {
        try {
          await this.#reportState(receipt.requestId, "submitted");
        } catch {
          // Estado ya aplicado o reporte ya hecho: idempotente.
        }
      }
    }
  }

  // ---------------------------------------------------- runState / reports

  async #declareRunState(runState: OmpRunState): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined || !this.#bound) return;
    await channel.request({
      operation: "notify",
      target: this.#targetRef(),
      // Convención INTEROP: data `{runState}` con valores broker `idle`|`busy`
      // (el estado nativo `running` se declara como `busy`).
      payload: { topic: RUN_STATE_TOPIC, data: { runState: runState === "idle" ? "idle" : "busy" } },
    });
  }

  async #reportState(
    requestId: RequestId,
    state: "received" | "submitted" | "rejected" | "expired" | "outcome_unknown",
    extra?: { error?: ProtocolError },
  ): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) {
      throw new OmpChannelError({ kind: "connection", message: "sin canal para reportar", requestId });
    }
    await channel.report(requestId, state, extra);
  }

  #targetRef(): TargetRef {
    return {
      target: this.#target,
      session: {
        projectId: this.#options.projectId,
        scope: "workspace",
        workspaceId: this.#options.workspaceId,
        target: this.#target,
        nativeSessionId: this.#nativeSessionId,
      },
    };
  }

  // ------------------------------------------------------- session_reply

  async #executeReplyTool(params: Record<string, unknown>, _ctx: OmpToolContext): Promise<OmpToolResult> {
    const verdict = await this.#sendReply(params);
    if (verdict.ok) {
      return {
        content: [{ type: "text", text: `reply enviado para ${verdict.replyTo}` }],
        details: { ok: true, replyTo: verdict.replyTo, replyRequestId: verdict.replyRequestId, askState: "completed" },
      };
    }
    return {
      content: [{ type: "text", text: `reply rechazado: ${verdict.error.code}/${verdict.error.reason}` }],
      details: { ok: false, error: verdict.error },
      isError: true,
    };
  }

  /**
   * Semántica congelada del reply (pendiente/duplicado/tardío/ajeno/instancia
   * vieja): cada rechazo ocurre ANTES de cualquier efecto (ni siquiera se envía
   * el request). Solo un reply aceptado por el broker completa el ask.
   */
  async #sendReply(
    params: Record<string, unknown>,
  ): Promise<{ ok: true; replyTo: RequestId; replyRequestId: RequestId } | { ok: false; error: ProtocolError }> {
    const rawReplyTo: unknown = params["replyTo"];
    if (typeof rawReplyTo !== "string" || !isRequestId(rawReplyTo)) {
      return { ok: false, error: protocolError("INVALID_INPUT", "reply_to_mismatch", "replyTo debe ser el requestId del ask", "params.replyTo") };
    }
    if (!("body" in params)) {
      return { ok: false, error: protocolError("INVALID_INPUT", "invalid_field", "body es obligatorio", "params.body") };
    }
    const rawSummary: unknown = params["summary"];
    if (rawSummary !== undefined && (typeof rawSummary !== "string" || rawSummary.length > LIMITS.maxAliasChars)) {
      return { ok: false, error: protocolError("INVALID_INPUT", "invalid_field", "summary inválido", "params.summary") };
    }
    const channel = this.#channel;
    // Autoridad de la instancia actual: sin binding vigente no hay reply.
    if (!this.#bound || channel === undefined) {
      return { ok: false, error: protocolError("UNAUTHORIZED", "unauthorized_scope", "sin autoridad sobre la sesión (sin conexión registrada)", "grant") };
    }
    if (!this.#bindingValid) {
      return { ok: false, error: protocolError("STALE_INSTANCE", "stale_instance", "la instancia/sesión ya no sostiene el binding", "instanceId") };
    }
    const receipt = this.#receipts.get(rawReplyTo);
    if (receipt === undefined || receipt.kind !== "ask" || receipt.instanceId !== this.#options.instanceId) {
      // Ajeno/desconocido: mismo rechazo, sin filtrar existencia.
      return { ok: false, error: protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "ask referenciado no disponible en este ámbito", "params.replyTo") };
    }
    if (receipt.replyState !== "none") {
      return { ok: false, error: protocolError("INVALID_INPUT", "terminal_state", "reply duplicado para este ask", "params.replyTo") };
    }
    if (receipt.state === "expired" || (receipt.deadlineAtMs !== null && this.#now() >= receipt.deadlineAtMs)) {
      return { ok: false, error: protocolError("EXPIRED", "deadline_out_of_bounds", "reply tardío: el plazo del ask venció", "params.replyTo") };
    }
    if (receipt.state === "outcome_unknown") {
      return { ok: false, error: protocolError("OUTCOME_UNKNOWN", "outcome_unknown_no_replay", "resultado incierto: no se repite sin reconciliación", "params.replyTo") };
    }
    if (TERMINAL_RECEIPT_STATES[receipt.state] === true) {
      return { ok: false, error: protocolError("INVALID_INPUT", "terminal_state", "el ask ya está terminado", "params.replyTo") };
    }
    const replyRequestId = newRequestId();
    const classification = classifyAskCompletion(
      { kind: "reply_tool", requestId: replyRequestId, replyTo: rawReplyTo, authorized: true },
      rawReplyTo,
    );
    if (!classification.ok) {
      return { ok: false, error: classification.error };
    }
    this.#receipts.put({
      requestId: receipt.requestId,
      kind: "ask",
      instanceId: this.#options.instanceId,
      state: receipt.state,
      replyState: "in_flight",
      question: receipt.question,
      deadlineAtMs: receipt.deadlineAtMs,
    });
    const payload: ReplyPayload = {
      replyTo: rawReplyTo,
      body: params["body"],
      ...(typeof rawSummary === "string" ? { summary: rawSummary } : {}),
    };
    let response: ResponseEnvelope;
    try {
      response = await channel.request({
        operation: "reply",
        target: this.#targetRef(),
        payload,
        requestId: replyRequestId,
      });
    } catch (error) {
      // Transporte incierto (timeout/caída): outcome_unknown, jamás reintento ciego.
      this.#receipts.put({
        requestId: receipt.requestId,
        kind: "ask",
        instanceId: this.#options.instanceId,
        state: "outcome_unknown",
        replyState: "failed",
        question: receipt.question,
        deadlineAtMs: receipt.deadlineAtMs,
        error: protocolError("OUTCOME_UNKNOWN", "outcome_unknown_no_replay", `envío de reply incierto: ${String(error)}`, "params.replyTo"),
      });
      return {
        ok: false,
        error: protocolError("OUTCOME_UNKNOWN", "outcome_unknown_no_replay", "resultado del envío incierto: no se repite", "params.replyTo"),
      };
    }
    if (response.error !== undefined) {
      const terminalState: AskReceiptState = response.error.code === "EXPIRED" ? "expired" : "failed";
      this.#receipts.put({
        requestId: receipt.requestId,
        kind: "ask",
        instanceId: this.#options.instanceId,
        state: terminalState,
        replyState: "failed",
        question: receipt.question,
        deadlineAtMs: receipt.deadlineAtMs,
        error: response.error,
      });
      return { ok: false, error: response.error };
    }
    this.#receipts.put({
      requestId: receipt.requestId,
      kind: "ask",
      instanceId: this.#options.instanceId,
      state: "completed",
      replyState: "done",
      question: receipt.question,
      deadlineAtMs: receipt.deadlineAtMs,
    });
    return { ok: true, replyTo: rawReplyTo, replyRequestId };
  }
}

/** Un reporte rechazado por «ya avanzado» es idempotente; el resto aborta. */
function isAlreadyAdvanced(error: unknown): boolean {
  return (
    error instanceof OmpChannelError &&
    error.protocolError !== undefined &&
    ALREADY_ADVANCED_REASONS[error.protocolError.reason] === true
  );
}
