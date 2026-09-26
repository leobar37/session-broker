/**
 * Errores tipados de `@session-broker/client` (P-003 / G-001).
 *
 * Reglas congeladas:
 *  - Los errores del PROTOCOLO viajan en `ResponseEnvelope.error` (tabla
 *    congelada de `@session-broker/protocol`); `request()` los RESUELVE.
 *  - Solo las condiciones LOCALES rechazan la promesa con
 *    `BrokerClientError`: validación de contrato, conexión, espera agotada,
 *    espera abortada o cliente cerrado.
 *  - `timeout` y `aborted` terminan la ESPERA local y nunca afirman cancelar
 *    trabajo remoto (`endsLocalWaitOnly`); jamás se reportan como el estado
 *    remoto `cancelled` ni como `OUTCOME_UNKNOWN` (ese estado es exclusivo del
 *    broker y exige reconciliación explícita).
 */

import { cliExitCodeForError, EXIT_CODES, type ProtocolError, type RequestId } from "@session-broker/protocol";

export type ClientErrorKind =
  /** Entrada/contrato inválido detectado localmente (tabla congelada en `protocolError`). */
  | "invalid_input"
  /** Error del protocolo/broker recibido fuera de un `ResponseEnvelope` (handshake, frame). */
  | "protocol"
  /** Sin conexión o desconexión. NO implica que el request/job remoto haya fallado. */
  | "connection"
  /** Espera local agotada. NO cancela trabajo remoto. */
  | "timeout"
  /** Espera local abortada (`close()`). NO cancela trabajo remoto. */
  | "aborted"
  /** Operación sobre un cliente ya cerrado. */
  | "closed";

const EXIT_CODE_BY_KIND: Readonly<Record<ClientErrorKind, number>> = {
  invalid_input: EXIT_CODES.INVALID_INPUT,
  protocol: EXIT_CODES.INTERNAL_ERROR,
  connection: EXIT_CODES.TARGET_OFFLINE,
  timeout: EXIT_CODES.EXPIRED,
  aborted: EXIT_CODES.EXPIRED,
  closed: EXIT_CODES.INVALID_INPUT,
};

export class BrokerClientError extends Error {
  readonly kind: ClientErrorKind;
  /** Error tipado de la tabla congelada, cuando existe (validación/protocolo). */
  readonly protocolError?: ProtocolError;
  /** `requestId` conservado ante cualquier fallo local: nunca se pierde ni se regenera. */
  readonly requestId?: RequestId;

  constructor(
    kind: ClientErrorKind,
    message: string,
    options?: { protocolError?: ProtocolError; requestId?: RequestId },
  ) {
    super(message);
    this.name = "BrokerClientError";
    this.kind = kind;
    if (options?.protocolError !== undefined) this.protocolError = options.protocolError;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }

  /** Exit code de la tabla única (`docs/contracts/exit-codes.md`). */
  get exitCode(): number {
    return this.protocolError !== undefined ? cliExitCodeForError(this.protocolError) : EXIT_CODE_BY_KIND[this.kind];
  }

  /** `true` solo cuando terminó la ESPERA local; el trabajo remoto puede seguir en curso. */
  get endsLocalWaitOnly(): boolean {
    return this.kind === "timeout" || this.kind === "aborted";
  }
}

export function isBrokerClientError(value: unknown): value is BrokerClientError {
  return value instanceof BrokerClientError;
}

/** Mensaje de una excepción desconocida sin exponer detalles internos sensibles. */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
