/**
 * Criterios binarios: grant válido ve solo su proyecto; grant ausente/expirado/
 * revocado y lectura/acción cross-project fallan con código estable SIN datos
 * filtrados; revocación/expiración revalidan conexiones vivas.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Capability } from "@session-broker/protocol";
import {
  ALL_ADAPTER_CAPABILITIES,
  assertModelUnused,
  bindRoot,
  expectResponseError,
  freshIdentity,
  openPeer,
  sessionRefFor,
  setupIsolation,
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

const projectA = freshIdentity();
const projectB = freshIdentity();
const MAC_KEY = "fixture-mac-key-not-a-real-secret";
const CRED_A = "fixture-credential-project-a";
const CRED_B = "fixture-credential-project-b";
const CRED_EXPIRES = "fixture-credential-expiring";
const CRED_REVOKED = "fixture-credential-revoked";
const CRED_CONTROL = "fixture-credential-no-control";

const grantA = testGrant({
  grantId: `grt_${"3".repeat(32)}`,
  projectId: projectA.projectId,
  workspaceIds: "*",
  targets: ["omp"],
  sessions: "*",
  capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool", "session.notify"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
const grantB = testGrant({
  grantId: `grt_${"4".repeat(32)}`,
  projectId: projectB.projectId,
  capabilities: [...ALL_ADAPTER_CAPABILITIES],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
// Expira 120s después del reloj de la suite: el test lo rebasa con `advance`.
const grantExpires = testGrant({
  grantId: `grt_${"5".repeat(32)}`,
  projectId: projectA.projectId,
  capabilities: ["session.identity", "session.observe"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 120_000,
});
const grantRevoked = testGrant({
  grantId: `grt_${"6".repeat(32)}`,
  projectId: projectA.projectId,
  capabilities: ["session.identity", "session.observe"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});
// Sin capacidades de control: toda acción de control queda fuera del ámbito.
const grantNoControl = testGrant({
  grantId: `grt_${"7".repeat(32)}`,
  projectId: projectA.projectId,
  capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
  issuedAtMs: 1_700_000_000_000 - 60_000,
  expiresAtMs: 1_700_000_000_000 + 3_600_000,
});

beforeAll(async () => {
  isolation = setupIsolation("grants-scope");
  writeGrants(isolation.dataDir, [
    { credential: CRED_A, grant: grantA },
    { credential: CRED_B, grant: grantB },
    { credential: CRED_EXPIRES, grant: grantExpires },
    { credential: CRED_REVOKED, grant: grantRevoked },
    { credential: CRED_CONTROL, grant: grantNoControl },
  ]);
  broker = await startBroker({ dataDir: isolation.dataDir, clock: isolation.clock, macKey: MAC_KEY });
});

afterAll(async () => {
  await broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

async function clientOf(input: {
  identity: ReturnType<typeof freshIdentity>;
  grantId: string;
  credential: string;
  capabilities?: readonly Capability[];
}): Promise<FakePeer> {
  return await openPeer({
    url: broker.url,
    projectId: input.identity.projectId,
    workspaceId: input.identity.workspaceId,
    instanceId: input.identity.instanceId,
    nativeSessionId: input.identity.nativeSessionId,
    grantId: input.grantId,
    credential: input.credential,
    capabilities: input.capabilities ?? ["session.identity", "session.observe"],
  });
}

describe("grants scoped y revalidación", () => {
  test("grant válido ve solo su proyecto; cross-project responde sin filtrar existencia", async () => {
    // Sesión registrada en el proyecto B.
    const adapterB = await clientOf({
      identity: projectB,
      grantId: String(grantB["grantId"]),
      credential: CRED_B,
      capabilities: ALL_ADAPTER_CAPABILITIES,
    });
    const bound = await bindRoot(adapterB, {
      macKey: MAC_KEY,
      target: "omp",
      sessionRef: sessionRefFor(projectB),
      nowMs: isolation.clock.nowMs,
    });
    expect(bound.kind).toBe("event");

    const clientA = await clientOf({ identity: projectA, grantId: String(grantA["grantId"]), credential: CRED_A });
    // list del proyecto A no muestra recursos del proyecto B.
    const listA = await clientA.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expect(listA["state"]).toBe("completed");
    const itemsA = (listA["result"] as Record<string, unknown>)["items"] as unknown[];
    expect(itemsA).toEqual([]);

    // Solicitud con sessionRef del proyecto B: código estable, sin filtrado.
    const cross = await clientA.request({
      operation: "inspect",
      target: { target: "omp", session: sessionRefFor(projectB) },
      payload: {},
    });
    expectResponseError(cross, "NOT_FOUND_OR_FORBIDDEN", "unauthorized_scope");

    // Recurso inexistente en el propio proyecto: no se inventa resumen
    // (availability "unavailable") y el resultado jamás mezcla datos ajenos.
    const missing = await clientA.request({
      operation: "inspect",
      target: { target: "omp", session: sessionRefFor(projectA) },
      payload: {},
    });
    expect(missing["state"]).toBe("completed");
    const missingResult = missing["result"] as Record<string, unknown>;
    expect(missingResult["availability"]).toBe("unavailable");
    clientA.close();
    adapterB.close();
  });

  test("grant expirado se detecta y revalida la conexión (EXPIRED/grant_expired)", async () => {
    const client = await clientOf({ identity: projectA, grantId: String(grantExpires["grantId"]), credential: CRED_EXPIRES });
    isolation.clock.advance(200_000);
    const response = await client.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expectResponseError(response, "EXPIRED", "grant_expired");
    await waitForValue(() => client.closeCode, "cierre por grant expirado");
    client.close();
  });

  test("grant revocado corta el acceso y revalida la conexión viva", async () => {
    const client = await clientOf({ identity: projectA, grantId: String(grantRevoked["grantId"]), credential: CRED_REVOKED });
    writeGrants(isolation.dataDir, [
      { credential: CRED_A, grant: grantA },
      { credential: CRED_B, grant: grantB },
      { credential: CRED_EXPIRES, grant: grantExpires },
      {
        credential: CRED_REVOKED,
        grant: { ...grantRevoked, revokedAtMs: isolation.clock.nowMs - 1 },
      },
      { credential: CRED_CONTROL, grant: grantNoControl },
    ]);
    const response = await client.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expectResponseError(response, "UNAUTHORIZED", "grant_revoked");
    await waitForValue(() => client.closeCode, "cierre por grant revocado");
    client.close();
  });

  test("acción fuera del scope del grant se deniega sin revelar dimensión", async () => {
    const client = await clientOf({ identity: projectA, grantId: String(grantNoControl["grantId"]), credential: CRED_CONTROL });
    // Sin capability de control en el grant: el ámbito lo deniega.
    const control = await client.request({
      operation: "control",
      target: { target: "omp", session: sessionRefFor(projectA) },
      payload: { verb: "abort" },
      controlEpoch: 1,
    });
    expectResponseError(control, "UNAUTHORIZED", "unauthorized_scope");

    // Dimensión de sesión restringida: la acción debe declararla y estar incluida.
    const restricted = testGrant({
      projectId: projectA.projectId,
      sessions: [projectA.nativeSessionId],
      capabilities: ["session.identity", "session.observe"],
      issuedAtMs: isolation.clock.nowMs - 60_000,
      expiresAtMs: isolation.clock.nowMs + 3_600_000,
    });
    writeGrants(isolation.dataDir, [
      { credential: CRED_A, grant: grantA },
      { credential: CRED_B, grant: grantB },
      { credential: CRED_EXPIRES, grant: grantExpires },
      {
        credential: CRED_REVOKED,
        grant: { ...grantRevoked, revokedAtMs: isolation.clock.nowMs - 1 },
      },
      { credential: CRED_CONTROL, grant: grantNoControl },
      { credential: "fixture-credential-restricted", grant: restricted },
    ]);
    const restrictedClient = await clientOf({
      identity: projectA,
      grantId: String(restricted["grantId"]),
      credential: "fixture-credential-restricted",
    });
    // Acción sin sesión declarada bajo un grant con sesión concreta: fail-closed.
    const undeclared = await restrictedClient.request({ operation: "list", target: { target: "omp" }, payload: {} });
    expectResponseError(undeclared, "UNAUTHORIZED", "unauthorized_scope");
    restrictedClient.close();
    client.close();
  });
});
