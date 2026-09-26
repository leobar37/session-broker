/**
 * Identificadores del contrato (FR-001/002/003). Cada identificador tiene un
 * ámbito y un ciclo de vida propios; NUNCA se sustituyen entre sí y los
 * identificadores son selectores, no credenciales.
 *
 * - `projectId`: estable y versionado en `.broker/project.json` (compartido por clones).
 * - `workspaceId`: único por checkout local en `.broker/workspace.json` (gitignored).
 * - `nativeSessionId`: sesión nativa persistible (opaca; el protocolo no asume formato OMP).
 * - `sessionRef`: referencia broker con ámbito explícito proyecto/workspace.
 * - `instanceId`: cambia en cada proceso.
 * - `connectionId`: por conexión WS.
 * - `requestId`/`eventId`/`eventSeq`: correlación y orden de eventos.
 * - `controlEpoch`: invalida control obsoleto tras takeover/revoke.
 */

import { randomBytes } from "node:crypto";
import { err, ok, isSafeInteger, isString, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";

export type ProjectId = string;
export type WorkspaceId = string;
export type NativeSessionId = string;
export type InstanceId = string;
export type ConnectionId = string;
export type RequestId = string;
export type EventId = string;
export type GrantId = string;
export type TargetId = string;
export type EventSeq = number;
export type ControlEpoch = number;

export const ID_PATTERNS = {
  projectId: /^prj_[0-9a-f]{32}$/,
  workspaceId: /^wsp_[0-9a-f]{32}$/,
  instanceId: /^ins_[0-9a-f]{32}$/,
  connectionId: /^con_[0-9a-f]{32}$/,
  requestId: /^req_[0-9a-f]{32}$/,
  eventId: /^evt_[0-9a-f]{32}$/,
  grantId: /^grt_[0-9a-f]{32}$/,
  proofId: /^rp_[0-9a-f]{32}$/,
  challenge: /^chal_[0-9a-f]{32}$/,
  /** Nombre corto de objetivo (p. ej. `omp`). */
  targetId: /^[a-z][a-z0-9._-]{0,62}$/,
  /**
   * Sesión nativa: opaca por diseño. Charset/longitud acotados únicamente
   * para evitar abusos de parsing; jamás se interpreta su contenido. Nunca
   * usa los prefijos reservados de los namespaces del broker.
   */
  nativeSessionId: /^[A-Za-z0-9._:@/+-]{1,128}$/,
} as const;

export function isProjectId(value: unknown): value is ProjectId {
  return isString(value) && ID_PATTERNS.projectId.test(value);
}

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return isString(value) && ID_PATTERNS.workspaceId.test(value);
}

export function isInstanceId(value: unknown): value is InstanceId {
  return isString(value) && ID_PATTERNS.instanceId.test(value);
}

export function isConnectionId(value: unknown): value is ConnectionId {
  return isString(value) && ID_PATTERNS.connectionId.test(value);
}

export function isRequestId(value: unknown): value is RequestId {
  return isString(value) && ID_PATTERNS.requestId.test(value);
}

export function isEventId(value: unknown): value is EventId {
  return isString(value) && ID_PATTERNS.eventId.test(value);
}

export function isGrantId(value: unknown): value is GrantId {
  return isString(value) && ID_PATTERNS.grantId.test(value);
}

/**
 * Prefijos reservados exclusivamente a los namespaces con identidad del
 * broker. Los identificadores opacos (target, sesión nativa) NUNCA pueden
 * usarlos: los namespaces son disjuntos por construcción y un valor de un
 * ámbito jamás es válido en otro.
 */
const RESERVED_ID_PREFIXES = ["prj_", "wsp_", "ins_", "con_", "req_", "evt_", "grt_", "rp_", "chal_"] as const;

function hasReservedIdPrefix(value: string): boolean {
  for (const prefix of RESERVED_ID_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

export function isTargetId(value: unknown): value is TargetId {
  return isString(value) && ID_PATTERNS.targetId.test(value) && !hasReservedIdPrefix(value);
}

export function isNativeSessionId(value: unknown): value is NativeSessionId {
  return isString(value) && ID_PATTERNS.nativeSessionId.test(value) && !hasReservedIdPrefix(value);
}

/** `eventSeq` es un entero seguro ≥ 1, estrictamente creciente por stream. */
export function isValidEventSeq(value: unknown): value is EventSeq {
  return isSafeInteger(value) && (value as number) >= 1;
}

/** `controlEpoch` es un entero seguro ≥ 0; 0 = sin lease de control vigente. */
export function isValidControlEpoch(value: unknown): value is ControlEpoch {
  return isSafeInteger(value) && (value as number) >= 0;
}

function randomHex32(): string {
  return randomBytes(16).toString("hex");
}

export function newProjectId(): ProjectId {
  return `prj_${randomHex32()}`;
}

export function newWorkspaceId(): WorkspaceId {
  return `wsp_${randomHex32()}`;
}

export function newInstanceId(): InstanceId {
  return `ins_${randomHex32()}`;
}

export function newConnectionId(): ConnectionId {
  return `con_${randomHex32()}`;
}

export function newRequestId(): RequestId {
  return `req_${randomHex32()}`;
}

export function newEventId(): EventId {
  return `evt_${randomHex32()}`;
}

export function newGrantId(): GrantId {
  return `grt_${randomHex32()}`;
}

export function newRootProofId(): string {
  return `rp_${randomHex32()}`;
}

export function newChallenge(): string {
  return `chal_${randomHex32()}`;
}

/**
 * Referencia broker a una sesión con ámbito explícito. `workspaceId` es
 * obligatorio si y solo si `scope === "workspace"`: no hay ámbito implícito.
 */
export interface SessionRef {
  readonly projectId: ProjectId;
  readonly scope: "project" | "workspace";
  readonly workspaceId?: WorkspaceId;
  readonly target: TargetId;
  readonly nativeSessionId: NativeSessionId;
}

/** Destino de una solicitud: objetivo + sesión opcional + instancia opcional. */
export interface TargetRef {
  readonly target: TargetId;
  readonly session?: SessionRef;
  readonly instanceId?: InstanceId;
}

export function validateSessionRef(value: unknown): Result<SessionRef, ProtocolError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "sessionRef debe ser un objeto", "sessionRef"));
  }
  const ref = value as Record<string, unknown>;
  const unknownKeys = Object.keys(ref).filter(
    (key) => key !== "projectId" && key !== "scope" && key !== "workspaceId" && key !== "target" && key !== "nativeSessionId",
  );
  if (unknownKeys.length > 0) {
    return err(
      protocolError("INVALID_INPUT", "unknown_fields", `sessionRef tiene campos desconocidos: ${unknownKeys.join(", ")}`, "sessionRef"),
    );
  }
  if (!isProjectId(ref.projectId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", "sessionRef.projectId"));
  }
  if (ref.scope !== "project" && ref.scope !== "workspace") {
    return err(protocolError("INVALID_INPUT", "invalid_field", 'scope debe ser "project" o "workspace"', "sessionRef.scope"));
  }
  if (ref.scope === "workspace") {
    if (!isWorkspaceId(ref.workspaceId)) {
      return err(
        protocolError(
          "INVALID_INPUT",
          "invalid_field",
          "workspaceId es obligatorio (y válido) cuando scope === 'workspace'",
          "sessionRef.workspaceId",
        ),
      );
    }
  } else if (ref.workspaceId !== undefined) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "invalid_field",
        "workspaceId solo puede acompañar a scope === 'workspace'",
        "sessionRef.workspaceId",
      ),
    );
  }
  if (!isTargetId(ref.target)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "target inválido", "sessionRef.target"));
  }
  if (!isNativeSessionId(ref.nativeSessionId)) {
    return err(
      protocolError("INVALID_INPUT", "invalid_format", "nativeSessionId inválido", "sessionRef.nativeSessionId"),
    );
  }
  return ok({
    projectId: ref.projectId as ProjectId,
    scope: ref.scope as "project" | "workspace",
    workspaceId: ref.workspaceId as WorkspaceId | undefined,
    target: ref.target as TargetId,
    nativeSessionId: ref.nativeSessionId as NativeSessionId,
  });
}
