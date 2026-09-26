# Durabilidad, dedup e incertidumbre (FR-007)

Fuente ejecutable: `packages/protocol/src/dedup.ts`, `states.ts`, `canonical.ts`.

## Fronteras transaccionales

1. **`queued` = commit durable del broker.** Solo se confirma una solicitud
   tras el commit; antes no hay recibo `queued`.
2. **`received` = journal incoming durable del cliente/adaptador.** Cubre la
   frontera entre recepción y la API nativa.
3. **`submitted` = entrega efectiva a la API OMP.**
4. **`completed` = resultado definido por operación** (en `ask`, solo reply
   explícito; ver [protocol.md](protocol.md)).

Presence, estado de solicitud y job status nativo son dimensiones distintas; no
se implementa job scheduler.

## Dedup autenticado (scoped por proyecto)

Clave: `projectId` + `requestId`. Identidad de contenido:
`payloadHash = sha256(canonicalJson({operation, target, payload}))`.

| Caso | Decisión (`evaluateDedup`) | Efectos |
| --- | --- | --- |
| `requestId` sin previo | `new` → registro en `queued` | una ejecución |
| mismo `requestId`, mismo hash | `idempotent_replay` | **ninguno**: recupera operación/recibos |
| mismo `requestId`, hash distinto | `PAYLOAD_CONFLICT/payload_conflict` | **ninguno** |
| mismo `requestId` de otro proyecto | `UNAUTHORIZED/unauthorized_scope` | ninguno |

El hash canónico ordena claves de objeto, preserva orden de arrays y rechaza
valores no JSON (`INVALID_INPUT/invalid_field`); por eso el mismo contenido
serializa idéntico en cualquier implementación.

## Recibos y consulta tras reconexión

- Cada transición deja recibo (`RequestReceipt`: estado, `atMs`, `eventId`,
  `eventSeq`, detalle). El replay idempotente devuelve el registro completo
  (estado + recibos), nunca re-despacha.
- Tras reconexión, la consulta por `requestId`/cursor recupera el estado real;
  sin inventar continuidad.

## `outcome_unknown` y reconciliación

- Ventana de crash entre aplicar a OMP y persistir el resultado →
  `outcome_unknown` (evento `crash_window` desde `received`/`submitted`).
- **No autoriza repetición**: re-enviar, re-ejecutar o "completar" desde
  `outcome_unknown` falla con `INVALID_INPUT/outcome_unknown_no_replay`.
  `allowsAutomaticReExecution("outcome_unknown") === false`.
- Solo la **reconciliación explícita** lo resuelve (`reconcile_completed` /
  `reconcile_failed`) con evidencia del runtime nativo. No hay replay ciego ni
  promesa de exactamente-una-vez universal.
- `expired`/`cancelled` no revierten efectos ya aplicados; `cancelled` es
  cancelación reconocida, no rollback.

## TTL, retención y cursores

| Concepto | Valor congelado |
| --- | --- |
| `requestRetentionMs` | 604 800 000 (7 d) |
| `eventRetentionMs` | 604 800 000 (7 d) |
| `cursorTtlMs` | 3 600 000 (1 h) |
| `maxJournalBytesPerProject` | 268 435 456 (256 MiB) |

Fuera de retención (`isRetentionExpired`) la consulta con cursor viejo responde
`CURSOR_EXPIRED/cursor_expired` y obliga a snapshot explícito. Al superar el
presupuesto de journal se recorta el extremo viejo (marcando discontinuidad
observable); jamás se descartan comandos durables en silencio.

## Backpressure

- Cola por suscripción: `maxEventQueueItemsPerSubscription` = 1 000 /
  `maxEventQueueBytesPerSubscription` = 4 MiB.
- Overflow → la suscripción se corta con `QUEUE_FULL` (política
  `BACKPRESSURE_POLICY.onEventQueueOverflow = "reject_with_QUEUE_FULL"`); el
  consumidor retoma desde snapshot/cursor nuevo. Un cliente lento nunca agota
  la memoria del broker ni provoca descarte silencioso.
- Reconexión: backoff con jitter (`reconnectBackoffMsInitial` 500 ms →
  `reconnectBackoffMsMax` 60 000 ms, jitter 0.2) + heartbeat
  (`heartbeatMs` 30 000). `eventSeq` dedup durable por evento.
