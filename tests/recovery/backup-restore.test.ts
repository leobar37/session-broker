/**
 * Backup consistente y restore conservador (FR-009 / NFR-004).
 *
 * Cubre los criterios binarios de la fase 05:
 *   - backup con método SOPORTADO (`VACUUM INTO`, nada de copia ingenua de un
 *     archivo activo ignorando el WAL) con manifiesto de hashes/journal;
 *   - restore a un TMP nuevo verificando schema/versión/integridad,
 *     correspondencia de journal y permisos;
 *   - backup corrupto/incompatible falla explícito SIN tocar el origen;
 *   - política conservadora tras restore: no reviven conexiones,
 *     leases/epochs obsoletos ni grants revocados; la reautorización es
 *     explícita y visible; `outcome_unknown` y dedup/recibos se conservan y
 *     jamás convierten un request incierto en trabajo nuevo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  BACKUP_MANIFEST_NAME,
  createBackup,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
  type RestoreReport,
} from "@session-broker/server";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  closePeers,
  freshIdentity,
  openPeer,
  sessionRefFor,
  setupIsolation,
  sleep,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type FakePeer,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const CREDENTIAL_READER = "fixture-reader-credential-not-a-real-secret";

const identity = freshIdentity();
let isolation: Isolation;

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  isolation = setupIsolation("recovery-backup");
});

afterAll(async () => {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch {
      // teardown best-effort
    }
  }
  cleanups.length = 0;
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

interface LiveFixture {
  readonly dataDir: string;
  readonly broker: BrokerHandle;
  readonly grant: Record<string, unknown>;
  readonly readerGrant: Record<string, unknown>;
  openHolder(sessionId: string): Promise<FakePeer>;
  openReader(): Promise<FakePeer>;
}

async function startLive(name: string): Promise<LiveFixture> {
  const dataDir = join(isolation.tmpDir, `live-${name}`);
  mkdirSync(dataDir, { recursive: true });
  const grant = testGrant({
    projectId: identity.projectId,
    capabilities: [...ALL_ADAPTER_CAPABILITIES],
    issuedAtMs: isolation.clock.nowMs - 60_000,
    expiresAtMs: isolation.clock.nowMs + 86_400_000,
  });
  const readerGrant = testGrant({
    projectId: identity.projectId,
    capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    issuedAtMs: isolation.clock.nowMs - 60_000,
    expiresAtMs: isolation.clock.nowMs + 86_400_000,
  });
  writeGrants(dataDir, [
    { credential: CREDENTIAL, grant },
    { credential: CREDENTIAL_READER, grant: readerGrant },
  ]);
  const broker = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
  cleanups.push(() => broker.close());
  return {
    dataDir,
    broker,
    grant,
    readerGrant,
    async openHolder(sessionId: string): Promise<FakePeer> {
      const peer = await openPeer({
        url: broker.url,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        instanceId: newInstanceId(),
        nativeSessionId: sessionId,
        grantId: String(grant["grantId"]),
        credential: CREDENTIAL,
        capabilities: [...ALL_ADAPTER_CAPABILITIES],
      });
      cleanups.push(() => peer.close());
      return peer;
    },
    async openReader(): Promise<FakePeer> {
      const peer = await openPeer({
        url: broker.url,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        instanceId: newInstanceId(),
        grantId: String(readerGrant["grantId"]),
        credential: CREDENTIAL_READER,
        capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
      });
      cleanups.push(() => peer.close());
      return peer;
    },
  };
}

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

function newAskPayload(question: string): Record<string, unknown> {
  return { question, deadlineMs: 300_000, policy: "when_idle" };
}

/** Huella de los archivos del backup para demostrar que el origen no cambia. */
function footprint(dir: string): string[] {
  return ["broker.sqlite", "grants.json", BACKUP_MANIFEST_NAME]
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => {
      const stat = statSync(join(dir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    });
}

describe("backup consistente (método soportado, nada de copia ingenua)", () => {
  test("el backup en vivo declara método, hashes, journal y permisos restrictivos", async () => {
    const live = await startLive("backup-method");
    const sessionId = "session-backup";
    const holder = await live.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const askId = newRequestId();
    const payload = newAskPayload("antes del backup");
    const mark = holder.mark();
    await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");

    const backupDir = join(isolation.tmpDir, "backup-method");
    const { manifest } = createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });

    // Método soportado declarado; jamás una copia ingenua del archivo activo.
    expect(manifest.method).toBe("sqlite-vacuum-into");
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(backupDir, "broker.sqlite-wal"))).toBe(false);
    expect(existsSync(join(backupDir, "broker.sqlite-shm"))).toBe(false);
    expect(manifest.journal.requests).toBe(1);
    expect(manifest.journal.events).toBeGreaterThanOrEqual(3);
    expect(manifest.grantIds.length).toBe(2);
    for (const name of ["broker.sqlite", "grants.json", BACKUP_MANIFEST_NAME]) {
      expect((statSync(join(backupDir, name)).mode & 0o777) === 0o600).toBe(true);
    }
    // El contenido jamás incluye credenciales en claro.
    const grantsText = readFileSync(join(backupDir, "grants.json"), "utf8");
    expect(grantsText.includes(CREDENTIAL)).toBe(false);
    expect(grantsText.includes(CREDENTIAL_READER)).toBe(false);
    await closePeers([holder]);
  });

  test("un destino no vacío se rechaza en silencio cero (sin sobrescritura)", async () => {
    const live = await startLive("backup-dest");
    const backupDir = join(isolation.tmpDir, "backup-dest");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "ocupado.txt"), "no pisar", "utf8");
    expect(() => createBackup({ dataDir: live.dataDir, destDir: backupDir })).toThrow(/no está vacío/);
    expect(readFileSync(join(backupDir, "ocupado.txt"), "utf8")).toBe("no pisar");
  });
});

describe("restore a TMP nuevo con verificación y política conservadora", () => {
  test("restore: integridad, schema, journal, permisos y reporte de reautorización", async () => {
    const live = await startLive("restore-ok");
    const sessionId = "session-restore";
    const holder = await live.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const askId = newRequestId();
    const uncertainId = newRequestId();
    const payload = newAskPayload("conservado");
    const uncertainPayload = newAskPayload("incierto");
    const mark = holder.mark();
    await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    const secondMark = holder.mark();
    await holder.request({ operation: "ask", target: targetOf(sessionId), payload: uncertainPayload, requestId: uncertainId });
    await holder.nextFrame(secondMark, "segunda entrega");
    // Ventana de crash real: `received` sin resultado => outcome_unknown.
    await holder.report(uncertainId, "received");
    holder.close();
    await sleep(50);

    const backupDir = join(isolation.tmpDir, "backup-restore-ok");
    const { manifest } = createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });
    const targetDir = join(isolation.tmpDir, "restore-ok-target");
    const report: RestoreReport = restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs });

    expect(report.integrity).toBe("ok");
    expect(report.journalCorrespondence).toBe("ok");
    expect(report.storeSchemaVersion).toBe(1);
    expect(report.permissions.dbMode).toBe(0o600);
    // La autoridad NO se restaura: la reautorización es explícita y visible.
    expect(report.requiresReauthorization).toEqual(manifest.grantIds);
    expect(existsSync(join(targetDir, "grants.json"))).toBe(false);
    expect(report.invalidated.sessions).toBe(1);
    expect(report.invalidated.controlEpochBumped).toBe(1);
    expect(report.invalidated.holdersCleared).toBe(1);
    // El lock de escritor NO viaja en el restore: el pid/token del escritor
    // original es autoridad vieja sobre OTRO archivo. La copia es una
    // instancia de store nueva que adquiere su propio lock al abrir.
    expect(report.writerLock).toBe("reset");

    // Sin grants provisionados, NADA autentica contra la copia restaurada. El
    // store original sigue VIVO y escribiendo en su propio archivo mientras la
    // copia abre: dos instancias, dos locks (la exclusión de segundo escritor
    // es por store, no global; ver test «el segundo escritor…»).
    const restored = await startBroker({ dataDir: targetDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => restored.close());
    const denied = await openPeer({
      url: restored.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: String(live.grant["grantId"]),
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => denied.close());
    await waitForValue(
      () => (denied.errors.length > 0 || denied.closeCode !== undefined ? true : undefined),
      "denegación de la autoridad no restaurada",
    );
    expect(denied.welcome).toBeUndefined();

    // Reautorización EXPLÍCITA del operador: provisionar de nuevo los grants.
    writeGrants(targetDir, [
      { credential: CREDENTIAL, grant: live.grant },
      { credential: CREDENTIAL_READER, grant: live.readerGrant },
    ]);
    const reader = await openPeer({
      url: restored.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: String(live.readerGrant["grantId"]),
      credential: CREDENTIAL_READER,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });
    cleanups.push(() => reader.close());

    // Dedup/recibos conservados: el MISMO requestId+hash no crea trabajo nuevo.
    const replay = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect((replay["result"] as Record<string, unknown>)["replay"]).toBe(true);
    const record = (replay["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(record["state"]).toBe("queued");
    const receipts = record["receipts"] as { state: string }[];
    expect(receipts.map((entry) => entry.state)).toEqual(["queued"]);

    // La incertidumbre antigua NO se convierte en trabajo nuevo.
    const uncertainReplay = await reader.request({
      operation: "ask",
      target: targetOf(sessionId),
      payload: uncertainPayload,
      requestId: uncertainId,
    });
    const uncertainRecord = (uncertainReplay["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(uncertainRecord["state"]).toBe("outcome_unknown");
    await closePeers([reader]);
  });

  test("la autoridad vieja no revive: leases/instances/epochs quedan invalidados", async () => {
    const live = await startLive("restore-fencing");
    const sessionId = "session-fencing";
    const holder = await live.openHolder(sessionId);
    await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const askId = newRequestId();
    const payload = newAskPayload("fencing");
    const mark = holder.mark();
    await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    const epochBefore = await holder.request({
      operation: "inspect",
      target: targetOf(sessionId),
      payload: { fields: ["controlEpoch"] },
    });
    const oldEpoch = Number((epochBefore["result"] as Record<string, unknown>)["controlEpoch"]);

    const backupDir = join(isolation.tmpDir, "backup-fencing");
    createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });
    const targetDir = join(isolation.tmpDir, "restore-fencing-target");
    const fenceReport = restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs });
    // El lock de escritor NO viaja: la copia abre aunque el escritor original
    // (mismo proceso, OTRO archivo) siga vivo con su pid/token.
    expect(fenceReport.writerLock).toBe("reset");
    writeGrants(targetDir, [
      { credential: CREDENTIAL, grant: live.grant },
      { credential: CREDENTIAL_READER, grant: live.readerGrant },
    ]);

    const restored = await startBroker({ dataDir: targetDir, clock: isolation.clock, macKey: MAC_KEY });
    cleanups.push(() => restored.close());
    const reader = await openPeer({
      url: restored.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: String(live.readerGrant["grantId"]),
      credential: CREDENTIAL_READER,
      capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
    });
    cleanups.push(() => reader.close());

    // Identidades separadas: el restore no colapsa nativeSessionId/sessionRef/
    // instanceId; el holder viejo queda sin instancia y con epoch + 1.
    const inspected = await reader.request({
      operation: "inspect",
      target: targetOf(sessionId),
      payload: { fields: ["controlEpoch", "instanceId", "presence", "sessionRef"] },
    });
    const summary = inspected["result"] as Record<string, unknown>;
    expect(Number(summary["controlEpoch"])).toBe(oldEpoch + 1);
    expect(summary["instanceId"]).toBe(null);
    expect(summary["presence"]).toBe("offline");
    const sessionRef = summary["sessionRef"] as Record<string, unknown>;
    expect(sessionRef["nativeSessionId"]).toBe(sessionId);
    expect(sessionRef["target"]).toBe("omp");
    expect(sessionRef["projectId"]).toBe(identity.projectId);

    // Un control con el epoch viejo queda fuera de juego (fencing). El probe
    // usa el grant del TITULAR (que sí tiene capacidades de control): lo que
    // se verifica es el fencing del epoch restaurado, no el scope del grant.
    const controller = await openPeer({
      url: restored.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: String(live.grant["grantId"]),
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => controller.close());
    const stale = await controller.request({
      operation: "control",
      target: targetOf(sessionId),
      payload: { verb: "abort" },
      controlEpoch: oldEpoch,
    });
    expect(stale["state"]).toBe("rejected");
    const staleError = stale["error"] as { code: string; reason: string };
    expect(staleError.code).toBe("STALE_CONTROL_EPOCH");
    expect(staleError.reason).toBe("stale_control_epoch");
  });

  test("backup corrupto falla explícito y el origen queda intacto", async () => {
    const live = await startLive("backup-corrupt");
    const backupDir = join(isolation.tmpDir, "backup-corrupt");
    createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });

    // Alteración de la copia: el manifiesto ya no coincide.
    const snapshotPath = join(backupDir, "broker.sqlite");
    const bytes = readFileSync(snapshotPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(snapshotPath, bytes);
    const before = footprint(backupDir);
    const targetDir = join(isolation.tmpDir, "restore-corrupt-target");
    expect(() => restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs })).toThrow(/corrupto/);
    expect(() => verifyBackup(backupDir)).toThrow(/corrupto/);
    // Ni destino parcial ni escrituras sobre el origen.
    expect(existsSync(targetDir)).toBe(false);
    expect(footprint(backupDir)).toEqual(before);
  });

  test("backup incompatible (schema/formato) falla explícito sin restaurar nada", async () => {
    const live = await startLive("backup-incompat");
    const backupDir = join(isolation.tmpDir, "backup-incompat");
    const { manifestPath } = createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, storeSchemaVersion: 2 }, null, 2)}\n`, "utf8");
    const targetDir = join(isolation.tmpDir, "restore-incompat-target");
    const beforeSchema = footprint(backupDir);
    expect(() => restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs })).toThrow(/incompatible/);
    expect(existsSync(targetDir)).toBe(false);
    expect(footprint(backupDir)).toEqual(beforeSchema);

    const manifest2 = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest2, formatVersion: 99 }, null, 2)}\n`, "utf8");
    const beforeFormat = footprint(backupDir);
    expect(() => restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs })).toThrow(/incompatible/);
    expect(existsSync(targetDir)).toBe(false);
    // El origen nunca se escribe durante los intentos fallidos.
    expect(footprint(backupDir)).toEqual(beforeFormat);
  });

  test("restore sobre destino no vacío se rechaza sin sobrescribir", async () => {
    const live = await startLive("restore-occupied");
    const backupDir = join(isolation.tmpDir, "backup-restore-occupied");
    createBackup({ dataDir: live.dataDir, destDir: backupDir, nowMs: isolation.clock.nowMs });
    const targetDir = join(isolation.tmpDir, "restore-occupied-target");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "preexistente.txt"), "intocable", "utf8");
    expect(() => restoreBackup({ backupDir, targetDir, nowMs: isolation.clock.nowMs })).toThrow(/no está vacío/);
    expect(readFileSync(join(targetDir, "preexistente.txt"), "utf8")).toBe("intocable");
  });
});
