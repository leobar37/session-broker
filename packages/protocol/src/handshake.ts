/**
 * Handshake del protocolo (NFR-004).
 *
 * Flujo congelado:
 *   1. cliente -> `hello` (versiones soportadas, identidad declarada, grantId
 *      y credencial; la credencial NUNCA se registra ni se persiste).
 *   2. servidor -> `welcome` (versión negociada, `connectionId`, `challenge`
 *      de un solo intercambio, capacidades soportadas) o `error`.
 *   3. opcional: el proceso raíz presenta `bind_root` con una root proof
 *      ligada al challenge; cualquier otro claim se deniega.
 */

import { err, ok, isPlainObject, isString, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import {
  ID_PATTERNS,
  isGrantId,
  isInstanceId,
  isNativeSessionId,
  isProjectId,
  isWorkspaceId,
  type ConnectionId,
  type GrantId,
  type InstanceId,
  type NativeSessionId,
  type ProjectId,
  type WorkspaceId,
} from "./ids";
import { validateCapabilityList, type Capability } from "./capabilities";
import { LIMITS } from "./limits";
import { PROTOCOL_MAJOR, PROTOCOL_VERSION, formatProtocolVersion, negotiateProtocolVersion, parseProtocolVersion } from "./version";

export interface HelloMessage {
  readonly kind: "hello";
  readonly v: number;
  readonly protocolVersions: readonly string[];
  readonly clientName: string;
  readonly clientVersion: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly instanceId: InstanceId;
  readonly nativeSessionId?: NativeSessionId;
  readonly grantId: GrantId;
  /** Credencial opaca del grant. Prohibido registrarla/persistirla en claro. */
  readonly credential: string;
  readonly capabilities: readonly Capability[];
}

export interface WelcomeMessage {
  readonly kind: "welcome";
  readonly v: number;
  readonly protocolVersion: string;
  readonly connectionId: ConnectionId;
  readonly serverChallenge: string;
  readonly serverCapabilities: readonly Capability[];
  readonly maxFrameBytes: number;
  readonly heartbeatMs: number;
}

export function validateHello(value: unknown): Result<HelloMessage, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "hello debe ser un objeto", "hello"));
  }
  const unknown = Object.keys(value).filter(
    (key) =>
      ![
        "kind",
        "v",
        "protocolVersions",
        "clientName",
        "clientVersion",
        "projectId",
        "workspaceId",
        "instanceId",
        "nativeSessionId",
        "grantId",
        "credential",
        "capabilities",
      ].includes(key),
  );
  if (unknown.length > 0) {
    return err(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "hello"));
  }
  if (value.kind !== "hello") {
    return err(protocolError("INVALID_INPUT", "schema_malformed", 'kind debe ser "hello"', "kind"));
  }
  if (typeof value.v !== "number" || !Number.isSafeInteger(value.v)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "v inválido", "v"));
  }
  if (!Array.isArray(value.protocolVersions) || value.protocolVersions.length === 0 || value.protocolVersions.length > 8) {
    return err(
      protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "protocolVersions inválido", "protocolVersions"),
    );
  }
  for (let i = 0; i < value.protocolVersions.length; i++) {
    const parsed = parseProtocolVersion(value.protocolVersions[i]);
    if (!parsed.ok) {
      return err(
        protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "versión no interpretable", `protocolVersions[${i}]`),
      );
    }
  }
  if (!isString(value.clientName) || value.clientName.length === 0 || value.clientName.length > LIMITS.maxAliasChars) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "clientName inválido", "clientName"));
  }
  if (
    !isString(value.clientVersion) ||
    value.clientVersion.length === 0 ||
    value.clientVersion.length > LIMITS.maxAliasChars
  ) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "clientVersion inválido", "clientVersion"));
  }
  if (!isProjectId(value.projectId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "projectId inválido", "projectId"));
  }
  if (!isWorkspaceId(value.workspaceId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "workspaceId inválido", "workspaceId"));
  }
  if (!isInstanceId(value.instanceId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "instanceId inválido", "instanceId"));
  }
  if (value.nativeSessionId !== undefined && !isNativeSessionId(value.nativeSessionId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "nativeSessionId inválido", "nativeSessionId"));
  }
  if (!isGrantId(value.grantId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "grantId inválido", "grantId"));
  }
  if (!isString(value.credential) || value.credential.length === 0 || value.credential.length > 512) {
    return err(protocolError("UNAUTHORIZED", "unauthorized_scope", "credencial ausente o inválida", "credential"));
  }
  const capabilities = validateCapabilityList(value.capabilities, "capabilities");
  if (!capabilities.ok) return capabilities;
  return ok({
    kind: "hello",
    v: value.v as number,
    protocolVersions: value.protocolVersions as string[],
    clientName: value.clientName as string,
    clientVersion: value.clientVersion as string,
    projectId: value.projectId as ProjectId,
    workspaceId: value.workspaceId as WorkspaceId,
    instanceId: value.instanceId as InstanceId,
    nativeSessionId: value.nativeSessionId as NativeSessionId | undefined,
    grantId: value.grantId as GrantId,
    credential: value.credential as string,
    capabilities: capabilities.value,
  });
}

export function validateWelcome(value: unknown): Result<WelcomeMessage, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "welcome debe ser un objeto", "welcome"));
  }
  if (value.kind !== "welcome") {
    return err(protocolError("INVALID_INPUT", "schema_malformed", 'kind debe ser "welcome"', "kind"));
  }
  const protocolVersion = parseProtocolVersion(value.protocolVersion);
  if (!protocolVersion.ok) return protocolVersion;
  if (!ID_PATTERNS.connectionId.test(String(value.connectionId))) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "connectionId inválido", "connectionId"));
  }
  if (!ID_PATTERNS.challenge.test(String(value.serverChallenge))) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "serverChallenge inválido", "serverChallenge"));
  }
  const capabilities = validateCapabilityList(value.serverCapabilities, "serverCapabilities");
  if (!capabilities.ok) return capabilities;
  if (!isFiniteNumber(value.maxFrameBytes) || value.maxFrameBytes <= 0 || value.maxFrameBytes > LIMITS.maxFrameBytes) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "maxFrameBytes inválido", "maxFrameBytes"));
  }
  if (!isFiniteNumber(value.heartbeatMs) || value.heartbeatMs <= 0) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "heartbeatMs inválido", "heartbeatMs"));
  }
  return ok({
    kind: "welcome",
    v: PROTOCOL_MAJOR,
    protocolVersion: formatProtocolVersion(protocolVersion.value),
    connectionId: String(value.connectionId) as ConnectionId,
    serverChallenge: String(value.serverChallenge),
    serverCapabilities: capabilities.value,
    maxFrameBytes: value.maxFrameBytes as number,
    heartbeatMs: value.heartbeatMs as number,
  });
}

/**
 * Negocia la versión del handshake a partir de las versiones del `hello`.
 * Devuelve la versión acuerda o `INCOMPATIBLE_VERSION` (fail-closed).
 */
export function negotiateHelloVersion(
  hello: HelloMessage,
  serverVersions: readonly string[],
): Result<string, ProtocolError> {
  return negotiateProtocolVersion(hello.protocolVersions, serverVersions);
}
