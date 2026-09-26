/**
 * Salida estable de la CLI (P-003 / G-001).
 *
 * - Texto por defecto (estable, orden fijo) y `--json` (un objeto por
 *   resultado; JSON Lines para eventos de `subscribe`).
 * - Errores en texto van a stderr; en `--json` van a stdout como objeto.
 * - TODA salida pasa por la redacción de secretos: jamás credenciales,
 *   userinfo de endpoints ni valores sensibles en stdout/stderr.
 */

import { EXIT_CODES } from "@session-broker/protocol";
import type { CliError } from "./errors";

export class Output {
  private readonly jsonMode: boolean;
  private readonly secrets: string[];

  constructor(jsonMode: boolean, secrets: string[]) {
    this.jsonMode = jsonMode;
    this.secrets = secrets;
  }

  /** Texto crudo (uso exclusivo de ayuda/versión); pasa por redacción. */
  raw(text: string): void {
    process.stdout.write(this.redact(text));
  }

  /** Resultado exitoso; devuelve el exit code indicado (0 salvo estados terminales visibles). */
  success(command: string, fields: Record<string, unknown>, exitCode: number = EXIT_CODES.OK): number {
    if (this.jsonMode) {
      process.stdout.write(this.redact(`${JSON.stringify({ ok: true, command, ...fields })}\n`));
      return exitCode;
    }
    const lines: string[] = [`ok ${command}`];
    for (const [key, value] of Object.entries(fields)) {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
    process.stdout.write(this.redact(`${lines.join("\n")}\n`));
    return exitCode;
  }

  /** Línea de evento para suscripciones (JSON Lines en `--json`). */
  eventLine(command: string, event: unknown): void {
    if (this.jsonMode) {
      process.stdout.write(this.redact(`${JSON.stringify({ ok: true, command, event })}\n`));
      return;
    }
    process.stdout.write(this.redact(`event ${command}: ${formatScalar(event)}\n`));
  }

  /** Resultado erróneo; SIEMPRE termina con el exit code de la tabla única. */
  failure(command: string, error: CliError): number {
    if (this.jsonMode) {
      const payload: Record<string, unknown> = {
        ok: false,
        command,
        error: { code: error.code, message: error.message },
      };
      const detail = payload.error as Record<string, unknown>;
      if (error.reason !== undefined) detail.reason = error.reason;
      if (error.requestId !== undefined) detail.requestId = error.requestId;
      if (error.state !== undefined) detail.state = error.state;
      if (error.hint !== undefined) detail.hint = error.hint;
      process.stdout.write(this.redact(`${JSON.stringify(payload)}\n`));
      return error.exitCode;
    }
    const lines: string[] = [`error ${error.code}: ${error.message}`];
    if (error.reason !== undefined) lines.push(`reason: ${error.reason}`);
    if (error.requestId !== undefined) lines.push(`requestId: ${error.requestId}`);
    if (error.state !== undefined) lines.push(`state: ${error.state}`);
    if (error.hint !== undefined) lines.push(`hint: ${error.hint}`);
    process.stderr.write(this.redact(`${lines.join("\n")}\n`));
    return error.exitCode;
  }

  /** Redacción de secretos conocidos y de userinfo en URLs; nunca se filtran valores sensibles. */
  redact(text: string): string {
    let out = text.replace(/:\/\/[^/@\s]+@/g, "://[redacted]@");
    for (const secret of this.secrets) {
      if (secret.length === 0) continue;
      out = out.split(secret).join("[redacted]");
    }
    return out;
  }
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
