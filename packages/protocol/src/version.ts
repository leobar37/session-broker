/**
 * Versión del protocolo y negociación (NFR-004).
 *
 * Compatible si y solo si coincide el `major` y el `minor` del cliente es ≤
 * que el del servidor (los cambios `minor` son aditivos; `patch` no negocia).
 * Cualquier otro caso falla cerrado con `INCOMPATIBLE_VERSION`.
 */

import { err, ok, isString, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";

export const PROTOCOL_VERSION = "1.0.0";
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const PROTOCOL_PATCH = 0;

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseProtocolVersion(value: unknown): Result<ProtocolVersion, ProtocolError> {
  if (!isString(value)) {
    return err(protocolError("INCOMPATIBLE_VERSION", "incompatible_version", "versión debe ser string semver", "protocolVersion"));
  }
  const match = VERSION_PATTERN.exec(value);
  if (match === null) {
    return err(
      protocolError("INCOMPATIBLE_VERSION", "incompatible_version", `versión no interpretable: ${value}`, "protocolVersion"),
    );
  }
  return ok({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

export function compareProtocolVersions(a: ProtocolVersion, b: ProtocolVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Forma canónica `major.minor.patch`. */
export function formatProtocolVersion(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Negociación de handshake: devuelve la versión acordada (string canónico) o
 * `INCOMPATIBLE_VERSION`. No hay fuzzy matching ni degradación silenciosa.
 */
export function negotiateProtocolVersion(
  clientVersions: readonly string[],
  serverVersions: readonly string[],
): Result<string, ProtocolError> {
  let best: ProtocolVersion | undefined;
  for (const serverRaw of serverVersions) {
    const server = parseProtocolVersion(serverRaw);
    if (!server.ok) continue;
    for (const clientRaw of clientVersions) {
      const client = parseProtocolVersion(clientRaw);
      if (!client.ok) continue;
      const compatible = client.value.major === server.value.major && client.value.minor <= server.value.minor;
      if (compatible && (best === undefined || compareProtocolVersions(server.value, best) > 0)) {
        best = server.value;
      }
    }
  }
  if (best === undefined) {
    return err(
      protocolError(
        "INCOMPATIBLE_VERSION",
        "incompatible_version",
        `sin versión negociable: cliente=[${clientVersions.join(", ")}] servidor=[${serverVersions.join(", ")}]`,
        "protocolVersion",
      ),
    );
  }
  return ok(formatProtocolVersion(best));
}

/** Comprobación directa de compatibilidad de un único par cliente/servidor. */
export function isProtocolVersionCompatible(client: ProtocolVersion, server: ProtocolVersion): boolean {
  return client.major === server.major && client.minor <= server.minor;
}
