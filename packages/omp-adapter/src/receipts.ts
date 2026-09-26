/**
 * Journal de recibos del adaptador (FR-007). Fuera de worktrees: vive en el
 * **user data dir** indicado por `OmpAdapterOptions.dataDir`, nunca en el
 * checkout ni en `.broker/`. No contiene credenciales, MAC keys ni payloads
 * sensibles más allá de la pregunta en curso necesaria para reanudar.
 *
 * Máquina local de un `ask` entregado por `broker.ask` (paralela a la máquina
 * congelada del broker, `docs/contracts/protocol.md`):
 *
 * ```text
 * (evento)  -> received      journal incoming durable; la llamada nativa NO se ha hecho
 * received  -> submitting    marcador persistido INMEDIATAMENTE antes de llamar a la API nativa
 * submitting-> submitted     llamada nativa hecha; se reporta `submitted` al broker
 * submitted -> completed     SOLO reply explícito de `session_reply` (jamás agent_end/texto)
 * cualquier -> expired|rejected|failed|cancelled|outcome_unknown
 * ```
 *
 * Invariante de reanudación (sin replay ciego):
 * - `received` sin `submitting` = la llamada nativa es **provablemente no
 *   hecha** (el marcador se persiste antes de llamar): se puede reanudar la
 *   entrega una sola vez.
 * - `submitting` = ventana de crash: el resultado es **incierto** =>
 *   `outcome_unknown` y jamás repetición.
 * - `submitted` y posteriores: no se repiten llamadas ni se inventan estados.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolError, RequestId } from "@session-broker/protocol";

export type AskReceiptState =
  | "received"
  | "submitting"
  | "submitted"
  | "replying"
  | "completed"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled"
  | "outcome_unknown";

export interface AskReceipt {
  readonly requestId: RequestId;
  /** `ask` o `notify` (los `control` no llegan: capacidades unsupported). */
  readonly kind: "ask" | "notify";
  /** Instancia que recibió la entrega: respuestas de instancias viejas se deniegan. */
  readonly instanceId: string;
  readonly state: AskReceiptState;
  /** Estado de la herramienta de reply frente a este ask. */
  readonly replyState: "none" | "in_flight" | "done" | "failed";
  /** Pregunta en curso (reanudación de entrega nunca iniciada). */
  readonly question: string | null;
  readonly deadlineAtMs: number | null;
  readonly updatedAtMs: number;
  readonly error?: ProtocolError;
}

interface ReceiptsFile {
  schemaVersion: 1;
  entries: AskReceipt[];
}

const FILE_SCHEMA_VERSION = 1;

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

/** Ruta del journal por stream en `dataDir` (user data, jamás worktrees). */
export function receiptsPathFor(dataDir: string, target: string, nativeSessionId: string): string {
  return join(dataDir, "omp-adapter-receipts", `${sanitize(target)}__${sanitize(nativeSessionId)}.json`);
}

/** Journal durable de recibos con escritura atómica (tmp + rename). */
export class ReceiptsJournal {
  filePath: string;
  readonly #now: () => number;
  readonly #entries = new Map<string, AskReceipt>();

  constructor(input: { filePath: string; now: () => number }) {
    this.filePath = input.filePath;
    this.#now = input.now;
    this.#load();
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupción local: se empieza vacío; jamás se adivina continuidad.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const file = parsed as Partial<ReceiptsFile>;
    if (file.schemaVersion !== FILE_SCHEMA_VERSION || !Array.isArray(file.entries)) return;
    for (const entry of file.entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const receipt = entry as Partial<AskReceipt>;
      if (typeof receipt.requestId !== "string" || typeof receipt.state !== "string") continue;
      this.#entries.set(receipt.requestId, receipt as AskReceipt);
    }
  }

  get(requestId: string): AskReceipt | undefined {
    return this.#entries.get(requestId);
  }

  all(): readonly AskReceipt[] {
    return [...this.#entries.values()];
  }

  /**
   * Cambia el journal al stream indicado (p. ej. tras un cambio de
   * `nativeSessionId`): los recibos del stream anterior dejan de consultarse
   * (no heredan autoridad) y se carga el journal propio del nuevo stream.
   */
  switchTo(filePath: string): void {
    if (filePath === this.filePath) return;
    this.filePath = filePath;
    this.#entries.clear();
    this.#load();
  }

  /** Persiste (o actualiza) un recibo. Nunca contiene secretos. */
  put(update: {
    requestId: RequestId;
    kind: "ask" | "notify";
    instanceId: string;
    state: AskReceiptState;
    replyState?: AskReceipt["replyState"];
    question?: string | null;
    deadlineAtMs?: number | null;
    error?: ProtocolError;
  }): AskReceipt {
    const previous = this.#entries.get(update.requestId);
    const receipt: AskReceipt = {
      requestId: update.requestId,
      kind: update.kind,
      instanceId: update.instanceId,
      state: update.state,
      replyState: update.replyState ?? previous?.replyState ?? "none",
      question: update.question !== undefined ? update.question : (previous?.question ?? null),
      deadlineAtMs: update.deadlineAtMs !== undefined ? update.deadlineAtMs : (previous?.deadlineAtMs ?? null),
      updatedAtMs: this.#now(),
      ...(update.error === undefined ? {} : { error: update.error }),
    };
    this.#entries.set(receipt.requestId, receipt);
    this.#flush();
    return receipt;
  }

  #flush(): void {
    const file: ReceiptsFile = { schemaVersion: FILE_SCHEMA_VERSION, entries: [...this.#entries.values()] };
    const dir = join(this.filePath, "..");
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}
