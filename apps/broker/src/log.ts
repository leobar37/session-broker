/**
 * Logs estructurados y REDACTADOS del broker (FR-010 / NFR-001).
 *
 * Cada línea es un objeto JSON compacto (`ts`, `level`, `event`, campos) que
 * puede consumirse con `jq` o journald. La redacción es la política por
 * defecto y no opcional:
 *   - valores de claves sensibles (`credential`, `token`, `macKey`, `proof`,
 *     `challenge`, `payload`, `body`, `question`, `result`, …) → `"[REDACTED]"`;
 *   - strings que coincidan con un secreto conocido (credencial, MAC key) →
 *     `"[REDACTED]"` en cualquier profundidad;
 *   - IDs se registran scoped (proyecto/sesión/connection) y nunca se
 *     combinan con contenidos privados ni historial.
 *
 * Sin sink no hay ruido: el sink por defecto escribe por nivel `warn`/`error`
 * en stderr; un sink explícito (p. ej. journald o un archivo) recibe todo el
 * nivel configurado. Ninguna operación de logging puede lanzar: un fallo del
 * sink jamás rompe el broker.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** Logger con campos base añadidos (IDs scoped del ámbito actual). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Destino de las líneas JSON; default stderr solo para `warn`/`error`. */
  readonly sink?: (line: string) => void;
  readonly minLevel?: LogLevel;
  /** Secretos conocidos cuyo valor jamás debe aparecer (credencial, MAC key). */
  readonly secrets?: () => readonly string[];
  readonly now?: () => number;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Claves cuyo VALOR jamás se registra (secretos y contenidos sensibles). */
const REDACTED_KEY_PATTERN =
  /(credential|secret|token|password|passwd|mac[-_]?key|authorization|proof|challenge)/i;

/** Claves exactas de contenidos (payloads/resultados de operaciones, historial). */
const REDACTED_EXACT_KEYS: Record<string, true> = {
  data: true,
  result: true,
  text: true,
  content: true,
  history: true,
  transcript: true,
  question: true,
  body: true,
  answer: true,
  summary: true,
  payload: true,
};

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 3;
const MAX_ARRAY_ITEMS = 8;
const MAX_STRING_CHARS = 256;

/**
 * Redacción recursiva de un valor para logging: claves sensibles, secretos
 * conocidos, profundidad/longitud acotadas. Exportado para poder verificar la
 * política por sí sola (tests de redacción).
 */
export function redactLogValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") {
    let out = value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
    for (const secret of secrets) {
      if (secret.length === 0) continue;
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactLogValue(item, secrets, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] =
        REDACTED_EXACT_KEYS[key] === true || REDACTED_KEY_PATTERN.test(key)
          ? REDACTED
          : redactLogValue(entry, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

class StructuredLogger implements Logger {
  readonly #sink: (line: string) => void;
  readonly #minLevel: LogLevel;
  readonly #secrets: () => readonly string[];
  readonly #now: () => number;
  readonly #bindings: LogFields;

  constructor(options: LoggerOptions, bindings: LogFields) {
    this.#sink =
      options.sink ??
      ((line: string) => {
        process.stderr.write(`${line}\n`);
      });
    this.#minLevel = options.minLevel ?? "warn";
    this.#secrets = options.secrets ?? (() => []);
    this.#now = options.now ?? Date.now;
    this.#bindings = bindings;
  }

  log(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;
    const merged: Record<string, unknown> = { ...this.#bindings, ...(fields ?? {}) };
    const safe = redactLogValue(merged, this.#secrets()) as Record<string, unknown>;
    const line = JSON.stringify({ ts: this.#now(), level, event, ...safe });
    try {
      this.#sink(line);
    } catch {
      // Un sink roto jamás tumba el broker ni fabrica estados.
    }
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(
      {
        sink: this.#sink,
        minLevel: this.#minLevel,
        secrets: this.#secrets,
        now: this.#now,
      },
      { ...this.#bindings, ...bindings },
    );
  }
}

/** Logger estructurado con redacción por defecto (ver docblock del módulo). */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options, {});
}
