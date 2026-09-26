/**
 * Store SQLite del broker (FR-007 / NFR-002). Privado: solo lo consume
 * `server.ts`; el contrato público del paquete es el de `docs/contracts`.
 *
 * Fronteras transaccionales (durability.md):
 *   - `queued` solo se confirma tras COMMIT durable (una sola transacción
 *     cubre request + hash + recibo + journal);
 *   - cada transición deja recibo y evento de journal coherentes;
 *   - `outcome_unknown` se conserva (solo reconciliación explícita) y jamás
 *     se elimina en la retención.
 *
 * Escritor único: la fila `store_lock` registra el proceso propietario con
 * heartbeat propio; un segundo proceso/instancia incompatible se RECHAZA.
 * Solo se reclama un lock huérfano (pid muerto o heartbeat vencido), nunca por
 * heartbeat ausente de un proceso vivo.
 */

import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyRequestEvent,
  evaluateDedup,
  newEventId,
  protocolError,
  type Capability,
  type ControlLease,
  type EventSeq,
  type ProtocolError,
  type RequestEventType,
  type RequestReceipt,
  type RequestRecord,
  type RequestState,
  type Result,
  renewControlLease,
} from "@session-broker/protocol";
import { GrantsRegistry } from "./grants";

export const STORE_SCHEMA_VERSION = 1;
export const DB_FILE_NAME = "broker.sqlite";
/** Lease del escritor único; el heartbeat real (no el reloj inyectable) lo renueva. */
export const STORE_LOCK_LEASE_MS = 30_000;
export const STORE_LOCK_HEARTBEAT_MS = 10_000;

export interface SessionKey {
  readonly projectId: string;
  readonly target: string;
  readonly nativeSessionId: string;
}

export interface SessionRow {
  readonly key: SessionKey;
  readonly workspaceId: string;
  readonly registeredAtMs: number;
  readonly lastSeenMs: number;
  readonly presence: "online" | "offline";
  readonly runState: "idle" | "busy" | "unknown";
  readonly capabilities: readonly Capability[];
  readonly holderInstanceId: string | null;
  readonly controlEpoch: number;
  readonly leaseExpiresAtMs: number | null;
}

export interface StoredRecord {
  readonly requestId: string;
  readonly projectId: string;
  readonly operation: string;
  readonly target: unknown;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly grantId: string;
  readonly state: RequestState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deadlineAtMs: number | null;
  readonly stream: SessionKey;
  readonly result: unknown;
  readonly error: ProtocolError | undefined;
  readonly receipts: readonly RequestReceipt[];
}

export interface EventRow {
  readonly eventId: string;
  readonly eventSeq: EventSeq;
  readonly topic: string;
  readonly data: unknown;
  readonly atMs: number;
  readonly bytes: number;
}

interface RequestRowShape {
  request_id: string;
  project_id: string;
  operation: string;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  grant_id: string;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
  deadline_at_ms: number | null;
  stream_target: string;
  stream_native: string;
  result_json: string | null;
  error_json: string | null;
  receipt_seq: number;
}

interface ReceiptRowShape {
  request_id: string;
  seq: number;
  state: string;
  at_ms: number;
  event_id: string;
  event_seq: number;
  detail: string | null;
}

interface SessionRowShape {
  project_id: string;
  target: string;
  native_session_id: string;
  workspace_id: string;
  registered_at_ms: number;
  last_seen_ms: number;
  presence: string;
  run_state: string;
  capabilities_json: string;
  holder_instance_id: string | null;
  control_epoch: number;
  lease_expires_at_ms: number | null;
}

interface EventRowShape {
  event_id: string;
  event_seq: number;
  topic: string;
  data_json: string;
  at_ms: number;
  bytes: number;
}

interface LockRowShape {
  owner_token: string;
  pid: number;
  acquired_at_ms: number;
  heartbeat_at_ms: number;
}

export interface StoreOptions {
  readonly dataDir: string;
  readonly now: () => number;
}

export type CommitOutcome =
  | { readonly kind: "new"; readonly record: StoredRecord }
  | { readonly kind: "idempotent_replay"; readonly record: StoredRecord }
  | { readonly kind: "error"; readonly error: ProtocolError };

export type TransitionOutcome =
  | { readonly ok: true; readonly record: StoredRecord }
  | { readonly ok: false; readonly error: ProtocolError };

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS store_lock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS root_proofs (
    proof_id TEXT PRIMARY KEY,
    consumed_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS streams (
    project_id TEXT NOT NULL,
    target TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, target, native_session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    project_id TEXT NOT NULL,
    target TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    registered_at_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    presence TEXT NOT NULL,
    run_state TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    holder_instance_id TEXT,
    control_epoch INTEGER NOT NULL DEFAULT 0,
    lease_expires_at_ms INTEGER,
    PRIMARY KEY (project_id, target, native_session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    target_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deadline_at_ms INTEGER,
    stream_target TEXT NOT NULL,
    stream_native TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    receipt_seq INTEGER NOT NULL DEFAULT 0,
    delivery_seq INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS receipts (
    request_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    detail TEXT,
    PRIMARY KEY (request_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    project_id TEXT NOT NULL,
    target TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    data_json TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (project_id, target, native_session_id, event_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS events_by_at ON events (at_ms)`,
  `CREATE INDEX IF NOT EXISTS requests_by_state ON requests (state)`,
];

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Normalización a forma de WIRE (JSON round-trip). El hash canónico del dedup
 * se define sobre los valores que cruzaron el socket (`computePayloadHash` de
 * protocol); la validación del protocolo normaliza objetos con claves
 * opcionales en `undefined` (p.ej. `target.instanceId`/`session`) que
 * `canonicalJson` rechaza. Hashear el wire evita falsear el contrato.
 */
export function wireValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as ErrnoException).code === "EPERM";
  }
}

export class Store {
  readonly db: Database;
  readonly dataDir: string;
  readonly grants: GrantsRegistry;
  /**
   * Notificación de eventos de journal CONFIRMADOS (tras COMMIT): el servidor
   * la usa para empujar entregas al titular y a las suscripciones. Los eventos
   * de una transacción abortada jamás se notifican.
   */
  listener: ((stream: SessionKey, event: EventRow) => void) | undefined;
  readonly #now: () => number;
  readonly #ownerToken: string;
  readonly #lockTimer: Timer;
  #eventBuffer: { stream: SessionKey; event: EventRow }[] = [];
  #closed = false;
  #dbClosed = false;
  #txDepth = 0;

  private constructor(db: Database, options: StoreOptions, ownerToken: string) {
    this.db = db;
    this.dataDir = options.dataDir;
    this.#now = options.now;
    this.#ownerToken = ownerToken;
    this.grants = new GrantsRegistry({ dataDir: options.dataDir, now: options.now });
    this.#lockTimer = setInterval(() => this.#touchLock(), STORE_LOCK_HEARTBEAT_MS);
  }

  /** Abre (o crea) el store y adquiere el escritor único. Lanza si ya hay escritor. */
  static open(options: StoreOptions): Store {
    mkdirSync(options.dataDir, { recursive: true });
    const db = new Database(join(options.dataDir, DB_FILE_NAME), { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    for (const migration of MIGRATIONS) db.exec(migration);
    const schema = db.query<Record<string, unknown>, any[]>("SELECT value FROM meta WHERE key = ?").get("schemaVersion");
    const current = schema === null ? undefined : Number(schema["value"]);
    if (current !== undefined && current !== STORE_SCHEMA_VERSION) {
      db.close();
      throw new Error(`schema del store no soportado: ${current} (esperado ${STORE_SCHEMA_VERSION})`);
    }
    const ownerToken = `stw_${newEventId().slice(4)}${Date.now().toString(16)}`;
    const store = new Store(db, options, ownerToken);
    try {
      // El escritor único se adquiere ANTES de cualquier escritura de datos:
      // un segundo escritor incompatible se rechaza sin tocar el store.
      store.#acquireLock();
    } catch (error) {
      clearInterval(store.#lockTimer);
      db.close();
      throw error;
    }
    db.query<any, any[]>("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "schemaVersion",
      String(STORE_SCHEMA_VERSION),
    );
    store.grants.refresh();
    store.recoverUncertain();
    return store;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get ownerToken(): string {
    return this.#ownerToken;
  }

  #q<R>(sql: string): Statement<R, any[]> {
    return this.db.prepare<R, any[]>(sql);
  }

  #withTx<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.#txDepth += 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.#txDepth -= 1;
      this.#flushEvents();
      return out;
    } catch (error) {
      this.#txDepth -= 1;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // el rollback best-effort no debe ocultar el error original
      }
      this.#eventBuffer = [];
      throw error;
    }
  }

  #flushEvents(): void {
    if (this.#eventBuffer.length === 0) return;
    const events = this.#eventBuffer;
    this.#eventBuffer = [];
    const listener = this.listener;
    if (listener === undefined) return;
    for (const entry of events) listener(entry.stream, entry.event);
  }

  // ---------------------------------------------------------------- escritor

  #acquireLock(): void {
    this.#withTx(() => {
      const row = this.#q<LockRowShape>("SELECT owner_token, pid, acquired_at_ms, heartbeat_at_ms FROM store_lock WHERE singleton = 1").get();
      const nowReal = Date.now();
      if (row === null) {
        this.#q("INSERT INTO store_lock (singleton, owner_token, pid, acquired_at_ms, heartbeat_at_ms) VALUES (1, ?, ?, ?, ?)").run(
          this.#ownerToken,
          process.pid,
          nowReal,
          nowReal,
        );
        return;
      }
      const stale = nowReal - row.heartbeat_at_ms > STORE_LOCK_LEASE_MS;
      const foreignerAlive = row.pid !== process.pid && isProcessAlive(row.pid);
      if (row.pid === process.pid || (foreignerAlive && !stale)) {
        throw new Error(
          `store ya tiene un escritor activo (pid=${row.pid}, token=${row.owner_token.slice(0, 12)}…): segundo escritor rechazado`,
        );
      }
      // Lock huérfano: el dueño murió (pid libre) o su heartbeat venció.
      this.#q("UPDATE store_lock SET owner_token = ?, pid = ?, acquired_at_ms = ?, heartbeat_at_ms = ? WHERE singleton = 1").run(
        this.#ownerToken,
        process.pid,
        nowReal,
        nowReal,
      );
    });
  }

  #touchLock(): void {
    if (this.#closed) return;
    try {
      const result = this.#q("UPDATE store_lock SET heartbeat_at_ms = ? WHERE singleton = 1 AND owner_token = ?").run(
        Date.now(),
        this.#ownerToken,
      );
      if (result.changes === 0) {
        // Otro escritor reclamó el store: este proceso pierde la autoridad.
        this.#closed = true;
      }
    } catch {
      // best-effort: el cierre ordenado libera el lock igualmente
    }
  }

  close(): void {
    if (this.#dbClosed) return;
    this.#dbClosed = true;
    this.#closed = true;
    clearInterval(this.#lockTimer);
    try {
      this.#q("DELETE FROM store_lock WHERE singleton = 1 AND owner_token = ?").run(this.#ownerToken);
    } catch {
      // best-effort
    }
    this.db.close();
  }

  // ------------------------------------------------------------ root proofs

  isProofConsumed(proofId: string): boolean {
    return this.#q<{ proof_id: string }>("SELECT proof_id FROM root_proofs WHERE proof_id = ?").get(proofId) !== null;
  }

  consumeProof(proofId: string, expiresAtMs: number): Result<true, ProtocolError> {
    return this.#withTx(() => {
      if (this.isProofConsumed(proofId)) {
        return {
          ok: false,
          error: protocolError("UNAUTHORIZED", "root_proof_consumed", "root proof ya consumida (uso único)", "rootProof.proofId"),
        } as const;
      }
      this.#q("INSERT INTO root_proofs (proof_id, consumed_at_ms, expires_at_ms) VALUES (?, ?, ?)").run(
        proofId,
        this.#now(),
        expiresAtMs,
      );
      return { ok: true, value: true } as const;
    });
  }

  // --------------------------------------------------------------- sesiones

  #rowToSession(row: SessionRowShape): SessionRow {
    return {
      key: { projectId: row.project_id, target: row.target, nativeSessionId: row.native_session_id },
      workspaceId: row.workspace_id,
      registeredAtMs: row.registered_at_ms,
      lastSeenMs: row.last_seen_ms,
      presence: row.presence === "online" ? "online" : "offline",
      runState: row.run_state === "idle" || row.run_state === "busy" ? row.run_state : "unknown",
      capabilities: (parseJson(row.capabilities_json) as Capability[] | undefined) ?? [],
      holderInstanceId: row.holder_instance_id,
      controlEpoch: row.control_epoch,
      leaseExpiresAtMs: row.lease_expires_at_ms,
    };
  }

  getSession(key: SessionKey): SessionRow | undefined {
    const row = this.#q<SessionRowShape>(
      "SELECT * FROM sessions WHERE project_id = ? AND target = ? AND native_session_id = ?",
    ).get(key.projectId, key.target, key.nativeSessionId);
    return row === null ? undefined : this.#rowToSession(row);
  }

  listSessions(projectId: string): SessionRow[] {
    return this.#q<SessionRowShape>("SELECT * FROM sessions WHERE project_id = ? ORDER BY target, native_session_id")
      .all(projectId)
      .map((row) => this.#rowToSession(row));
  }

  leaseFor(session: SessionRow): ControlLease | undefined {
    if (session.holderInstanceId === null || session.leaseExpiresAtMs === null) return undefined;
    return {
      scopeProjectId: session.key.projectId,
      scopeTarget: session.key.target,
      scopeNativeSessionId: session.key.nativeSessionId,
      epoch: session.controlEpoch,
      holderInstanceId: session.holderInstanceId,
      issuedAtMs: session.registeredAtMs,
      expiresAtMs: session.leaseExpiresAtMs,
    };
  }

  /**
   * Registro raíz de la sesión: upsert de la identidad asociada
   * (projectId/workspaceId/target/nativeSessionId/instanceId sin colapsarlos)
   * y renovación/takeover del lease de control (siempre incrementa el epoch).
   * Un takeover deja `outcome_unknown` sobre lo entregado sin confirmar del
   * dueño anterior: no se afirma cancelación de efectos ya ocurridos.
   */
  registerSession(input: {
    key: SessionKey;
    workspaceId: string;
    instanceId: string;
    capabilities: readonly Capability[];
    nowMs: number;
    leaseTtlMs: number;
  }): { session: SessionRow; epoch: number; takeover: boolean; previousHolder: string | null; event: EventRow } {
    return this.#withTx(() => {
      const previous = this.getSession(input.key);
      const previousHolder = previous?.holderInstanceId ?? null;
      const takeover = previousHolder !== null && previousHolder !== input.instanceId;
      const lease = renewControlLease(previous === undefined ? undefined : this.leaseFor(previous), {
        scopeProjectId: input.key.projectId,
        scopeTarget: input.key.target,
        scopeNativeSessionId: input.key.nativeSessionId,
        holderInstanceId: input.instanceId,
        issuedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.leaseTtlMs,
      });
      if (takeover) {
        this.#crashWindow(input.key, input.nowMs, `takeover de instancia ${input.instanceId}`);
      }
      if (previous === undefined) {
        this.#q(
          `INSERT INTO sessions (project_id, target, native_session_id, workspace_id, registered_at_ms, last_seen_ms,
            presence, run_state, capabilities_json, holder_instance_id, control_epoch, lease_expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'online', 'unknown', ?, ?, ?, ?)`,
        ).run(
          input.key.projectId,
          input.key.target,
          input.key.nativeSessionId,
          input.workspaceId,
          input.nowMs,
          input.nowMs,
          JSON.stringify([...input.capabilities]),
          input.instanceId,
          lease.epoch,
          lease.expiresAtMs,
        );
      } else {
        this.#q(
          `UPDATE sessions SET workspace_id = ?, last_seen_ms = ?, presence = 'online', capabilities_json = ?,
            holder_instance_id = ?, control_epoch = ?, lease_expires_at_ms = ?
           WHERE project_id = ? AND target = ? AND native_session_id = ?`,
        ).run(
          input.workspaceId,
          input.nowMs,
          JSON.stringify([...input.capabilities]),
          input.instanceId,
          lease.epoch,
          lease.expiresAtMs,
          input.key.projectId,
          input.key.target,
          input.key.nativeSessionId,
        );
      }
      const event = this.appendEvent(
        input.key,
        "broker.presence",
        {
          sessionRef: {
            projectId: input.key.projectId,
            scope: "workspace",
            workspaceId: input.workspaceId,
            target: input.key.target,
            nativeSessionId: input.key.nativeSessionId,
          },
          instanceId: input.instanceId,
          presence: "online",
          takeover,
          controlEpoch: lease.epoch,
          previousHolder,
        },
        input.nowMs,
      );
      const session = this.getSession(input.key);
      if (session === undefined) throw new Error("registro de sesión desapareció en la misma transacción");
      return { session, epoch: lease.epoch, takeover, previousHolder, event };
    });
  }

  /** Heartbeat del titular: presencia/runState; jamás cambia el epoch ni completa requests. */
  heartbeat(key: SessionKey, instanceId: string, runState: "idle" | "busy" | "unknown", nowMs: number): void {
    this.#withTx(() => {
      const session = this.getSession(key);
      if (session === undefined || session.holderInstanceId !== instanceId) return;
      this.#q(
        "UPDATE sessions SET last_seen_ms = ?, run_state = ? WHERE project_id = ? AND target = ? AND native_session_id = ?",
      ).run(nowMs, runState, key.projectId, key.target, key.nativeSessionId);
    });
  }

  /**
   * Baja del titular (desconexión). Presencia pasa a offline, lo entregado sin
   * confirmar queda `outcome_unknown` y lo meramente `queued` permanece
   * re-entregable. Con `invalidateControl` (revocación/expiración del grant)
   * además se incrementa el epoch, invalidando todo control previo.
   */
  markInstanceOffline(
    key: SessionKey,
    instanceId: string,
    nowMs: number,
    options: { readonly invalidateControl: boolean },
  ): void {
    this.#withTx(() => {
      const session = this.getSession(key);
      if (session === undefined || session.holderInstanceId !== instanceId) return;
      this.#crashWindow(key, nowMs, `titular ${instanceId} desconectado`);
      let epoch = session.controlEpoch;
      if (options.invalidateControl) {
        const lease = renewControlLease(this.leaseFor(session), {
          scopeProjectId: key.projectId,
          scopeTarget: key.target,
          scopeNativeSessionId: key.nativeSessionId,
          holderInstanceId: instanceId,
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + Math.max(1, (session.leaseExpiresAtMs ?? nowMs) - session.registeredAtMs),
        });
        epoch = lease.epoch;
        this.#q(
          "UPDATE sessions SET presence = 'offline', last_seen_ms = ?, control_epoch = ? WHERE project_id = ? AND target = ? AND native_session_id = ?",
        ).run(nowMs, epoch, key.projectId, key.target, key.nativeSessionId);
      } else {
        this.#q(
          "UPDATE sessions SET presence = 'offline', last_seen_ms = ? WHERE project_id = ? AND target = ? AND native_session_id = ?",
        ).run(nowMs, key.projectId, key.target, key.nativeSessionId);
      }
      this.appendEvent(
        key,
        "broker.presence",
        { instanceId, presence: "offline", controlInvalidated: options.invalidateControl, controlEpoch: epoch },
        nowMs,
      );
    });
  }

  /** Ventana de crash: entregado sin confirmar => `outcome_unknown` (nunca replay). */
  #crashWindow(key: SessionKey, nowMs: number, detail: string): void {
    const pending = this.#q<RequestRowShape>(
      "SELECT * FROM requests WHERE project_id = ? AND stream_target = ? AND stream_native = ? AND state IN ('received', 'submitted')",
    ).all(key.projectId, key.target, key.nativeSessionId);
    for (const row of pending) {
      this.#applyTransitionUnlocked(row.request_id, "crash_window", {
        nowMs,
        detail,
        error: protocolError(
          "OUTCOME_UNKNOWN",
          "outcome_unknown_no_replay",
          "ventana de crash: resultado no verificable, exige reconciliación explícita",
          "state",
        ),
      });
    }
  }

  /**
   * Recuperación tras restart: requests en `received`/`submitted` sin resultado
   * persistido quedan `outcome_unknown`; lo `queued` sigue disponible para
   * re-entrega idempotente. No relanza nada ni completa requests.
   */
  recoverUncertain(): number {
    return this.#withTx(() => {
      const rows = this.#q<RequestRowShape>(
        "SELECT * FROM requests WHERE state IN ('received', 'submitted')",
      ).all();
      for (const row of rows) {
        this.#applyTransitionUnlocked(row.request_id, "crash_window", {
          nowMs: this.#now(),
          detail: "recuperación tras restart del broker",
          error: protocolError(
            "OUTCOME_UNKNOWN",
            "outcome_unknown_no_replay",
            "ventana de crash: resultado no verificable, exige reconciliación explícita",
            "state",
          ),
        });
      }
      return rows.length;
    });
  }

  // ---------------------------------------------------------------- eventos

  appendEvent(stream: SessionKey, topic: string, data: unknown, nowMs: number): EventRow {
    return this.#withTx(() => {
      const row = this.#q<{ next_seq: number }>(
        "SELECT next_seq FROM streams WHERE project_id = ? AND target = ? AND native_session_id = ?",
      ).get(stream.projectId, stream.target, stream.nativeSessionId);
      const seq = row === null ? 1 : row.next_seq;
      this.#q(
        `INSERT INTO streams (project_id, target, native_session_id, next_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, target, native_session_id) DO UPDATE SET next_seq = excluded.next_seq`,
      ).run(stream.projectId, stream.target, stream.nativeSessionId, seq + 1);
      const eventId = newEventId();
      const dataJson = JSON.stringify(data ?? null);
      const bytes = Buffer.byteLength(dataJson, "utf8");
      this.#q(
        "INSERT INTO events (project_id, target, native_session_id, event_seq, event_id, topic, data_json, at_ms, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(stream.projectId, stream.target, stream.nativeSessionId, seq, eventId, topic, dataJson, nowMs, bytes);
      const event: EventRow = { eventId, eventSeq: seq, topic, data, atMs: nowMs, bytes };
      this.#eventBuffer.push({ stream, event });
      return event;
    });
  }

  oldestEventSeq(stream: SessionKey): number | undefined {
    const row = this.#q<{ event_seq: number }>(
      "SELECT event_seq FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? ORDER BY event_seq LIMIT 1",
    ).get(stream.projectId, stream.target, stream.nativeSessionId);
    return row === null ? undefined : row.event_seq;
  }

  /**
   * Próximo `eventSeq` del stream (= máximo asignado + 1). `1` significa que el
   * stream nunca tuvo eventos; un valor mayor con journal vacío denota recorte
   * (la historia ya no empieza donde el consumidor espera).
   */
  streamNextSeq(stream: SessionKey): number {
    const row = this.#q<{ next_seq: number }>(
      "SELECT next_seq FROM streams WHERE project_id = ? AND target = ? AND native_session_id = ?",
    ).get(stream.projectId, stream.target, stream.nativeSessionId);
    return row === null ? 1 : row.next_seq;
  }

  /**
   * Mayor `event_seq` del stream que YA quedó fuera de la ventana de retención
   * (`at_ms < nowMs - retentionMs`). Sirve para detectar huecos explícitos: un
   * consumidor que reanuda por encima de este punto no vería esos eventos y el
   * hueco jamás se oculta como página vacía.
   */
  lastUnretainedSeq(stream: SessionKey, nowMs: number, retentionMs: number): number | undefined {
    const row = this.#q<{ event_seq: number | null }>(
      "SELECT MAX(event_seq) AS event_seq FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? AND at_ms < ?",
    ).get(stream.projectId, stream.target, stream.nativeSessionId, nowMs - retentionMs);
    return row === null || row.event_seq === null ? undefined : row.event_seq;
  }

  /**
   * Página de historial. Los eventos fuera de retención o por debajo del piso
   * recortado se resuelven como gap explícito en `server.ts` (`CURSOR_EXPIRED`).
   */
  historyPage(stream: SessionKey, fromSeq: number, limit: number, nowMs: number, retentionMs: number): EventRow[] {
    const floor = nowMs - retentionMs;
    return this.#q<EventRowShape>(
      "SELECT * FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? AND event_seq >= ? AND at_ms >= ? ORDER BY event_seq LIMIT ?",
    )
      .all(stream.projectId, stream.target, stream.nativeSessionId, fromSeq, floor, limit)
      .map((row) => ({
        eventId: row.event_id,
        eventSeq: row.event_seq,
        topic: row.topic,
        data: parseJson(row.data_json),
        atMs: row.at_ms,
        bytes: row.bytes,
      }));
  }

  hasEventsFrom(stream: SessionKey, fromSeq: number): boolean {
    return (
      this.#q<{ event_seq: number }>(
        "SELECT event_seq FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? AND event_seq >= ? LIMIT 1",
      ).get(stream.projectId, stream.target, stream.nativeSessionId, fromSeq) !== null
    );
  }

  eventAt(stream: SessionKey, seq: number): EventRow | undefined {
    const row = this.#q<EventRowShape>(
      "SELECT * FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? AND event_seq = ?",
    ).get(stream.projectId, stream.target, stream.nativeSessionId, seq);
    if (row === null) return undefined;
    return {
      eventId: row.event_id,
      eventSeq: row.event_seq,
      topic: row.topic,
      data: parseJson(row.data_json),
      atMs: row.at_ms,
      bytes: row.bytes,
    };
  }

  /**
   * Entregas durables pendientes (estado `queued`) de un stream, con el evento
   * de journal original: la re-entrega reutiliza el MISMO eventId/eventSeq.
   */
  pendingDeliveries(stream: SessionKey): { record: StoredRecord; event: EventRow }[] {
    const out: { record: StoredRecord; event: EventRow }[] = [];
    for (const record of this.requestsForStream(stream, ["queued"])) {
      const row = this.#q<{ delivery_seq: number | null }>(
        "SELECT delivery_seq FROM requests WHERE request_id = ?",
      ).get(record.requestId);
      const seq = row?.delivery_seq ?? null;
      if (seq === null) continue;
      const event = this.eventAt(stream, seq);
      if (event === undefined) continue;
      out.push({ record, event });
    }
    return out;
  }

  // -------------------------------------------------------------- requests

  #rowToRecord(row: RequestRowShape): StoredRecord {
    const receipts = this.#q<ReceiptRowShape>(
      "SELECT * FROM receipts WHERE request_id = ? ORDER BY seq",
    )
      .all(row.request_id)
      .map((receipt) => ({
        state: receipt.state as RequestState,
        atMs: receipt.at_ms,
        eventId: receipt.event_id,
        eventSeq: receipt.event_seq,
        detail: receipt.detail ?? undefined,
      }));
    return {
      requestId: row.request_id,
      projectId: row.project_id,
      operation: row.operation,
      target: parseJson(row.target_json),
      payload: parseJson(row.payload_json),
      payloadHash: row.payload_hash,
      grantId: row.grant_id,
      state: row.state as RequestState,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      deadlineAtMs: row.deadline_at_ms,
      stream: { projectId: row.project_id, target: row.stream_target, nativeSessionId: row.stream_native },
      result: parseJson(row.result_json),
      error: parseJson(row.error_json) as ProtocolError | undefined,
      receipts,
    };
  }

  getRequest(requestId: string): StoredRecord | undefined {
    const row = this.#q<RequestRowShape>("SELECT * FROM requests WHERE request_id = ?").get(requestId);
    return row === null ? undefined : this.#rowToRecord(row);
  }

  requestsForStream(stream: SessionKey, states?: readonly RequestState[]): StoredRecord[] {
    const rows = this.#q<RequestRowShape>(
      "SELECT * FROM requests WHERE project_id = ? AND stream_target = ? AND stream_native = ? ORDER BY created_at_ms, request_id",
    ).all(stream.projectId, stream.target, stream.nativeSessionId);
    return rows
      .map((row) => this.#rowToRecord(row))
      .filter((record) => states === undefined || states.includes(record.state));
  }

  countQueuedAsks(stream: SessionKey): number {
    const row = this.#q<{ n: number }>(
      "SELECT COUNT(*) AS n FROM requests WHERE project_id = ? AND stream_target = ? AND stream_native = ? AND operation = 'ask' AND state = 'queued'",
    ).get(stream.projectId, stream.target, stream.nativeSessionId);
    return row === null ? 0 : row.n;
  }

  countInFlight(grantId: string): number {
    const row = this.#q<{ n: number }>(
      "SELECT COUNT(*) AS n FROM requests WHERE grant_id = ? AND state IN ('queued', 'received', 'submitted')",
    ).get(grantId);
    return row === null ? 0 : row.n;
  }

  /**
   * Commit durable de una solicitud (dedup scoped por proyecto + requestId).
   * `new` => transacción única request/hash/recibo/journal; replay => el
   * registro completo SIN nuevos efectos; hash distinto => `PAYLOAD_CONFLICT`.
   */
  commitRequest(input: {
    requestId: string;
    projectId: string;
    operation: string;
    target: unknown;
    payload: unknown;
    grantId: string;
    stream: SessionKey;
    nowMs: number;
    deadlineAtMs: number | null;
    /** Entrega durable al titular (ask/notify/control); el evento se re-envía idéntico al reconectar. */
    delivery?: { readonly topic: string; readonly data: unknown };
  }): CommitOutcome {
    return this.#withTx(() => {
      const wireTarget = wireValue(input.target);
      const wirePayload = wireValue(input.payload);
      const existing = this.getRequest(input.requestId);
      const decision = evaluateDedup(existing as RequestRecord | undefined, {
        projectId: input.projectId,
        requestId: input.requestId as RequestRecord["requestId"],
        operation: input.operation as RequestRecord["operation"],
        target: wireTarget,
        payload: wirePayload,
        nowMs: input.nowMs,
      });
      if (!decision.ok) return { kind: "error", error: decision.error };
      const verdict = decision.value;
      if (verdict.kind === "conflict") return { kind: "error", error: verdict.error };
      if (verdict.kind === "idempotent_replay") {
        return { kind: "idempotent_replay", record: existing as StoredRecord };
      }
      const event = this.appendEvent(
        input.stream,
        "broker.state",
        { requestId: input.requestId, operation: input.operation, from: "new", to: "queued" },
        input.nowMs,
      );
      const deliveryEvent =
        input.delivery === undefined
          ? undefined
          : this.appendEvent(input.stream, input.delivery.topic, input.delivery.data, input.nowMs);
      this.#q(
        `INSERT INTO requests (request_id, project_id, operation, target_json, payload_json, payload_hash, grant_id,
          state, created_at_ms, updated_at_ms, deadline_at_ms, stream_target, stream_native, result_json, error_json, receipt_seq, delivery_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
      ).run(
        input.requestId,
        input.projectId,
        input.operation,
        JSON.stringify(wireTarget ?? null),
        JSON.stringify(wirePayload ?? null),
        verdict.record.payloadHash,
        input.grantId,
        input.nowMs,
        input.nowMs,
        input.deadlineAtMs,
        input.stream.target,
        input.stream.nativeSessionId,
        deliveryEvent === undefined ? null : deliveryEvent.eventSeq,
      );
      this.#q(
        "INSERT INTO receipts (request_id, seq, state, at_ms, event_id, event_seq, detail) VALUES (?, 1, 'queued', ?, ?, ?, ?)",
      ).run(input.requestId, input.nowMs, event.eventId, event.eventSeq, "durable commit del broker");
      const record = this.getRequest(input.requestId);
      if (record === undefined) throw new Error("commit desapareció en la misma transacción");
      return { kind: "new", record };
    });
  }

  /** Transición + recibo + journal en UNA transacción (comparación atómica). */
  transition(
    requestId: string,
    event: RequestEventType,
    options: {
      nowMs: number;
      detail?: string;
      result?: unknown;
      error?: ProtocolError;
      requireEvidenceForReconcile?: boolean;
    },
  ): TransitionOutcome {
    return this.#withTx(() =>
      this.#applyTransitionUnlocked(requestId, event, options),
    );
  }

  #applyTransitionUnlocked(
    requestId: string,
    event: RequestEventType,
    options: {
      nowMs: number;
      detail?: string;
      result?: unknown;
      error?: ProtocolError;
      requireEvidenceForReconcile?: boolean;
    },
  ): TransitionOutcome {
    const row = this.#q<RequestRowShape>("SELECT * FROM requests WHERE request_id = ?").get(requestId);
    if (row === null) {
      return {
        ok: false,
        error: protocolError("NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope", "solicitud no disponible en este ámbito", "requestId"),
      };
    }
    const record = this.#rowToRecord(row);
    if (
      options.requireEvidenceForReconcile === true &&
      (event === "reconcile_completed" || event === "reconcile_failed")
    ) {
      const hasEvidence = event === "reconcile_completed" ? options.result !== undefined : options.error !== undefined;
      if (!hasEvidence) {
        return {
          ok: false,
          error: protocolError(
            "INVALID_INPUT",
            "outcome_unknown_no_replay",
            "la reconciliación exige evidencia explícita del runtime nativo",
            "state",
          ),
        };
      }
    }
    const next = applyRequestEvent(record.state, event, {
      operation: record.operation as Parameters<typeof applyRequestEvent>[2]["operation"],
    });
    if (!next.ok) return { ok: false, error: next.error };
    const journal = this.appendEvent(
      record.stream,
      "broker.state",
      {
        requestId: record.requestId,
        operation: record.operation,
        from: record.state,
        to: next.value,
        error: options.error,
      },
      options.nowMs,
    );
    this.#q(
      "INSERT INTO receipts (request_id, seq, state, at_ms, event_id, event_seq, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.requestId,
      row.receipt_seq + 1,
      next.value,
      options.nowMs,
      journal.eventId,
      journal.eventSeq,
      options.detail ?? null,
    );
    this.#q(
      "UPDATE requests SET state = ?, updated_at_ms = ?, result_json = ?, error_json = ?, receipt_seq = ? WHERE request_id = ?",
    ).run(
      next.value,
      options.nowMs,
      options.result === undefined ? (row.result_json ?? null) : JSON.stringify(options.result),
      options.error === undefined ? (row.error_json ?? null) : JSON.stringify(options.error),
      row.receipt_seq + 1,
      record.requestId,
    );
    const updated = this.getRequest(record.requestId);
    if (updated === undefined) throw new Error("transición desapareció en la misma transacción");
    return { ok: true, record: updated };
  }

  /** Reconciliación explícita de `outcome_unknown` con evidencia (jamás replay). */
  reconcile(
    requestId: string,
    outcome: "completed" | "failed",
    evidence: { result?: unknown; error?: ProtocolError },
    nowMs: number,
  ): TransitionOutcome {
    return this.transition(requestId, outcome === "completed" ? "reconcile_completed" : "reconcile_failed", {
      nowMs,
      detail: "reconciliación explícita con evidencia del runtime nativo",
      result: evidence.result,
      error: evidence.error,
      requireEvidenceForReconcile: true,
    });
  }

  // ------------------------------------------------------------- barridos

  /** Expira plazos vencidos (`EXPIRED`) y recorta retención; nunca toca `outcome_unknown`. */
  sweep(nowMs: number, retention: { requestMs: number; eventMs: number; journalBytesPerProject: number }): void {
    this.#withTx(() => {
      const overdue = this.#q<RequestRowShape>(
        "SELECT * FROM requests WHERE deadline_at_ms IS NOT NULL AND deadline_at_ms <= ? AND state IN ('queued', 'received', 'submitted')",
      ).all(nowMs);
      for (const row of overdue) {
        this.#applyTransitionUnlocked(row.request_id, "expire", {
          nowMs,
          detail: "plazo vencido",
          error: protocolError("EXPIRED", "deadline_out_of_bounds", "el plazo de la solicitud venció", "deadlineMs"),
        });
      }
      this.#q("DELETE FROM events WHERE at_ms < ?").run(nowMs - retention.eventMs);
      this.#q(
        "DELETE FROM requests WHERE updated_at_ms < ? AND state IN ('completed', 'rejected', 'failed', 'expired', 'cancelled')",
      ).run(nowMs - retention.requestMs);
      const projects = this.#q<{ project_id: string }>("SELECT DISTINCT project_id FROM events").all();
      for (const project of projects) {
        let row = this.#q<{ total: number }>(
          "SELECT COALESCE(SUM(bytes), 0) AS total FROM events WHERE project_id = ?",
        ).get(project.project_id);
        while (row !== null && row.total > retention.journalBytesPerProject) {
          const oldest = this.#q<{ project_id: string; target: string; native_session_id: string; event_seq: number }>(
            "SELECT project_id, target, native_session_id, event_seq FROM events WHERE project_id = ? ORDER BY at_ms, event_seq LIMIT 1",
          ).get(project.project_id);
          if (oldest === null) break;
          this.#q(
            "DELETE FROM events WHERE project_id = ? AND target = ? AND native_session_id = ? AND event_seq = ?",
          ).run(oldest.project_id, oldest.target, oldest.native_session_id, oldest.event_seq);
          row = this.#q<{ total: number }>(
            "SELECT COALESCE(SUM(bytes), 0) AS total FROM events WHERE project_id = ?",
          ).get(project.project_id);
        }
      }
    });
  }

  // ---------------------------------------------------------------- health

  /**
   * Salud del store: `usable` distingue "el proceso puede leer/escribir el
   * store" de un mero archivo presente; `schemaCompatible` declara si la
   * versión del schema es la soportada. Sin secretos ni historial privado.
   */
  health(): {
    schemaVersion: number;
    schemaCompatible: boolean;
    usable: boolean;
    writer: boolean;
    grants: number;
    sessions: number;
    requests: number;
    events: number;
  } {
    const count = (sql: string): number => {
      const row = this.#q<{ n: number }>(sql).get();
      return row === null ? 0 : row.n;
    };
    try {
      return {
        schemaVersion: STORE_SCHEMA_VERSION,
        schemaCompatible: true,
        usable: true,
        writer: !this.#closed,
        grants: this.grants.size,
        sessions: count("SELECT COUNT(*) AS n FROM sessions"),
        requests: count("SELECT COUNT(*) AS n FROM requests"),
        events: count("SELECT COUNT(*) AS n FROM events"),
      };
    } catch {
      // Disco/permiso/transacción fallida: error OBSERVABLE, jamás salud falsa.
      return {
        schemaVersion: STORE_SCHEMA_VERSION,
        schemaCompatible: true,
        usable: false,
        writer: false,
        grants: 0,
        sessions: 0,
        requests: 0,
        events: 0,
      };
    }
  }
}
