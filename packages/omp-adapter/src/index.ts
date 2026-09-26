/**
 * `@session-broker/omp-adapter` — adaptador OMP nativo del session broker
 * (P-004 / G-001).
 *
 * Superficie pública: firmas DEBIDAS congeladas en `docs/contracts/packages.md`
 * (`OmpAdapterOptions`, `OmpAdapter`, `createOmpAdapter`, `issueRootProof`) más
 * los tipos de integración congelados en P-001: puertos estructurales OMP
 * (`./ports`), vistas de lectura sin inferencia y operaciones broker delegadas.
 * Todo lo demás (canal holder, journal de recibos) es privado del paquete.
 *
 * Este paquete es la ÚNICA frontera autorizada con APIs OMP, y la recibe por
 * inyección de dependencias (`OmpAdapterOptions.host`): jamás importa el
 * paquete global del host ni sus privados. No ejecuta inferencia por sí mismo;
 * registra `session_reply` por `registerTool` y entrega asks broker como
 * prompts nativos `when_idle` sin sustituir la TUI (input local, timeline e
 * historial nativos intactos).
 *
 * Evidencia de capacidades y versión OMP: `docs/compatibility/omp-api-matrix.md`.
 * Consumo por los tests: `tests/omp/**` (fake host + fake model + broker real).
 */

export type {
  OmpExtensionHost,
  OmpHostEvent,
  OmpRunState,
  OmpSendUserMessageOptions,
  OmpTextContent,
  OmpToolContext,
  OmpToolDefinition,
  OmpToolResult,
  OmpToolSessionEvent,
  OmpUnsubscribe,
} from "./ports";
export { createOmpAdapter } from "./adapter";
export type {
  OmpAdapter,
  OmpAdapterOptions,
  OmpBrokerOps,
  OmpNativeSnapshot,
  OmpObservedEvent,
  PendingAskView,
} from "./adapter";
export { issueRootProof } from "./root-proof";
export type { IssueRootProofInput } from "./root-proof";
