/**
 * Init idempotente e identidad de proyecto/workspace (FR-002 / P-003).
 *
 * - `.broker/project.json` (versionado, compartible): conserva `projectId`
 *   entre checkouts/clones. Nunca contiene endpoints, tokens ni rutas
 *   privadas.
 * - `.broker/workspace.json` (local, gitignored, permisos 0600): registra la
 *   raíz del checkout; una copia/movimiento/colisión NO acredita este
 *   checkout (`workspace_identity_mismatch`) y exige regeneración explícita
 *   (`--regenerate-workspace`), que archiva el archivo previo.
 * - Repeticiones conservan IDs, no duplican reglas ignore ni borran datos
 *   ajenos del directorio `.broker/`.
 * - Sin Git no se crea repo; en un checkout Git solo se añade la regla ignore
 *   acordada, sin stage/commit.
 * - JSON corrupto, schema futuro, permiso denegado y escritura interrumpida
 *   producen errores explícitos sin archivos parciales que parezcan válidos.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import {
  EXIT_CODES,
  PROJECT_FILE_RELATIVE_PATH,
  WORKSPACE_FILE_GITIGNORE_ENTRY,
  WORKSPACE_FILE_RELATIVE_PATH,
  checkWorkspaceIdentity,
  createProjectFile,
  createWorkspaceFile,
  normalizeRootPath,
  parseProjectFile,
  parseWorkspaceFile,
  type ProjectFile,
  type ProjectId,
  type WorkspaceFile,
  type WorkspaceId,
} from "@session-broker/protocol";
import { CliError, cliErrorFromProtocol } from "./errors";

const PROJECT_FILE_MODE = 0o644;
const WORKSPACE_FILE_MODE = 0o600;

export interface InitOutcome {
  readonly rootPath: string;
  readonly projectFilePath: string;
  readonly workspaceFilePath: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly createdProject: boolean;
  readonly createdWorkspace: boolean;
  readonly regeneratedWorkspace: boolean;
  readonly gitignoreApplies: boolean;
  readonly gitignoreRule: string;
  readonly gitignoreUpdated: boolean;
}

export interface ProjectIdentity {
  readonly rootPath: string;
  readonly projectFilePath: string;
  readonly workspaceFilePath: string;
  readonly project: ProjectFile;
  readonly workspace: WorkspaceFile;
}

function describeIoError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code: unknown = cause.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "io_error";
}

function ioCliError(context: string, cause: unknown, hint?: string): CliError {
  const detail = describeIoError(cause);
  return new CliError({
    code: "INTERNAL_ERROR",
    exitCode: EXIT_CODES.INTERNAL_ERROR,
    message: `${context}: ${detail}`,
    hint: detail === "EACCES" || detail === "EPERM" ? hint ?? "permiso denegado: revisa los permisos del directorio/Archivo" : hint,
  });
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw ioCliError(`no se puede leer ${path}`, cause, "permiso denegado: revisa los permisos del archivo de identidad");
  }
  try {
    return JSON.parse(text);
  } catch {
    // El contenido nunca se copia al mensaje: podría contener datos sensibles.
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "schema_malformed",
      message: `${path} no es JSON válido`,
      hint: "corrige el archivo o restáuralo desde el control de versiones (project.json) / regenera con init --regenerate-workspace (workspace.json)",
    });
  }
}

/**
 * Escritura atómica: temporal opuesto + rename. Ante fallo no queda ningún
 * archivo parcial que parezca válido (el temporal se elimina y nunca usa el
 * nombre definitivo).
 */
function writeJsonAtomic(path: string, value: unknown, mode: number): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (cause) {
    throw ioCliError(`no se puede serializar ${path}`, cause);
  }
  try {
    writeFileSync(tempPath, serialized, { mode });
    // Modo exacto pese al umask, ANTES del rename definitivo.
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (cause) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // mejor esfuerzo de limpieza
    }
    throw ioCliError(
      `escritura interrumpida en ${path}; no se dejó ningún archivo parcial válido`,
      cause,
      "permiso denegado o escritura interrumpida: revisa el directorio .broker y repite init",
    );
  }
}

export function initIdentity(input: {
  root: string;
  name?: string | undefined;
  regenerateWorkspace: boolean;
  nowMs: number;
}): InitOutcome {
  const rootPath = normalizeRootPath(resolvePath(input.root));
  const projectFilePath = join(rootPath, PROJECT_FILE_RELATIVE_PATH);
  const workspaceFilePath = join(rootPath, WORKSPACE_FILE_RELATIVE_PATH);
  try {
    mkdirSync(dirname(projectFilePath), { recursive: true });
  } catch (cause) {
    throw ioCliError(`no se puede crear ${dirname(projectFilePath)}`, cause);
  }

  let createdProject = false;
  let project: ProjectFile;
  if (existsSync(projectFilePath)) {
    const parsed = parseProjectFile(readJsonFile(projectFilePath));
    if (!parsed.ok) throw cliErrorFromProtocol(parsed.error);
    project = parsed.value;
  } else {
    project = createProjectFile(input.nowMs, input.name);
    writeJsonAtomic(projectFilePath, project, PROJECT_FILE_MODE);
    createdProject = true;
  }

  let createdWorkspace = false;
  let regeneratedWorkspace = false;
  let workspace: WorkspaceFile;
  if (existsSync(workspaceFilePath)) {
    const parsed = parseWorkspaceFile(readJsonFile(workspaceFilePath));
    if (!parsed.ok) throw cliErrorFromProtocol(parsed.error);
    const identity = checkWorkspaceIdentity(parsed.value, rootPath);
    const sameProject = parsed.value.projectId === project.projectId;
    if (identity.ok && sameProject) {
      workspace = parsed.value;
    } else if (!input.regenerateWorkspace) {
      throw new CliError({
        code: "INVALID_INPUT",
        exitCode: EXIT_CODES.INVALID_INPUT,
        reason: "workspace_identity_mismatch",
        message: sameProject
          ? `${WORKSPACE_FILE_RELATIVE_PATH} pertenece a otra raíz de checkout (copia/clone/move) y no acredita este checkout`
          : `${WORKSPACE_FILE_RELATIVE_PATH} apunta a otro proyecto (identidad stale)`,
        hint: "ejecuta init --regenerate-workspace para archivar el archivo previo y generar un workspaceId nuevo; nunca se sobrescribe en silencio",
      });
    } else {
      const archivePath = `${workspaceFilePath}.conflict-${input.nowMs}`;
      try {
        renameSync(workspaceFilePath, archivePath);
      } catch (cause) {
        throw ioCliError(`no se pudo archivar ${workspaceFilePath}`, cause);
      }
      workspace = createWorkspaceFile({ projectId: project.projectId, rootPath, nowMs: input.nowMs });
      writeJsonAtomic(workspaceFilePath, workspace, WORKSPACE_FILE_MODE);
      regeneratedWorkspace = true;
    }
  } else {
    workspace = createWorkspaceFile({ projectId: project.projectId, rootPath, nowMs: input.nowMs });
    writeJsonAtomic(workspaceFilePath, workspace, WORKSPACE_FILE_MODE);
    createdWorkspace = true;
  }

  const gitignoreApplies = existsSync(join(rootPath, ".git"));
  let gitignoreUpdated = false;
  if (gitignoreApplies) {
    gitignoreUpdated = applyGitignoreRule(rootPath);
  }

  return {
    rootPath,
    projectFilePath,
    workspaceFilePath,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    createdProject,
    createdWorkspace,
    regeneratedWorkspace,
    gitignoreApplies,
    gitignoreRule: WORKSPACE_FILE_GITIGNORE_ENTRY,
    gitignoreUpdated,
  };
}

/** Añade la regla ignore del workspace local si falta; nunca duplica ni toca el resto. */
function applyGitignoreRule(rootPath: string): boolean {
  const ignorePath = join(rootPath, ".gitignore");
  let content = "";
  if (existsSync(ignorePath)) {
    try {
      content = readFileSync(ignorePath, "utf8");
    } catch (cause) {
      throw ioCliError(`no se puede leer ${ignorePath}`, cause);
    }
  }
  const present = content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === WORKSPACE_FILE_GITIGNORE_ENTRY || trimmed === `/${WORKSPACE_FILE_GITIGNORE_ENTRY}`;
  });
  if (present) return false;
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  try {
    writeFileSync(ignorePath, `${content}${separator}${WORKSPACE_FILE_GITIGNORE_ENTRY}\n`);
  } catch (cause) {
    throw ioCliError(`no se puede escribir ${ignorePath}`, cause);
  }
  return true;
}

/** Lee y valida la identidad del checkout; cualquier stale/mismatch es error explícito. */
export function readIdentity(root: string): ProjectIdentity {
  const rootPath = normalizeRootPath(resolvePath(root));
  const projectFilePath = join(rootPath, PROJECT_FILE_RELATIVE_PATH);
  const workspaceFilePath = join(rootPath, WORKSPACE_FILE_RELATIVE_PATH);
  if (!existsSync(projectFilePath)) {
    throw new CliError({
      code: "NOT_FOUND_OR_FORBIDDEN",
      exitCode: EXIT_CODES.NOT_FOUND_OR_FORBIDDEN,
      message: `no hay identidad de proyecto en ${projectFilePath}`,
      hint: "ejecuta init en la raíz del proyecto",
    });
  }
  if (!existsSync(workspaceFilePath)) {
    throw new CliError({
      code: "NOT_FOUND_OR_FORBIDDEN",
      exitCode: EXIT_CODES.NOT_FOUND_OR_FORBIDDEN,
      message: `no hay identidad de workspace en ${workspaceFilePath}`,
      hint: "ejecuta init en este checkout para generar su workspaceId local",
    });
  }
  const projectParsed = parseProjectFile(readJsonFile(projectFilePath));
  if (!projectParsed.ok) throw cliErrorFromProtocol(projectParsed.error);
  const workspaceParsed = parseWorkspaceFile(readJsonFile(workspaceFilePath));
  if (!workspaceParsed.ok) throw cliErrorFromProtocol(workspaceParsed.error);
  const identity = checkWorkspaceIdentity(workspaceParsed.value, rootPath);
  if (!identity.ok) {
    throw cliErrorFromProtocol(identity.error, {
      hint: "ejecuta init --regenerate-workspace para archivar la identidad ajena y generar un workspaceId propio de este checkout",
    });
  }
  if (workspaceParsed.value.projectId !== projectParsed.value.projectId) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "workspace_identity_mismatch",
      message: `${WORKSPACE_FILE_RELATIVE_PATH} apunta a un projectId distinto del de ${PROJECT_FILE_RELATIVE_PATH} (identidad stale)`,
      hint: "ejecuta init --regenerate-workspace para regenerar la identidad local de este checkout",
    });
  }
  return {
    rootPath,
    projectFilePath,
    workspaceFilePath,
    project: projectParsed.value,
    workspace: workspaceParsed.value,
  };
}

/** Modo efectivo de un archivo (para comprobaciones de secretos en tests/inspección). */
export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}
