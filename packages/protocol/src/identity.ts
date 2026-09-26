/**
 * Identidad versionada en archivos del repo y del checkout (FR-001/002/003).
 *
 * `.broker/project.json`  -> versionado en Git, conserva `projectId` (compartido por clones/worktrees).
 * `.broker/workspace.json` -> local a este checkout (gitignored), conserva `workspaceId`.
 *
 * Política de clone/move congelada: una copia de un archivo local NO acredita
 * otro checkout. Si `rootPath` registrado ≠ raíz actual, se rechaza con
 * `workspace_identity_mismatch` y se exige regeneración EXPLÍCITA del
 * `workspaceId`; jamás hay sobrescritura silenciosa.
 *
 * Formato futuro (schemaVersion mayor) falla cerrado con
 * `unsupported_schema_version`; no hay migración difusa.
 */

import { err, ok, isPlainObject, isString, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import { isProjectId, isWorkspaceId, newProjectId, newWorkspaceId, type ProjectId, type WorkspaceId } from "./ids";
import { LIMITS } from "./limits";

export const PROJECT_FILE_RELATIVE_PATH = ".broker/project.json";
export const WORKSPACE_FILE_RELATIVE_PATH = ".broker/workspace.json";
export const PROJECT_FILE_SCHEMA_VERSION = 1;
export const WORKSPACE_FILE_SCHEMA_VERSION = 1;
export const WORKSPACE_FILE_GITIGNORE_ENTRY = ".broker/workspace.json";

export interface ProjectFile {
  readonly schemaVersion: number;
  readonly projectId: ProjectId;
  readonly createdAtMs: number;
  readonly name?: string;
}

export interface WorkspaceFile {
  readonly schemaVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  /** Raíz absoluta del checkout cuando se generó la identidad; clave anti-copia. */
  readonly rootPath: string;
  readonly createdAtMs: number;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Result<true, ProtocolError> {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return err(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, path));
  }
  return ok(true);
}

function readSchemaVersion(value: Record<string, unknown>, path: string): Result<number, ProtocolError> {
  const raw: unknown = value.schemaVersion;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "schemaVersion ausente o inválido", `${path}.schemaVersion`));
  }
  return ok(raw);
}

export function parseProjectFile(value: unknown): Result<ProjectFile, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "project.json debe ser un objeto", PROJECT_FILE_RELATIVE_PATH));
  }
  const keys = rejectUnknownKeys(value, ["schemaVersion", "projectId", "createdAtMs", "name"], PROJECT_FILE_RELATIVE_PATH);
  if (!keys.ok) return keys;
  const version = readSchemaVersion(value, PROJECT_FILE_RELATIVE_PATH);
  if (!version.ok) return version;
  if (version.value !== PROJECT_FILE_SCHEMA_VERSION) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "unsupported_schema_version",
        `schemaVersion ${version.value} no soportado (soportado: ${PROJECT_FILE_SCHEMA_VERSION})`,
        `${PROJECT_FILE_RELATIVE_PATH}.schemaVersion`,
      ),
    );
  }
  if (!isProjectId(value.projectId)) {
    return err(
      protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", `${PROJECT_FILE_RELATIVE_PATH}.projectId`),
    );
  }
  if (!isFiniteNumber(value.createdAtMs) || value.createdAtMs < 0) {
    return err(
      protocolError("INVALID_INPUT", "invalid_field", "createdAtMs inválido", `${PROJECT_FILE_RELATIVE_PATH}.createdAtMs`),
    );
  }
  if (value.name !== undefined && (!isString(value.name) || value.name.length > LIMITS.maxAliasChars)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "name inválido", `${PROJECT_FILE_RELATIVE_PATH}.name`));
  }
  return ok({
    schemaVersion: version.value,
    projectId: value.projectId as ProjectId,
    createdAtMs: value.createdAtMs as number,
    name: value.name as string | undefined,
  });
}

export function createProjectFile(nowMs: number, name?: string): ProjectFile {
  const base = {
    schemaVersion: PROJECT_FILE_SCHEMA_VERSION,
    projectId: newProjectId(),
    createdAtMs: nowMs,
  };
  return name === undefined ? base : { ...base, name };
}

export function parseWorkspaceFile(value: unknown): Result<WorkspaceFile, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(
      protocolError("INVALID_INPUT", "schema_malformed", "workspace.json debe ser un objeto", WORKSPACE_FILE_RELATIVE_PATH),
    );
  }
  const keys = rejectUnknownKeys(
    value,
    ["schemaVersion", "workspaceId", "projectId", "rootPath", "createdAtMs"],
    WORKSPACE_FILE_RELATIVE_PATH,
  );
  if (!keys.ok) return keys;
  const version = readSchemaVersion(value, WORKSPACE_FILE_RELATIVE_PATH);
  if (!version.ok) return version;
  if (version.value !== WORKSPACE_FILE_SCHEMA_VERSION) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "unsupported_schema_version",
        `schemaVersion ${version.value} no soportado (soportado: ${WORKSPACE_FILE_SCHEMA_VERSION})`,
        `${WORKSPACE_FILE_RELATIVE_PATH}.schemaVersion`,
      ),
    );
  }
  if (!isWorkspaceId(value.workspaceId)) {
    return err(
      protocolError("INVALID_INPUT", "invalid_format", "workspaceId inválido", `${WORKSPACE_FILE_RELATIVE_PATH}.workspaceId`),
    );
  }
  if (!isProjectId(value.projectId)) {
    return err(
      protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", `${WORKSPACE_FILE_RELATIVE_PATH}.projectId`),
    );
  }
  if (!isString(value.rootPath) || value.rootPath.length === 0 || value.rootPath.length > 4096) {
    return err(
      protocolError("INVALID_INPUT", "invalid_field", "rootPath inválido", `${WORKSPACE_FILE_RELATIVE_PATH}.rootPath`),
    );
  }
  if (!isFiniteNumber(value.createdAtMs) || value.createdAtMs < 0) {
    return err(
      protocolError("INVALID_INPUT", "invalid_field", "createdAtMs inválido", `${WORKSPACE_FILE_RELATIVE_PATH}.createdAtMs`),
    );
  }
  return ok({
    schemaVersion: version.value,
    workspaceId: value.workspaceId as WorkspaceId,
    projectId: value.projectId as ProjectId,
    rootPath: value.rootPath as string,
    createdAtMs: value.createdAtMs as number,
  });
}

export function createWorkspaceFile(input: {
  projectId: ProjectId;
  rootPath: string;
  nowMs: number;
}): WorkspaceFile {
  return {
    schemaVersion: WORKSPACE_FILE_SCHEMA_VERSION,
    workspaceId: newWorkspaceId(),
    projectId: input.projectId,
    rootPath: normalizeRootPath(input.rootPath),
    createdAtMs: input.nowMs,
  };
}

/** Normalización léxica de raíz de checkout (comparación de igualdad exacta tras normalizar). */
export function normalizeRootPath(rootPath: string): string {
  let normalized = rootPath.replace(/\/+$/, "");
  if (normalized.length === 0) normalized = "/";
  return normalized;
}

/**
 * Detección de clone/move/copia: el `workspaceId` solo es válido para la raíz
 * donde se emitió. Devuelve error `workspace_identity_mismatch` si la copia
 * actual vive en otra raíz; el llamador debe exigir regeneración explícita.
 */
export function checkWorkspaceIdentity(
  file: WorkspaceFile,
  currentRootPath: string,
): Result<"workspace_identity_match", ProtocolError> {
  if (normalizeRootPath(file.rootPath) === normalizeRootPath(currentRootPath)) {
    return ok("workspace_identity_match");
  }
  return err(
    protocolError(
      "INVALID_INPUT",
      "workspace_identity_mismatch",
      "workspace.json pertenece a otra raíz de checkout (copia/clone/move); requiere regeneración explícita del workspaceId, sin sobrescritura silenciosa",
      `${WORKSPACE_FILE_RELATIVE_PATH}.rootPath`,
    ),
  );
}
