# CORRECTIVE HANDOFF — P-002 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-002/G-001 (broker durable autorizado). Éxito observable: `bun run typecheck` y `bun run test:broker` exit 0 reproducidos por el coordinador.

## Contexto de corrección (coordinador reprodujo `bun run test:broker`)
Resultado: 2 pass / 44 fail (46 tests). Causa raíz ÚNICA que cascada sobre casi toda la suite:

`apps/broker/src/server.ts:427` llama `negotiateHelloVersion(hello.value.protocolVersions, SERVER_PROTOCOL_VERSIONS)`, pero la firma CONGELADA de `negotiateHelloVersion` (packages/protocol/src/handshake.ts:192) es `(hello: HelloMessage, serverVersions: readonly string[])` — recibe el objeto HELLO, no su array; internamente hace `negotiateProtocolVersion(hello.protocolVersions, serverVersions)` y al pasar un array `hello.protocolVersions` es `undefined` → `TypeError: undefined is not an object (evaluating 'clientRaw of clientVersions')` en packages/protocol/src/version.ts:66, disparado desde `#handleHello` (server.ts:427 → #onMessage:370 → message:279). Los demás fallos (p.ej. `expect(welcome).toBeDefined()` en tests/broker/durability.test.ts:75) son cascada del handshake roto.

## Gaps a corregir (edit-only; ownership: apps/broker/** y tests/broker/**)
1. Corrige la llamada: `negotiateHelloVersion(hello.value, SERVER_PROTOCOL_VERSIONS)` (o `negotiateProtocolVersion(hello.value.protocolVersions, SERVER_PROTOCOL_VERSIONS)` si prefieres la primitiva). `packages/protocol` es READ-ONLY: si crees que la API congelada está mal, REPÓRTA en vez de tocarla.
2. AUDITORÍA OBLIGATORIA de la misma CLASE de error: este desajuste de forma/orden de argumentos escapó a tu revisión estática. Revisa TODAS las llamadas de `apps/broker/**` y `tests/broker/**` contra las firmas exportadas reales de `@session-broker/protocol` (lee packages/protocol/src/{handshake,version,envelope,grants,root-proof,dedup,states,operations,capabilities,identity,ids,errors,limits,canonical,validation}.ts): argumentos en orden correcto, objetos vs arrays, acceso a `.value` de los `Result`, y nombres de campos de los objetos validados (p.ej. `hello.protocolVersions`). Corrige todo lo que encuentres dentro de tu ownership.
3. No cambies semántica congelada ni firmas públicas de `@session-broker/server` (BrokerServerOptions/BrokerServer/createBrokerServer). Si tras el fix emergen otros fallos de comportamiento propios, repáralos también dentro de ownership; si son de contrato ajeno, repórtalos.

## Reglas
EDIT-ONLY: no ejecutes tests/typecheck/builds/formatters/installs; el coordinador reproduce `bun run typecheck` y `bun run test:broker`. Ownership inalterado; no toques `packages/protocol`, `docs/contracts`, `packages/client`, `apps/cli`, `tests/cli`, raíz ni `.plans/**`. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`). Sin monorepo/dotfiles/git/Climier/publicación/servicios/inferencia real. Los puntos de interop que ya declaraste siguen válidos.

## Reporte
Anchor restatado, modelo efectivo, archivos modificados, tabla de llamadas auditadas (API → veredicto), explicación estática del fix, pendientes y bloqueos mínimos. Cierra con STOP.
