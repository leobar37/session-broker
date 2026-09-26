/**
 * Cursores opacos de paginación (FR-005 / FR-009).
 *
 * Un cursor codifica el ámbito que lo emitió (clase de listado + clave de
 * stream) y su instante de emisión. Cualquier cursor que no pertenezca al
 * ámbito consultado o cuya TTL (`LIMITS.cursorTtlMs`) haya vencido se resuelve
 * con `CURSOR_EXPIRED` y obliga a un snapshot explícito: nunca se inventa
 * continuidad ni se "arregla" un cursor ajeno.
 */

import { LIMITS } from "@session-broker/protocol";

export interface Cursor {
  readonly kind: "history" | "list" | "query";
  /** Clave del stream/ámbito al que pertenece el cursor. */
  readonly key: string;
  /** Posición: `eventSeq` en historial, offset en listados/búsquedas. */
  readonly pos: number;
  readonly issuedAtMs: number;
}

const CURSOR_PREFIX = "cur_";

/** Codifica un cursor opaco (<= maxIdChars). */
export function encodeCursor(cursor: Cursor): string {
  const payload = `${cursor.kind}|${cursor.key}|${cursor.pos}|${cursor.issuedAtMs}`;
  return CURSOR_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decodifica un cursor. Devuelve `undefined` si el texto no es un cursor de
 * este broker; la vigencia se comprueba aparte (`isCursorExpired`).
 */
export function decodeCursor(raw: string): Cursor | undefined {
  if (typeof raw !== "string" || !raw.startsWith(CURSOR_PREFIX)) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  // El key de ámbito puede contener "|": se codifican pos/issued al final.
  const parts = decoded.split("|");
  if (parts.length < 4) return undefined;
  const kind: string = parts[0] ?? "";
  const key = parts.slice(1, parts.length - 2).join("|");
  const pos = Number(parts[parts.length - 2]);
  const issuedAtMs = Number(parts[parts.length - 1]);
  if (kind !== "history" && kind !== "list" && kind !== "query") return undefined;
  if (key.length === 0 || key.length > LIMITS.maxIdChars * 4) return undefined;
  if (!Number.isSafeInteger(pos) || pos < 0) return undefined;
  if (!Number.isFinite(issuedAtMs) || issuedAtMs < 0) return undefined;
  return { kind, key, pos, issuedAtMs };
}

/** TTL del cursor: vencido => el consumidor debe pedir snapshot explícito. */
export function isCursorExpired(cursor: Cursor, nowMs: number): boolean {
  return nowMs - cursor.issuedAtMs > LIMITS.cursorTtlMs;
}
