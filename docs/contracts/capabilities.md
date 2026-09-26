# Capacidades (FR-008)

Fuente ejecutable: `packages/protocol/src/capabilities.ts`. Matriz de APIs OMP
con evidencia: [../compatibility/omp-api-matrix.md](../compatibility/omp-api-matrix.md).

## Lista congelada

| Capability | Clase | Operaciones que la requieren |
| --- | --- | --- |
| `session.identity` | core | identidad/lifecycle de sesión (handshake y directorio) |
| `session.observe` | core | `query`, `list`, `inspect`, `history`, `subscribe` |
| `session.prompt.when_idle` | core | `ask` (entrega como prompt seguro cuando el agente está idle) |
| `session.reply_tool` | core | `ask`, `reply` (herramienta explícita de respuesta) |
| `root.binding` | core | bootstrap raíz autenticado (root proof) |
| `session.notify` | opcional | `notify` |
| `session.control.prompt` | opcional | `control {verb:"prompt"}` |
| `session.control.steer` | opcional | `control {verb:"steer"}` |
| `session.control.follow_up` | opcional | `control {verb:"follow_up"}` |
| `session.control.abort` | opcional | `control {verb:"abort"}` |

`CORE_CAPABILITIES` / `OPTIONAL_CAPABILITIES` están exportados y verificados
contra `freeze.json`.

## Reglas de soporte (fail-closed)

1. Cada capacidad declarada por un objetivo necesita **evidencia local
   reproducible** (lectura de API instalada/registro en runtime). No se afirma
   soporte por conveniencia.
2. Capacidad **ausente o desconocida** → `UNSUPPORTED_CAPABILITY`
   (`unknown_capability` para nombres desconocidos; `missing_capability` para
   conocidas no soportadas). Nunca fallback silencioso.
3. Si falta una capacidad **core** de ask/reply/root binding, se **bloquea la
   unidad afectada** (p. ej. integración ask/reply o root) con evidencia; no se
   acepta stub ni se redefine el DoD.
4. `checkOperationSupport(operation, controlVerb, supported)` es la puerta
   única de comprobación por operación/verbo.

## Relación con el adaptador OMP

- Core ask/reply se satisface con: identidad/lifecycle de sesión, observación
  sin inferencia, envío de prompts `when_idle` y registro explícito de la
  herramienta de respuesta broker (`session_reply`) por API pública.
- `notify`/`control` son **opcionales** y solo se declaran soportados si existe
  un mapping seguro verificado (ver matriz). Sin mapping → `unsupported`.
- La TUI y el historial nativos se mantienen intactos: sin RPC headless
  obligatorio, sin scraping, sin Enter artificial y sin shell sustituto.
- Reiniciar el broker no relanza OMP ni replica herramientas; una sesión sin
  broker muestra indisponibilidad real, no control ficticio.
