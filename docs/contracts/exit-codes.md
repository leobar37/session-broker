# Tabla única de errores y exit codes CLI

Fuente ejecutable: `packages/protocol/src/errors.ts`
(`PROTOCOL_ERROR_CODES`, `PROTOCOL_ERROR_TABLE`, `EXIT_CODES`,
`cliExitCodeForError`); verificada contra `freeze.json` por
`tests/protocol/contract-freeze.test.ts`.

Los **14 códigos mínimos observables** de `requirements.md` aparecen tal cual.
`INVALID_INPUT` y `AMBIGUOUS_TARGET` son **adicionales** y completan la lista
del contrato 4 del plan (invalid input / ambiguous target); los 16 forman la
tabla única, sin tablas paralelas en consumidores.

| code | terminal | retrySafe | exit code | Significado |
| --- | --- | --- | --- | --- |
| — (éxito) | — | — | **0** | Operación completada. |
| — (error interno) | — | — | **1** | Fallo inesperado del binario (bug/IO); no clasificado. |
| `INVALID_INPUT` | sí | no | **2** | Esquema malformado, campo fuera de rango, frame/payload excedido. |
| `UNAUTHORIZED` | sí | no | **3** | Credencial/grant ausente, revocado, expirado o fuera de scope; root proof inválida. |
| `NOT_FOUND_OR_FORBIDDEN` | sí | no | **4** | Recurso inexistente o sin acceso (no filtra existencia). |
| `INCOMPATIBLE_VERSION` | sí | no | **5** | Versión de protocolo no negociable. |
| `UNSUPPORTED_CAPABILITY` | sí | no | **6** | Capacidad/operación/verbo desconocido o no soportado. |
| `TARGET_OFFLINE` | no | sí | **7** | Objetivo desconectado; reintento con backoff. |
| `TARGET_BUSY` | no | sí | **8** | Objetivo ocupado y la política no interrumpe. |
| `STALE_INSTANCE` | sí | no | **9** | Instancia de proceso ya no vigente. |
| `STALE_CONTROL_EPOCH` | sí | no | **10** | `controlEpoch` obsoleto tras takeover/revoke. |
| `PAYLOAD_CONFLICT` | sí | no | **11** | Mismo `requestId` con hash distinto; sin efectos. |
| `EXPIRED` | sí | no | **12** | Plazo/TTL/lease vencido; no revierte efectos. |
| `RATE_LIMITED` | no | sí | **13** | Cuota de tasa superada. |
| `QUEUE_FULL` | no | sí | **14** | Cola/backpressure llena; sin descarte silencioso. |
| `CURSOR_EXPIRED` | sí | no | **15** | Cursor fuera de retención; snapshot explícito. |
| `OUTCOME_UNKNOWN` | sí | **no** | **16** | Resultado incierto; **nunca** repetir, reconciliar explícitamente. |
| `AMBIGUOUS_TARGET` | sí | no | **17** | Selector ambiguo; no se elige en silencio. |

## Semántica de las columnas

- **terminal** = la solicitud no puede progresar automáticamente; queda en un
  estado terminal (ver [protocol.md](protocol.md)).
- **retrySafe** = el cliente puede reintentar con **mismo `requestId` + mismo
  hash** tras despejar la causa (backoff); el replay idempotente no duplica
  efectos. `OUTCOME_UNKNOWN` es deliberadamente `retrySafe: false`.
- **exit code** = mapeo numérico único de la CLI (`@session-broker/cli`); los
  scripts consumen estos números, nunca texto de error.

## Uso en código

```ts
import { cliExitCodeForError, PROTOCOL_ERROR_TABLE, EXIT_CODES } from "@session-broker/protocol";

const exit = cliExitCodeForError(error); // 0..17 según la tabla
process.exit(exit);
```
