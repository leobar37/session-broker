# CORRECTIVE HANDOFF #2 — P-003 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-003/G-001. Éxito observable: `bun run typecheck` y `bun run test:cli` exit 0 reproducidos por el coordinador, con semántica fiel a `docs/contracts/` (NO «verde a cualquier precio»).

## Contexto de corrección (coordinador reprodujo `bun run test:cli` tras tu corrective #1)
Resultado: 50 pass / 13 fail (63 tests). Tu corrective #1 desbloqueó los `beforeAll` y reveló 13 fallos de comportamiento que estaban ocultos. Causa raíz de los 6 anteriores RESUELTA (contrato de salida JSON/humano). Ahora quedan estos 13, con evidencia exacta observada (mapea cada línea a su test leyendo tu propio código):

`tests/cli/cli.test.ts` — exit code esperado 0, recibido 2 (INVALID_INPUT) en:
- (225) test «config con secretos y permisos abiertos → UNAUTHORIZED con hint accionable»
- (302) test «ask imprime requestId y estado sin ocultar nada»
- (380) test «11 PAYLOAD_CONFLICT: mismo requestId con payload distinto»
- (440) test «16 OUTCOME_UNKNOWN: visible, sin segunda ejecución ni ID nuevo»
- (460) test «0 OK y estados progresivos visibles»
Sospecha: el parseo de argumentos/flags estánfallo (`INVALID_INPUT`) en rutas que deberían funcionar (p.ej. flag mal tipado, subcomando no reconocido, o validación de payload demasiado estricta). Diagnostícalo por lectura de `apps/cli/src/cli.ts` y `output.ts` contra cómo los tests invocan `captureCli`.

`tests/cli/client.test.ts`:
- (234) «control exige controlEpoch explícito y lo propaga; el obsoleto es STALE_CONTROL_EPOCH» — `expect(x).toBeUndefined()` recibió `{…}`.
- (274) «ask produce requestId y solo el reply explícito lo completa» — `expect(x).toBeUndefined()` recibió `{…}`.
- (297) «reply con replyTo erróneo o ambiguo se rechaza sin completar el ask» — esperado `"submitted"`, recibido `undefined`.
- (376) «ACK perdido conserva requestId y la consulta por estado no reejecuta» — esperado `true`, recibido `false`.
- (401) «mismo requestId con hash distinto → PAYLOAD_CONFLICT sin efectos» — `expect(x).toBeUndefined()` recibió `{…}`.
- (425) «abort/timeout terminan la espera local y jamás afirman cancelación remota» — esperado `true`, recibido `false`.
- (487) «server offline ≠ request/job fallido» — esperado `true`, recibido `false`.
- (516) «reconexión con backoff reanuda la suscripción por cursor sin duplicar eventos» — esperado 3, recibido 4 (¡duplicado de evento en el resumen por cursor! — el criterio binario exige «sin duplicar eventos»).

## Gaps a corregir (edit-only; ownership: packages/client, apps/cli, tests/cli)
1. Reconcilia cada fallo con `docs/contracts/` (protocol.md, durability.md, exit-codes.md, limits.md): si es la IMPLEMENTACIÓN la que viola el contrato, corrígela; si es el TEST el que codifica una expectativa contraria al contrato, corrige el test y documéntalo en tu reporte. PROHIBIDO debilitar aserciones o «maquillar» para obtener verde: el criterio es coherencia con el contrato congelado.
2. Casos prioritarios por criterios binarios de la fase: (a) exit codes congelados correctos para PAYLOAD_CONFLICT=11, OUTCOME_UNKNOWN=16, OK=0 y sus estados progresivos; (b) ask → requestId y SOLO reply explícito `replyTo` lo completa (ni texto siguiente ni `agent_end`); reply erróneo/ambiguo rechazado sin completar; (c) ACK perdido: se conserva el mismo requestId y la consulta de estado NO reejecuta ni genera ID nuevo; (d) mismo requestId + hash distinto → PAYLOAD_CONFLICT sin efectos; (e) abort/timeout = fin de espera local, jamás cancelación remota; (f) server offline ≠ request/job fallido; (g) resubscripción por cursor SIN duplicar eventos; (h) control exige `controlEpoch` explícito y el obsoleto es `STALE_CONTROL_EPOCH`; (i) config con secretos y permisos abiertos → `UNAUTHORIZED` con hint accionable.
3. Si el fake broker (`tests/cli/fake-broker.ts`) es el que contradice el contrato (p.ej. estados `received/submitted` inalcanzables, semántica de dedup), corrígelo también (es tuyo). Si el contrato congelado es ambiguo para un caso, REPÓRTA la ambigüedad y elige la interpretación conservadora (fail-closed), documentándola.

## Reglas
EDIT-ONLY: no ejecutes tests/typecheck/builds/formatters/installs; el coordinador reproduce los gates. Ownership inalterado; no toques `packages/protocol`, `docs/contracts`, `apps/broker`, `tests/broker`, raíz ni `.plans/**`. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`). Sin monorepo/dotfiles/git/Climier/publicación/servicios/inferencia real.

## Reporte
Anchor restatado, modelo efectivo, archivos modificados, tabla de los 13 fallos → causa → fix (estático), cobertura añadida, ambigüedades de contrato reportadas, pendientes y bloqueos mínimos. Cierra con STOP.
