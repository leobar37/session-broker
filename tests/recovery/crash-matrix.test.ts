/**
 * Matriz de fronteras de crash (FR-007) — `tests/recovery`.
 *
 * Cada fila de la tabla de `docs/contracts/durability.md` (y de la fase 05)
 * tiene aquí un fixture y un resultado durable esperado:
 *
 *   1. antes de commit queued  -> sin afirmar aceptación; retry mismo
 *      requestId/hash respeta dedup sin segundo efecto;
 *   2. queued → envío          -> request/journal consultables; entrega por
 *      recibos/deadline/grant/epoch ACTUALES;
 *   3. envío → received        -> sin evidencia durable no hay entrega ciega:
 *      `outcome_unknown` o re-entrega idempotente según recibos;
 *   4. received → ACK          -> el reenvío de recibos recupera la MISMA
 *      identidad, jamás un segundo efecto;
 *   5. submitted → resultado   -> la llamada nativa NO es `completed`; la duda
 *      se conserva como `outcome_unknown` (solo reconciliación con evidencia);
 *   6. completed → consumidor  -> consulta/replay devuelve el resultado
 *      ORIGINAL sin nueva llamada;
 *   7. revocación/takeover/timeout concurrentes -> fencing y permisos
 *      vigentes; un restore jamás resucita autoridad vieja (ver
 *      `backup-restore.test.ts`).
 *
 * Además: kill real del broker (SIGKILL), desconexión de cliente y pérdida de
 * ACK. Nada de exactly-once externo ni replay de tools; `nativeSessionId`,
 * `sessionRef` e `instanceId` jamás se colapsan.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  closePeers,
  expectError,
  expectResponseError,
  freshIdentity,
  openPeer,
  sessionRefFor,
  setupIsolation,
  sleep,
  spawnBrokerProcess,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type ChildBroker,
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
  isolation = setupIsolation("recovery-crash");
});

afterAll(async () => {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch {
      // el teardown best-effort no debe ocultar el fallo del test
    }
  }
  cleanups.length = 0;
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

interface Fixture {
  readonly dataDir: string;
  readonly broker: BrokerHandle;
  readonly grant: Record<string, unknown>;
  readonly readerGrant: Record<string, unknown>;
  /** Reescribe el archivo de grants (revocaciones incluidas); sin credenciales en claro en disco más allá del hash. */
  provisionGrants(entries: readonly { credential: string; grant: Record<string, unknown> }[]): void;
  openHolder(sessionId: string, instanceId?: string): Promise<FakePeer>;
  openReader(): Promise<FakePeer>;
}

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

function newAskPayload(question: string): Record<string, unknown> {
  return { question, deadlineMs: 300_000, policy: "when_idle" };
}

async function startFixture(name: string): Promise<Fixture> {
  const dataDir = join(isolation.tmpDir, `data-${name}`);
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
    provisionGrants(entries) {
      writeGrants(dataDir, entries);
    },
    async openHolder(sessionId: string, instanceId?: string): Promise<FakePeer> {
      const peer = await openPeer({
        url: broker.url,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        instanceId: instanceId ?? newInstanceId(),
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

/** Registro raíz del titular (root proof ligada al challenge de ESTE welcome). */
async function registerHolder(peer: FakePeer): Promise<void> {
  const frame = await bindRoot(peer, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
  expect(frame.kind).toBe("event");
}

/**
 * Consulta durable del request: reenviar el MISMO requestId+MISMO payload
 * devuelve el registro completo (estado + recibos) sin efectos nuevos.
 */
async function consult(
  reader: FakePeer,
  requestId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const replay = await reader.request({
    operation: "ask",
    target: targetOf(sessionId),
    payload,
    requestId,
  });
  const result = replay["result"] as Record<string, unknown>;
  return result["record"] as Record<string, unknown>;
}

function receiptsOf(record: Record<string, unknown>): string[] {
  const receipts = record["receipts"] as { state: string }[];
  return receipts.map((receipt) => receipt.state);
}

async function historyTopics(reader: FakePeer, sessionId: string): Promise<string[]> {
  const history = await reader.request({
    operation: "history",
    target: targetOf(sessionId),
    payload: { fromEventSeq: 1, limit: 200 },
  });
  const items = (history["result"] as Record<string, unknown>)["items"] as Record<string, unknown>[];
  return items.map((item) => String(item["topic"]));
}

describe("matriz de fronteras de crash (FR-007)", () => {
  test("antes de commit queued: sin aceptación afirmada y retry con mismo requestId/hash sin segundo efecto", async () => {
    const fixture = await startFixture("r1");
    const sessionId = "session-r1";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("¿arranco?");

    // (a) Rechazo PRE-efecto (objetivo sin registrar): no hay recibo `queued`.
    const early = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(early["state"]).toBe("rejected");
    expectResponseError(early, "TARGET_OFFLINE", "target_offline");

    // (b) El MISMO requestId+hash ya procesado es nuevo (una sola ejecución).
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    const queued = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");
    const delivery = await holder.nextFrame(mark, "entrega del ask");
    expect(delivery["topic"]).toBe("broker.ask");
    const deliveryData = delivery["data"] as Record<string, unknown>;
    expect(deliveryData["requestId"]).toBe(askId);

    // (c) El reintento posterior es replay idempotente: cero efectos nuevos.
    const replay = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect((replay["result"] as Record<string, unknown>)["replay"]).toBe(true);
    const record = (replay["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(record["state"]).toBe("queued");
    expect(receiptsOf(record)).toEqual(["queued"]);
    // Evidencia durable: el journal tiene UNA sola entrega, no dos.
    const topics = await historyTopics(reader, sessionId);
    expect(topics.filter((topic) => topic === "broker.ask").length).toBe(1);
    expect(holder.events.filter((event) => event["topic"] === "broker.ask").length).toBe(1);
    await closePeers([reader, holder]);
  });

  test("queued → envío: consultable, re-entrega con la MISMA identidad y deadline vigente", async () => {
    const fixture = await startFixture("r2");
    const sessionId = "session-r2";
    const reader = await fixture.openReader();
    // La sesión está REGISTRADA pero el titular no está: el ask queda durable
    // (`queued`) sin haberse enviado a nadie (frontera queued → envío).
    const primer = await fixture.openHolder(sessionId);
    await registerHolder(primer);
    primer.close();
    await sleep(50);
    const askId = newRequestId();
    const payload = newAskPayload("espera");

    // (a) Sin titular conectado el ask queda durable y consultable.
    const queued = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");
    const before = await consult(reader, askId, sessionId, payload);
    expect(before["state"]).toBe("queued");
    expect(receiptsOf(before)).toEqual(["queued"]);

    // (b) La entrega al titular reutiliza el eventId/eventSeq del journal.
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const delivered = await waitForValue(
      () => holder.events.find((event) => event["topic"] === "broker.ask"),
      "entrega del ask al titular",
    );
    const firstEventId = delivered["eventId"];
    const firstEventSeq = delivered["eventSeq"];
    holder.close();

    // Reconexión del MISMO proceso (misma instancia): re-entrega idéntica.
    const holderAgain = await fixture.openHolder(sessionId, holder.input.instanceId);
    await registerHolder(holderAgain);
    const redelivered = await waitForValue(
      () => holderAgain.events.find((event) => event["topic"] === "broker.ask"),
      "re-entrega del ask al titular",
    );
    expect(redelivered["eventId"]).toBe(firstEventId);
    expect(redelivered["eventSeq"]).toBe(firstEventSeq);

    // (c) El plazo ACTUAL manda: vencido el deadline el reply no tiene efectos.
    isolation.clock.advance(400_000);
    const late = await holderAgain.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askId, body: "tarde" },
    });
    expectResponseError(late, "EXPIRED", "deadline_out_of_bounds");
    const after = await consult(reader, askId, sessionId, payload);
    expect(after["state"]).toBe("expired");
    expect(receiptsOf(after)).toEqual(["queued", "expired"]);
    await closePeers([reader, holderAgain]);
  });

  test("queued → envío: sin permisos vigentes NO se entrega (grant revocado)", async () => {
    const fixture = await startFixture("r2b");
    const sessionId = "session-r2b";
    const reader = await fixture.openReader();
    // Sesión registrada, titular retirado: el ask queda `queued` sin enviarse.
    const primer = await fixture.openHolder(sessionId);
    await registerHolder(primer);
    primer.close();
    await sleep(50);
    const askId = newRequestId();
    const payload = newAskPayload("¿llego?");
    const queued = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");

    // Revocación del grant del titular ANTES de que se registre; el del
    // lector sigue vigente para poder auditar el estado durable.
    fixture.provisionGrants([
      { credential: CREDENTIAL, grant: { ...fixture.grant, revokedAtMs: isolation.clock.nowMs } },
      { credential: CREDENTIAL_READER, grant: fixture.readerGrant },
    ]);
    const holder = await fixture.openHolder(sessionId);
    await waitForValue(
      () => (holder.errors.length > 0 || holder.closeCode !== undefined ? true : undefined),
      "rechazo del handshake del titular revocado",
    );
    expect(holder.welcome).toBeUndefined();

    // El ask sigue queued y NUNCA se entregó.
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("queued");
    expect(receiptsOf(record)).toEqual(["queued"]);
    const topics = await historyTopics(reader, sessionId);
    expect(topics.filter((topic) => topic === "broker.ask").length).toBe(1);
    await closePeers([reader, holder]);
  });

  test("envío → received: sin recibo durable NO hay entrega ciega (re-entrega idempotente por recibos)", async () => {
    const fixture = await startFixture("r3a");
    const sessionId = "session-r3a";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("sin recibo");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    const queued = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");
    const delivered = await holder.nextFrame(mark, "entrega del ask");
    expect(delivered["topic"]).toBe("broker.ask");
    // El titular muere SIN reportar `received`: la evidencia durable dice que
    // el journal incoming nunca existió.
    holder.close();
    await sleep(50);
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("queued");
    expect(receiptsOf(record)).toEqual(["queued"]);

    // La re-entrega reutiliza la MISMA identidad de evento (sin trabajo nuevo).
    const holderAgain = await fixture.openHolder(sessionId, holder.input.instanceId);
    await registerHolder(holderAgain);
    const redelivered = await waitForValue(
      () => holderAgain.events.find((event) => event["topic"] === "broker.ask"),
      "re-entrega idempotente del ask",
    );
    expect(redelivered["eventId"]).toBe(delivered["eventId"]);
    expect(redelivered["eventSeq"]).toBe(delivered["eventSeq"]);
    expect(holderAgain.events.filter((event) => event["topic"] === "broker.ask").length).toBe(1);
    await closePeers([reader, holderAgain]);
  });

  test("envío → received: lo entregado sin confirmar queda outcome_unknown y jamás se re-entrega", async () => {
    const fixture = await startFixture("r3b");
    const sessionId = "session-r3b";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("en vuelo");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    const delivered = await holder.nextFrame(mark, "entrega del ask");
    expect(delivered["topic"]).toBe("broker.ask");
    // El journal incoming SÍ existe (`received`) y luego cae todo.
    const reported = await holder.report(askId, "received");
    expect(reported["kind"]).toBe("response");
    expect(reported["state"]).toBe("received");
    holder.close();
    await sleep(50);

    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("outcome_unknown");
    expect(receiptsOf(record)).toEqual(["queued", "received", "outcome_unknown"]);
    expect((record["error"] as { code: string }).code).toBe("OUTCOME_UNKNOWN");

    // Reintento con mismo requestId/hash: recupera el MISMO registro, sin efectos.
    const replay = await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect((replay["result"] as Record<string, unknown>)["replay"]).toBe(true);

    // Un titular nuevo NO recibe re-entrega alguna (nunca entrega ciega).
    const holderNext = await fixture.openHolder(sessionId);
    await registerHolder(holderNext);
    await sleep(50);
    expect(holderNext.events.filter((event) => event["topic"] === "broker.ask").length).toBe(0);

    // Completar sin evidencia explícita está prohibido.
    const completion = await holderNext.report(askId, "completed");
    expectError(completion, "INVALID_INPUT", "outcome_unknown_no_replay");
    const still = await consult(reader, askId, sessionId, payload);
    expect(still["state"]).toBe("outcome_unknown");
    await closePeers([reader, holderNext]);
  });

  test("received → ACK: el reenvío de recibos recupera la MISMA identidad sin segundo efecto", async () => {
    const fixture = await startFixture("r4");
    const sessionId = "session-r4";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("ack perdido");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");

    // Reporte aplicado, pero el ACK se perdió: el emisor lo reenvía.
    const first = await holder.report(askId, "received");
    expect(first["state"]).toBe("received");
    const retry = await holder.report(askId, "received");
    // El reintento NO crea identidad nueva ni transiciona en silencio.
    expectError(retry, "INVALID_INPUT", "invalid_transition");

    const record = await consult(reader, askId, sessionId, payload);
    expect(record["requestId"]).toBe(askId);
    expect(record["state"]).toBe("received");
    expect(receiptsOf(record)).toEqual(["queued", "received"]);
    await closePeers([reader, holder]);
  });

  test("submitted → resultado: la llamada nativa NO es completed; la duda se conserva", async () => {
    const fixture = await startFixture("r5");
    const sessionId = "session-r5";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("nativa");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    const received = await holder.report(askId, "received");
    expect(received["state"]).toBe("received");
    const submitted = await holder.report(askId, "submitted");
    expect(submitted["state"]).toBe("submitted");

    // Llamada nativa hecha ≠ resultado definido: NO es `completed`.
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("submitted");
    expect(record["result"] ?? null).toBe(null);

    // Sin resultado durable la duda sobrevive a la caída del titular.
    holder.close();
    await sleep(50);
    const uncertain = await consult(reader, askId, sessionId, payload);
    expect(uncertain["state"]).toBe("outcome_unknown");

    // Solo la reconciliación explícita con evidencia resuelve la incertidumbre.
    const holderNext = await fixture.openHolder(sessionId);
    await registerHolder(holderNext);
    const withoutEvidence = await holderNext.report(askId, "completed");
    expectError(withoutEvidence, "INVALID_INPUT", "outcome_unknown_no_replay");
    const reconciled = await holderNext.report(askId, "completed", {
      result: { replyRequestId: newRequestId(), body: "respuesta" },
    });
    expect(reconciled["state"]).toBe("completed");
    const final = await consult(reader, askId, sessionId, payload);
    expect(final["state"]).toBe("completed");
    await closePeers([reader, holderNext]);
  });

  test("completed → consumidor: el resultado ORIGINAL se consulta sin nueva llamada", async () => {
    const fixture = await startFixture("r6");
    const sessionId = "session-r6";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("resultado");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    await holder.report(askId, "received");
    await holder.report(askId, "submitted");
    const replyId = newRequestId();
    const reply = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askId, body: "respuesta original", summary: "ok" },
      requestId: replyId,
    });
    expect(reply["state"]).toBe("completed");

    // El consumidor NO vio el evento: consulta y replay devuelven el resultado
    // ORIGINAL y no se duplica NINGÚN evento de entrega (cero nuevas llamadas).
    // Nota de timeline: cada consulta `history` es ella misma una solicitud
    // durable y añade sus eventos de ciclo de vida al journal (commit +
    // receive/submit/complete); por eso la comparación se hace sobre los
    // eventos de ENTREGA (`broker.ask`), que son los que un replay no duplica.
    const deliveriesBefore = (await historyTopics(reader, sessionId)).filter((topic) => topic === "broker.ask");
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("completed");
    const result = record["result"] as Record<string, unknown>;
    expect(result["body"]).toBe("respuesta original");
    expect(result["replyRequestId"]).toBe(replyId);
    expect(receiptsOf(record)).toEqual(["queued", "received", "submitted", "completed"]);
    const deliveriesAfter = (await historyTopics(reader, sessionId)).filter((topic) => topic === "broker.ask");
    expect(deliveriesBefore.length).toBe(1);
    expect(deliveriesAfter.length).toBe(deliveriesBefore.length);
    await closePeers([reader, holder]);
  });

  test("takeover y retorno tardío: la instancia vieja pierde autoridad (fencing)", async () => {
    const fixture = await startFixture("r7");
    const sessionId = "session-r7";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("autoridad");
    const holderA = await fixture.openHolder(sessionId);
    await registerHolder(holderA);
    const mark = holderA.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holderA.nextFrame(mark, "entrega del ask");
    await holderA.report(askId, "received");
    const epochA = await reader.request({
      operation: "inspect",
      target: targetOf(sessionId),
      payload: { fields: ["controlEpoch"] },
    });
    const epochBefore = Number((epochA["result"] as Record<string, unknown>)["controlEpoch"]);

    // Takeover: una instancia NUEVA toma la sesión (epoch + 1).
    const holderB = await fixture.openHolder(sessionId);
    await registerHolder(holderB);
    const epochB = await reader.request({
      operation: "inspect",
      target: targetOf(sessionId),
      payload: { fields: ["controlEpoch"] },
    });
    const epochAfter = Number((epochB["result"] as Record<string, unknown>)["controlEpoch"]);
    expect(epochAfter).toBe(epochBefore + 1);

    // La instancia VIEJA que vuelve tarde pierde autoridad de inmediato.
    const staleReport = await holderA.report(askId, "submitted");
    expectError(staleReport, "STALE_INSTANCE", "stale_instance");
    const staleControl = await holderA.request({
      operation: "control",
      target: targetOf(sessionId),
      payload: { verb: "abort" },
      controlEpoch: epochBefore,
    });
    expectResponseError(staleControl, "STALE_CONTROL_EPOCH", "stale_control_epoch");

    // El takeover deja la incertidumbre explícita sobre lo entregado sin
    // confirmar: jamás una cancelación ni un completado inventado.
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("outcome_unknown");
    await closePeers([reader, holderA, holderB]);
  });

  test("timeout concurrente: vencido el plazo el reply tardío no completa nada", async () => {
    const fixture = await startFixture("r7b");
    const sessionId = "session-r7b";
    const reader = await fixture.openReader();
    const askId = newRequestId();
    const payload = newAskPayload("plazo");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const mark = holder.mark();
    await reader.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    await holder.report(askId, "received");
    await holder.report(askId, "submitted");

    isolation.clock.advance(400_000);
    const lateReply = await holder.request({
      operation: "reply",
      target: targetOf(sessionId),
      payload: { replyTo: askId, body: "tarde" },
    });
    expectResponseError(lateReply, "EXPIRED", "deadline_out_of_bounds");
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("expired");
    expect(receiptsOf(record)).toEqual(["queued", "received", "submitted", "expired"]);
    await closePeers([reader, holder]);
  });

  test("desconexión de cliente: jamás completa ni cancela requests artificialmente", async () => {
    const fixture = await startFixture("r8");
    const sessionId = "session-r8";
    const askId = newRequestId();
    const payload = newAskPayload("cliente caído");
    const holder = await fixture.openHolder(sessionId);
    await registerHolder(holder);
    const asker = await fixture.openReader();
    const mark = holder.mark();
    await asker.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    asker.close();
    await sleep(50);

    // El estado durable sigue siendo el mismo: nada se completó "solo".
    const reader = await fixture.openReader();
    const record = await consult(reader, askId, sessionId, payload);
    expect(record["state"]).toBe("queued");
    expect(receiptsOf(record)).toEqual(["queued"]);
    await closePeers([reader, holder]);
  });
});

describe("kill real del broker (SIGKILL) y recuperación", () => {
  test("submitted sin resultado durable => outcome_unknown consultable, sin re-entrega ni replay", async () => {
    const dataDir = join(isolation.tmpDir, "data-kill");
    mkdirSync(dataDir, { recursive: true });
    const grant = testGrant({
      projectId: identity.projectId,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
      issuedAtMs: isolation.clock.nowMs - 60_000,
      expiresAtMs: isolation.clock.nowMs + 86_400_000,
    });
    writeGrants(dataDir, [{ credential: CREDENTIAL, grant }]);
    const grantId = String(grant["grantId"]);
    const entryPath = join(import.meta.dir, "..", "..", "apps", "broker", "src", "index.ts");
    const child: ChildBroker = await spawnBrokerProcess({
      tmpDir: isolation.tmpDir,
      home: isolation.home,
      dataDir,
      macKey: MAC_KEY,
      entryPath,
      nowMs: isolation.clock.nowMs,
    });
    cleanups.push(() => child.kill());

    const sessionId = "session-kill";
    const holder = await openPeer({
      url: `ws://127.0.0.1:${child.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await registerHolder(holder);
    const askId = newRequestId();
    const payload = newAskPayload("crash real");
    const mark = holder.mark();
    await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    await holder.nextFrame(mark, "entrega del ask");
    await holder.report(askId, "received");
    await holder.report(askId, "submitted");

    // SIGKILL: el proceso muere sin shutdown ordenado alguno.
    await child.kill();

    // Nuevo proceso sobre el MISMO store (el lock huérfano se reclama).
    const revived: ChildBroker = await spawnBrokerProcess({
      tmpDir: isolation.tmpDir,
      home: isolation.home,
      dataDir,
      macKey: MAC_KEY,
      entryPath,
      nowMs: isolation.clock.nowMs,
    });
    cleanups.push(() => revived.kill());
    const holderNext = await openPeer({
      url: `ws://127.0.0.1:${revived.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holderNext.close());
    await registerHolder(holderNext);

    // Recuperación conservadora: la ventana de crash es outcome_unknown.
    const afterKill = await holderNext.request({
      operation: "ask",
      target: targetOf(sessionId),
      payload,
      requestId: askId,
    });
    const record = (afterKill["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(record["state"]).toBe("outcome_unknown");
    expect(receiptsOf(record)).toEqual(["queued", "received", "submitted", "outcome_unknown"]);

    // Cero re-entrega ciega: el nuevo titular no recibe el ask.
    await sleep(50);
    expect(holderNext.events.filter((event) => event["topic"] === "broker.ask").length).toBe(0);

    // Completar sin evidencia sigue prohibido tras el reinicio.
    const completion = await holderNext.report(askId, "completed");
    expectError(completion, "INVALID_INPUT", "outcome_unknown_no_replay");
    await closePeers([holder, holderNext]);
    await revived.kill();
  });

  test("kill antes de entregar: el ask queued sobrevive y se re-entrega con la MISMA identidad", async () => {
    const dataDir = join(isolation.tmpDir, "data-kill-queued");
    mkdirSync(dataDir, { recursive: true });
    const grant = testGrant({
      projectId: identity.projectId,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
      issuedAtMs: isolation.clock.nowMs - 60_000,
      expiresAtMs: isolation.clock.nowMs + 86_400_000,
    });
    writeGrants(dataDir, [{ credential: CREDENTIAL, grant }]);
    const grantId = String(grant["grantId"]);
    const entryPath = join(import.meta.dir, "..", "..", "apps", "broker", "src", "index.ts");
    const child: ChildBroker = await spawnBrokerProcess({
      tmpDir: isolation.tmpDir,
      home: isolation.home,
      dataDir,
      macKey: MAC_KEY,
      entryPath,
      nowMs: isolation.clock.nowMs,
    });
    cleanups.push(() => child.kill());

    const sessionId = "session-kill-queued";
    const askId = newRequestId();
    const payload = newAskPayload("sobrevive");
    const asker = await openPeer({
      url: `ws://127.0.0.1:${child.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => asker.close());
    // Sesión registrada y titular retirado: el ask queda `queued` sin enviarse.
    const primer = await openPeer({
      url: `ws://127.0.0.1:${child.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    await registerHolder(primer);
    primer.close();
    await sleep(50);
    const queued = await asker.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    expect(queued["state"]).toBe("queued");
    await child.kill();

    const revived: ChildBroker = await spawnBrokerProcess({
      tmpDir: isolation.tmpDir,
      home: isolation.home,
      dataDir,
      macKey: MAC_KEY,
      entryPath,
      nowMs: isolation.clock.nowMs,
    });
    cleanups.push(() => revived.kill());
    const holder = await openPeer({
      url: `ws://127.0.0.1:${revived.port}`,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
    });
    cleanups.push(() => holder.close());
    await registerHolder(holder);
    const delivered = await waitForValue(
      () => holder.events.find((event) => event["topic"] === "broker.ask"),
      "re-entrega tras el crash",
    );
    const deliveredData = delivered["data"] as Record<string, unknown>;
    expect(deliveredData["requestId"]).toBe(askId);

    // La identidad del journal se conserva: mismo evento, misma requestId.
    const replay = await holder.request({ operation: "ask", target: targetOf(sessionId), payload, requestId: askId });
    const record = (replay["result"] as Record<string, unknown>)["record"] as Record<string, unknown>;
    expect(record["requestId"]).toBe(askId);
    expect(record["state"]).toBe("queued");
    expect(receiptsOf(record)).toEqual(["queued"]);
    await closePeers([asker, holder]);
    await revived.kill();
  });
});
