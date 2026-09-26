/**
 * Serialización canónica y hash de payload para dedup (FR-007).
 *
 * El hash canónico cubre SIEMPRE {operación, target, payload}: mismo
 * `requestId` + mismo hash es idempotente; mismo `requestId` + hash distinto
 * es `PAYLOAD_CONFLICT` sin efectos.
 */

import { createHash } from "node:crypto";
import { err, ok, isPlainObject, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";

/**
 * JSON canónico determinista: claves de objeto ordenadas lexicográficamente,
 * arrays en orden, sin espacio innecesario, solo valores JSON (null, boolean,
 * número finito, string, array, objeto plano). Cualquier otro valor (undefined,
 * bigint, Date, Map, NaN, Infinity, funciones, prototipos raros) se rechaza.
 */
export function canonicalJson(value: unknown, path = "$"): Result<string, ProtocolError> {
  if (value === null) return ok("null");
  if (typeof value === "boolean") return ok(value ? "true" : "false");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return err(protocolError("INVALID_INPUT", "invalid_field", "número no finito no es serializable", path));
    }
    return ok(JSON.stringify(value));
  }
  if (typeof value === "string") return ok(JSON.stringify(value));
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = canonicalJson(value[i], `${path}[${i}]`);
      if (!item.ok) return item;
      parts.push(item.value);
    }
    return ok(`[${parts.join(",")}]`);
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const fieldValue: unknown = value[key];
      if (fieldValue === undefined) {
        return err(
          protocolError("INVALID_INPUT", "invalid_field", `campo con valor undefined no es serializable: ${key}`, `${path}.${key}`),
        );
      }
      const serialized = canonicalJson(fieldValue, `${path}.${key}`);
      if (!serialized.ok) return serialized;
      parts.push(`${JSON.stringify(key)}:${serialized.value}`);
    }
    return ok(`{${parts.join(",")}}`);
  }
  return err(
    protocolError("INVALID_INPUT", "invalid_field", `valor no serializable de tipo ${typeof value}`, path),
  );
}

export interface PayloadHashInput {
  readonly operation: string;
  readonly target: unknown;
  readonly payload: unknown;
}

/** sha256 (hex) sobre la serialización canónica de {operación, target, payload}. */
export function computePayloadHash(input: PayloadHashInput): Result<string, ProtocolError> {
  const canonical = canonicalJson(
    { operation: input.operation, target: input.target, payload: input.payload },
    "$.dedup",
  );
  if (!canonical.ok) return canonical;
  return ok(createHash("sha256").update(canonical.value, "utf8").digest("hex"));
}

/** sha256 (hex) de una cadena; usado para MACs y fingerprints. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
