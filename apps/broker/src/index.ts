/**
 * `@session-broker/server` — broker durable y autorizado (P-002 / G-001).
 *
 * Superficie pública CONGELADA (`docs/contracts/packages.md`): `BrokerServerOptions`,
 * `BrokerServer` y `createBrokerServer`. Todo lo demás (store SQLite, rutas,
 * autorización interna, transporte) es privado; los tests de P-002 consumen
 * solo estos exports y los fixtures de `@session-broker/protocol`.
 *
 * El servidor es un único proceso lógico (Bun + SQLite nativos, sin deps
 * externas) que acepta conexiones WS/WSS outbound de clientes y adaptadores.
 * No ejecuta inferencia, no lanza sesiones nativas, no conoce proveedores.
 */

import { BrokerServerImpl } from "./server";

export interface BrokerServerOptions {
  /** Por defecto `127.0.0.1`. */
  host?: string;
  /** `0` = puerto efímero (fixtures/tests). */
  port: number;
  /** SQLite + journals (TMP en tests; user data en operación, nunca worktrees). */
  dataDir: string;
  /** HMAC de root proofs (config de usuario). Sin él, `root.binding` queda unsupported. */
  macKey?: string;
  /** Reloj inyectable para tests. */
  now?: () => number;
  /**
   * Sink de logs estructurados (JSON por línea, redactados). Aditivo de P-005:
   * sin él, solo se emiten `warn`/`error` a stderr; jamás credenciales, MAC
   * keys ni payloads sensibles.
   */
  logSink?: (line: string) => void;
}

export interface BrokerServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly activeConnections: number;
}

export function createBrokerServer(options: BrokerServerOptions): BrokerServer {
  return new BrokerServerImpl(options);
}

/**
 * Operación y recovery (aditivos P-005, sin tocar las firmas congeladas):
 * backup/restore consistentes del store (`docs/operations`) y logs
 * estructurados redactados. Ver `./backup` y `./log`.
 */
export {
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_NAME,
  RESTORE_POLICY,
  RESTORE_REPORT_NAME,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "./backup";
export type {
  BackupFileEntry,
  BackupJournalSummary,
  BackupManifest,
  BackupMethod,
  CreateBackupInput,
  CreateBackupResult,
  RestoreBackupInput,
  RestoreReport,
} from "./backup";
export { createLogger, redactLogValue } from "./log";
export type { LogFields, LogLevel, Logger, LoggerOptions } from "./log";
