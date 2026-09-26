/**
 * `@session-broker/protocol` — contrato público congelado (P-001 / G-001).
 *
 * Fuente única de verdad de:
 *   - versión y handshake del protocolo (`version.ts`, `handshake.ts`)
 *   - identidad (proyecto/workspace/sesión/instancia) y sus archivos (`ids.ts`, `identity.ts`)
 *   - root proof no heredable (`root-proof.ts`)
 *   - grants autenticados y `controlEpoch` (`grants.ts`)
 *   - envelopes y operaciones (`envelope.ts`, `operations.ts`)
 *   - estados únicos, dedup y semántica de `outcome_unknown` (`states.ts`, `dedup.ts`)
 *   - capacidades, límites numéricos y tabla de errores/exit codes
 *     (`capabilities.ts`, `limits.ts`, `errors.ts`)
 *
 * Este paquete no depende de OMP, de SQLite, de red ni de ningún runtime de
 * broker. P-002/P-003/P-004/P-006 consumen SOLO estos exports; ver
 * `docs/contracts/packages.md` para el freeze completo de los cinco paquetes.
 */

export * from "./validation";
export * from "./errors";
export * from "./limits";
export * from "./ids";
export * from "./canonical";
export * from "./version";
export * from "./identity";
export * from "./capabilities";
export * from "./operations";
export * from "./states";
export * from "./dedup";
export * from "./grants";
export * from "./root-proof";
export * from "./envelope";
export * from "./handshake";
