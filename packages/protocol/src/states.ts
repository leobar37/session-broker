/**
 * Estados únicos de una solicitud (FR-007) y su máquina de transiciones.
 *
 * Estados congelados (sin competidores tipo `accepted`/`delivered`):
 *   queued            -> commit durable del broker
 *   received          -> journal incoming durable del cliente/adaptador
 *   submitted         -> entregado a la API OMP
 *   completed         -> resultado definido por operación; en `ask` SOLO reply explícito
 *   rejected          -> rechazado antes de efectos (validación/auth/capacidad)
 *   failed            -> ejecución fallida con resultado definido (error)
 *   expired           -> plazo/TTL vencido (no revierte efectos aplicados)
 *   cancelled         -> cancelación solicitada y reconocida (no es rollback)
 *   outcome_unknown   -> ventana de crash entre aplicar y persistir; exige
 *                        reconciliación explícita y NUNCA autoriza repetición
 */

import { err, ok, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import { isRequestId, type RequestId } from "./ids";
import type { Operation } from "./operations";

export const REQUEST_STATES = [
  "queued",
  "received",
  "submitted",
  "completed",
  "rejected",
  "failed",
  "expired",
  "cancelled",
  "outcome_unknown",
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

export const TERMINAL_STATES: readonly RequestState[] = [
  "completed",
  "rejected",
  "failed",
  "expired",
  "cancelled",
  "outcome_unknown",
];

export const REQUEST_EVENTS = [
  "commit",
  "receive",
  "submit",
  "complete",
  "reply",
  "reject",
  "fail",
  "expire",
  "cancel",
  "crash_window",
  "reconcile_completed",
  "reconcile_failed",
] as const;

export type RequestEventType = (typeof REQUEST_EVENTS)[number];

const TRANSITIONS: Readonly<Record<RequestState | "new", Partial<Record<RequestEventType, RequestState>>>> = {
  new: { commit: "queued" },
  queued: {
    receive: "received",
    reject: "rejected",
    fail: "failed",
    expire: "expired",
    cancel: "cancelled",
    crash_window: "outcome_unknown",
  },
  received: {
    submit: "submitted",
    reject: "rejected",
    fail: "failed",
    expire: "expired",
    cancel: "cancelled",
    crash_window: "outcome_unknown",
  },
  submitted: {
    complete: "completed",
    reply: "completed",
    fail: "failed",
    expire: "expired",
    cancel: "cancelled",
    crash_window: "outcome_unknown",
  },
  completed: {},
  rejected: {},
  failed: {},
  expired: {},
  cancelled: {},
  outcome_unknown: {
    reconcile_completed: "completed",
    reconcile_failed: "failed",
  },
};

export function isTerminalState(state: RequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Aplica un evento a la máquina de estados.
 *
 * Reglas congeladas:
 *  - `ask` solo alcanza `completed` mediante `reply` explícito con
 *    `replyTo = requestId` autorizado; el evento `complete` genérico se
 *    rechaza (`ask_requires_explicit_reply`). Ni `agent_end` ni el siguiente
 *    texto del modelo existen como eventos de este protocolo: `classifyAskCompletion`
 *    los ignora explícitamente.
 *  - `outcome_unknown` no admite `submit`/`complete`/`reply`: solo
 *    reconciliación explícita (`reconcile_completed`/`reconcile_failed`).
 */
export function applyRequestEvent(
  state: RequestState | "new",
  event: RequestEventType,
  options: { operation: Operation },
): Result<RequestState, ProtocolError> {
  if (event === "complete" && options.operation === "ask") {
    return err(
      protocolError(
        "INVALID_INPUT",
        "ask_requires_explicit_reply",
        "un ask solo puede completarse mediante reply explícito con replyTo=requestId",
        "event",
      ),
    );
  }
  if (event === "reply" && options.operation !== "ask") {
    return err(
      protocolError("INVALID_INPUT", "invalid_transition", "reply solo aplica a operaciones ask", "event"),
    );
  }
  if (state === "outcome_unknown" && event !== "reconcile_completed" && event !== "reconcile_failed") {
    return err(
      protocolError(
        "INVALID_INPUT",
        "outcome_unknown_no_replay",
        "outcome_unknown no autoriza repetición ni progreso automático; exige reconciliación explícita",
        "state",
      ),
    );
  }
  const table = TRANSITIONS[state];
  const next = table[event];
  if (next === undefined) {
    if (isTerminalState(state as RequestState)) {
      return err(
        protocolError("INVALID_INPUT", "terminal_state", `estado terminal ${state} no acepta el evento ${event}`, "state"),
      );
    }
    return err(
      protocolError("INVALID_INPUT", "invalid_transition", `transición inválida ${state} + ${event}`, "state"),
    );
  }
  return ok(next);
}

/**
 * Señales nativas observadas en un runtime (p. ej. OMP) frente a un `ask`.
 * Solo la herramienta explícita de reply completa la solicitud.
 */
export type NativeAskSignal =
  | { readonly kind: "agent_end" }
  | { readonly kind: "next_text" }
  | {
      readonly kind: "reply_tool";
      readonly requestId: RequestId;
      readonly replyTo: RequestId;
      readonly authorized: boolean;
    };

/**
 * Clasifica una señal nativa frente a un `ask`:
 *  - `agent_end` / `next_text`  -> `null` (NUNCA completan ni progresan el ask)
 *  - `reply_tool` con `replyTo` coincidente y autorizado -> evento `reply`
 *  - `reply_tool` con `replyTo` distinto -> `reply_to_mismatch`
 *  - `reply_tool` no autorizado -> `UNAUTHORIZED`
 */
export function classifyAskCompletion(
  signal: NativeAskSignal,
  askRequestId: RequestId,
): Result<RequestEventType | null, ProtocolError> {
  if (signal.kind === "agent_end" || signal.kind === "next_text") {
    return ok(null);
  }
  if (!isRequestId(signal.replyTo) || signal.replyTo !== askRequestId || signal.requestId === askRequestId) {
    return err(
      protocolError(
        "INVALID_INPUT",
        "reply_to_mismatch",
        "replyTo debe referenciar exactamente el requestId del ask",
        "payload.replyTo",
      ),
    );
  }
  if (!signal.authorized) {
    return err(protocolError("UNAUTHORIZED", "unauthorized_scope", "reply no autorizado para este ámbito", "grant"));
  }
  return ok("reply");
}
