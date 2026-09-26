/**
 * Errores de la CLI (P-003 / G-001).
 *
 * Toda salida de error termina con un exit code numérico de la tabla única
 * (`docs/contracts/exit-codes.md`, `EXIT_CODES`); nunca texto como código.
 * Los errores del protocolo conservan `code`/`reason` congelados; las
 * condiciones locales usan el nombre del exit code como `code` y pueden
 * llevar `hint` accionable.
 */

import {
  EXIT_CODES,
  cliExitCodeForError,
  type ProtocolError,
  type RequestState,
} from "@session-broker/protocol";
import { isBrokerClientError } from "@session-broker/client";

export interface CliErrorInit {
  code: string;
  exitCode: number;
  message: string;
  reason?: string;
  hint?: string;
  requestId?: string;
  state?: string;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly reason: string | undefined;
  readonly hint: string | undefined;
  readonly requestId: string | undefined;
  readonly state: string | undefined;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.code = init.code;
    this.exitCode = init.exitCode;
    this.reason = init.reason;
    this.hint = init.hint;
    this.requestId = init.requestId;
    this.state = init.state;
  }
}

const CODE_NAME_BY_EXIT = new Map<number, string>();
for (const [name, exit] of Object.entries(EXIT_CODES)) {
  CODE_NAME_BY_EXIT.set(exit, name);
}

/** Nombre de código congelado para un exit code conocido (fallback `INTERNAL_ERROR`). */
export function codeNameForExit(exitCode: number): string {
  return CODE_NAME_BY_EXIT.get(exitCode) ?? "INTERNAL_ERROR";
}

export function cliErrorFromProtocol(
  error: ProtocolError,
  extra?: { hint?: string; requestId?: string; state?: string },
): CliError {
  return new CliError({
    code: error.code,
    reason: error.reason,
    message: error.message,
    exitCode: cliExitCodeForError(error),
    hint: extra?.hint,
    requestId: extra?.requestId,
    state: extra?.state,
  });
}

const KIND_CODE_NAME: Readonly<Record<string, string>> = {
  invalid_input: "INVALID_INPUT",
  protocol: "INTERNAL_ERROR",
  connection: "TARGET_OFFLINE",
  timeout: "EXPIRED",
  aborted: "EXPIRED",
  closed: "INVALID_INPUT",
};

/** Traduce cualquier fallo a `CliError` sin perder el `requestId` ni la semántica local/remota. */
export function toCliError(value: unknown): CliError {
  if (value instanceof CliError) return value;
  if (isBrokerClientError(value)) {
    const code = value.protocolError !== undefined ? value.protocolError.code : KIND_CODE_NAME[value.kind] ?? "INTERNAL_ERROR";
    const hint =
      value.endsLocalWaitOnly || value.kind === "connection"
        ? "el trabajo remoto NO se marca fallido ni cancelado: conserva el requestId y consulta su estado antes de reintentar"
        : undefined;
    return new CliError({
      code,
      reason: value.protocolError !== undefined ? value.protocolError.reason : undefined,
      message: value.message,
      exitCode: value.exitCode,
      hint,
      requestId: value.requestId,
    });
  }
  if (value instanceof Error) {
    return new CliError({ code: "INTERNAL_ERROR", exitCode: EXIT_CODES.INTERNAL_ERROR, message: value.message });
  }
  return new CliError({ code: "INTERNAL_ERROR", exitCode: EXIT_CODES.INTERNAL_ERROR, message: String(value) });
}

/** Exit code para un estado terminal sin error de protocolo; jamás se oculta `outcome_unknown`. */
export function exitCodeForState(state: RequestState): number {
  switch (state) {
    case "completed":
    case "queued":
    case "received":
    case "submitted":
      return EXIT_CODES.OK;
    case "rejected":
      return EXIT_CODES.INVALID_INPUT;
    case "expired":
      return EXIT_CODES.EXPIRED;
    case "outcome_unknown":
      return EXIT_CODES.OUTCOME_UNKNOWN;
    case "failed":
    case "cancelled":
      // Sin código propio en la tabla única: se clasifica como no clasificado.
      return EXIT_CODES.INTERNAL_ERROR;
  }
}

export function cliErrorForState(state: RequestState, requestId: string): CliError {
  const exitCode = exitCodeForState(state);
  return new CliError({
    code: codeNameForExit(exitCode),
    exitCode,
    state,
    requestId,
    message: `la solicitud ${requestId} terminó en estado ${state} (visible; no se oculta ningún estado terminal)`,
    reason: state === "outcome_unknown" ? "outcome_unknown_no_replay" : undefined,
    hint:
      state === "outcome_unknown"
        ? "outcome_unknown exige reconciliación explícita; no reenvíes ni reejecutes con un requestId nuevo"
        : undefined,
  });
}
