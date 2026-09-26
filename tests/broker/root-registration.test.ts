/**
 * Criterios binarios: registro raíz autenticado con root proof no heredable
 * (challenge, uso único, TTL); environment/PID/cwd/IDs/token reutilizable jamás
 * acreditan raíz; workspace/sesión falsificados fallan; reconexión conserva la
 * instancia y un proceso nuevo cambia instanceId (takeover).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newInstanceId } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  expectError,
  expectWelcome,
  freshIdentity,
  makeRootProof,
  openPeer,
  sessionRefFor,
  setupIsolation,
  startBroker,
  testGrant,
  writeGrants,
  type BrokerHandle,
  type FakePeer,
  type Isolation,
} from "./helpers";

let isolation: Isolation;
let broker: BrokerHandle;
let noMacBroker: BrokerHandle;

const identity = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const adapterGrant = testGrant({
  grantId: `grt_${"2".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
const adapterGrantId = String(adapterGrant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("root-registration");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: adapterGrant }]);
  writeGrants(`${isolation.dataDir}-nomac`, [{ credential: CREDENTIAL, grant: adapterGrant }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
  noMacBroker = await startBroker({
    dataDir: `${isolation.dataDir}-nomac`,
    clock: isolation.clock,
  });
});

afterAll(async () => {
  await broker.close();
  await noMacBroker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

async function adapterPeer(instanceId: string, nativeSessionId: string = identity.nativeSessionId): Promise<FakePeer> {
  return await openPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId,
    nativeSessionId,
    grantId: adapterGrantId,
    credential: CREDENTIAL,
    capabilities: ALL_ADAPTER_CAPABILITIES,
  });
}

describe("registro raíz autenticado", () => {
  test("root proof válida registra la sesión con identidades separadas", async () => {
    const peer = await adapterPeer(identity.instanceId);
    const frame = await bindRoot(peer, {
      macKey: MAC_KEY,
      target: "omp",
      sessionRef: sessionRefFor(identity),
      nowMs: isolation.clock.nowMs,
    });
    expect(frame.kind).toBe("event");
    expect(frame["topic"]).toBe("broker.presence");
    const data = frame["data"] as Record<string, unknown>;
    expect(data["controlEpoch"]).toBe(1);
    expect(data["takeover"]).toBe(false);
    const sessionRef = data["sessionRef"] as Record<string, unknown>;
    expect(sessionRef["projectId"]).toBe(identity.projectId);
    expect(sessionRef["workspaceId"]).toBe(identity.workspaceId);
    expect(sessionRef["nativeSessionId"]).toBe(identity.nativeSessionId);
    expect(sessionRef["target"]).toBe("omp");
    expect(data["instanceId"]).toBe(identity.instanceId);
    peer.close();
  });

  test("prueba consumida vuelve a fallar (uso único por proofId y challenge)", async () => {
    const peer = await adapterPeer(identity.instanceId);
    const welcome = expectWelcome(peer);
    const proof = makeRootProof({
      macKey: MAC_KEY,
      instanceId: identity.instanceId,
      nativeSessionId: identity.nativeSessionId,
      challenge: String(welcome["serverChallenge"]),
      audience: String(welcome["connectionId"]),
      nowMs: isolation.clock.nowMs,
    });
    const first = await bindRoot(peer, { macKey: MAC_KEY, target: "omp", proof, nowMs: isolation.clock.nowMs });
    expect(first.kind).toBe("event");

    // Reuso en la misma conexión: el challenge era de un solo intercambio.
    const mark = peer.mark();
    peer.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof }, target: "omp" });
    const reused = await peer.nextFrame(mark, "rechazo de prueba reusada");
    expect(reused.kind).toBe("error");
    peer.close();

    // Otra conexión minte una proof NUEVA reutilizando el proofId consumido:
    // uso único por proofId (sin excepciones).
    const other = await adapterPeer(identity.instanceId);
    const otherWelcome = expectWelcome(other);
    const replayed = makeRootProof({
      macKey: MAC_KEY,
      instanceId: identity.instanceId,
      nativeSessionId: identity.nativeSessionId,
      challenge: String(otherWelcome["serverChallenge"]),
      audience: String(otherWelcome["connectionId"]),
      nowMs: isolation.clock.nowMs,
      proofId: proof.proofId,
    });
    const otherMark = other.mark();
    other.send({ kind: "bind_root", v: 1, claim: { kind: "root_proof", proof: replayed }, target: "omp" });
    const foreign = await other.nextFrame(otherMark, "rechazo de proofId consumido");
    expectError(foreign, "UNAUTHORIZED", "root_proof_consumed");
    other.close();
  });

  test("la prueba de otra instancia se rechaza (root_proof_subject_mismatch)", async () => {
    const peer = await adapterPeer(identity.instanceId);
    const welcome = expectWelcome(peer);
    const foreignProof = makeRootProof({
      macKey: MAC_KEY,
      instanceId: newInstanceId(),
      nativeSessionId: identity.nativeSessionId,
      challenge: String(welcome["serverChallenge"]),
      audience: String(welcome["connectionId"]),
      nowMs: isolation.clock.nowMs,
    });
    const frame = await bindRoot(peer, { macKey: MAC_KEY, target: "omp", proof: foreignProof, nowMs: isolation.clock.nowMs });
    expectError(frame, "UNAUTHORIZED", "root_proof_subject_mismatch");
    peer.close();
  });

  test("claims heredables (environment/PID/cwd/IDs/token) jamás acreditan raíz", async () => {
    const claims: unknown[] = [
      { kind: "environment", variables: { OMP_SESSION: identity.nativeSessionId, HOME: isolation.home } },
      { kind: "pid", pid: 4242 },
      { kind: "cwd", cwd: isolation.tmpDir },
      { kind: "ids", instanceId: identity.instanceId, nativeSessionId: identity.nativeSessionId },
      { kind: "reusable_token", token: "static-token-copied-by-subagent" },
    ];
    for (const claim of claims) {
      const peer = await adapterPeer(identity.instanceId);
      const frame = await bindRoot(peer, { macKey: MAC_KEY, target: "omp", claim, nowMs: isolation.clock.nowMs });
      expectError(frame, "UNAUTHORIZED", "root_claim_not_proven");
      peer.close();
    }
  });

  test("workspace/sesión falsificados en sessionRef no acreditan", async () => {
    const wrongSession = await adapterPeer(identity.instanceId);
    const frameA = await bindRoot(wrongSession, {
      macKey: MAC_KEY,
      target: "omp",
      sessionRef: sessionRefFor(identity, { nativeSessionId: "session-otra" }),
      nowMs: isolation.clock.nowMs,
    });
    expectError(frameA, "UNAUTHORIZED", "root_claim_not_proven");
    wrongSession.close();

    const wrongWorkspace = await adapterPeer(identity.instanceId);
    const frameB = await bindRoot(wrongWorkspace, {
      macKey: MAC_KEY,
      target: "omp",
      sessionRef: {
        projectId: identity.projectId,
        scope: "workspace",
        workspaceId: `wsp_${"9".repeat(32)}`,
        target: "omp",
        nativeSessionId: identity.nativeSessionId,
      },
      nowMs: isolation.clock.nowMs,
    });
    expectError(frameB, "UNAUTHORIZED", "root_claim_not_proven");
    wrongWorkspace.close();
  });

  test("reconectar el mismo proceso conserva instanceId; el proceso nuevo la cambia (takeover)", async () => {
    const sessionId = `session-takeover-${Date.now().toString(16)}`;
    const first = await adapterPeer(identity.instanceId, sessionId);
    const bindA = await bindRoot(first, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    expect(bindA.kind).toBe("event");
    first.close();

    const reconnect = await adapterPeer(identity.instanceId, sessionId);
    const bindB = await bindRoot(reconnect, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const dataB = bindB["data"] as Record<string, unknown>;
    expect(dataB["instanceId"]).toBe(identity.instanceId);
    expect(dataB["controlEpoch"]).toBe(2);
    expect(dataB["takeover"]).toBe(false);
    reconnect.close();

    const newProcess = await adapterPeer(newInstanceId(), sessionId);
    const bindC = await bindRoot(newProcess, { macKey: MAC_KEY, target: "omp", nowMs: isolation.clock.nowMs });
    const dataC = bindC["data"] as Record<string, unknown>;
    expect(dataC["instanceId"]).toBe(newProcess.input.instanceId);
    expect(dataC["controlEpoch"]).toBe(3);
    expect(dataC["takeover"]).toBe(true);
    expect(dataC["previousHolder"]).toBe(identity.instanceId);
    newProcess.close();
  });

  test("sin macKey: root.binding queda unsupported y bind_root falla sin efectos", async () => {
    const peer = await openPeer({
      url: noMacBroker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: identity.instanceId,
      nativeSessionId: identity.nativeSessionId,
      grantId: adapterGrantId,
      credential: CREDENTIAL,
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    const welcome = expectWelcome(peer);
    expect(welcome["serverCapabilities"]).not.toContain("root.binding");
    const frame = await bindRoot(peer, {
      macKey: MAC_KEY,
      target: "omp",
      nowMs: isolation.clock.nowMs,
    });
    expectError(frame, "UNSUPPORTED_CAPABILITY", "missing_capability");
    peer.close();
  });
});
