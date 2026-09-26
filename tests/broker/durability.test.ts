/**
 * Criterios binarios: requestId/hash repetido (incluso concurrente y tras
 * restart) produce una sola identidad durable; hash distinto se rechaza sin
 * efectos; crash tras queued conserva request/journal; `outcome_unknown`
 * queda consultable sin replay ciego; el store rechaza al segundo escritor.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  expectResponseError,
  expectWelcome,
  freshIdentity,
  makeRootProof,
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
  type FakePeer,
  type Frame,
  type Isolation,
} from "./helpers";

let isolation: Isolation;
let broker: BrokerHandle;

const identity = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const grant = testGrant({
  grantId: `grt_${"d".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
const grantId = String(grant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("durability");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

async function adapter(instanceId: string, nativeSessionId: string, url: string = broker.url): Promise<FakePeer> {
  return await openPeer({
    url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId,
    nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    capabilities: ALL_ADAPTER_CAPABILITIES,
  });
}

/** Registro raíz con proof derivada del welcome de ESTA conexión. */
async function register(peer: FakePeer): Promise<Frame> {
  const welcome = expectWelcome(peer);
  const proof = makeRootProof({
    macKey: MAC_KEY,
    instanceId: peer.input.instanceId,
    nativeSessionId: peer.input.nativeSessionId ?? "",
    challenge: String(welcome["serverChallenge"] ?? ""),
    audience: String(welcome["connectionId"] ?? ""),
    nowMs: isolation.clock.nowMs,
  });
  const mark = peer.mark();
  peer.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof }, target: "omp" });
  const frame = await peer.nextFrame(mark, "registro raíz");
  expect(frame.kind).toBe("event");
  return frame;
}

function askPayload(question: string): Record<string, unknown> {
  return { question, deadlineMs: 300_000, policy: "when_idle" };
}

function targetOf(sessionId: string): Record<string, unknown> {
  return { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) };
}

function askDeliveries(peer: FakePeer): Frame[] {
  return peer.events.filter((frame) => frame["topic"] === "broker.ask");
}

describe("dedup durable, crash y outcome_unknown", () => {
  test("mismo requestId + mismo hash: una sola identidad durable (replay sin efectos)", async () => {
    const sessionId = `session-dedup-${Date.now().toString(16)}`;
    const holder = await adapter(identity.instanceId, sessionId);
    await register(holder);

    const requestId = newRequestId();
    const target = targetOf(sessionId);
    const payload = askPayload("¿estado del proyecto?");
    const first = await holder.request({ operation: "ask", target, payload, requestId });
    expect(first["state"]).toBe("queued");

    // Reintento concurrente idéntico y reintento posterior: solo una entrega.
    const [again, later] = await Promise.all([
      holder.request({ operation: "ask", target, payload, requestId }),
      (async () => {
        await waitForValue(() => askDeliveries(holder)[0], "primera entrega del ask");
        return await holder.request({ operation: "ask", target, payload, requestId });
      })(),
    ]);
    expect((again["result"] as Record<string, unknown>)["replay"]).toBe(true);
    expect((later["result"] as Record<string, unknown>)["replay"]).toBe(true);
    expect(askDeliveries(holder).length).toBe(1);
    holder.close();
  });

  test("mismo requestId con hash distinto: PAYLOAD_CONFLICT sin efectos", async () => {
    const sessionId = `session-conflict-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);

    const requestId = newRequestId();
    const target = targetOf(sessionId);
    const first = await holder.request({ operation: "ask", target, payload: askPayload("pregunta original"), requestId });
    expect(first["state"]).toBe("queued");

    const conflict = await holder.request({ operation: "ask", target, payload: askPayload("pregunta DIFERENTE"), requestId });
    expect(conflict["state"]).toBe("rejected");
    expectResponseError(conflict, "PAYLOAD_CONFLICT", "payload_conflict");
    expect(askDeliveries(holder).length).toBe(1);
    holder.close();
  });

  test("restart del broker conserva request/journal y re-entrega sin duplicar identidad", async () => {
    const sessionId = `session-restart-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);

    const requestId = newRequestId();
    const target = targetOf(sessionId);
    const queued = await holder.request({ operation: "ask", target, payload: askPayload("sobrevive al restart"), requestId });
    expect(queued["state"]).toBe("queued");
    const firstDelivery = askDeliveries(holder)[0];
    expect(firstDelivery).toBeDefined();
    holder.close();
    await broker.close();

    // Restart sobre el MISMO dataDir: estado + journal reconstruidos.
    broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
    const reader = await adapter(newInstanceId(), sessionId);
    await register(reader);

    const inspect = await reader.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    const requests = detail["requests"] as Record<string, unknown>[];
    const survived = requests.find((record) => record["requestId"] === requestId);
    expect(survived).toBeDefined();
    expect(survived?.["state"]).toBe("queued");
    const receipts = survived?.["receipts"] as Record<string, unknown>[];
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    // La re-entrega reutiliza el MISMO eventId/eventSeq del journal.
    const redelivery = askDeliveries(reader)[0];
    expect(redelivery).toBeDefined();
    expect(redelivery?.["eventId"]).toBe(firstDelivery?.["eventId"]);
    expect(redelivery?.["eventSeq"]).toBe(firstDelivery?.["eventSeq"]);
    reader.close();
  });

  test("crash real (SIGKILL) tras queued conserva request/journal", async () => {
    const childDataDir = join(isolation.tmpDir, "child-data");
    writeGrants(childDataDir, [{ credential: CREDENTIAL, grant }]);
    const child = await spawnBrokerProcess({
      tmpDir: isolation.tmpDir,
      home: isolation.home,
      dataDir: childDataDir,
      macKey: MAC_KEY,
      entryPath: join(import.meta.dir, "..", "..", "apps", "broker", "src", "index.ts"),
      nowMs: isolation.clock.nowMs,
    });
    const url = `ws://127.0.0.1:${child.port}`;

    // Mientras el proceso vive, un segundo escritor del store se rechaza.
    await expect(startBroker({ dataDir: childDataDir, clock: isolation.clock, macKey: MAC_KEY })).rejects.toThrow();

    const sessionId = `session-crash-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId, url);
    await register(holder);
    const requestId = newRequestId();
    const target = targetOf(sessionId);
    const queued = await holder.request({ operation: "ask", target, payload: askPayload("crash inminente"), requestId });
    expect(queued["state"]).toBe("queued");
    const firstDelivery = askDeliveries(holder)[0];
    await child.kill();

    // El store reclama el lock huérfano (pid muerto) y conserva el estado.
    const afterCrash = await startBroker({ dataDir: childDataDir, clock: isolation.clock, macKey: MAC_KEY });
    const reader = await openPeer({
      url: afterCrash.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId,
      credential: CREDENTIAL,
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    await register(reader);

    const inspect = await reader.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
    const detail = inspect["result"] as Record<string, unknown>;
    const requests = detail["requests"] as Record<string, unknown>[];
    const survived = requests.find((record) => record["requestId"] === requestId);
    expect(survived).toBeDefined();
    expect(survived?.["state"]).toBe("queued");
    const receipts = survived?.["receipts"] as Record<string, unknown>[];
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const redelivery = askDeliveries(reader)[0];
    expect(redelivery).toBeDefined();
    expect(redelivery?.["eventId"]).toBe(firstDelivery?.["eventId"]);
    reader.close();
    await afterCrash.close();
  });

  test("entrega sin resultado verificable queda outcome_unknown consultable y sin replay", async () => {
    const sessionId = `session-unknown-${Date.now().toString(16)}`;
    const holder = await adapter(newInstanceId(), sessionId);
    await register(holder);

    const requestId = newRequestId();
    const target = targetOf(sessionId);
    await holder.request({ operation: "ask", target, payload: askPayload("¿resultado?"), requestId });

    // El adaptador confirma journal incoming y handoff nativo, luego cae.
    await holder.report(requestId, "received");
    await holder.report(requestId, "submitted");
    holder.close();

    const reader = await adapter(newInstanceId(), sessionId);
    await register(reader);

    // Espera a que la desconexión del titular deje la ventana de crash.
    let uncertain: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50 && uncertain === undefined; attempt += 1) {
      const inspect = await reader.request({ operation: "inspect", target: targetOf(sessionId), payload: {} });
      const detail = inspect["result"] as Record<string, unknown>;
      const requests = detail["requests"] as Record<string, unknown>[];
      uncertain = requests.find((record) => record["requestId"] === requestId && record["state"] === "outcome_unknown");
      if (uncertain === undefined) await sleep(10);
    }
    expect(uncertain).toBeDefined();

    // Reintento con el MISMO requestId: replay del registro, sin re-entrega.
    const replay = await reader.request({ operation: "ask", target, payload: askPayload("¿resultado?"), requestId });
    expect((replay["result"] as Record<string, unknown>)["replay"]).toBe(true);
    expect(askDeliveries(reader).length).toBe(0);

    // Reconciliación exige evidencia explícita del runtime; sin ella no hay replay.
    const withoutEvidence = await reader.report(requestId, "completed");
    expect(withoutEvidence.kind).toBe("error");
    const reconciled = await reader.report(requestId, "completed", { result: { answer: "42" } });
    expect(reconciled["state"]).toBe("completed");
    reader.close();
  });

  test("el segundo escritor sobre el mismo store se rechaza mientras el primero vive", async () => {
    const dataDir = join(isolation.tmpDir, "single-writer-data");
    const first = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    await expect(startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY })).rejects.toThrow();
    await first.close();
    // Tras el cierre ordenado el store queda libre.
    const second = await startBroker({ dataDir, clock: isolation.clock, macKey: MAC_KEY });
    await second.close();
  });
});
