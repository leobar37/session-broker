/**
 * Generador DECLARATIVO de la unidad systemd **user** del broker (FR-010).
 *
 * Generar el artefacto NO instala, habilita, arranca ni reinicia nada: este
 * módulo solo renderiza texto. La activación real queda tras el gate humano
 * `G-BROKER-SERVICE` (ver `docs/operations`); ninguna prueba ni comando toca
 * el user manager ni `~/.config/systemd`.
 *
 * Reglas que la unidad debe respetar (y que el generador hace cumplir):
 *   - rutas y argumentos de configuración EXPLÍCITOS y absolutos;
 *   - data dir FUERA de worktrees (se rechaza cualquier ruta dentro de uno);
 *   - `Restart=` aplica SOLO al proceso del broker (una unidad, un proceso);
 *   - secretos JAMÁS en `ExecStart` ni en archivos versionados: van en un
 *     `EnvironmentFile` con permisos 600 (el generador emite una plantilla sin
 *     valores);
 *   - sin lingering (la unidad solo corre dentro de una sesión de usuario
 *     activa; jamás se recomienda autoarranque sin sesión de login).
 */

export const SYSTEMD_UNIT_NAME = "session-broker.service";
export const SESSION_BROKER_ENV_FILE_NAME = "broker.env";

export type SystemdRestartPolicy = "no" | "on-failure" | "always";

export interface SystemdExec {
  /** Ejecutable absoluto (p. ej. `/usr/bin/bun`). */
  readonly command: string;
  /** Argumentos explícitos (p. ej. la ruta absoluta al entrypoint del broker). */
  readonly args?: readonly string[];
}

export interface SystemdUserUnitInput {
  readonly exec: SystemdExec;
  /** Data dir absoluto del broker (SQLite/journals/grants), fuera de worktrees. */
  readonly dataDir: string;
  /** Ruta absoluta del EnvironmentFile (permisos 600) donde viven los secretos. */
  readonly environmentFile: string;
  /** WorkingDirectory absoluto opcional (instalación; nunca el data dir). */
  readonly workingDirectory?: string;
  /** Raíces de worktrees prohibidas para `dataDir` (fixtures y operación). */
  readonly worktreeRoots?: readonly string[];
  readonly description?: string;
  readonly restart?: SystemdRestartPolicy;
  readonly restartSec?: number;
}

export interface RenderedSystemdArtifacts {
  readonly unitName: string;
  readonly unit: string;
  /** Plantilla del EnvironmentFile: solo nombres de variables, nunca valores. */
  readonly environmentFileTemplate: string;
}

const ALLOWED_RESTART: Record<string, true> = { no: true, "on-failure": true, always: true };
const DEFAULT_DESCRIPTION =
  "session-broker: broker durable (servicio user OPT-IN; activación manual tras gate G-BROKER-SERVICE)";

/**
 * Escapa un argumento de unidad systemd: una sola línea, sin caracteres de
 * control, envuelto en comillas dobles con `\` y `"` escapados. Un valor
 * multilinea o con caracteres de control es un error explícito (nunca se
 * "arregla" en silencio).
 */
export function escapeSystemdValue(value: string, label: string): string {
  if (value.length === 0) throw new Error(`systemd: ${label} no puede estar vacío`);
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`systemd: ${label} contiene saltos de línea o caracteres de control (no se emite)`);
    }
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function requireAbsolutePath(value: string, label: string): string {
  const escaped = escapeSystemdValue(value, label);
  if (!value.startsWith("/")) throw new Error(`systemd: ${label} debe ser una ruta absoluta: ${value}`);
  return escaped;
}

/** Rechaza `dataDir` dentro de un worktree: los datos viven fuera del código. */
export function assertOutsideWorktrees(dataDir: string, worktreeRoots: readonly string[]): void {
  for (const root of worktreeRoots) {
    const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
    if (normalized.length === 0) continue;
    if (dataDir === normalized || dataDir.startsWith(`${normalized}/`)) {
      throw new Error(`systemd: el data dir no puede vivir dentro de un worktree (${root}): ${dataDir}`);
    }
  }
}

/**
 * Renderiza la unidad user y la plantilla del EnvironmentFile. La salida es
 * texto estático: no escribe archivos, no contacta al user manager y no
 * contiene secretos.
 */
export function renderSystemdUserUnit(input: SystemdUserUnitInput): RenderedSystemdArtifacts {
  const description = input.description ?? DEFAULT_DESCRIPTION;
  const restart = input.restart ?? "on-failure";
  const restartSec = input.restartSec ?? 5;
  if (ALLOWED_RESTART[restart] !== true) {
    throw new Error(`systemd: política Restart no soportada: ${String(restart)}`);
  }
  if (!Number.isSafeInteger(restartSec) || restartSec < 1 || restartSec > 3600) {
    throw new Error(`systemd: RestartSec debe ser un entero en 1..3600 (recibido ${String(restartSec)})`);
  }
  if (input.worktreeRoots !== undefined) assertOutsideWorktrees(input.dataDir, input.worktreeRoots);
  const command = requireAbsolutePath(input.exec.command, "exec.command");
  const args = (input.exec.args ?? []).map((arg, index) => escapeSystemdValue(arg, `exec.args[${index}]`));
  const dataDir = requireAbsolutePath(input.dataDir, "dataDir");
  const environmentFile = requireAbsolutePath(input.environmentFile, "environmentFile");
  const workingDirectory =
    input.workingDirectory === undefined ? undefined : requireAbsolutePath(input.workingDirectory, "workingDirectory");

  const unitLines: string[] = [
    "[Unit]",
    `Description=${description}`,
    "After=default.target",
    "",
    "[Service]",
    "Type=exec",
    ...(workingDirectory === undefined ? [] : [`WorkingDirectory=${workingDirectory}`]),
    `ExecStart=${[command, ...args].join(" ")}`,
    // Configuración explícita en la unidad; los secretos JAMÁS aparecen aquí.
    `Environment=SESSION_BROKER_DATA_DIR=${dataDir}`,
    `EnvironmentFile=-${environmentFile}`,
    `Restart=${restart}`,
    `RestartSec=${restartSec}`,
    "# Secretos (credencial/MAC key) SOLO en el EnvironmentFile con permisos 600:",
    "# jamás en ExecStart, en la línea de comandos ni en archivos versionados.",
    "# Unidad user sin lingering: solo corre dentro de una sesión de usuario",
    "# activa; habilitar y arrancar el servicio queda tras el gate humano.",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];

  const envLines: string[] = [
    "# EnvironmentFile del session broker (user). Copia, ajusta y protege:",
    `#   chmod 600 ${SESSION_BROKER_ENV_FILE_NAME}`,
    "# Los valores secretos viven SOLO en este archivo (600); el generador jamás",
    "# escribe valores reales ni los incluye en la unidad.",
    `SESSION_BROKER_DATA_DIR=${input.dataDir}`,
    "SESSION_BROKER_HOST=127.0.0.1",
    "SESSION_BROKER_PORT=8791",
    "# SESSION_BROKER_MAC_KEY=  (define aquí la MAC key del root binding; 600)",
    "",
  ];

  return {
    unitName: SYSTEMD_UNIT_NAME,
    unit: unitLines.join("\n"),
    environmentFileTemplate: envLines.join("\n"),
  };
}
