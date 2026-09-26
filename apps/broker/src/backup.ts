/**
 * Backup y restore CONSISTENTES del store del broker (FR-009 / NFR-004).
 *
 * Método soportado: `VACUUM INTO` sobre la conexión SQLite (snapshot
 * consistente que incluye lo que aún vive en el WAL). NUNCA se copia de forma
 * ingenua un archivo activo (`broker.sqlite` + `-wal` + `-shm`) ignorando el
 * WAL: si `VACUUM INTO` falla, el backup falla de forma explícita y no queda
 * ninguna copia presentada como válida.
 *
 * Política CONSERVADORA tras restore (la copia restaura datos, no confianza
 * sobre lo ocurrido después del backup):
 *   - NO se restaura autoridad: el directorio restaurado queda SIN `grants.json`
 *     (fail-closed: sin provisión explícita no hay autenticación). Los grants
 *     presentes en el backup se listan en `requiresReauthorization` del reporte.
 *   - Los leases/control se invalidan: cada sesión queda `offline`, sin titular
 *     y con `control_epoch` incrementado (fencing de cualquier instancia vieja).
 *   - El lock de escritor NO viaja: la copia restaurada es una instancia de
 *     store nueva y adquiere su propio lock al abrir (el pid/token del
 *     escritor original es autoridad vieja sobre otro archivo). La exclusión
 *     de dos escritores sobre el MISMO store se mantiene en `Store.open`.
 *   - Los consumos de root proofs NO se reviven (el ledger viaja íntegro).
 *   - `outcome_unknown` se conserva tal cual; dedup/recibos se conservan para
 *     que un reintento antiguo sea idempotente, jamás trabajo nuevo.
 *
 * Un backup corrupto o incompatible falla explícitamente SIN escribir en el
 * origen (backup ni data dir): el restore limpia su directorio destino.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database, constants } from "bun:sqlite";
import { GRANTS_FILE_NAME } from "./grants";
import { DB_FILE_NAME, STORE_SCHEMA_VERSION } from "./store";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_NAME = "backup-manifest.json";
export const RESTORE_REPORT_NAME = "restore-report.json";
/** Permisos restrictivos de los artefactos que pueden contener datos del store. */
const ARTIFACT_MODE = 0o600;

/** Método declarado en el manifiesto; ver docblock: jamás copia ingenua. */
export type BackupMethod = "sqlite-vacuum-into";

export interface BackupFileEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupJournalSummary {
  readonly events: number;
  readonly requests: number;
  readonly receipts: number;
  readonly sessions: number;
  readonly streams: number;
  readonly rootProofs: number;
  readonly maxEventSeq: number;
}

export interface BackupManifest {
  readonly formatVersion: number;
  readonly createdAtMs: number;
  readonly method: BackupMethod;
  readonly storeSchemaVersion: number;
  readonly dbFile: string;
  readonly files: readonly BackupFileEntry[];
  readonly journal: BackupJournalSummary;
  /** Grant IDs del backup (sin hashes ni credenciales): reautorización visible. */
  readonly grantIds: readonly string[];
}

export interface CreateBackupInput {
  readonly dataDir: string;
  readonly destDir: string;
  readonly nowMs?: number;
}

export interface CreateBackupResult {
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
}

export interface RestoreBackupInput {
  readonly backupDir: string;
  readonly targetDir: string;
  readonly nowMs?: number;
}

export interface RestoreReport {
  readonly restoredAtMs: number;
  readonly targetDir: string;
  readonly storeSchemaVersion: number;
  readonly integrity: "ok";
  readonly journal: BackupJournalSummary;
  readonly journalCorrespondence: "ok";
  readonly permissions: { readonly dbMode: number; readonly reportMode: number };
  readonly invalidated: {
    readonly sessions: number;
    readonly controlEpochBumped: number;
    readonly holdersCleared: number;
    readonly leasesCleared: number;
  };
  /**
   * Lock de escritor NO heredado: la copia restaurada es una instancia de
   * store NUEVA y debe adquirir su propio lock al abrir (el pid/token del
   * escritor original viaja en el snapshot, pero su autoridad no).
   */
  readonly writerLock: "reset";
  /** Autoridad NO restaurada: hay que volver a provisionar estos grants. */
  readonly requiresReauthorization: readonly string[];
  readonly policy: string;
}

export const RESTORE_POLICY =
  "restore conservador: sin grants provisionados (reautorización explícita), leases/holders invalidados con epoch incrementado, lock de escritor reseteado (la copia adquiere el suyo al abrir), root proofs consumidas siguen consumidas y outcome_unknown preservado";

function sha256OfFile(path: string): { bytes: number; sha256: string } {
  const buffer = readFileSync(path);
  return { bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function requireEmptyDir(dir: string, label: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(`${label} ya existe y no está vacío: ${dir} (no se sobrescribe nada en silencio)`);
  }
}

function countRows(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, any[]>(sql).get();
  if (row === null) return 0;
  const value = row["n"];
  return typeof value === "number" ? value : 0;
}

function journalSummary(db: Database): BackupJournalSummary {
  const maxRow = db.query<Record<string, unknown>, any[]>("SELECT COALESCE(MAX(event_seq), 0) AS n FROM events").get();
  const maxEventSeqRaw = maxRow === null ? 0 : maxRow["n"];
  return {
    events: countRows(db, "SELECT COUNT(*) AS n FROM events"),
    requests: countRows(db, "SELECT COUNT(*) AS n FROM requests"),
    receipts: countRows(db, "SELECT COUNT(*) AS n FROM receipts"),
    sessions: countRows(db, "SELECT COUNT(*) AS n FROM sessions"),
    streams: countRows(db, "SELECT COUNT(*) AS n FROM streams"),
    rootProofs: countRows(db, "SELECT COUNT(*) AS n FROM root_proofs"),
    maxEventSeq: typeof maxEventSeqRaw === "number" ? maxEventSeqRaw : 0,
  };
}

/** Grant IDs provisionados (solo identificadores; jamás hashes/credenciales). */
function grantIdsOf(dataDir: string): string[] {
  const path = join(dataDir, GRANTS_FILE_NAME);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof raw !== "object" || raw === null) return [];
  const grants = (raw as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  const ids: string[] = [];
  for (const entry of grants) {
    if (typeof entry !== "object" || entry === null) continue;
    const grant = (entry as { grant?: unknown }).grant;
    if (typeof grant !== "object" || grant === null) continue;
    const grantId = (grant as { grantId?: unknown }).grantId;
    if (typeof grantId === "string") ids.push(grantId);
  }
  return ids;
}

/**
 * Verificación de correspondencia de journal dentro de una copia abierta:
 *   - todo recibo referencia un evento de journal existente (mismo eventId/seq);
 *   - `requests.receipt_seq` es el máximo de sus recibos;
 *   - `streams.next_seq` es estrictamente mayor que el máximo `event_seq`.
 */
function assertJournalCorrespondence(db: Database): void {
  const orphanReceipts = countRows(
    db,
    "SELECT COUNT(*) AS n FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = r.event_id AND e.event_seq = r.event_seq)",
  );
  if (orphanReceipts > 0) {
    throw new Error(`backup corrupto: ${orphanReceipts} recibo(s) sin evento de journal correspondiente`);
  }
  const badReceiptSeq = countRows(
    db,
    "SELECT COUNT(*) AS n FROM requests q WHERE q.receipt_seq <> (SELECT COALESCE(MAX(seq), 0) FROM receipts r WHERE r.request_id = q.request_id)",
  );
  if (badReceiptSeq > 0) {
    throw new Error(`backup corrupto: ${badReceiptSeq} solicitud(es) con receipt_seq incoherente con sus recibos`);
  }
  const badStreams = countRows(
    db,
    "SELECT COUNT(*) AS n FROM streams s WHERE s.next_seq <= (SELECT COALESCE(MAX(e.event_seq), 0) FROM events e WHERE e.project_id = s.project_id AND e.target = s.target AND e.native_session_id = s.native_session_id)",
  );
  if (badStreams > 0) {
    throw new Error(`backup corrupto: ${badStreams} stream(s) con next_seq por debajo de su journal`);
  }
}

/**
 * Abre un archivo del store para backup/verificación.
 *
 * `bun:sqlite` exige modo de apertura EXPLÍCITO: un options object con claves
 * parciales (`{ create: false }`) se tradujo en flags nulos y SQLite respondió
 * `SQLITE_MISUSE` («bad parameter or other API misuse»). Por eso se pasan los
 * flags NUMÉRICOS de `sqlite3.h` vía `constants` (el constructor los acepta
 * literalmente): `READONLY` para inspección (el origen jamás se toca) y
 * `READWRITE|CREATE` para `VACUUM INTO` sobre la fuente y para la política de
 * invalidación de la copia restaurada. La existencia del archivo se exige
 * antes: nada se crea en silencio.
 */
function openStoreFile(path: string, mode: "readonly" | "readwrite"): Database {
  if (!existsSync(path)) {
    throw new Error(`no existe la copia del store que se intenta abrir: ${path}`);
  }
  const flags =
    mode === "readonly"
      ? constants.SQLITE_OPEN_READONLY
      : constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
  return new Database(path, flags);
}

function assertIntegrityAndSchema(db: Database, label: string): void {
  const integrity = db.query<Record<string, unknown>, any[]>("PRAGMA integrity_check").get();
  const verdict = integrity === null ? undefined : integrity["integrity_check"];
  if (verdict !== "ok") {
    throw new Error(`${label}: integridad SQLite fallida (${String(verdict)})`);
  }
  const schema = db.query<Record<string, unknown>, any[]>("SELECT value FROM meta WHERE key = ?").get("schemaVersion");
  const current = schema === null ? undefined : Number(schema["value"]);
  if (current !== STORE_SCHEMA_VERSION) {
    throw new Error(
      `${label}: schema del store no soportado: ${String(current)} (esperado ${STORE_SCHEMA_VERSION}); no se restaura nada`,
    );
  }
}

/**
 * Abre una copia del store, verifica integridad/schema/correspondencia de
 * journal y devuelve su resumen. Cierra la conexión SIEMPRE.
 */
function inspectSnapshot(path: string, label: string): BackupJournalSummary {
  const db = openStoreFile(path, "readonly");
  try {
    assertIntegrityAndSchema(db, label);
    assertJournalCorrespondence(db);
    return journalSummary(db);
  } finally {
    db.close();
  }
}

/**
 * Verifica la copia restaurada y aplica la política conservadora: sesiones
 * `offline`, sin titular, sin lease y con `control_epoch` incrementado
 * (fencing) y lock de escritor reseteado. Devuelve el resumen de journal y lo
 * invalidado.
 */
function verifyAndFenceRestoredCopy(dbTarget: string): {
  journal: BackupJournalSummary;
  invalidated: RestoreReport["invalidated"];
} {
  const db = openStoreFile(dbTarget, "readwrite");
  try {
    assertIntegrityAndSchema(db, "copia restaurada");
    assertJournalCorrespondence(db);
    const journal = journalSummary(db);
    const sessions = countRows(db, "SELECT COUNT(*) AS n FROM sessions");
    const bumped = countRows(db, "SELECT COUNT(*) AS n FROM sessions WHERE control_epoch >= 1");
    const holders = countRows(db, "SELECT COUNT(*) AS n FROM sessions WHERE holder_instance_id IS NOT NULL");
    const leases = countRows(db, "SELECT COUNT(*) AS n FROM sessions WHERE lease_expires_at_ms IS NOT NULL");
    db.exec(
      "UPDATE sessions SET presence = 'offline', holder_instance_id = NULL, lease_expires_at_ms = NULL, control_epoch = control_epoch + 1",
    );
    // El lock de escritor NO viaja: el pid/token del escritor original es una
    // autoridad vieja sobre OTRO archivo. La copia restaurada es una instancia
    // de store nueva que adquiere su propio lock al abrir; la exclusión de dos
    // escritores sobre el MISMO store no cambia (sigue en `Store.open`).
    db.exec("DELETE FROM store_lock");
    return {
      journal,
      invalidated: {
        sessions,
        controlEpochBumped: bumped,
        holdersCleared: holders,
        leasesCleared: leases,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Crea un backup consistente de `<dataDir>` en `<destDir>` (que debe estar
 * vacío). El snapshot se produce con `VACUUM INTO`; el manifiesto declara el
 * método, los hashes de cada archivo y el resumen de journal.
 */
export function createBackup(input: CreateBackupInput): CreateBackupResult {
  const nowMs = input.nowMs ?? Date.now();
  const dbPath = join(input.dataDir, DB_FILE_NAME);
  if (!existsSync(dbPath)) {
    throw new Error(`no hay store que respaldar en ${input.dataDir} (falta ${DB_FILE_NAME})`);
  }
  mkdirSync(input.destDir, { recursive: true });
  requireEmptyDir(input.destDir, "destino de backup");
  const snapshotPath = join(input.destDir, DB_FILE_NAME);
  const db = openStoreFile(dbPath, "readwrite");
  try {
    // Método soportado y único: jamás copia ingenua del archivo activo. La
    // ruta se escapa como literal SQL (comillas simples dobladas).
    db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } catch (cause) {
    rmSync(snapshotPath, { force: true });
    throw new Error(`backup consistente falló (VACUUM INTO): ${String(cause)}`);
  } finally {
    db.close();
  }
  chmodSync(snapshotPath, ARTIFACT_MODE);

  const files: BackupFileEntry[] = [{ name: DB_FILE_NAME, ...sha256OfFile(snapshotPath) }];
  const grantsSource = join(input.dataDir, GRANTS_FILE_NAME);
  if (existsSync(grantsSource)) {
    const grantsCopy = join(input.destDir, GRANTS_FILE_NAME);
    copyFileSync(grantsSource, grantsCopy);
    chmodSync(grantsCopy, ARTIFACT_MODE);
    files.push({ name: GRANTS_FILE_NAME, ...sha256OfFile(grantsCopy) });
  }

  // El resumen del manifiesto se lee del SNAPSHOT (lo que de verdad se copió).
  const journal = inspectSnapshot(snapshotPath, "backup recién creado");

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAtMs: nowMs,
    method: "sqlite-vacuum-into",
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    dbFile: DB_FILE_NAME,
    files,
    journal,
    grantIds: grantIdsOf(input.dataDir),
  };
  const manifestPath = join(input.destDir, BACKUP_MANIFEST_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  chmodSync(manifestPath, ARTIFACT_MODE);
  return { manifestPath, manifest };
}

function readManifest(backupDir: string): BackupManifest {
  const manifestPath = join(backupDir, BACKUP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`backup sin manifiesto: falta ${BACKUP_MANIFEST_NAME} en ${backupDir}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`backup corrupto: ${BACKUP_MANIFEST_NAME} no es JSON válido`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`backup corrupto: ${BACKUP_MANIFEST_NAME} no es un objeto`);
  }
  const manifest = raw as Partial<BackupManifest>;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `backup incompatible: formatVersion ${String(manifest.formatVersion)} no soportado (esperado ${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (manifest.storeSchemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error(
      `backup incompatible: schema del store ${String(manifest.storeSchemaVersion)} no soportado (esperado ${STORE_SCHEMA_VERSION})`,
    );
  }
  if (manifest.method !== "sqlite-vacuum-into") {
    throw new Error(`backup incompatible: método ${String(manifest.method)} no reconocido`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("backup corrupto: manifiesto sin archivos");
  }
  return manifest as BackupManifest;
}

/**
 * Verifica un backup SOLO LECTURA (hashes, integridad SQLite, schema y
 * correspondencia de journal). Cualquier problema lanza un error explícito sin
 * escribir en `backupDir`.
 */
export function verifyBackup(backupDir: string): BackupManifest {
  const manifest = readManifest(backupDir);
  for (const entry of manifest.files) {
    const path = join(backupDir, entry.name);
    if (!existsSync(path)) {
      throw new Error(`backup corrupto: falta el archivo ${entry.name} declarado en el manifiesto`);
    }
    const actual = sha256OfFile(path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`backup corrupto: ${entry.name} no coincide con el manifiesto (hash/tamaño alterado)`);
    }
  }
  const snapshotPath = join(backupDir, manifest.dbFile);
  const journal = inspectSnapshot(snapshotPath, "backup");
  if (
    journal.events !== manifest.journal.events ||
    journal.requests !== manifest.journal.requests ||
    journal.receipts !== manifest.journal.receipts
  ) {
    throw new Error("backup corrupto: el resumen de journal del manifiesto no corresponde con la copia");
  }
  return manifest;
}

/**
 * Restaura un backup en un directorio destino NUEVO (debe estar vacío o no
 * existir). Nunca escribe en el origen: si algo falla tras la copia, se limpia
 * el destino y se deja el backup intacto.
 */
export function restoreBackup(input: RestoreBackupInput): RestoreReport {
  const nowMs = input.nowMs ?? Date.now();
  // 1) verificación de solo lectura del origen (nunca se modifica).
  const manifest = verifyBackup(input.backupDir);
  if (existsSync(input.targetDir)) {
    const entries = readdirSync(input.targetDir);
    if (entries.length > 0) {
      throw new Error(`destino de restore ya existe y no está vacío: ${input.targetDir} (no se sobrescribe nada en silencio)`);
    }
  }
  mkdirSync(input.targetDir, { recursive: true });
  try {
    // 2) copia aislada al destino (el snapshot es un SQLite completo, sin WAL).
    const dbTarget = join(input.targetDir, DB_FILE_NAME);
    copyFileSync(join(input.backupDir, manifest.dbFile), dbTarget);
    chmodSync(dbTarget, ARTIFACT_MODE);

    // 3) verificación de la copia + política conservadora de invalidación.
    const { journal, invalidated } = verifyAndFenceRestoredCopy(dbTarget);

    // 4) autoridad NO restaurada: sin grants provisionados no hay autenticación.
    const restoredGrants = join(input.targetDir, GRANTS_FILE_NAME);
    if (existsSync(restoredGrants)) {
      throw new Error("la copia restaurada no debe contener grants provisionados: la reautorización es explícita");
    }
    const report: RestoreReport = {
      restoredAtMs: nowMs,
      targetDir: input.targetDir,
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      integrity: "ok",
      writerLock: "reset",
      journal,
      journalCorrespondence: "ok",
      permissions: { dbMode: ARTIFACT_MODE, reportMode: ARTIFACT_MODE },
      invalidated,
      requiresReauthorization: [...manifest.grantIds],
      policy: RESTORE_POLICY,
    };
    const reportPath = join(input.targetDir, RESTORE_REPORT_NAME);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    chmodSync(reportPath, ARTIFACT_MODE);
    // Permisos exigidos en el destino (el reporte declara lo aplicado).
    if ((statSync(dbTarget).mode & 0o777) !== ARTIFACT_MODE) {
      throw new Error(`permisos inseguros en la copia restaurada: ${dbTarget}`);
    }
    return report;
  } catch (error) {
    // Fallo explícito: se retira la copia parcial y el origen queda intacto.
    rmSync(input.targetDir, { recursive: true, force: true });
    throw error;
  }
}
