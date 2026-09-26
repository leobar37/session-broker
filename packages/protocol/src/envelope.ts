/**
 * Envelopes del protocolo (FR-006 / NFR-004).
 *
 * Todo mensaje es JSON con `kind` discriminante y `v` = major del protocolo.
 * Los validadores son manuales (sin zod) y devuelven rechazos estables
 * (code + reason + path). El tamaño de frame/payload se comprueba aquí con
 * los límites congelados de `limits.ts`.
 */

import { err, ok, isPlainObject, isString, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import {
  isEventId,
  isGrantId,
  isInstanceId,
  isRequestId,
  isValidControlEpoch,
  isValidEventSeq,
  validateSessionRef,
  type ControlEpoch,
  type EventId,
  type EventSeq,
  type GrantId,
  type InstanceId,
  type RequestId,
  type TargetRef,
  isTargetId,
} from "./ids";
import { LIMITS } from "./limits";
import { PROTOCOL_MAJOR } from "./version";
import { canonicalJson } from "./canonical";
import { isOperation, isControlVerb, validateOperationPayload, type Operation } from "./operations";
import { validateCapabilityList, type Capability } from "./capabilities";
import { REQUEST_STATES, type RequestState } from "./states";

export interface RequestEnvelope {
  readonly v: number;
  readonly kind: "request";
  readonly requestId: RequestId;
  readonly operation: Operation;
  readonly target: TargetRef;
  readonly payload: unknown;
  readonly grantId: GrantId;
  readonly sentAtMs: number;
  readonly deadlineMs?: number;
  /** Obligatorio para `control`; compara atómicamente contra el lease vigente. */
  readonly controlEpoch?: ControlEpoch;
  /** Capacidades que el cliente exige del objetivo; desconocida => rechazo estable. */
  readonly requiredCapabilities?: readonly Capability[];
}

export interface ResponseEnvelope {
  readonly v: number;
  readonly kind: "response";
  readonly requestId: RequestId;
  /** En respuestas a `reply`, referencia el `requestId` del `ask`. */
  readonly replyTo?: RequestId;
  readonly state: RequestState;
  readonly eventId: EventId;
  readonly eventSeq: EventSeq;
  readonly atMs: number;
  readonly result?: unknown;
  readonly error?: ProtocolError;
}

export interface EventEnvelope {
  readonly v: number;
  readonly kind: "event";
  readonly eventId: EventId;
  readonly eventSeq: EventSeq;
  readonly topic: string;
  readonly data: unknown;
  readonly atMs: number;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

/** Tamaño en bytes UTF-8 del frame serializado (límite `maxFrameBytes`). */
export function frameByteLength(frameJson: string): number {
  return new TextEncoder().encode(frameJson).length;
}

export function checkFrameSize(frameJson: string): Result<true, ProtocolError> {
  const bytes = frameByteLength(frameJson);
  if (bytes > LIMITS.maxFrameBytes) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "frame_too_large",
        `frame de ${bytes} bytes excede maxFrameBytes=${LIMITS.maxFrameBytes}`,
        "frame",
      ),
    );
  }
  return ok(true);
}

function checkEnvelopeVersion(value: Record<string, unknown>): Result<true, ProtocolError> {
  if (value.v !== PROTOCOL_MAJOR) {
    return err(
      protocolError(
        "INCOMPATIBLE_VERSION",
        "incompatible_version",
        `major de protocolo no soportado: ${String(value.v)} (soportado: ${PROTOCOL_MAJOR})`,
        "v",
      ),
    );
  }
  return ok(true);
}

function checkTargetRef(raw: unknown): Result<TargetRef, ProtocolError> {
  if (!isPlainObject(raw)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "target debe ser un objeto", "target"));
  }
  const unknown = Object.keys(raw).filter((key) => key !== "target" && key !== "session" && key !== "instanceId");
  if (unknown.length > 0) {
    return err(protocolError("INVALID_INPUT", "unknown_fields", `campos desconocidos: ${unknown.join(", ")}`, "target"));
  }
  if (!isTargetId(raw.target)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "target inválido", "target.target"));
  }
  let session: TargetRef["session"];
  if (raw.session !== undefined) {
    const parsed = validateSessionRef(raw.session);
    if (!parsed.ok) return parsed;
    session = parsed.value;
  }
  if (raw.instanceId !== undefined && !isInstanceId(raw.instanceId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "instanceId inválido", "target.instanceId"));
  }
  return ok({
    target: raw.target as string,
    session,
    instanceId: raw.instanceId as InstanceId | undefined,
  });
}

/**
 * Validación completa de una solicitud. `frameJson` (opcional) permite además
 * comprobar el límite de frame completo.
 */
export function validateRequestEnvelope(
  value: unknown,
  options?: { frameJson?: string },
): Result<RequestEnvelope, ProtocolError> {
  if (options?.frameJson !== undefined) {
    const frame = checkFrameSize(options.frameJson);
    if (!frame.ok) return frame;
  }
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "envelope debe ser un objeto", "envelope"));
  }
  const version = checkEnvelopeVersion(value);
  if (!version.ok) return version;
  if (value.kind !== "request") {
    return err(protocolError("INVALID_INPUT", "schema_malformed", 'kind debe ser "request"', "kind"));
  }
  if (!isRequestId(value.requestId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "requestId inválido", "requestId"));
  }
  if (!isOperation(value.operation)) {
    return err(
      protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", `operación desconocida: ${String(value.operation)}`, "operation"),
    );
  }
  const target = checkTargetRef(value.target);
  if (!target.ok) return target;
  if (!isGrantId(value.grantId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "grantId inválido", "grantId"));
  }
  if (!isFiniteNumber(value.sentAtMs) || value.sentAtMs < 0) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "sentAtMs inválido", "sentAtMs"));
  }
  if (value.deadlineMs !== undefined) {
    if (!isFiniteNumber(value.deadlineMs) || value.deadlineMs <= 0 || value.deadlineMs > LIMITS.requestTimeoutMsMax) {
      return err(
        protocolError(
          "INVALID_INPUT",
          "deadline_out_of_bounds",
          `deadlineMs debe estar en 1..${LIMITS.requestTimeoutMsMax}`,
          "deadlineMs",
        ),
      );
    }
  }
  if (value.operation === "control") {
    if (!isValidControlEpoch(value.controlEpoch)) {
      return err(
        protocolError(
          "STALE_CONTROL_EPOCH",
          "stale_control_epoch",
          "control requiere controlEpoch numérico vigente",
          "controlEpoch",
        ),
      );
    }
    const controlPayload = validateOperationPayload("control", value.payload);
    if (!controlPayload.ok) return controlPayload;
    if (!isControlVerb((controlPayload.value as { verb: string }).verb)) {
      return err(
        protocolError("UNSUPPORTED_CAPABILITY", "unsupported_control_verb", "verbo de control inválido", "payload.verb"),
      );
    }
  } else if (value.controlEpoch !== undefined) {
    if (!isValidControlEpoch(value.controlEpoch)) {
      return err(protocolError("INVALID_INPUT", "invalid_field", "controlEpoch inválido", "controlEpoch"));
    }
  }
  const payload = validateOperationPayload(value.operation, value.payload);
  if (!payload.ok) return payload;
  const canonical = canonicalJson(value.payload, "payload");
  if (!canonical.ok) return canonical;
  const payloadBytes = frameByteLength(canonical.value);
  if (payloadBytes > LIMITS.maxPayloadBytes) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "payload_too_large",
        `payload de ${payloadBytes} bytes excede maxPayloadBytes=${LIMITS.maxPayloadBytes}`,
        "payload",
      ),
    );
  }
  let requiredCapabilities: readonly Capability[] | undefined;
  if (value.requiredCapabilities !== undefined) {
    const parsed = validateCapabilityList(value.requiredCapabilities, "requiredCapabilities");
    if (!parsed.ok) return parsed;
    requiredCapabilities = parsed.value;
  }
  if (value.operation === "reply") {
    const replyPayload = payload.value as { replyTo: string };
    const reqId: unknown = value.requestId;
    if (replyPayload.replyTo === reqId) {
      return err(
        protocolError(
          "INVALID_INPUT",
          "reply_to_mismatch",
          "replyTo debe referenciar el requestId del ask, no el de la propia reply",
          "payload.replyTo",
        ),
      );
    }
  }
  return ok({
    v: PROTOCOL_MAJOR,
    kind: "request",
    requestId: value.requestId as RequestId,
    operation: value.operation as Operation,
    target: target.value,
    payload: value.payload,
    grantId: value.grantId as GrantId,
    sentAtMs: value.sentAtMs as number,
    deadlineMs: value.deadlineMs as number | undefined,
    controlEpoch: value.controlEpoch as ControlEpoch | undefined,
    requiredCapabilities,
  });
}

export function validateResponseEnvelope(value: unknown): Result<ResponseEnvelope, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "envelope debe ser un objeto", "envelope"));
  }
  const version = checkEnvelopeVersion(value);
  if (!version.ok) return version;
  if (value.kind !== "response") {
    return err(protocolError("INVALID_INPUT", "schema_malformed", 'kind debe ser "response"', "kind"));
  }
  if (!isRequestId(value.requestId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "requestId inválido", "requestId"));
  }
  if (value.replyTo !== undefined && !isRequestId(value.replyTo)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "replyTo inválido", "replyTo"));
  }
  if (!isEventId(value.eventId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "eventId inválido", "eventId"));
  }
  if (!isValidEventSeq(value.eventSeq)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "eventSeq inválido", "eventSeq"));
  }
  if (!isFiniteNumber(value.atMs)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "atMs inválido", "atMs"));
  }
  const state: unknown = value.state;
  if (!(REQUEST_STATES as readonly unknown[]).includes(state)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", `state desconocido: ${String(state)}`, "state"));
  }
  if (value.error !== undefined) {
    if (!isPlainObject(value.error) || !isString(value.error.code) || !isString(value.error.reason) || !isString(value.error.message)) {
      return err(protocolError("INVALID_INPUT", "schema_malformed", "error inválido", "error"));
    }
  }
  return ok({
    v: PROTOCOL_MAJOR,
    kind: "response",
    requestId: value.requestId as RequestId,
    replyTo: value.replyTo as RequestId | undefined,
    state: state as RequestState,
    eventId: value.eventId as EventId,
    eventSeq: value.eventSeq as EventSeq,
    atMs: value.atMs as number,
    result: value.result,
    error: value.error as ProtocolError | undefined,
  });
}

export function validateEventEnvelope(value: unknown): Result<EventEnvelope, ProtocolError> {
  if (!isPlainObject(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "envelope debe ser un objeto", "envelope"));
  }
  const version = checkEnvelopeVersion(value);
  if (!version.ok) return version;
  if (value.kind !== "event") {
    return err(protocolError("INVALID_INPUT", "schema_malformed", 'kind debe ser "event"', "kind"));
  }
  if (!isEventId(value.eventId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "eventId inválido", "eventId"));
  }
  if (!isValidEventSeq(value.eventSeq)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "eventSeq inválido", "eventSeq"));
  }
  if (!isString(value.topic) || value.topic.length === 0 || value.topic.length > LIMITS.maxAliasChars) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "topic inválido", "topic"));
  }
  if (!isFiniteNumber(value.atMs)) {
    return err(protocolError("INVALID_INPUT", "invalid_field", "atMs inválido", "atMs"));
  }
  return ok({
    v: PROTOCOL_MAJOR,
    kind: "event",
    eventId: value.eventId as EventId,
    eventSeq: value.eventSeq as EventSeq,
    topic: value.topic as string,
    data: value.data,
    atMs: value.atMs as number,
  });
}

/** Snapshot autorizado y acotado de historial (FR-005); sin inferencia. */
export interface HistorySnapshot {
  readonly sessionRef: TargetRef["session"];
  readonly observedAtMs: number;
  /** "available" | "unavailable": nunca se inventa historial inexistente. */
  readonly availability: "available" | "unavailable";
  readonly ageMs: number;
  readonly items: readonly unknown[];
  readonly nextCursor?: string;
  readonly fromEventSeq?: EventSeq;
}
