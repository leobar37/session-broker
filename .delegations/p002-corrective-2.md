# CORRECTIVE HANDOFF #2 — P-002 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-002/G-001. Éxito observable: `bun run typecheck` y `bun run test:broker` exit 0 reproducidos por el coordinador, con semántica fiel a `docs/contracts/`.

## Contexto de corrección (coordinador reprodujo gates)
`bun run test:broker` = 22 pass / 24 fail. Tras tu fix del handshake quedó un patrón dominante: peticiones VÁLIDAS devueltas con state `"rejected"` donde los tests esperan `queued`/`completed`, y varios pares de código de error invertidos respecto al contrato. Hipótesis con evidencia fuerte (es EXACTAMENTE la clase de bug ya confirmada en la rama paralela P-003, donde el coordinador la verificó):

**El servidor hashea objetos NORMALIZADOS con claves `undefined`.** `packages/protocol/src/canonical.ts:43-45` RECHAZA valores `undefined` («campo con valor undefined no es serializable»), pero la normalización del protocolo los inyecta: `checkTargetRef` devuelve `{target, session, instanceId}` con `session`/`instanceId` potencialmente `undefined` (envelope.ts:135) y `validateOperationPayload` devuelve objetos con opcionales en `undefined` (operations.ts). Si `apps/broker/src/server.ts:722` (`computeRequestPayloadHash({operation, target, payload})`) o `store.ts` pasan esos objetos normalizados, el hash falla con `INVALID_INPUT/invalid_field` ANTES de crear registro durable → todo responde `rejected`. La semántica congelada se define sobre los valores del WIRE: el fixture de referencia de P-001 `idempotentReplayExample()` (`packages/protocol/src/fixtures.ts:547`) hashea objetos planos del wire sin claves `undefined`. En P-003 el fix confirmado fue `wireValue()` (JSON round-trip = exactamente lo que cruza el wire) antes de hashear.

## Gaps a corregir (edit-only; ownership: apps/broker/** y tests/broker/**)
1. Hashea el WIRE, no la normalización: en todos los puntos donde computes `computeRequestPayloadHash` (server.ts/store.ts), hashea `{operation, target, payload}` con la forma que cruzó el wire (JSON round-trip o `frameJson` original), sin claves `undefined`. `packages/protocol` es READ-ONLY.
2. Tras ese fix, re-mapea los 24 fallos por lectura (muchos son cascada) y reconcilia los pares de error con `docs/contracts/`:
   - «replyTo erróneo (a sí mismo / inexistente)»: test espera `NOT_FOUND_OR_FORBIDDEN`, recibe `INVALID_INPUT`.
   - «reply ajeno y reply tardío»: espera `UNAUTHORIZED`, recibe `INVALID_INPUT`.
   - «agent_end/siguiente texto no completan ask…»: espera `INVALID_INPUT`, recibe `NOT_FOUND_OR_FORBIDDEN`.
   - «reply sobre un requestId que no es ask»: espera `NOT_FOUND_OR_FORBIDDEN`, recibe `INVALID_INPUT`.
   - «la cuota de tasa por grant se acota con RATE_LIMITED»: espera `RATE_LIMITED`, recibe `INVALID_INPUT`.
   - Tests con `TypeError: undefined is not an object` sobre `.result.requests`, `result1.items`, `detail.controlEpoch` = cascada de respuestas `rejected`.
   Criterio: si la IMPLEMENTACIÓN viola el contrato, corrígela; si el TEST codifica una expectativa contraria al contrato, corrige el test y documéntalo; si el contrato es ambiguo, REPÓRTA la ambigüedad, elige la interpretación fail-closed/conservadora y documéntala. PROHIBIDO debilitar aserciones o maquillar verde.
3. Corrige los errores de typecheck dentro de TU ownership (el coordinador reproduce `bun run typecheck`):
   - `apps/broker/src/grants.ts(76,17) TS18048: 'targets' is possibly 'undefined'`.
   - `tests/broker/helpers.ts(424,27)(425,29)(434,27)(435,29) TS2769: No overload matches this call`.
   - `tests/broker/control-epoch.test.ts(209,67) TS2769: No overload matches this call`.
   (El error de `tests/cli/fake-broker.ts(612,35)` es de P-003 y lo resuelve el coordinador: NO lo toques.)

## Reglas
EDIT-ONLY: no ejecutes tests/typecheck/builds/formatters/installs. Ownership inalterado; no toques `packages/protocol`, `docs/contracts`, `packages/client`, `apps/cli`, `tests/cli`, raíz ni `.plans/**`. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`). Sin monorepo/dotfiles/git/Climier/publicación/servicios/inferencia real. Tus puntos de interop declarados siguen vigentes.

## Reporte
Anchor restatado, modelo efectivo, archivos modificados, tabla de los 24 fallos → causa → fix (estático), decisiones semánticas/ambigüedades, typecheck corregido, pendientes y bloqueos mínimos. Cierra con STOP.
