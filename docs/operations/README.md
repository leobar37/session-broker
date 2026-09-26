# Operación del session broker (guía honesta)

Este documento describe cómo operar el broker **cuando el operador decida
hacerlo**. Todo lo que aquí se explica está implementado y probado con
fixtures aisladas (`bun run test:recovery`); **ninguna** de estas acciones se
ejecutó sobre servicios, sesiones o datos reales al escribirlo.

Regla de gates (no negociable):

- `G-BROKER-SERVICE` (persistencia real, instalación/enable/start del servicio
  user) lo autoriza **solo el operador**, explícitamente. **No ejecutar los
  pasos de la sección «Servicio systemd user» sin esa autorización.** Generar
  instrucciones, unidades o plantillas NO constituye autorización.
- `G-BROKER-LIVE` (inferencia/proveedores reales, gasto) es otra puerta
  distinta; nada de esta guía la toca.

## Rutas y permisos

| Artefacto | Ruta | Permisos | Nota |
| --- | --- | --- | --- |
| Config de usuario (endpoint, grant, credential) | `$XDG_CONFIG_HOME/session-broker/config.json` (o `~/.config/...`) | `600` | Jamás en el checkout; la CLI falla si hay secretos con permisos abiertos |
| Data del broker (SQLite + journal + grants) | `$XDG_DATA_HOME/session-broker` (o `~/.local/share/session-broker`) | `700` dir / `600` archivos | **Fuera de worktrees**: un clon no hereda datos ni secretos |
| Provisión de grants | `<dataDir>/grants.json` | `600` | Solo `credentialHash` (sha256); la credenciales en claro jamás se persiste |
| Journal de recibos del adaptador OMP | `<dataDir>/omp-adapter-receipts/*.json` | `600` | User data; nunca el checkout |
| Backups | ruta elegida por el operador (fuera del data dir activo) | `600` | Ver «Backup y restore» |

Variables de entorno reconocidas por el entrypoint del broker
(`apps/broker/src/serve.ts`): `SESSION_BROKER_DATA_DIR` (obligatoria, absoluta),
`SESSION_BROKER_HOST` (default `127.0.0.1`), `SESSION_BROKER_PORT` (default
`8791`), `SESSION_BROKER_MAC_KEY` (opcional; activa `root.binding`). Flags
equivalentes: `--data-dir`, `--host`, `--port`, `--mac-key-file`. **La MAC key
nunca viaja en la línea de comandos**: usa el flag de archivo o el
EnvironmentFile con permisos `600`.

## Arranque manual y health

```sh
SESSION_BROKER_DATA_DIR=~/.local/share/session-broker bun apps/broker/src/serve.ts
```

El proceso imprime una línea JSON `{ "ready": true, "host": …, "port": … }`.
`SIGTERM`/`SIGINT` provocan un **shutdown ordenado**: se cierran conexiones,
timers y la base de datos y **no se completa ningún request artificialmente**.

`GET /health` (mismo puerto) distingue cuatro dimensiones que NO deben
confundirse:

| Campo | Significado |
| --- | --- |
| `process.listening` | el proceso está accesible y escuchando |
| `store.usable` / `store.writer` | el store es utilizable y este proceso es el escritor único |
| `schema.compatible` | la versión del schema del store es la soportada |
| `peers.available` / `peers.connections` / `peers.sessionsOnline` | disponibilidad de conexiones y sesiones registradas |

`ok: true` exige las cuatro en verde. La salud **no** contiene credenciales,
MAC keys, payloads ni historial, y **no** dice nada sobre el estado de trabajo
nativo de una sesión (presencia ≠ estado de tarea; el broker no ejecuta
inferencia).

## Logs

Los logs son JSON por línea (`ts`, `level`, `event`, campos) con **redacción
por defecto**: claves sensibles (`credential`, `macKey`, `proof`, `payload`,
`body`, `question`, `result`, …) y valores de secretos conocidos se sustituyen
por `[REDACTED]`; los IDs se registran scoped (proyecto/sesión/conexión). Sin
sink explícito solo se emiten `warn`/`error` a stderr; para operación se
recomienda capturar el flujo con el propio service manager (journald) o
proporcionar un `logSink`.

Nunca se registran tokens, credenciales, MAC keys ni payloads sensibles. Si
necesitas depurar contenido de mensajes, usa la consulta autorizada por canal
(`sessions inspect|history`), no los logs.

## Backup y restore

Método soportado: `VACUUM INTO` sobre la conexión SQLite (snapshot consistente
que incluye lo que aún vive en el WAL). **No** se copia de forma ingenua un
archivo activo (`broker.sqlite` + `-wal` + `-shm`); si el snapshot falla, el
backup falla y no queda ninguna copia presentada como válida.

- `createBackup({ dataDir, destDir })` escribe `broker.sqlite` (snapshot),
  `grants.json` (si existe) y `backup-manifest.json` con método, hashes y
  resumen de journal; todo con permisos `600`. El destino debe estar vacío.
- `verifyBackup(backupDir)` verifica hashes, `PRAGMA integrity_check`, versión
  de schema y correspondencia de journal (recibos ↔ eventos, `receipt_seq`,
  `next_seq`) **solo lectura**.
- `restoreBackup({ backupDir, targetDir })` restaura en un directorio **nuevo**
  (vacío), re-verifica la copia y aplica la política conservadora.

**Política conservadora tras restore** (la copia restaura datos, no confianza
sobre lo ocurrido después del backup):

1. La autoridad **no** se restaura: el directorio restaurado queda **sin
   `grants.json`** (fail-closed). El reporte `restore-report.json` lista
   `requiresReauthorization` con los grant IDs que el operador debe volver a
   provisionar de forma explícita.
2. Los leases se invalidan: cada sesión queda `offline`, sin titular y con
   `control_epoch` incrementado (fencing de cualquier instancia vieja).
   Un control con el epoch anterior falla con `STALE_CONTROL_EPOCH`.
3. El **lock de escritor no viaja**: la copia restaurada es una instancia de
   store **nueva** y adquiere su propio lock al abrir (`writerLock: "reset"`
   en `restore-report.json`). El pid/token del escritor original es autoridad
   vieja sobre otro archivo: no bloquea la copia, y a la inversa. La exclusión
   de dos escritores sobre el **mismo** store se mantiene intacta.
4. Los consumos de root proofs no se reviven: el ledger viaja íntegro.
5. `outcome_unknown` se conserva tal cual; dedup y recibos se conservan para
   que un reintento antiguo sea idempotente, **nunca** trabajo nuevo.
6. Un backup corrupto o incompatible falla con un error explícito **sin
   escribir** en el origen ni dejar un destino parcial.

`nativeSessionId`, `sessionRef` e `instanceId` no se colapsan en el restore:
son dimensiones distintas y siguen siéndolo.

## Semántica de `outcome_unknown`

`outcome_unknown` es la ventana de crash entre aplicar una acción a OMP y
persistir su resultado. Significa **«no sé qué pasó»**, no «reintenta»:

- no autoriza repetición: reenviar/re-ejecutar/completar falla con
  `INVALID_INPUT/outcome_unknown_no_replay`;
- solo la **reconciliación explícita** lo resuelve (`reconcile_completed` /
  `reconcile_failed`) aportando evidencia del runtime nativo;
- no existe exactly-once externo universal: el crash entre el efecto OMP y la
  escritura local no es demostrable exactamente-una-vez y así se documenta.

En la práctica: conserva el `requestId`, consulta su estado
(`sessions inspect` / replay idempotente) y reconcilia con evidencia real del
runtime (por ejemplo, el `session_reply` que el operador observó).

## Límites (resumen)

Los valores congelados viven en `docs/contracts/limits.md`
(`packages/protocol/src/limits.ts`). Los relevantes para operación:

| Límite | Valor | Comportamiento al exceder |
| --- | --- | --- |
| `maxFrameBytes` / `maxPayloadBytes` | 1 MiB / 512 KiB | rechazo explícito (`frame_too_large` / `payload_too_large`) |
| `maxQueuedAsksPerSession` | 8 | `QUEUE_FULL` (sin descartar durables) |
| `maxInFlightRequestsPerGrant` / `maxRequestsPerMinutePerGrant` | 32 / 120 | `QUEUE_FULL` / `RATE_LIMITED` |
| `maxEventQueueItemsPerSubscription` / `maxEventQueueBytesPerSubscription` | 1000 / 4 MiB | la suscripción se CORTA con `QUEUE_FULL` (nunca descarte silencioso) |
| `requestRetentionMs` / `eventRetentionMs` | 7 d | fuera de retención: `CURSOR_EXPIRED` (gap explícito) o `gap: true` en el snapshot |
| `cursorTtlMs` | 1 h | `CURSOR_EXPIRED` → snapshot explícito |

Un consumidor lento nunca agota la memoria del broker: se corta con
`QUEUE_FULL` y retoma desde snapshot/cursor nuevo. La CLI no oculta los huecos:
`CURSOR_EXPIRED` termina con exit code 15 y el snapshot declara `gap: true`.

## Troubleshooting acotado

| Síntoma | Causa probable | Acción |
| --- | --- | --- |
| Handshake denegado (`UNAUTHORIZED`) | credencial/grant erróneo, revocado o expirado; permisos del config > 600 | revisa `grants.json` y `chmod 600` el config; re-provisiona |
| `STALE_CONTROL_EPOCH` / `STALE_INSTANCE` | otro proceso tomó la sesión o hubo restore/takeover | obtén el epoch vigente (`sessions inspect`) y vuelve a pedir control |
| `CURSOR_EXPIRED` (exit 15) | cursor fuera de retención o TTL vencido | pide snapshot explícito; no fuerces continuidad |
| `QUEUE_FULL` | asks en cola, cuota o consumidor lento | espera/backoff; para suscripciones, re-alta desde snapshot |
| `TARGET_OFFLINE` | el objetivo no está registrado/conectado | reintenta con backoff; el broker no relanza OMP por ti |
| `outcome_unknown` en un request | crash entre efecto y persistencia | reconcilia con evidencia; jamás reintentes a ciegas |
| «store ya tiene un escritor activo» | segundo proceso sobre el mismo `dataDir` | detén uno de los dos; un solo escritor por store |
| `backup corrupto`/`incompatible` | copia alterada o de otra versión | restaura desde otro backup sano; el origen no se tocó |
| `/health` con `store.usable: false` | disco/permisos/IO | revisa el data dir y permisos; no hay recibos falsos: la operación falló |

## Servicio systemd user — CONDICIONADO A `G-BROKER-SERVICE`

> **NO EJECUTAR SIN AUTORIZACIÓN EXPLÍCITA DEL OPERADOR.** Los pasos de abajo
> instalan/habilitan/arrancan un servicio user. Prepararlos, generarlos o
> leerlos no los autoriza. Sin `G-BROKER-SERVICE` abierto, el alcance termina
> en generar y revisar los artefactos.

Artefactos (sin instalar nada):

- `ops/systemd/session-broker.service.example` — unidad user de ejemplo;
- `ops/systemd/session-broker.env.example` — plantilla del EnvironmentFile;
- `renderSystemdUserUnit` (`@session-broker/cli`) — generador declarativo que
  valida rutas absolutas, data dir fuera de worktrees, escaping y ausencia de
  secretos. `Restart=` aplica SOLO al proceso del broker; **sin lingering**.

Con `G-BROKER-SERVICE` autorizado, la activación sería (operador, a mano):

1. Generar la unidad con rutas reales y revisarla (`ExecStart`, `dataDir`,
   `EnvironmentFile`); confirmar que NO contiene secretos.
2. Copiar la unidad a `~/.config/systemd/user/` y el EnvironmentFile a la ruta
   declarada, con `chmod 600`.
3. `systemctl --user daemon-reload`, `enable --now session-broker.service`.
4. Verificar con `GET /health` y con `systemctl --user status session-broker`.

Ninguna prueba del repo ejecuta estos pasos: la suite usa un service manager
**fake** y afirma que queda intacto (cero `install/enable/start/daemon-reload`).

## Lo que NO está verificado (límites honestos)

- No se instaló, habilitó ni arrancó ningún servicio real; no se tocó
  `~/.config/systemd`, dotfiles ni el user manager.
- No se ejecutó inferencia real ni se contactó a proveedores; las suites usan
  fake model que FALLA si se le invoca.
- No hay benchmarks de wall time: los límites de backpressure/reconexión se
  verifican con contadores y reloj de fixture.
- No se promete exactly-once externo: ver `outcome_unknown`.
