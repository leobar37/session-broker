# Límites numéricos (NFR-002 / NFR-004)

Fuente ejecutable: `packages/protocol/src/limits.ts` (`LIMITS`,
`BACKPRESSURE_POLICY`); verificados por `tests/protocol/limits.test.ts` y
contrastados con `freeze.json`. Todo límite es verificable por validadores;
cualquier exceso se rechaza con el error estable indicado.

| Límite | Valor | Unidad | Error al exceder |
| --- | --- | --- | --- |
| `maxFrameBytes` | 1 048 576 | bytes UTF-8 del frame | `INVALID_INPUT/frame_too_large` |
| `maxPayloadBytes` | 524 288 | bytes del JSON canónico del payload | `INVALID_INPUT/payload_too_large` |
| `maxIdChars` | 128 | chars por identificador opaco | `INVALID_INPUT/invalid_format` |
| `maxAliasChars` | 128 | chars por alias/tema/resumen | `INVALID_INPUT/invalid_field` |
| `maxHistoryPageItems` | 200 | items por página | `INVALID_INPUT/invalid_field` |
| `maxHistoryPageBytes` | 262 144 | bytes por página | `INVALID_INPUT/payload_too_large` |
| `maxEventQueueItemsPerSubscription` | 1 000 | eventos encolados | `QUEUE_FULL` (corta suscripción) |
| `maxEventQueueBytesPerSubscription` | 4 194 304 | bytes encolados | `QUEUE_FULL` (corta suscripción) |
| `maxInFlightRequestsPerGrant` | 32 | solicitudes en vuelo | `QUEUE_FULL/queue_full` |
| `maxQueuedAsksPerSession` | 8 | asks encolados por sesión | `QUEUE_FULL/queue_full` |
| `maxRequestsPerMinutePerGrant` | 120 | req/min por grant | `RATE_LIMITED/rate_limited` |
| `requestTimeoutMsDefault` | 30 000 | ms | — (default) |
| `requestTimeoutMsMax` | 900 000 | ms | `INVALID_INPUT/deadline_out_of_bounds` |
| `askDeadlineMsDefault` | 300 000 | ms | — (default) |
| `askDeadlineMsMax` | 3 600 000 | ms | `INVALID_INPUT/deadline_out_of_bounds` |
| `grantTtlMsDefault` | 86 400 000 | ms (24 h) | — (default) |
| `grantTtlMsMax` | 2 592 000 000 | ms (30 d) | `INVALID_INPUT/invalid_field` |
| `rootProofTtlMsMax` | 300 000 | ms | `UNAUTHORIZED/root_proof_expired` |
| `challengeTtlMs` | 300 000 | ms | `UNAUTHORIZED/root_proof_expired` |
| `cursorTtlMs` | 3 600 000 | ms | `CURSOR_EXPIRED/cursor_expired` |
| `eventRetentionMs` | 604 800 000 | ms (7 d) | `CURSOR_EXPIRED/cursor_expired` |
| `requestRetentionMs` | 604 800 000 | ms (7 d) | `CURSOR_EXPIRED/cursor_expired` |
| `maxJournalBytesPerProject` | 268 435 456 | bytes (256 MiB) | recorte del extremo viejo con discontinuidad observable |
| `heartbeatMs` | 30 000 | ms | desconexión + reconexión con backoff |
| `reconnectBackoffMsInitial` | 500 | ms | — |
| `reconnectBackoffMsMax` | 60 000 | ms | — |
| `reconnectJitterRatio` | 0.2 | ratio 0..1 | — |

## Backpressure (política congelada)

```ts
BACKPRESSURE_POLICY = {
  onEventQueueOverflow: "reject_with_QUEUE_FULL",
  durableCommandDrop: "never",
  slowConsumerAction: "close_subscription",
}
```

Un consumidor lento nunca provoca descarte silencioso de comandos durables: la
suscripción se cierra con `QUEUE_FULL` y el consumidor retoma desde
snapshot/cursor nuevo.

## Presupuesto de recursos de prueba (NFR-002)

Las suites usan TMP `omp-session-broker-test-*`, HOME/config/data efímeros,
puertos efímeros y fake model/transport con guardas que fallan ante red externa
o proveedores reales; teardown en `afterAll` incluso ante fallo. Estos límites
de entorno son parte del contrato de verificación.
