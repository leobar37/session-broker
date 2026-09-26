/**
 * Tabla única de errores del protocolo (congelada por P-001).
 *
 * `PROTOCOL_ERROR_TABLE` es la única fuente de terminalidad y de mapeo a
 * exit codes numéricos de la CLI. Ningún paquete consumidor define su propia
 * tabla: `cliExitCodeForError` es el mapeo oficial.
 *
 * Los 14 códigos mínimos observables de `requirements.md` están aquí tal cual;
 * `INVALID_INPUT` y `AMBIGUOUS_TARGET` completan la lista del contrato 4 del
 * plan (invalid input / ambiguous target) y se documentan como adicionales.
 */

export const PROTOCOL_ERROR_CODES = [
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "NOT_FOUND_OR_FORBIDDEN",
  "INCOMPATIBLE_VERSION",
  "UNSUPPORTED_CAPABILITY",
  "TARGET_OFFLINE",
  "TARGET_BUSY",
  "STALE_INSTANCE",
  "STALE_CONTROL_EPOCH",
  "PAYLOAD_CONFLICT",
  "EXPIRED",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "CURSOR_EXPIRED",
  "OUTCOME_UNKNOWN",
  "AMBIGUOUS_TARGET",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/**
 * Motivos estables y congelados. Un mismo `code` puede tener varios motivos;
 * `code` + `reason` juntos son la semántica estable de rechazo.
 */
export const PROTOCOL_ERROR_REASONS = [
  "schema_malformed",
  "invalid_field",
  "invalid_format",
  "unsupported_schema_version",
  "unknown_fields",
  "incompatible_version",
  "frame_too_large",
  "payload_too_large",
  "unknown_capability",
  "missing_capability",
  "unsupported_operation",
  "unsupported_control_verb",
  "unauthorized_scope",
  "grant_expired",
  "grant_revoked",
  "grant_not_yet_valid",
  "ids_are_not_credentials",
  "root_claim_not_proven",
  "root_proof_expired",
  "root_proof_not_yet_valid",
  "root_proof_consumed",
  "root_proof_invalid_mac",
  "root_proof_challenge_mismatch",
  "root_proof_audience_mismatch",
  "root_proof_subject_mismatch",
  "root_proof_rebind_required",
  "stale_instance",
  "stale_control_epoch",
  "payload_conflict",
  "deadline_out_of_bounds",
  "quota_exceeded",
  "rate_limited",
  "queue_full",
  "cursor_expired",
  "outcome_unknown_no_replay",
  "ask_requires_explicit_reply",
  "reply_to_mismatch",
  "workspace_identity_mismatch",
  "ambiguous_target",
  "target_offline",
  "target_busy",
  "invalid_transition",
  "terminal_state",
] as const;

export type ProtocolErrorReason = (typeof PROTOCOL_ERROR_REASONS)[number];

export interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly reason: ProtocolErrorReason;
  /** Mensaje humano; nunca contiene secretos ni datos fuera del ámbito del llamador. */
  readonly message: string;
  /** Ruta del campo que falló (p. ej. `payload.question`); sin valores sensibles. */
  readonly path?: string;
}

export interface ProtocolErrorTableEntry {
  /** `true`: la solicitud termina y no puede progresar automáticamente. */
  readonly terminal: boolean;
  /** `true`: el cliente puede reintentar con MISMO `requestId` + MISMO hash tras despejar la causa. */
  readonly retrySafe: boolean;
  /** Exit code numérico de la CLI para este error. */
  readonly exitCode: number;
  readonly description: string;
}

export const PROTOCOL_ERROR_TABLE: Readonly<Record<ProtocolErrorCode, ProtocolErrorTableEntry>> = {
  INVALID_INPUT: {
    terminal: true,
    retrySafe: false,
    exitCode: 2,
    description: "Entrada malformada, esquema inválido o parámetro fuera de límites.",
  },
  UNAUTHORIZED: {
    terminal: true,
    retrySafe: false,
    exitCode: 3,
    description: "Credencial/grant ausente, revocado, expirado o fuera de scope; los IDs nunca autorizan.",
  },
  NOT_FOUND_OR_FORBIDDEN: {
    terminal: true,
    retrySafe: false,
    exitCode: 4,
    description: "Recurso inexistente o sin acceso; no filtra existencia fuera del ámbito.",
  },
  INCOMPATIBLE_VERSION: {
    terminal: true,
    retrySafe: false,
    exitCode: 5,
    description: "Versión de protocolo no negociable (major distinto o minor del cliente mayor que el servidor).",
  },
  UNSUPPORTED_CAPABILITY: {
    terminal: true,
    retrySafe: false,
    exitCode: 6,
    description: "Capacidad desconocida o no soportada por el objetivo; falla cerrada sin fallback.",
  },
  TARGET_OFFLINE: {
    terminal: false,
    retrySafe: true,
    exitCode: 7,
    description: "El objetivo no está conectado; la operación puede reintentarse con backoff.",
  },
  TARGET_BUSY: {
    terminal: false,
    retrySafe: true,
    exitCode: 8,
    description: "El objetivo está ocupado y la política no permite interrumpir; reintentable.",
  },
  STALE_INSTANCE: {
    terminal: true,
    retrySafe: false,
    exitCode: 9,
    description: "La instancia de proceso referida ya no es la vigente (reinicio/otro proceso).",
  },
  STALE_CONTROL_EPOCH: {
    terminal: true,
    retrySafe: false,
    exitCode: 10,
    description: "El control se ejercía con un `controlEpoch` obsoleto tras takeover/revoke.",
  },
  PAYLOAD_CONFLICT: {
    terminal: true,
    retrySafe: false,
    exitCode: 11,
    description: "Mismo `requestId` con hash de payload/target/operación distinto; sin efectos.",
  },
  EXPIRED: {
    terminal: true,
    retrySafe: false,
    exitCode: 12,
    description: "Plazo, TTL o lease vencido; expirar no revierte efectos ya aplicados.",
  },
  RATE_LIMITED: {
    terminal: false,
    retrySafe: true,
    exitCode: 13,
    description: "Cuota de tasa por grant/proyecto superada; reintentable tras backoff.",
  },
  QUEUE_FULL: {
    terminal: false,
    retrySafe: true,
    exitCode: 14,
    description: "Cola/backpressure llena; nunca se descartan comandos durables en silencio.",
  },
  CURSOR_EXPIRED: {
    terminal: true,
    retrySafe: false,
    exitCode: 15,
    description: "Cursor fuera de la ventana de retención; obliga a snapshot explícito.",
  },
  OUTCOME_UNKNOWN: {
    terminal: true,
    retrySafe: false,
    exitCode: 16,
    description:
      "Resultado incierto (ventana de crash entre aplicar y persistir); NUNCA autoriza repetición, exige reconciliación explícita.",
  },
  AMBIGUOUS_TARGET: {
    terminal: true,
    retrySafe: false,
    exitCode: 17,
    description: "El selector resuelve a más de un objetivo/sesión; no se elige en silencio.",
  },
};

/** Exit codes numéricos de la CLI (tabla única; ver docs/contracts/exit-codes.md). */
export const EXIT_CODES = {
  OK: 0,
  INTERNAL_ERROR: 1,
  INVALID_INPUT: 2,
  UNAUTHORIZED: 3,
  NOT_FOUND_OR_FORBIDDEN: 4,
  INCOMPATIBLE_VERSION: 5,
  UNSUPPORTED_CAPABILITY: 6,
  TARGET_OFFLINE: 7,
  TARGET_BUSY: 8,
  STALE_INSTANCE: 9,
  STALE_CONTROL_EPOCH: 10,
  PAYLOAD_CONFLICT: 11,
  EXPIRED: 12,
  RATE_LIMITED: 13,
  QUEUE_FULL: 14,
  CURSOR_EXPIRED: 15,
  OUTCOME_UNKNOWN: 16,
  AMBIGUOUS_TARGET: 17,
} as const;

export function protocolError(
  code: ProtocolErrorCode,
  reason: ProtocolErrorReason,
  message: string,
  path?: string,
): ProtocolError {
  return path === undefined ? { code, reason, message } : { code, reason, message, path };
}

export function cliExitCodeForError(error: ProtocolError): number {
  return PROTOCOL_ERROR_TABLE[error.code].exitCode;
}

export function exitCodeForErrorCode(code: ProtocolErrorCode): number {
  return PROTOCOL_ERROR_TABLE[code].exitCode;
}
