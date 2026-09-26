/**
 * Criterios binarios: handshake hello/welcome con negociación fail-closed,
 * credencial solo en hello, frames validados con límites y errores tipados de
 * la tabla congelada (sin datos fuera de ámbito ni secretos).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LIMITS, newInstanceId, newRequestId } from "@session-broker/protocol";
import {
  assertModelUnused,
  expectError,
  expectResponseError,
  expectWelcome,
  freshIdentity,
  openPeer,
  setupIsolation,
  startBroker,
  testGrant,
  waitForValue,
  writeGrants,
  type BrokerHandle,
  type Isolation,
} from "./helpers";

let isolation: Isolation;
let broker: BrokerHandle;

const identity = freshIdentity();
const CREDENTIAL = "fixture-credential-not-a-real-secret";
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const identityGrant = testGrant({
  grantId: `grt_${"1".repeat(32)}`,
  projectId: identity.projectId,
  capabilities: ["session.identity", "session.observe"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
const identityGrantId = String(identityGrant["grantId"]);

beforeAll(async () => {
  isolation = setupIsolation("handshake");
  writeGrants(isolation.dataDir, [{ credential: CREDENTIAL, grant: identityGrant }]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

describe("handshake hello/welcome", () => {
  test("welcome negocia versión, límites y capacidades del servidor", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: identity.instanceId,
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const welcome = expectWelcome(peer);
    expect(welcome["protocolVersion"]).toBe("1.0.0");
    expect(String(welcome["connectionId"])).toMatch(/^con_[0-9a-f]{32}$/);
    expect(String(welcome["serverChallenge"])).toMatch(/^chal_[0-9a-f]{32}$/);
    expect(welcome["maxFrameBytes"]).toBe(LIMITS.maxFrameBytes);
    expect(welcome["heartbeatMs"]).toBe(LIMITS.heartbeatMs);
    expect(welcome["serverCapabilities"]).toContain("root.binding");
    peer.close();
  });

  test("versión incompatible falla cerrado con INCOMPATIBLE_VERSION", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
      protocolVersions: ["2.0.0"],
    });
    expect(peer.welcome).toBeUndefined();
    const error = peer.errors[0];
    expect(error).toBeDefined();
    if (error !== undefined) expectError(error, "INCOMPATIBLE_VERSION", "incompatible_version");
    peer.close();
  });

  test("grant desconocido y credencial errónea se deniegan sin filtrar", async () => {
    const unknownGrant = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: `grt_${"a".repeat(32)}`,
      credential: CREDENTIAL,
    });
    expect(unknownGrant.welcome).toBeUndefined();
    const first = unknownGrant.errors[0];
    expect(first).toBeDefined();
    if (first !== undefined) expectError(first, "UNAUTHORIZED", "unauthorized_scope");
    unknownGrant.close();

    const badCredential = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: "otra-credencial",
    });
    expect(badCredential.welcome).toBeUndefined();
    const second = badCredential.errors[0];
    expect(second).toBeDefined();
    if (second !== undefined) expectError(second, "UNAUTHORIZED", "unauthorized_scope");
    badCredential.close();
  });

  test("hello sin credencial se rechaza; tras el handshake ninguna request lleva credencial", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: "",
    });
    expect(peer.welcome).toBeUndefined();
    peer.close();

    const good = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const response = await good.request({
      operation: "list",
      target: { target: "omp" },
      payload: {},
    });
    expect(response["state"]).toBe("completed");
    expect(response["error"]).toBeUndefined();
    good.close();
  });

  test("hello duplicado se rechaza con schema_malformed", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const mark = peer.mark();
    peer.hello();
    const duplicate = await peer.nextFrame(mark, "rechazo de hello duplicado");
    expectError(duplicate, "INVALID_INPUT", "schema_malformed");
    peer.close();
  });

  test("frame gigante se resuelve con frame_too_large y cierre acotado", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const mark = peer.mark();
    peer.sendRaw(`{"kind":"request","v":1,"pad":"${"x".repeat(LIMITS.maxFrameBytes)}"}`);
    const frame = await peer.nextFrame(mark, "rechazo de frame gigante");
    expectError(frame, "INVALID_INPUT", "frame_too_large");
    peer.close();
  });

  test("frame binario se rechaza sin reinterpretarse", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const mark = peer.mark();
    peer.raw.send(new Uint8Array([1, 2, 3, 4]));
    const frame = await peer.nextFrame(mark, "rechazo de frame binario");
    expectError(frame, "INVALID_INPUT", "schema_malformed");
    peer.close();
  });

  test("request con validación fallida responde error tipado correlacionable", async () => {
    const peer = await openPeer({
      url: broker.url,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      instanceId: newInstanceId(),
      grantId: identityGrantId,
      credential: CREDENTIAL,
    });
    const requestId = newRequestId();
    peer.send({
      v: 1,
      kind: "request",
      requestId,
      operation: "execute",
      target: { target: "omp" },
      payload: {},
      grantId: identityGrantId,
      sentAtMs: Date.now(),
    });
    const response = await waitForValue(() => peer.responseFor(requestId), "response de operación desconocida");
    expectResponseError(response, "UNSUPPORTED_CAPABILITY", "unsupported_operation");
    peer.close();
  });
});
