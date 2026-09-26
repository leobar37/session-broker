# Contrato público congelado — session broker (P-001 / G-001)

Estado: **FREEZE**. Todo lo documentado aquí es contrato público que
`@session-broker/client`, `@session-broker/server`, `@session-broker/cli` y
`@session-broker/omp-adapter` DEBEN consumir tal cual en P-002..P-006. Los
cambios posteriores al freeze se serializan con el coordinador; no se resuelven
en ramas paralelas.

Versión de protocolo: **1.0.0** (`PROTOCOL_VERSION`). Fuente ejecutable:
`packages/protocol/src/**` (paquete `@session-broker/protocol`, exports
source-first a `src/index.ts`, sin build step y sin dependencias runtime
externas). La representación legible por máquinas de este freeze es
[freeze.json](freeze.json) y `tests/protocol/contract-freeze.test.ts` exige que
coincida con las constantes exportadas por el paquete.

## Índice

| Documento | Contenido congelado |
| --- | --- |
| [identity.md](identity.md) | Identidad proyecto/checkout/sesión/instancia, archivos y rutas |
| [root-proof.md](root-proof.md) | Root binding no heredable: prueba, expiración, consumo, rebind |
| [auth.md](auth.md) | Grants autenticados, scopes, `controlEpoch`, transporte |
| [protocol.md](protocol.md) | Versión/handshake, envelopes, operaciones, estados, errores |
| [durability.md](durability.md) | Dedup por `requestId` + hash canónico, recibos, `outcome_unknown` |
| [capabilities.md](capabilities.md) | Capacidades core/opcionales y matriz de soporte |
| [limits.md](limits.md) | Límites numéricos, quotas, TTL, backpressure |
| [exit-codes.md](exit-codes.md) | Tabla única de errores y exit codes CLI |
| [packages.md](packages.md) | FREEZE de los cinco paquetes: nombres, versiones, exports, firmas |
| [ownership.md](ownership.md) | Ownership por fase (tabla de `context.md`) |
| [consumption.md](consumption.md) | Receta de consumo local reproducible sin npm publicado |

## Reglas de interpretación

1. **Fail-closed.** Versión incompatible, capacidad ausente/desconocida,
   identidad ambigua o formato futuro se rechazan con el error estable
   (`code` + `reason` + `path`) documentado. Nunca hay fuzzy fallback.
2. **IDs no son credenciales.** Conocer `projectId`, `workspaceId`,
   `sessionRef`, `instanceId` o `requestId` no otorga permisos ni acredita raíz.
3. **Errores sin filtrar existencia.** Las lecturas fuera de scope responden
   `NOT_FOUND_OR_FORBIDDEN`, nunca revelan si el recurso existe.
4. **Secretos fuera de logs/fixtures/handoff.** La credencial del grant y la
   MAC key jamás se persisten en claro ni aparecen en transcripciones.
5. **Mensajes remotos = datos.** Un payload recibido por red nunca es
   instrucción administrativa ni amplía autorización.
