/**
 * Límites numéricos congelados (NFR-002/NFR-004). Todo límite es verificable:
 * los validadores de este paquete los aplican y `tests/protocol` los ejercita.
 */

export const LIMITS = {
  /** Tamaño máximo de un frame WS completo (UTF-8 bytes del JSON serializado). */
  maxFrameBytes: 1_048_576,
  /** Tamaño máximo del campo `payload` de un envelope (UTF-8 bytes de su JSON canónico). */
  maxPayloadBytes: 524_288,
  /** Longitud máxima de cualquier identificador opaco (`requestId`, `nativeSessionId`, ...). */
  maxIdChars: 128,
  /** Longitud máxima de alias/nombres legibles. */
  maxAliasChars: 128,
  /** Máximo de items devueltos en una página de historial/listado. */
  maxHistoryPageItems: 200,
  /** Máximo de bytes de una página de historial (data serializada). */
  maxHistoryPageBytes: 262_144,
  /** Máximo de eventos pendientes por suscripción (backpressure duro). */
  maxEventQueueItemsPerSubscription: 1_000,
  /** Máximo de bytes encolados por suscripción. */
  maxEventQueueBytesPerSubscription: 4_194_304,
  /** Máximo de solicitudes en vuelo por grant. */
  maxInFlightRequestsPerGrant: 32,
  /** Máximo de `ask` encolados por sesión destino. */
  maxQueuedAsksPerSession: 8,
  /** Cuota de tasa por defecto: solicitudes por minuto por grant. */
  maxRequestsPerMinutePerGrant: 120,
  /** Timeout por defecto de una solicitud (ms). */
  requestTimeoutMsDefault: 30_000,
  /** Timeout máximo aceptado en una solicitud (ms). */
  requestTimeoutMsMax: 900_000,
  /** Plazo por defecto de un `ask` (ms). */
  askDeadlineMsDefault: 300_000,
  /** Plazo máximo de un `ask` (ms). */
  askDeadlineMsMax: 3_600_000,
  /** TTL por defecto de un grant (ms). */
  grantTtlMsDefault: 86_400_000,
  /** TTL máximo aceptado de un grant (ms). */
  grantTtlMsMax: 2_592_000_000,
  /** TTL máximo de una root proof (ms); es de un solo uso. */
  rootProofTtlMsMax: 300_000,
  /** Vigencia del challenge de conexión emitido por el servidor (ms). */
  challengeTtlMs: 300_000,
  /** TTL de un cursor de suscripción/historial (ms). */
  cursorTtlMs: 3_600_000,
  /** Retención de eventos para replay/cursor (ms). */
  eventRetentionMs: 604_800_000,
  /** Retención de registros de solicitud y recibos (ms). */
  requestRetentionMs: 604_800_000,
  /** Presupuesto máximo del journal de eventos por proyecto (bytes); al superarse se recorta el extremo viejo. */
  maxJournalBytesPerProject: 268_435_456,
  /** Intervalo de heartbeat de la conexión (ms). */
  heartbeatMs: 30_000,
  /** Backoff inicial de reconexión (ms). */
  reconnectBackoffMsInitial: 500,
  /** Backoff máximo de reconexión (ms). */
  reconnectBackoffMsMax: 60_000,
  /** Ratio de jitter aplicado al backoff (0..1). */
  reconnectJitterRatio: 0.2,
} as const;

export type Limits = typeof LIMITS;

/**
 * Política de backpressure: un consumidor lento nunca provoca descarte
 * silencioso de comandos durables; la suscripción se corta con `QUEUE_FULL`
 * y el consumidor debe retomar desde un snapshot/cursor nuevo.
 */
export const BACKPRESSURE_POLICY = {
  onEventQueueOverflow: "reject_with_QUEUE_FULL" as const,
  durableCommandDrop: "never" as const,
  slowConsumerAction: "close_subscription" as const,
};
