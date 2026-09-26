/**
 * Grants autenticados y `controlEpoch` (FR-004 / NFR-001).
 *
 * - Un grant limita proyecto/workspace/target/sesión/capability y operaciones.
 * - Los IDs son SELECTORES, nunca credenciales: conocer un `projectId`,
 *   `sessionRef` o `requestId` no otorga ningún permiso.
 * - Lectura, envío y control se separan en capacidades distintas.
 * - Toda acción mutante de control exibe el `controlEpoch` vigente; la
 *   comparación es atómica en el broker y un epoch obsoleto se rechaza con
 *   `STALE_CONTROL_EPOCH` (takeover/revoke invalidan el control anterior).
 */

import { err, ok, isString, isPlainObject, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import {
  isGrantId,
  isInstanceId,
  isNativeSessionId,
  isProjectId,
  isTargetId,
  isWorkspaceId,
  isValidControlEpoch,
  type ControlEpoch,
  type GrantId,
  type InstanceId,
  type NativeSessionId,
  type ProjectId,
  type TargetId,
  type WorkspaceId,
} from "./ids";
import { isCapability, type Capability } from "./capabilities";
import { LIMITS } from "./limits";

export type GrantSelector<T> = readonly T[] | "*";

export interface GrantScope {
  readonly projectId: ProjectId;
  readonly workspaceIds?: GrantSelector<WorkspaceId>;
  readonly targets?: GrantSelector<TargetId>;
  readonly sessions?: GrantSelector<NativeSessionId>;
  readonly capabilities: readonly Capability[];
}

export interface Grant {
  readonly grantId: GrantId;
  /** Principal al que pertenece el grant (identidad autenticada por credencial). */
  readonly subject: string;
  readonly scope: GrantScope;
  readonly issuedBy: string;
  readonly issuedAtMs: number;
  readonly notBeforeMs?: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs?: number;
}

export interface GrantAction {
  readonly projectId: ProjectId;
  readonly workspaceId?: WorkspaceId;
  readonly target: TargetId;
  readonly nativeSessionId?: NativeSessionId;
  readonly capability: Capability;
}

function selectorAllows<T extends string>(selector: GrantSelector<T> | undefined, value: T): boolean {
  if (selector === undefined) return false;
  if (selector === "*") return true;
  return selector.includes(value);
}

/**
 * Evaluación de un grant contra una acción concreta. Todo lo que no esté
 * explícitamente permitido se deniega (`UNAUTHORIZED`); un ID conocido nunca
 * sustituye la credencial del grant.
 */
export function evaluateGrant(grant: Grant, action: GrantAction, nowMs: number): Result<true, ProtocolError> {
  if (grant.revokedAtMs !== undefined && nowMs >= grant.revokedAtMs) {
    return err(protocolError("UNAUTHORIZED", "grant_revoked", "grant revocado", "grant.revokedAtMs"));
  }
  if (grant.notBeforeMs !== undefined && nowMs < grant.notBeforeMs) {
    return err(protocolError("UNAUTHORIZED", "grant_not_yet_valid", "grant aún no vigente", "grant.notBeforeMs"));
  }
  if (nowMs >= grant.expiresAtMs) {
    return err(protocolError("EXPIRED", "grant_expired", "grant expirado", "grant.expiresAtMs"));
  }
  if (grant.expiresAtMs - grant.issuedAtMs > LIMITS.grantTtlMsMax) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "TTL de grant excede el máximo", "grant.expiresAtMs"));
  }
  if (grant.scope.projectId !== action.projectId) {
    return err(protocolError("UNAUTHORIZED", "unauthorized_scope", "grant no cubre este proyecto", "grant.scope.projectId"));
  }
  // Dimensión con lista explícita: la acción DEBE declarar un valor incluido en
  // ella. Una acción que omita la dimensión abarcaría datos fuera de la lista y
  // se deniega (fail-closed). Solo el wildcard "*" relaja esta regla.
  if (action.workspaceId === undefined) {
    if (grant.scope.workspaceIds !== undefined && grant.scope.workspaceIds !== "*") {
      return err(
        protocolError(
          "UNAUTHORIZED",
          "unauthorized_scope",
          "grant exige un workspace concreto; la acción no declara workspace",
          "grant.scope.workspaceIds",
        ),
      );
    }
  } else if (!selectorAllows(grant.scope.workspaceIds, action.workspaceId)) {
    return err(
      protocolError("UNAUTHORIZED", "unauthorized_scope", "grant no cubre este workspace", "grant.scope.workspaceIds"),
    );
  }
  if (!selectorAllows(grant.scope.targets, action.target)) {
    return err(protocolError("UNAUTHORIZED", "unauthorized_scope", "grant no cubre este target", "grant.scope.targets"));
  }
  if (action.nativeSessionId === undefined) {
    if (grant.scope.sessions !== undefined && grant.scope.sessions !== "*") {
      return err(
        protocolError(
          "UNAUTHORIZED",
          "unauthorized_scope",
          "grant exige una sesión concreta; la acción no declara sesión",
          "grant.scope.sessions",
        ),
      );
    }
  } else if (!selectorAllows(grant.scope.sessions, action.nativeSessionId)) {
    return err(protocolError("UNAUTHORIZED", "unauthorized_scope", "grant no cubre esta sesión", "grant.scope.sessions"));
  }
  if (!grant.scope.capabilities.includes(action.capability)) {
    return err(
      protocolError("UNAUTHORIZED", "unauthorized_scope", `grant no incluye la capability ${action.capability}`, "grant.scope.capabilities"),
    );
  }
  return ok(true);
}

export interface GrantTokenRecord {
  /** Hash de la credencial; la credencial en claro jamás se persiste ni se registra. */
  readonly credentialHash: string;
  readonly grant: Grant;
}

/** Marcador de credencial ausente: los IDs por sí solos nunca autentican. */
export const IDS_ARE_NOT_CREDENTIALS = "ids_are_not_credentials";

export function idsAloneAuthenticate(): Result<never, ProtocolError> {
  return err(
    protocolError(
      "UNAUTHORIZED",
      "ids_are_not_credentials",
      "IDs (proyecto/workspace/sesión/instancia) son selectores, no credenciales",
      "auth",
    ),
  );
}

export interface ControlLease {
  readonly scopeProjectId: ProjectId;
  readonly scopeTarget: TargetId;
  readonly scopeNativeSessionId?: NativeSessionId;
  readonly epoch: ControlEpoch;
  readonly holderInstanceId: InstanceId;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Comparación atómica de `controlEpoch`: la llama el broker dentro de la misma
 * transacción que aplica la acción mutante. Un epoch distinto (takeover o
 * revoke) invalida el control anterior sin excepciones.
 */
export function assertControlEpoch(
  lease: ControlLease | undefined,
  claimed: unknown,
  claimedInstanceId: unknown,
  nowMs: number,
): Result<ControlLease, ProtocolError> {
  if (lease === undefined) {
    return err(protocolError("STALE_CONTROL_EPOCH", "stale_control_epoch", "no hay lease de control vigente", "controlEpoch"));
  }
  if (!isValidControlEpoch(claimed)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "controlEpoch inválido", "controlEpoch"));
  }
  if (!isInstanceId(claimedInstanceId)) {
    return err(protocolError("STALE_INSTANCE", "stale_instance", "instancia desconocida o no vigente", "instanceId"));
  }
  if (nowMs >= lease.expiresAtMs) {
    return err(protocolError("EXPIRED", "grant_expired", "lease de control expirado", "lease.expiresAtMs"));
  }
  if (claimed !== lease.epoch) {
    return err(
      protocolError(
        "STALE_CONTROL_EPOCH",
        "stale_control_epoch",
        `controlEpoch obsoleto (presentado ${String(claimed)}, vigente ${lease.epoch})`,
        "controlEpoch",
      ),
    );
  }
  if (claimedInstanceId !== lease.holderInstanceId) {
    return err(protocolError("STALE_INSTANCE", "stale_instance", "la instancia no sostiene el lease de control", "instanceId"));
  }
  return ok(lease);
}

/** Renovación/takeover: siempre incrementa el epoch; el anterior queda inválido. */
export function renewControlLease(previous: ControlLease | undefined, next: Omit<ControlLease, "epoch">): ControlLease {
  return { ...next, epoch: previous === undefined ? 1 : previous.epoch + 1 };
}

export interface ParsedGrantJson {
  readonly grant: Grant;
}

/** Validación estricta de un grant serializado (fixtures, handoff, almacenamiento). */
export function parseGrant(value: unknown): Result<Grant, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "grant debe ser un objeto", "grant"));
  }
  const unknown = Object.keys(value).filter(
    (key) =>
      !["grantId", "subject", "scope", "issuedBy", "issuedAtMs", "notBeforeMs", "expiresAtMs", "revokedAtMs"].includes(key),
  );
  if (unknown.length > 0) {
    return err(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "grant"));
  }
  if (!isGrantId(value.grantId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "grantId inválido", "grant.grantId"));
  }
  if (!isString(value.subject) || value.subject.length === 0 || value.subject.length > LIMITS.maxAliasChars) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "subject inválido", "grant.subject"));
  }
  if (!isString(value.issuedBy) || value.issuedBy.length === 0 || value.issuedBy.length > LIMITS.maxAliasChars) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "issuedBy inválido", "grant.issuedBy"));
  }
  if (!isFiniteNumber(value.issuedAtMs) || value.issuedAtMs < 0) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "issuedAtMs inválido", "grant.issuedAtMs"));
  }
  if (!isFiniteNumber(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "expiresAtMs inválido", "grant.expiresAtMs"));
  }
  if (value.expiresAtMs - value.issuedAtMs > LIMITS.grantTtlMsMax) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "TTL de grant excede el máximo", "grant.expiresAtMs"));
  }
  if (value.notBeforeMs !== undefined && (!isFiniteNumber(value.notBeforeMs) || value.notBeforeMs < 0)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "notBeforeMs inválido", "grant.notBeforeMs"));
  }
  if (value.revokedAtMs !== undefined && (!isFiniteNumber(value.revokedAtMs) || value.revokedAtMs < 0)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "revokedAtMs inválido", "grant.revokedAtMs"));
  }
  const scopeResult = parseGrantScope(value.scope);
  if (!scopeResult.ok) return scopeResult;
  return ok({
    grantId: value.grantId as GrantId,
    subject: value.subject as string,
    scope: scopeResult.value,
    issuedBy: value.issuedBy as string,
    issuedAtMs: value.issuedAtMs as number,
    notBeforeMs: value.notBeforeMs as number | undefined,
    expiresAtMs: value.expiresAtMs as number,
    revokedAtMs: value.revokedAtMs as number | undefined,
  });
}

function parseSelector<T extends string>(
  raw: unknown,
  guard: (value: unknown) => value is T,
  path: string,
): Result<GrantSelector<T>, ProtocolError> {
  if (raw === "*") return ok("*");
  if (!Array.isArray(raw)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "selector debe ser lista o '*'", path));
  }
  const out: T[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (!guard(item)) {
      return err(protocolError("INVALID_INPUT", "invalid_format", "selector con elemento inválido", `${path}[${i}]`));
    }
    out.push(item);
  }
  return ok(out);
}

function parseGrantScope(value: unknown): Result<GrantScope, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "scope debe ser un objeto", "grant.scope"));
  }
  const unknown = Object.keys(value).filter(
    (key) => !["projectId", "workspaceIds", "targets", "sessions", "capabilities"].includes(key),
  );
  if (unknown.length > 0) {
    return err(
      protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "grant.scope"),
    );
  }
  if (!isProjectId(value.projectId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", "grant.scope.projectId"));
  }
  const workspaceIds =
    value.workspaceIds === undefined ? ok(undefined) : parseSelector(value.workspaceIds, isWorkspaceId, "grant.scope.workspaceIds");
  if (!workspaceIds.ok) return workspaceIds;
  const targets = value.targets === undefined ? ok(undefined) : parseSelector(value.targets, isTargetId, "grant.scope.targets");
  if (!targets.ok) return targets;
  const sessions =
    value.sessions === undefined ? ok(undefined) : parseSelector(value.sessions, isNativeSessionId, "grant.scope.sessions");
  if (!sessions.ok) return sessions;
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    return err(
      protocolError("INVALID_INPUT", "invalid_field", "capabilities debe ser una lista no vacía", "grant.scope.capabilities"),
    );
  }
  const capabilities: Capability[] = [];
  for (let i = 0; i < value.capabilities.length; i++) {
    const item: unknown = value.capabilities[i];
    if (!isCapability(item)) {
      return err(
        protocolError("UNSUPPORTED_CAPABILITY", "unknown_capability", `capacidad desconocida: ${String(item)}`, `grant.scope.capabilities[${i}]`),
      );
    }
    if (!capabilities.includes(item)) capabilities.push(item);
  }
  return ok({
    projectId: value.projectId as ProjectId,
    workspaceIds: workspaceIds.value,
    targets: targets.value,
    sessions: sessions.value,
    capabilities,
  });
}
