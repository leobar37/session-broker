/**
 * Deduplicación durable scoped por proyecto + `requestId` (FR-007).
 *
 * - mismo `requestId` + mismo hash -> replay idempotente: se recuperan la
 *   operación y los recibos ya registrados, SIN nuevos efectos;
 * - mismo `requestId` + hash distinto -> `PAYLOAD_CONFLICT` SIN efectos;
 * - hash canónico sobre {operación, target, payload}.
 *
 * `outcome_unknown` conserva su incertidumbre: el replay devuelve el registro
 * tal cual (sin re-despachar) y solo la reconciliación explícita lo resuelve.
 */

import { err, ok, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import { isRequestId, type RequestId, type EventSeq } from "./ids";
import { computePayloadHash } from "./canonical";
import { applyRequestEvent, type RequestState } from "./states";
import type { Operation } from "./operations";
import { LIMITS } from "./limits";

export interface RequestReceipt {
  readonly state: RequestState;
  readonly atMs: number;
  readonly eventId: string;
  readonly eventSeq: EventSeq;
  readonly detail?: string;
}

export interface RequestRecord {
  readonly projectId: string;
  readonly requestId: RequestId;
  readonly operation: Operation;
  readonly target: unknown;
  readonly payloadHash: string;
  readonly state: RequestState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly receipts: readonly RequestReceipt[];
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly reason: string; readonly message: string };
}

export interface DedupInput {
  readonly projectId: string;
  readonly requestId: RequestId;
  readonly operation: Operation;
  readonly target: unknown;
  readonly payload: unknown;
  readonly nowMs: number;
}

export type DedupDecision =
  | { readonly kind: "new"; readonly record: RequestRecord }
  | { readonly kind: "idempotent_replay"; readonly record: RequestRecord }
  | { readonly kind: "conflict"; readonly error: ProtocolError };

export function computeRequestPayloadHash(input: {
  operation: Operation;
  target: unknown;
  payload: unknown;
}): Result<string, ProtocolError> {
  return computePayloadHash(input);
}

/**
 * Decisión de dedup. La creación de un registro NUEVO solo ocurre cuando no
 * existe previo; el paso a `queued` (`commit`) es responsabilidad del broker
 * tras su commit durable — aquí se modela como evento explícito.
 */
export function evaluateDedup(
  existing: RequestRecord | undefined,
  input: DedupInput,
): Result<DedupDecision, ProtocolError> {
  if (!isRequestId(input.requestId)) {
    return err(protocolError("INVALID_INPUT", "invalid_format", "requestId inválido", "requestId"));
  }
  const hash = computeRequestPayloadHash(input);
  if (!hash.ok) return hash;
  if (existing === undefined) {
    const queued = applyRequestEvent("new", "commit", { operation: input.operation });
    if (!queued.ok) return queued;
    return ok({
      kind: "new",
      record: {
        projectId: input.projectId,
        requestId: input.requestId,
        operation: input.operation,
        target: input.target,
        payloadHash: hash.value,
        state: queued.value,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
        receipts: [
          { state: "queued", atMs: input.nowMs, eventId: "", eventSeq: 1, detail: "durable commit" },
        ],
      },
    });
  }
  if (existing.projectId !== input.projectId) {
    return err(
      protocolError("UNAUTHORIZED", "unauthorized_scope", "requestId pertenece a otro proyecto", "requestId"),
    );
  }
  if (existing.payloadHash !== hash.value) {
    return err(
      protocolError(
        "PAYLOAD_CONFLICT",
        "payload_conflict",
        "mismo requestId con hash de payload/target/operación distinto; sin efectos",
        "requestId",
      ),
    );
  }
  return ok({ kind: "idempotent_replay", record: existing });
}

/**
 * ¿Puede re-ejecutarse una operación desde este estado? NUNCA de forma
 * automática: `outcome_unknown` exige reconciliación explícita y cualquier
 * re-entrega con igual hash es solo replay idempotente (recuperación de
 * recibos), no una nueva ejecución.
 */
export function allowsAutomaticReExecution(state: RequestState): boolean {
  return state === "queued" || state === "received" || state === "submitted";
}

/**
 * Ventana de retención: un registro/cursor fuera de retención obliga a
 * snapshot explícito (`CURSOR_EXPIRED`), nunca a inventar continuidad.
 */
export function isRetentionExpired(createdAtMs: number, nowMs: number, retentionMs: number = LIMITS.eventRetentionMs): boolean {
  return nowMs - createdAtMs > retentionMs;
}
