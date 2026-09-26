/**
 * `@session-broker/cli` — CLI del session broker (P-003 / G-001).
 *
 * Export congelado (`docs/contracts/packages.md`):
 *
 * ```ts
 * runCli(argv: readonly string[]): Promise<number>  // exit code 0..17
 * ```
 *
 * Importar este paquete no ejecuta nada: todos los efectos ocurren al llamar
 * `runCli`. La CLI consume solo exports públicos de `@session-broker/client`
 * y `@session-broker/protocol`.
 */

export { runCli } from "./cli";

/**
 * Generación declarativa de la unidad systemd user (aditivo P-005): renderiza
 * el artefacto y su EnvironmentFile SIN instalarlo, habilitarlo ni iniciarlo.
 * La activación real es opt-in y requiere el gate humano `G-BROKER-SERVICE`.
 */
export {
  SESSION_BROKER_ENV_FILE_NAME,
  SYSTEMD_UNIT_NAME,
  assertOutsideWorktrees,
  escapeSystemdValue,
  renderSystemdUserUnit,
} from "./systemd";
export type {
  RenderedSystemdArtifacts,
  SystemdExec,
  SystemdRestartPolicy,
  SystemdUserUnitInput,
} from "./systemd";
