/**
 * Operaciones congeladas del protocolo y sus payloads (FR-006).
 *
 * `query`/`list`/`inspect`/`history`/`subscribe` son lecturas sin inferencia;
 * `ask` encola una pregunta broker como prompt nativo seguro `when_idle`;
 * `reply` es la respuesta estructurada explícita (`replyTo = requestId`);
 * `notify` no promete respuesta ni activa inferencia; `control` solo ofrece
 * los verbos verificados (`prompt`/`steer`/`follow_up`/`abort`).
 */

import { err, ok, isString, isPlainObject, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import { isRequestId, isValidEventSeq, type RequestId, type EventSeq } from "./ids";
import { LIMITS } from "./limits";

export const OPERATIONS = ["query", "list", "inspect", "history", "subscribe", "ask", "reply", "notify", "control"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const CONTROL_VERBS = ["prompt", "steer", "follow_up", "abort"] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

export function isOperation(value: unknown): value is Operation {
  return isString(value) && (OPERATIONS as readonly string[]).includes(value);
}

export function isControlVerb(value: unknown): value is ControlVerb {
  return isString(value) && (CONTROL_VERBS as readonly string[]).includes(value);
}

export type OperationCategory = "read" | "send" | "control";

export function operationCategory(operation: Operation): OperationCategory {
  switch (operation) {
    case "query":
    case "list":
    case "inspect":
    case "history":
    case "subscribe":
      return "read";
    case "ask":
    case "reply":
    case "notify":
      return "send";
    case "control":
      return "control";
  }
}

export interface QueryPayload {
  readonly query: string;
  readonly limit?: number;
}

export interface ListPayload {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InspectPayload {
  readonly fields?: readonly string[];
}

export interface HistoryPayload {
  readonly fromEventSeq?: EventSeq;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SubscribePayload {
  readonly topics: readonly string[];
  readonly fromEventSeq?: EventSeq;
}

export interface AskPayload {
  readonly question: string;
  readonly deadlineMs: number;
  readonly maxTurns?: number;
  readonly depth?: number;
  /** Política de entrega congelada: `when_idle` (nunca interrumpe tarea ocupada por defecto). */
  readonly policy: "when_idle";
}

export interface ReplyPayload {
  /** Siempre el `requestId` del `ask` que se responde. */
  readonly replyTo: RequestId;
  readonly body: unknown;
  readonly summary?: string;
}

export interface NotifyPayload {
  readonly topic: string;
  readonly data: unknown;
}

export interface ControlPayload {
  readonly verb: ControlVerb;
  readonly instruction?: string;
}

export type OperationPayload =
  | QueryPayload
  | ListPayload
  | InspectPayload
  | HistoryPayload
  | SubscribePayload
  | AskPayload
  | ReplyPayload
  | NotifyPayload
  | ControlPayload;

function readOptionalLimit(payload: Record<string, unknown>, path: string): Result<number | undefined, ProtocolError> {
  if (payload.limit === undefined) return ok(undefined);
  const limit: unknown = payload.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.maxHistoryPageItems) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "invalid_field",
        `limit debe ser entero 1..${LIMITS.maxHistoryPageItems}`,
        `${path}.limit`,
      ),
    );
  }
  return ok(limit);
}

function readOptionalCursor(payload: Record<string, unknown>, path: string): Result<string | undefined, ProtocolError> {
  if (payload.cursor === undefined) return ok(undefined);
  const cursor: unknown = payload.cursor;
  if (!isString(cursor) || cursor.length === 0 || cursor.length > LIMITS.maxIdChars) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "cursor inválido", `${path}.cursor`));
  }
  return ok(cursor);
}

function readOptionalEventSeq(payload: Record<string, unknown>, field: string, path: string): Result<number | undefined, ProtocolError> {
  const raw: unknown = payload[field];
  if (raw === undefined) return ok(undefined);
  if (!isValidEventSeq(raw)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", `${field} inválido`, `${path}.${field}`));
  }
  return ok(raw as number);
}

/**
 * Validación manual de payloads por operación. Rechaza campos desconocidos y
 * valores fuera de límites con `code`/`reason` estables.
 */
export function validateOperationPayload(operation: Operation, value: unknown): Result<OperationPayload, ProtocolError> {
  const path = "payload";
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "payload debe ser un objeto", path));
  }
  const payload = value;
  switch (operation) {
    case "query": {
      const keys = checkKeys(payload, ["query", "limit"], path);
      if (!keys.ok) return keys;
      if (!isString(payload.query) || payload.query.length === 0 || payload.query.length > LIMITS.maxPayloadBytes) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "query inválido", `${path}.query`));
      }
      const limit = readOptionalLimit(payload, path);
      if (!limit.ok) return limit;
      return ok({ query: payload.query as string, limit: limit.value });
    }
    case "list": {
      const keys = checkKeys(payload, ["limit", "cursor"], path);
      if (!keys.ok) return keys;
      const limit = readOptionalLimit(payload, path);
      if (!limit.ok) return limit;
      const cursor = readOptionalCursor(payload, path);
      if (!cursor.ok) return cursor;
      return ok({ limit: limit.value, cursor: cursor.value });
    }
    case "inspect": {
      const keys = checkKeys(payload, ["fields"], path);
      if (!keys.ok) return keys;
      if (payload.fields === undefined) return ok({});
      if (!Array.isArray(payload.fields) || payload.fields.length > LIMITS.maxHistoryPageItems) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "fields inválido", `${path}.fields`));
      }
      const fields: string[] = [];
      for (let i = 0; i < payload.fields.length; i++) {
        const field: unknown = payload.fields[i];
        if (!isString(field) || field.length === 0 || field.length > LIMITS.maxAliasChars) {
          return err(protocolError("INVALID_INPUT", "invalid_field", "field inválido", `${path}.fields[${i}]`));
        }
        fields.push(field);
      }
      return ok({ fields });
    }
    case "history": {
      const keys = checkKeys(payload, ["fromEventSeq", "limit", "cursor"], path);
      if (!keys.ok) return keys;
      const from = readOptionalEventSeq(payload, "fromEventSeq", path);
      if (!from.ok) return from;
      const limit = readOptionalLimit(payload, path);
      if (!limit.ok) return limit;
      const cursor = readOptionalCursor(payload, path);
      if (!cursor.ok) return cursor;
      return ok({ fromEventSeq: from.value, limit: limit.value, cursor: cursor.value });
    }
    case "subscribe": {
      const keys = checkKeys(payload, ["topics", "fromEventSeq"], path);
      if (!keys.ok) return keys;
      if (!Array.isArray(payload.topics) || payload.topics.length === 0) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "topics debe ser una lista no vacía", `${path}.topics`));
      }
      const topics: string[] = [];
      for (let i = 0; i < payload.topics.length; i++) {
        const topic: unknown = payload.topics[i];
        if (!isString(topic) || topic.length === 0 || topic.length > LIMITS.maxAliasChars) {
          return err(protocolError("INVALID_INPUT", "invalid_field", "topic inválido", `${path}.topics[${i}]`));
        }
        topics.push(topic);
      }
      const from = readOptionalEventSeq(payload, "fromEventSeq", path);
      if (!from.ok) return from;
      return ok({ topics, fromEventSeq: from.value });
    }
    case "ask": {
      const keys = checkKeys(payload, ["question", "deadlineMs", "maxTurns", "depth", "policy"], path);
      if (!keys.ok) return keys;
      if (!isString(payload.question) || payload.question.length === 0 || payload.question.length > LIMITS.maxPayloadBytes) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "question inválido", `${path}.question`));
      }
      const deadlineMs: unknown = payload.deadlineMs;
      if (
        !isFiniteNumber(deadlineMs) ||
        (deadlineMs as number) <= 0 ||
        (deadlineMs as number) > LIMITS.askDeadlineMsMax
      ) {
        return err(
          protocolError(
            "INVALID_INPUT",
            "deadline_out_of_bounds",
            `deadlineMs debe estar en 1..${LIMITS.askDeadlineMsMax}`,
            `${path}.deadlineMs`,
          ),
        );
      }
      if (payload.policy !== "when_idle") {
        return err(
          protocolError("INVALID_INPUT", "invalid_field", 'policy debe ser "when_idle"', `${path}.policy`),
        );
      }
      const maxTurns = readOptionalCount(payload, "maxTurns", 1, 32, path);
      if (!maxTurns.ok) return maxTurns;
      const depth = readOptionalCount(payload, "depth", 0, 8, path);
      if (!depth.ok) return depth;
      return ok({
        question: payload.question as string,
        deadlineMs: deadlineMs as number,
        maxTurns: maxTurns.value,
        depth: depth.value,
        policy: "when_idle",
      });
    }
    case "reply": {
      const keys = checkKeys(payload, ["replyTo", "body", "summary"], path);
      if (!keys.ok) return keys;
      if (!isRequestId(payload.replyTo)) {
        return err(protocolError("INVALID_INPUT", "invalid_format", "replyTo debe ser un requestId válido", `${path}.replyTo`));
      }
      if (payload.body === undefined) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "body es obligatorio", `${path}.body`));
      }
      if (payload.summary !== undefined && (!isString(payload.summary) || payload.summary.length > LIMITS.maxAliasChars)) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "summary inválido", `${path}.summary`));
      }
      return ok({
        replyTo: payload.replyTo as RequestId,
        body: payload.body,
        summary: payload.summary as string | undefined,
      });
    }
    case "notify": {
      const keys = checkKeys(payload, ["topic", "data"], path);
      if (!keys.ok) return keys;
      if (!isString(payload.topic) || payload.topic.length === 0 || payload.topic.length > LIMITS.maxAliasChars) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "topic inválido", `${path}.topic`));
      }
      return ok({ topic: payload.topic as string, data: payload.data });
    }
    case "control": {
      const keys = checkKeys(payload, ["verb", "instruction"], path);
      if (!keys.ok) return keys;
      if (!isControlVerb(payload.verb)) {
        return err(
          protocolError(
            "UNSUPPORTED_CAPABILITY",
            "unsupported_control_verb",
            `verbo de control no soportado: ${String(payload.verb)}`,
            `${path}.verb`,
          ),
        );
      }
      if (payload.instruction !== undefined && (!isString(payload.instruction) || payload.instruction.length > LIMITS.maxPayloadBytes)) {
        return err(protocolError("INVALID_INPUT", "invalid_field", "instruction inválido", `${path}.instruction`));
      }
      return ok({ verb: payload.verb, instruction: payload.instruction as string | undefined });
    }
  }
}

function checkKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Result<true, ProtocolError> {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return err(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, path));
  }
  return ok(true);
}

function readOptionalCount(
  payload: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  path: string,
): Result<number | undefined, ProtocolError> {
  const raw: unknown = payload[field];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    return err(
      protocolError("INVALID_INPUT", "invalid_field", `${field} debe ser entero ${min}..${max}`, `${path}.${field}`),
    );
  }
  return ok(raw);
}

export function isReplyPayload(payload: OperationPayload): payload is ReplyPayload {
  return "replyTo" in payload;
}
