/**
 * Criterios binarios (contrato 7, FR-008/NFR-004): `notify`/`control` sin
 * mapping seguro verificado se rechazan con `UNSUPPORTED_CAPABILITY` ANTES de
 * cualquier efecto nativo (nunca teclas/Enter, shell ni prompt sustituto); el
 * fixture no anuncia más capacidades de las que demuestra la matriz; el único
 * mapping de `notify` soportado es el tema reservado de runState.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { newInstanceId, type TargetRef } from "@session-broker/protocol";
import { createClient, type BrokerClient } from "@session-broker/client";
import { createOmpAdapter, type OmpAdapter } from "@session-broker/omp-adapter";
import {
  FakeOmpHost,
  RootClaimPeer,
  assertModelUnused,
  freshIdentity,
  openRootClaimPeer,
  setupIsolation,
  startBroker,
  testGrant,
  waitForCondition,
  writeGrants,
  type BrokerHandle,
  type Isolation,
  type RawFrame,
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
let client: BrokerClient;
let adapter: OmpAdapter;
let host: FakeOmpHost;
let controlPeer: RootClaimPeer;
const identity = freshIdentity();
const SESSION = "session-unsupported";
const grantInput = testGrant({
  projectId: identity.projectId,
  // El GRANT permite control/notifica: la negación debe venir de las
  // capacidades del objetivo (unsupported), no del scope del grant.
  capabilities: [...ADAPTER_CAPS, "session.control.prompt", "session.control.steer", "session.control.follow_up", "session.control.abort"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 86_400_000,
});
const grantId = String(grantInput["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("unsupported");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: grantInput }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
  host = new FakeOmpHost({ sessionId: SESSION, model: isolation.fakeModel });
  adapter = createOmpAdapter({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: identity.instanceId,
    nativeSessionId: SESSION,
    grantId,
    credential: CREDENTIAL,
    host,
    macKey: MAC_KEY,
    dataDir: isolation.userDataDir,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await adapter.start();
  client = createClient({
    endpoint: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    grantId,
    credential: CREDENTIAL,
    allowInsecureWs: true,
    now: isolation.clock.now,
  });
  await client.connect();
  controlPeer = await openRootClaimPeer({
    url: broker.url,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    instanceId: newInstanceId(),
    nativeSessionId: SESSION,
    grantId,
    credential: CREDENTIAL,
  });
});

afterAll(async () => {
  controlPeer.close();
  await client.close();
  await adapter.stop();
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

test("el objetivo anuncia exactamente las capacidades demostradas (sin control)", async () => {
  const response = await client.inspect({}, targetOf(SESSION));
  const detail = (response.result ?? {}) as { capabilities?: string[] };
  expect(detail.capabilities).toEqual([...ADAPTER_CAPS]);
  expect((detail.capabilities ?? []).some((capability) => capability.startsWith("session.control."))).toBe(false);
});

test("control con verbo conocido se rechaza como unsupported antes de efectos", async () => {
  const frame: RawFrame = await controlPeer.request({
    operation: "control",
    payload: { verb: "prompt", instruction: "haz algo" },
    target: targetOf(SESSION),
    controlEpoch: 0,
  });
  expect(frame.kind).toBe("response");
  const error = frame["error"] as { code?: string; reason?: string };
  expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
  expect(error.reason).toBe("missing_capability");
  // Cero efectos nativos: ni prompt, ni abort, ni teclas.
  expect(host.sendUserMessageCalls).toEqual([]);
  expect(host.abortCalls).toBe(0);
  expect(host.inputBuffer).toEqual([]);
});

test("control con verbo desconocido se rechaza como unsupported antes de efectos", async () => {
  const frame: RawFrame = await controlPeer.request({
    operation: "control",
    payload: { verb: "explode" },
    target: targetOf(SESSION),
    controlEpoch: 0,
  });
  expect(frame.kind).toBe("response");
  const error = frame["error"] as { code?: string; reason?: string };
  expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
  expect(error.reason).toBe("unsupported_control_verb");
  expect(host.abortCalls).toBe(0);
});

test("notify sin mapping nativo verificado termina rejected con UNSUPPORTED_CAPABILITY", async () => {
  const response = await client.notify({ topic: "tema.arbitrario", data: { texto: "hola" } }, targetOf(SESSION));
  expect(response.state).toBe("queued");
  const requestId = response.requestId;
  await waitForCondition(async () => {
    const detail = await client.inspect({}, targetOf(SESSION));
    const record = ((detail.result ?? {}) as { requests?: { requestId: string; state: string }[] }).requests?.find(
      (candidate) => candidate.requestId === requestId,
    );
    return record?.state === "rejected";
  }, "notify rechazado por el adaptador");
  // El rechazo es explícito y ANTES de efectos nativos (no existe mapping).
  expect(host.sendUserMessageCalls).toEqual([]);
  expect(host.abortCalls).toBe(0);
  assertModelUnused(isolation.fakeModel);
});

test("el único mapping soportado de notify es el tema reservado de runState", async () => {
  await waitForCondition(async () => {
    const detail = await client.inspect({}, targetOf(SESSION));
    return ((detail.result ?? {}) as { runState?: string }).runState === "idle";
  }, "runState idle declarado por el titular");
  host.setStreaming(true);
  await waitForCondition(async () => {
    const detail = await client.inspect({}, targetOf(SESSION));
    return ((detail.result ?? {}) as { runState?: string }).runState === "busy";
  }, "runState busy declarado por el titular");
  host.setStreaming(false);
  await waitForCondition(async () => {
    const detail = await client.inspect({}, targetOf(SESSION));
    return ((detail.result ?? {}) as { runState?: string }).runState === "idle";
  }, "runState idle declarado por el titular");
  // La declaración de runState no es prompt ni inferencia.
  expect(host.sendUserMessageCalls).toEqual([]);
});

test("las respuestas unsupported no provocan fallbacks peligrosos", async () => {
  // Ningún intento de estos rechazos abrió turnos, tocó la TUI o registró
  // herramientas extra durante toda la suite.
  expect(host.registerToolCalls).toBe(1);
  expect(host.tools.size).toBe(1);
  expect(host.timeline.filter((entry) => entry.kind === "user_message")).toEqual([]);
  expect(host.inputBuffer).toEqual([]);
  assertModelUnused(isolation.fakeModel);
});
