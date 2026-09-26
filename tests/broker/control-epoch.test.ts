/**
 * Criterios binarios: dos controladores en carrera no aplican el mismo control
 * con epochs obsoletos; el dueño viejo no puede entregar después del
 * takeover/revoke; control sin capability soportada no tiene efectos; target
 * ambiguo nunca se resuelve en silencio.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  expectResponseError,
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

let isolation: Isolation;
let broker: BrokerHandle;

const identity = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";

const controlGrant = testGrant({
  grantId: `grt_${"b".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
const controlGrantId = String(controlGrant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("control-epoch");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: controlGrant }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

async function adapter(instanceId: string, nativeSessionId: string): Promise<FakePeer> {
  return await openPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId,
    nativeSessionId,
    grantId: controlGrantId,
    credential: CREDENTIAL,
    capabilities: ALL_ADAPTER_CAPABILITIES,
  });
}

async function register(instanceId: string, nativeSessionId: string): Promise<{ peer: FakePeer; epoch: number }> {
  const peer = await adapter(instanceId, nativeSessionId);
  const frame = await bindRoot(peer, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
  expect(frame.kind).toBe("event");
  const data = frame["data"] as Record<string, unknown>;
  return { peer, epoch: Number(data["controlEpoch"]) };
}

function controlRequest(peer: FakePeer, input: { sessionId: string; epoch?: number; instanceId?: string; verb?: string; requestId?: string }) {
  return peer.request({
    operation: "control",
    target: {
      target: "omp",
      session: sessionRefFor(identity, { nativeSessionId: input.sessionId }),
      ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    },
    payload: { verb: input.verb ?? "abort" },
    ...(input.epoch === undefined ? {} : { controlEpoch: input.epoch }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}

describe("controlEpoch y autoridad de entrega", () => {
  test("control con epoch vigente se encola y llega al titular; sin epoch falla", async () => {
    const sessionId = `session-control-${Date.now().toString(16)}`;
    const holder = await register(identity.instanceId, sessionId);
    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.abort"],
    });

    const missingEpoch = await controlRequest(controller, { sessionId, instanceId: identity.instanceId });
    expectResponseError(missingEpoch, "STALE_CONTROL_EPOCH", "stale_control_epoch");

    const mark = holder.peer.mark();
    const ok = await controlRequest(controller, {
      sessionId,
      epoch: holder.epoch,
      instanceId: identity.instanceId,
    });
    expect(ok["state"]).toBe("queued");
    const delivered = await holder.peer.nextFrame(mark, "entrega de control al titular");
    expect(delivered["kind"]).toBe("event");
    expect(delivered["topic"]).toBe("broker.control");

    controller.close();
    holder.peer.close();
  });

  test("takeover: el dueño viejo no entrega (STALE_INSTANCE) y el epoch viejo se rechaza", async () => {
    const sessionId = `session-takeover-control-${Date.now().toString(16)}`;
    const oldOwner = await register(identity.instanceId, sessionId);
    const newOwner = await register(newInstanceId(), sessionId);
    expect(newOwner.epoch).toBe(oldOwner.epoch + 1);

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.abort", "session.reply_tool"],
    });

    // Epoch obsoleto del dueño anterior: jamás aplica.
    const staleEpoch = await controlRequest(controller, {
      sessionId,
      epoch: oldOwner.epoch,
      instanceId: identity.instanceId,
    });
    expectResponseError(staleEpoch, "STALE_CONTROL_EPOCH", "stale_control_epoch");

    // El dueño viejo intenta entregar un reply: pierde autoridad.
    const askId = newRequestId();
    const ask = await controller.request({
      operation: "ask",
      target: { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) },
      payload: { question: "¿estado?", deadlineMs: 300_000, policy: "when_idle" },
      requestId: askId,
    });
    expect(ask["state"]).toBe("queued");

    const replyFromOld = await oldOwner.peer.request({
      operation: "reply",
      target: { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) },
      payload: { replyTo: askId, body: { answer: "del dueño viejo" } },
    });
    expectResponseError(replyFromOld, "STALE_INSTANCE", "stale_instance");

    // El nuevo dueño sí entrega y completa el ask exacto.
    const replyFromNew = await newOwner.peer.request({
      operation: "reply",
      target: { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) },
      payload: { replyTo: askId, body: { answer: "del dueño nuevo" } },
    });
    expect(replyFromNew["state"]).toBe("completed");

    controller.close();
    oldOwner.peer.close();
    newOwner.peer.close();
  });

  test("dos controladores en carrera: solo el epoch vigente aplica el mismo control", async () => {
    const sessionId = `session-race-${Date.now().toString(16)}`;
    // Dos takeovers simultáneos: ambos incrementan el epoch de forma atómica.
    const [first, second] = await Promise.all([
      register(newInstanceId(), sessionId),
      register(newInstanceId(), sessionId),
    ]);
    const epochs = new Set([first.epoch, second.epoch]);
    expect(epochs.size).toBe(2);

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.abort"],
    });

    const responses = await Promise.all([
      controlRequest(controller, { sessionId, epoch: first.epoch, instanceId: first.peer.input.instanceId, requestId: newRequestId() }),
      controlRequest(controller, { sessionId, epoch: second.epoch, instanceId: second.peer.input.instanceId, requestId: newRequestId() }),
    ]);
    const successes = responses.filter((frame) => frame["error"] === undefined);
    const failures = responses.filter((frame) => frame["error"] !== undefined);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (failure !== undefined) {
      const error = failure["error"] as { code: string };
      expect(["STALE_CONTROL_EPOCH", "STALE_INSTANCE"]).toContain(error.code);
    }

    controller.close();
    first.peer.close();
    second.peer.close();
  });

  test("revoke del grant del titular invalida el control previo (epoch nuevo)", async () => {
    const sessionId = `session-revoke-${Date.now().toString(16)}`;
    const holderGrant = testGrant({
      grantId: `grt_${"c".repeat(32)}`,
      projectId: identity.projectId,
      capabilities: [...ALL_ADAPTER_CAPABILITIES],
      issuedAtMs: 1_700_000_000_000 - 60_000,
      expiresAtMs: 1_700_000_000_000 + 3_600_000,
    });
    writeGrants(isolation.dataDir, [
      { credential: CREDENTIAL, grant: controlGrant },
      { credential: "fixture-credential-holder", grant: holderGrant },
    ]);
    const holder = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: identity.instanceId,
      nativeSessionId: sessionId,
      grantId: String(holderGrant["grantId"]),
      credential: "fixture-credential-holder",
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    const bound = await bindRoot(holder, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const epoch = Number((bound["data"] as Record<string, unknown>)["controlEpoch"]);

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.abort"],
    });
    const before = await controlRequest(controller, { sessionId, epoch, instanceId: identity.instanceId });
    expect(before["state"]).toBe("queued");

    // Revocación del grant del titular: su conexión se revalida y se cierra, y
    // el revoke incrementa el epoch invalidando todo control previo.
    writeGrants(isolation.dataDir, [
      { credential: CREDENTIAL, grant: controlGrant },
      {
        credential: "fixture-credential-holder",
        grant: { ...holderGrant, revokedAtMs: isolation.clock.nowMs - 1 },
      },
    ]);
    const holderView = await holder.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expectResponseError(holderView, "UNAUTHORIZED", "grant_revoked");
    await waitForValue(() => holder.closeCode, "cierre del titular por revocación");

    // El revoke incrementa el epoch: se espera a que el cierre quede aplicado
    // antes de comprobar que el control previo caducó.
    let bumped = false;
    for (let attempt = 0; attempt < 50 && !bumped; attempt += 1) {
      const view = await controller.request({
        operation: "inspect",
        target: { target: "omp", session: sessionRefFor(identity, { nativeSessionId: sessionId }) },
        payload: {},
      });
      const detail = view["result"] as Record<string, unknown>;
      if (Number(detail["controlEpoch"]) > epoch) bumped = true;
      else await sleep(10);
    }
    expect(bumped).toBe(true);

    const stale = await controlRequest(controller, { sessionId, epoch, instanceId: identity.instanceId });
    expectResponseError(stale, "STALE_CONTROL_EPOCH", "stale_control_epoch");

    controller.close();
    holder.close();
  });

  test("control sin capability soportada por el objetivo falla sin efectos", async () => {
    const sessionId = `session-unsupported-${Date.now().toString(16)}`;
    // Objetivo que solo declara observe+identity: steer no está soportado.
    const limited = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      nativeSessionId: sessionId,
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe"],
    });
    const bound = await bindRoot(limited, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const epoch = Number((bound["data"] as Record<string, unknown>)["controlEpoch"]);

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.steer"],
    });
    const mark = limited.mark();
    const response = await controlRequest(controller, {
      sessionId,
      epoch,
      instanceId: limited.input.instanceId,
      verb: "steer",
    });
    expectResponseError(response, "UNSUPPORTED_CAPABILITY", "missing_capability");
    // Sin efectos: el titular no recibe entrega alguna.
    expect(limited.frames.length).toBe(mark);

    controller.close();
    limited.close();
  });

  test("target ambiguo jamás se elige en silencio", async () => {
    const sessionIdA = `session-amb-a-${Date.now().toString(16)}`;
    const sessionIdB = `session-amb-b-${Date.now().toString(16)}`;
    const a = await register(newInstanceId(), sessionIdA);
    const b = await register(newInstanceId(), sessionIdB);

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.abort"],
    });
    // Dos sesiones registradas bajo el mismo nombre de target: sin sessionRef
    // el selector es ambiguo.
    const ambiguous = await controller.request({
      operation: "control",
      target: { target: "omp" },
      payload: { verb: "abort" },
      controlEpoch: a.epoch,
    });
    expectResponseError(ambiguous, "AMBIGUOUS_TARGET", "ambiguous_target");

    controller.close();
    a.peer.close();
    b.peer.close();
  });

  test("TARGET_BUSY gatea control prompt sobre sesión ocupada", async () => {
    const sessionId = `session-busy-${Date.now().toString(16)}`;
    const holder = await register(identity.instanceId, sessionId);
    await holder.peer.declareRunState("busy");

    const controller = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: controlGrantId,
      credential: CREDENTIAL,
      capabilities: ["session.identity", "session.observe", "session.control.prompt"],
    });
    const busy = await controlRequest(controller, {
      sessionId,
      epoch: holder.epoch,
      instanceId: identity.instanceId,
      verb: "prompt",
    });
    expectResponseError(busy, "TARGET_BUSY", "target_busy");

    await holder.peer.declareRunState("idle");
    const mark = holder.peer.mark();
    const idle = await controlRequest(controller, {
      sessionId,
      epoch: holder.epoch,
      instanceId: identity.instanceId,
      verb: "prompt",
    });
    expect(idle["state"]).toBe("queued");
    const delivered = await holder.peer.nextFrame(mark, "entrega de prompt en idle");
    expect(delivered["topic"]).toBe("broker.control");

    controller.close();
    holder.peer.close();
  });
});
