/**
 * Capacidades del protocolo (FR-008). Core es requisito para la unidad
 * ask/reply/root; las opcionales ausentes o desconocidas devuelven
 * `UNSUPPORTED_CAPABILITY` (falla cerrada, sin fallback).
 */

import { err, ok, isString, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";

export const CAPABILITIES = {
  identity: "session.identity",
  observe: "session.observe",
  promptWhenIdle: "session.prompt.when_idle",
  replyTool: "session.reply_tool",
  notify: "session.notify",
  controlPrompt: "session.control.prompt",
  controlSteer: "session.control.steer",
  controlFollowUp: "session.control.follow_up",
  controlAbort: "session.control.abort",
  rootBinding: "root.binding",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: readonly Capability[] = Object.values(CAPABILITIES);

/** Capacidades core: si falta alguna, se bloquea la unidad afectada (sin stub). */
export const CORE_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.identity,
  CAPABILITIES.observe,
  CAPABILITIES.promptWhenIdle,
  CAPABILITIES.replyTool,
  CAPABILITIES.rootBinding,
];

/** Capacidades opcionales: ausentes => `unsupported`, nunca fallback silencioso. */
export const OPTIONAL_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.notify,
  CAPABILITIES.controlPrompt,
  CAPABILITIES.controlSteer,
  CAPABILITIES.controlFollowUp,
  CAPABILITIES.controlAbort,
];

export function isCapability(value: unknown): value is Capability {
  return isString(value) && (ALL_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Comprueba que la lista pedida por un cliente contiene solo capacidades
 * conocidas. El soporte efectivo se contrasta con `checkOperationSupport`.
 */
export function validateCapabilityList(value: unknown, path: string): Result<Capability[], ProtocolError> {
  if (!Array.isArray(value)) {
    return err(protocolError("INVALID_INPUT", "schema_malformed", "capabilities debe ser una lista", path));
  }
  const out: Capability[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (!isCapability(item)) {
      return err(
        protocolError(
          "UNSUPPORTED_CAPABILITY",
          "unknown_capability",
          `capacidad desconocida: ${String(item)}`,
          `${path}[${i}]`,
        ),
      );
    }
    if (!out.includes(item)) out.push(item);
  }
  return ok(out);
}

/**
 * Traduce soporte declarado por el objetivo a una operación/verbo concreto.
 * Falta de capacidad => `UNSUPPORTED_CAPABILITY` con `missing_capability`.
 */
export function checkOperationSupport(
  operation: string,
  controlVerb: string | undefined,
  supported: readonly Capability[],
): Result<true, ProtocolError> {
  const required = requiredCapabilitiesFor(operation, controlVerb);
  if (required === undefined) {
    return err(
      protocolError("UNSUPPORTED_CAPABILITY", "unsupported_operation", `operación desconocida: ${operation}`, "operation"),
    );
  }
  for (const capability of required) {
    if (!supported.includes(capability)) {
      return err(
        protocolError(
          "UNSUPPORTED_CAPABILITY",
          "missing_capability",
          `capacidad no soportada por el objetivo: ${capability}`,
          "capabilities",
        ),
      );
    }
  }
  return ok(true);
}

export function requiredCapabilitiesFor(operation: string, controlVerb?: string): readonly Capability[] | undefined {
  switch (operation) {
    case "query":
    case "list":
    case "inspect":
    case "history":
    case "subscribe":
      return [CAPABILITIES.observe];
    case "ask":
      return [CAPABILITIES.promptWhenIdle, CAPABILITIES.replyTool];
    case "reply":
      return [CAPABILITIES.replyTool];
    case "notify":
      return [CAPABILITIES.notify];
    case "control":
      switch (controlVerb) {
        case "prompt":
          return [CAPABILITIES.controlPrompt];
        case "steer":
          return [CAPABILITIES.controlSteer];
        case "follow_up":
          return [CAPABILITIES.controlFollowUp];
        case "abort":
          return [CAPABILITIES.controlAbort];
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}
