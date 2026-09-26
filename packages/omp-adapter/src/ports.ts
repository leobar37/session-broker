/**
 * Puertos ESTRUCTURALES de la API pública OMP (P-004 / G-001).
 *
 * El adaptador es la única frontera autorizada con APIs OMP, pero **nunca
 * importa** el paquete del host ni sus tipos privados: modela aquí, con
 * interfaces propias, la superficie pública documentada por
 * `docs/compatibility/omp-api-matrix.md` y la recibe por inyección de
 * dependencias (`OmpAdapterOptions.host`). Cada miembro cita la evidencia
 * file:line de la instalación.
 *
 * Evidencia (fuentes instaladas `pi-coding-agent@17.4.2` en
 * `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` y fuentes del
 * binario `omp v18.3.1` en `~/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.3.1@@@1`):
 *
 * | Puerto | 17.4.2 | 18.3.1 |
 * | --- | --- | --- |
 * | `on(event, handler)` | `src/extensibility/extensions/types.ts:1240-1281` | `src/extensibility/extensions/types.ts:~1277-1317` |
 * | `registerTool(tool)` | `types.ts:1285` | `types.ts:1322` |
 * | `sendUserMessage(content, options?)` | `types.ts:1418-1421` | `types.ts:1461` + `src/session/agent-session-types.ts:393-399` |
 * | `isIdle()` / `abort()` / `hasPendingMessages()` | `types.ts:481/483/485` | `types.ts:455/457/459` |
 * | `getSessionId()` / `getSessionFile()` | `src/session/session-manager.ts:1946/1950` (`ReadonlySessionManager`, `:363-364`) | `src/session/session-manager.ts:2541/2545` |
 * | `subscribeRunState(listener)` | `src/session/agent-session.ts:3750` | `src/session/agent-session.ts:4749` |
 * | `ToolDefinition` (`execute`, `onSession`) | `types.ts:602-660` | `types.ts:611-660` |
 * | `ToolSessionEvent {reason, previousSessionFile}` | `types.ts:594-600` | `types.ts:~603-609` |
 *
 * Lo que estos puertos NO cubren (semántica no verificada) queda fuera del
 * adaptador: `control.abort`/`steer` y el mapping nativo de `notify` con temas
 * arbitrarios siguen siendo `unsupported` (matriz §5); jamás se activa un
 * fallback por su ausencia.
 */

/** Cancelación de suscripción/registro; `void` si el host no ofrece unsubscribe. */
export type OmpUnsubscribe = () => void;

/** Estado de trabajo NATIVO (dimensión distinta de presencia broker). */
export type OmpRunState = "running" | "idle";

/**
 * Opciones de `sendUserMessage` (evidencia 18.3.1 `agent-session-types.ts:393-399`:
 * `SendUserMessageOptions { deliverAs?: "steer" | "followUp" | "aside" }`).
 * `"aside"` existe en 18.3.1 pero no se usa: el mapping `when_idle` congelado
 * solo requiere `"steer"`/`"followUp"`.
 */
export interface OmpSendUserMessageOptions {
  deliverAs?: "steer" | "followUp";
}

/** Bloque de contenido de texto (subconjunto estructural de `TextContent`). */
export interface OmpTextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * Resultado de herramienta (subconjunto estructural de `AgentToolResult`,
 * `@oh-my-pi/pi-agent-core` `src/types.ts:952-964`).
 */
export interface OmpToolResult {
  readonly content: readonly OmpTextContent[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Contexto de ejecución (subconjunto de `ExtensionContext`, `types.ts:455-485`). */
export interface OmpToolContext {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
}

/** Evento de lifecycle de sesión para herramientas (`ToolSessionEvent`, `types.ts:594-600`). */
export interface OmpToolSessionEvent {
  readonly reason: "start" | "switch" | "branch" | "tree" | "shutdown";
  readonly previousSessionFile: string | undefined;
}

/**
 * Definición de herramienta (subconjunto estructural de `ToolDefinition`,
 * `types.ts:602-660`). `parameters` es un esquema opaco del host (zod/TypeBox
 * según runtime); el adaptador entrega un objeto JSON-schema y el shim de
 * binding puede envolverlo en el TSchema que el runtime exija.
 */
export interface OmpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { text?: string }) => void) | undefined,
    ctx: OmpToolContext,
  ): Promise<OmpToolResult>;
  onSession?(event: OmpToolSessionEvent, ctx: OmpToolContext): void | Promise<void>;
}

/**
 * Eventos de `ExtensionAPI.on` que el adaptador consume (evidencia `types.ts`
 * 17.4.2 `:1240-1281` / 18.3.1 `:1277-1317`). Solo nombres documentados.
 */
export type OmpHostEvent =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "session_shutdown";

/**
 * Runtime OMP inyectado (dependency inversion). El adaptador jamás importa el
 * paquete global del host: un shim en proceso (extensión cargada en la sesión
 * nativa) implementa estos métodos delegando en la API pública documentada.
 */
export interface OmpExtensionHost {
  /** Suscripción a eventos nativos (`ExtensionAPI.on`). Lectura sin inferencia. */
  on(event: OmpHostEvent, handler: (payload: unknown) => void): OmpUnsubscribe | void;
  /** Registro de herramienta por API pública (`registerTool`, `types.ts:1285/1322`). */
  registerTool(tool: OmpToolDefinition): void;
  /**
   * Prompt de usuario nativo. Mapping `when_idle` verificado en la matriz §3:
   * idle -> `sendUserMessage(pregunta)` (inicia turno); ocupado ->
   * `sendUserMessage(pregunta, { deliverAs: "followUp" })` (encola hasta el fin
   * del turno, sin interrumpir; evidencia 18.3.1 `agent-session.ts:8083-8140`).
   */
  sendUserMessage(content: string, options?: OmpSendUserMessageOptions): void;
  /** Identidad de la sesión nativa (`sessionManager.getSessionId()`). */
  getSessionId(): string;
  /** Archivo de sesión si está asignado (`getSessionFile()`). */
  getSessionFile?(): string | undefined;
  /** ¿Está el agente idle? (`isIdle()`; 18.3.1 `runtime-init.ts` → `!session.isStreaming`). */
  isIdle(): boolean;
  /** ¿Hay mensajes encolados? (`hasPendingMessages()`). */
  hasPendingMessages?(): boolean;
  /** Estado de trabajo nativo (`AgentSession.subscribeRunState`). */
  subscribeRunState(listener: (state: OmpRunState) => void): OmpUnsubscribe;
  /**
   * Abort nativo (`abort()`, `types.ts:457/483`). Modelado por completitud de
   * la matriz §5 pero **no conectado** a ninguna capacidad: la semántica de
   * `control.abort`/`steer` no está verificada y se responde
   * `UNSUPPORTED_CAPABILITY`.
   */
  abort?(): void;
}
