/**
 * Criterios binarios (contratos 1-2, FR-003): fixture raíz válida se registra;
 * hijo con environment completo heredado, claims por PID/cwd/IDs/token y
 * reutilización de pruebas fallan SIN autoridad residual; reconexión conserva
 * `instanceId`; proceso nuevo cambia `instanceId`/owner/epoch sin heredar;
 * cambio de `nativeSessionId` invalida el binding y el rebind exige root proof
 * nueva.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { newInstanceId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createOmpAdapter, issueRootProof, type OmpAdapter, type OmpToolResult } from "@session-broker/omp-adapter";
import {
  FakeOmpHost,
  assertModelUnused,
  expectFrameError,
  freshIdentity,
  openRootClaimPeer,
  setupIsolation,
  sleep,
  startBroker,
  testGrant,
  writeGrants,
  type BrokerHandle,
  type Isolation,
} from "./helpers";

const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CREDENTIAL = "fixture-credential-not-a-real-secret";

const ADAPTER_CAPS = [
  "session.identity",
  "session.observe",
  "session.prompt.when_idle",
  "session.reply_tool",
  "session.notify",
  "root.binding",
] as const;

let isolation: Isolation;
let broker: BrokerHandle;
let reader: BrokerClient;
const identity = freshIdentity();
const grantInput = testGrant({
  projectId: identity.projectId,
  capabilities: [...ADAPTER_CAPS, "session.control.prompt", "session.control.steer", "session.control.follow_up", "session.control.abort"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grantInput["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("root-binding");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
  reader = createClient({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await reader.connect();
});

afterAll(async () => {
  await reader.close();
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function targetOf(nativeSessionId: string): TargetRef {
  return {
    target: "omp",
    session: {
      projectId: identity.projectId,
      scope: "workspace",
      workspaceId: identity.workspaceId,
      target: "omp",
      nativeSessionId,
    },
  };
}

async function inspect(nativeSessionId: string): Promise<Record<string, unknown>> {
  const response = await reader.inspect({}, targetOf(nativeSessionId));
  return (response.result ?? {}) as Record<string, unknown>;
}

function makeAdapter(input: { nativeSessionId: string; instanceId?: string }): { adapter: OmpAdapter; host: FakeOmpHost } {
  const host = new FakeOmpHost({ sessionId: input.nativeSessionId, model: isolation.fakeModel });
  const adapter = createOmpAdapter({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: input.instanceId ?? identity.instanceId,
    nativeSessionId: input.nativeSessionId,
    grantId,
    credential: CREDENTIAL,
    host,
    macKey: MAC_KEY,
    dataDir: isolation.userDataDir,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  return { adapter, host };
}

test("raíz válida se registra y anuncia exactamente las capacidades demostradas", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-root-ok" });
  await adapter.start();
  expect(adapter.snapshot().bound).toBe(true);
  expect([...adapter.capabilities]).toEqual([...ADAPTER_CAPS]);
  const registered = await inspect("session-root-ok");
  expect(registered["instanceId"]).toBe(identity.instanceId);
  expect(registered["presence"]).toBe("online");
  expect(registered["capabilities"]).toEqual([...ADAPTER_CAPS]);
  // La herramienta se registra por API pública una sola vez (sin replicar).
  expect(host.registerToolCalls).toBe(1);
  expect(host.tools.has("session_reply")).toBe(true);
  await adapter.stop();
});

test("hijo con environment heredado/claims copiables falla sin autoridad residual", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-child-victim" });
  await adapter.start();
  const child = await openRootClaimPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    nativeSessionId: "session-child-victim",
    grantId,
    credential: CREDENTIAL,
  });
  // Environment copiado completo: NUNCA acredita raíz.
  const envClaim = await child.bindRoot({
    kind: "environment",
    variables: { OMP_SESSION: "session-child-victim", HOME: "/home/leobar37", PWD: "/home/leobar37/code/broker", TOKEN: "reusable" },
  });
  expectFrameError(envClaim, "UNAUTHORIZED", "root_claim_not_proven");
  // PID/cwd/IDs/token reutilizable: idéntico, sin importar su contenido.
  const claims: unknown[] = [
    { kind: "pid", pid: process.pid },
    { kind: "cwd", cwd: "/home/leobar37/code/broker" },
    { kind: "ids", instanceId: identity.instanceId, nativeSessionId: "session-child-victim" },
    { kind: "reusable_token", token: "grt_reusable_token" },
  ];
  for (const claim of claims) {
    const frame = await child.bindRoot(claim);
    expectFrameError(frame, "UNAUTHORIZED", "root_claim_not_proven");
  }
  // Sin autoridad residual: el hijo no quedó registrado ni puede actuar.
  const unauthorized = await child.request({
    operation: "reply",
    payload: { replyTo: `req_${"a".repeat(32)}`, body: { answer: 1 } },
    target: targetOf("session-child-victim"),
  });
  expect(unauthorized.kind).toBe("response");
  const error = unauthorized["error"] as { code?: string; reason?: string };
  expect(["UNAUTHORIZED", "NOT_FOUND_OR_FORBIDDEN"]).toContain(error.code ?? "(sin code)");
  expect(child.frames.filter((frame) => frame.kind === "event")).toEqual([]);
  const detail = await inspect("session-child-victim");
  expect(detail["instanceId"]).toBe(identity.instanceId);
  expect(host.sendUserMessageCalls).toEqual([]);
  child.close();
  await adapter.stop();
});

test("reutilizar una root proof en otra conexión falla; otra instancia no hereda la prueba", async () => {
  const ownerInstanceId = newInstanceId();
  const owner = await openRootClaimPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: ownerInstanceId,
    nativeSessionId: "session-proof",
    grantId,
    credential: CREDENTIAL,
  });
  const welcome = owner.welcome;
  if (welcome === undefined) throw new Error("sin welcome");
  const proof = issueRootProof({
    macKey: MAC_KEY,
    issuer: `omp-adapter:${ownerInstanceId}`,
    instanceId: ownerInstanceId,
    nativeSessionId: "session-proof",
    challenge: String(welcome["serverChallenge"]),
    audience: String(welcome["connectionId"]),
    nowMs: isolation.clock.nowMs,
    ttlMs: 300_000,
  });
  const registered = await owner.bindRoot({ kind: "root_proof", proof });
  expect(registered.kind).toBe("event");

  // Copia de la prueba en otro proceso (conexión distinta): jamás registra.
  const thiefInstanceId = newInstanceId();
  const thief = await openRootClaimPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: thiefInstanceId,
    nativeSessionId: "session-proof",
    grantId,
    credential: CREDENTIAL,
  });
  const copied = await thief.bindRoot({ kind: "root_proof", proof });
  expectFrameError(copied, "UNAUTHORIZED", "root_proof_challenge_mismatch");
  expect(thief.frames.filter((frame) => frame.kind === "event")).toEqual([]);

  // Otra instancia presentando una prueba de otro sujeto (propia conexión):
  // subject mismatch, sin heredar owner.
  const thiefWelcome = thief.welcome;
  if (thiefWelcome === undefined) throw new Error("sin welcome");
  const foreignProof = issueRootProof({
    macKey: MAC_KEY,
    issuer: `omp-adapter:${ownerInstanceId}`,
    instanceId: ownerInstanceId,
    nativeSessionId: "session-proof",
    challenge: String(thiefWelcome["serverChallenge"]),
    audience: String(thiefWelcome["connectionId"]),
    nowMs: isolation.clock.nowMs,
    ttlMs: 300_000,
  });
  const mismatch = await thief.bindRoot({ kind: "root_proof", proof: foreignProof });
  expectFrameError(mismatch, "UNAUTHORIZED", "root_proof_subject_mismatch");

  // La prueba tampoco vale para otra sesión nativa declarada.
  const otherSession = await openRootClaimPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: ownerInstanceId,
    nativeSessionId: "session-other",
    grantId,
    credential: CREDENTIAL,
  });
  const otherWelcome = otherSession.welcome;
  if (otherWelcome === undefined) throw new Error("sin welcome");
  const wrongSessionProof = issueRootProof({
    macKey: MAC_KEY,
    issuer: `omp-adapter:${ownerInstanceId}`,
    instanceId: ownerInstanceId,
    nativeSessionId: "session-proof",
    challenge: String(otherWelcome["serverChallenge"]),
    audience: String(otherWelcome["connectionId"]),
    nowMs: isolation.clock.nowMs,
    ttlMs: 300_000,
  });
  const wrongSession = await otherSession.bindRoot({ kind: "root_proof", proof: wrongSessionProof });
  expectFrameError(wrongSession, "UNAUTHORIZED", "root_proof_subject_mismatch");

  const detail = await inspect("session-proof");
  expect(detail["instanceId"]).toBe(ownerInstanceId);
  owner.close();
  thief.close();
  otherSession.close();
});

test("reconexión conserva instanceId; proceso nuevo cambia owner y epoch sin heredar", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-instance-flow" });
  await adapter.start();
  const first = await inspect("session-instance-flow");
  expect(first["instanceId"]).toBe(identity.instanceId);
  const epoch1 = Number(first["controlEpoch"]);
  await adapter.stop();
  // Misma reconexión de proceso: instanceId conservada, proof nueva obligatoria.
  await adapter.start();
  const second = await inspect("session-instance-flow");
  expect(second["instanceId"]).toBe(identity.instanceId);
  expect(Number(second["controlEpoch"])).toBe(epoch1 + 1);
  await adapter.stop();

  // Proceso nuevo: instanceId nueva, owner/epoch sin heredar (epoch avanza).
  const nextInstanceId = newInstanceId();
  const next = makeAdapter({ nativeSessionId: "session-instance-flow", instanceId: nextInstanceId });
  await next.adapter.start();
  const third = await inspect("session-instance-flow");
  expect(third["instanceId"]).toBe(nextInstanceId);
  expect(Number(third["controlEpoch"])).toBe(epoch1 + 2);
  expect(host.registerToolCalls).toBe(1);
  expect(next.host.registerToolCalls).toBe(1);
  await next.adapter.stop();
});

test("cambio de nativeSessionId invalida el binding y rebind exige root proof nueva", async () => {
  const { adapter, host } = makeAdapter({ nativeSessionId: "session-switch-a" });
  await adapter.start();
  expect(adapter.snapshot().bound).toBe(true);
  // El runtime cambia de sesión nativa (switch): el binding anterior muere.
  host.sessionId = "session-switch-b";
  host.emitSessionLifecycle("switch");
  expect(adapter.snapshot().bound).toBe(false);

  // Sin binding no hay reply: rechazo antes de efectos.
  const stale = (await host.callTool("session_reply", { replyTo: `req_${"b".repeat(32)}`, body: {} })) as OmpToolResult;
  expect(stale.isError).toBe(true);
  expect(host.sendUserMessageCalls).toEqual([]);

  // Rebind explícito: conexión + challenge + root proof nuevas para la sesión nueva.
  await adapter.rebind();
  expect(adapter.snapshot().bound).toBe(true);
  expect(adapter.snapshot().nativeSessionId).toBe("session-switch-b");
  const detailB = await inspect("session-switch-b");
  expect(detailB["instanceId"]).toBe(identity.instanceId);

  // El binding anterior no recibe entregas: un ask a la sesión vieja queda
  // encolado en el broker sin tocar el runtime nativo.
  await reader.ask(
    { question: "¿estado?", deadlineMs: 60_000, policy: "when_idle" },
    targetOf("session-switch-a"),
  );
  await sleep(150);
  expect(host.sendUserMessageCalls).toEqual([]);
  await adapter.stop();
});
