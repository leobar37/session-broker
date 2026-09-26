/**
 * Criterio binario: grants scoped autenticados (IDs no son credenciales),
 * root proof no heredable con expiración/consumo/rebind explícito y
 * `controlEpoch` que invalida control obsoleto.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertControlEpoch,
  computeRootProofMac,
  evaluateGrant,
  evaluateRootBindingClaim,
  parseGrant,
  verifyRootProof,
  RootProofLedger,
  LIMITS,
} from "@session-broker/protocol";
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_MAC_KEY,
  FIXTURE_NOW_MS,
  FIXTURE_PROJECT_ID,
  FIXTURE_TARGET,
  FIXTURE_ASK_REQUEST_ID,
  FIXTURE_NATIVE_SESSION_ID,
  FIXTURE_ROOT_CTX,
  FIXTURE_WORKSPACE_ID,
  fixtureRenewedControlLease,
  referenceFixtures,
} from "@session-broker/protocol/fixtures";
import { assertModelUnused, expectAccepted, expectRejection, setupIsolation, type Isolation } from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function observeAction(capability: "session.observe" | "session.prompt.when_idle" | "session.control.abort") {
  return {
    projectId: FIXTURE_PROJECT_ID,
    workspaceId: FIXTURE_WORKSPACE_ID,
    target: FIXTURE_TARGET,
    nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
    capability,
  } as const;
}

describe("grants autenticados y scoped", () => {
  test("el grant de referencia es válido y permite sus capacidades", () => {
    const grant = expectAccepted(parseGrant(referenceFixtures().grant));
    expectAccepted(evaluateGrant(grant, observeAction("session.observe"), FIXTURE_NOW_MS));
    expectAccepted(evaluateGrant(grant, observeAction("session.prompt.when_idle"), FIXTURE_NOW_MS));
    expectAccepted(evaluateGrant(grant, observeAction("session.control.abort"), FIXTURE_NOW_MS));
  });

  test("fuera de scope se deniega sin filtrar existencia", () => {
    const grant = expectAccepted(parseGrant(referenceFixtures().grant));
    expectRejection(
      evaluateGrant(grant, { ...observeAction("session.observe"), projectId: "prj_00000000000000000000000000000000" }, FIXTURE_NOW_MS),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
    expectRejection(
      evaluateGrant(grant, { ...observeAction("session.observe"), target: "otro" }, FIXTURE_NOW_MS),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
    expectRejection(
      evaluateGrant(grant, { ...observeAction("session.observe"), workspaceId: "wsp_00000000000000000000000000000000" }, FIXTURE_NOW_MS),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
    expectRejection(
      evaluateGrant(grant, { ...observeAction("session.observe"), capability: "session.control.steer" }, FIXTURE_NOW_MS),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
    expectRejection(
      evaluateGrant(grant, { ...observeAction("session.observe"), nativeSessionId: "otra-sesion" }, FIXTURE_NOW_MS),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
  });

  test("el wildcard sessions:'*' cubre cualquier sesión del mismo scope (semántica documentada)", () => {
    const json = referenceFixtures().grant as Record<string, unknown>;
    const scope = json.scope as Record<string, unknown>;
    const wildcard = expectAccepted(parseGrant({ ...json, scope: { ...scope, sessions: "*" } }));
    expectAccepted(
      evaluateGrant(wildcard, { ...observeAction("session.observe"), nativeSessionId: "otra-sesion" }, FIXTURE_NOW_MS),
    );
    // El wildcard nunca amplía proyecto/target fuera del scope.
    expectRejection(
      evaluateGrant(
        wildcard,
        { ...observeAction("session.observe"), nativeSessionId: "otra-sesion", target: "otro" },
        FIXTURE_NOW_MS,
      ),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
  });

  test("una lista explícita en una dimensión no se elude omitiendo la dimensión en la acción", () => {
    const grant = expectAccepted(parseGrant(referenceFixtures().grant));
    const withoutSession = {
      projectId: FIXTURE_PROJECT_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
      target: FIXTURE_TARGET,
      capability: "session.observe",
    } as const;
    const withoutWorkspace = {
      projectId: FIXTURE_PROJECT_ID,
      target: FIXTURE_TARGET,
      nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      capability: "session.observe",
    } as const;
    expectRejection(evaluateGrant(grant, withoutSession, FIXTURE_NOW_MS), "UNAUTHORIZED", "unauthorized_scope");
    expectRejection(evaluateGrant(grant, withoutWorkspace, FIXTURE_NOW_MS), "UNAUTHORIZED", "unauthorized_scope");

    // Con wildcard en ambas dimensiones, omitirlas en la acción sí está permitido.
    const json = referenceFixtures().grant as Record<string, unknown>;
    const scope = json.scope as Record<string, unknown>;
    const wildcard = expectAccepted(parseGrant({ ...json, scope: { ...scope, sessions: "*", workspaceIds: "*" } }));
    expectAccepted(evaluateGrant(wildcard, withoutSession, FIXTURE_NOW_MS));
    expectAccepted(evaluateGrant(wildcard, withoutWorkspace, FIXTURE_NOW_MS));
  });

  test("grant expirado o revocado deja de autorizar", () => {
    const json = referenceFixtures().grant as Record<string, unknown>;
    const expired = expectAccepted(parseGrant({ ...json, issuedAtMs: FIXTURE_NOW_MS - 7_200_000, expiresAtMs: FIXTURE_NOW_MS - 3_600_000 }));
    expectRejection(evaluateGrant(expired, observeAction("session.observe"), FIXTURE_NOW_MS), "EXPIRED", "grant_expired");
    const revoked = expectAccepted(parseGrant({ ...json, revokedAtMs: FIXTURE_NOW_MS - 1_000 }));
    expectRejection(evaluateGrant(revoked, observeAction("session.observe"), FIXTURE_NOW_MS), "UNAUTHORIZED", "grant_revoked");
  });

  test("TTL de grant excesivo se rechaza al validar", () => {
    const json = referenceFixtures().grant as Record<string, unknown>;
    expectRejection(
      parseGrant({ ...json, expiresAtMs: FIXTURE_NOW_MS + LIMITS.grantTtlMsMax + 60_000 }),
      "INVALID_INPUT",
      "invalid_field",
    );
  });
});

describe("root proof no heredable", () => {
  test("la root proof de referencia es válida para su instancia/challenge", () => {
    const fixtures = referenceFixtures();
    expectAccepted(verifyRootProof(fixtures.rootProof, FIXTURE_ROOT_CTX));
    expectAccepted(evaluateRootBindingClaim({ kind: "root_proof", proof: fixtures.rootProof }, FIXTURE_ROOT_CTX));
  });

  test("expirada o aún no vigente se rechaza", () => {
    const fixtures = referenceFixtures();
    expectRejection(
      verifyRootProof(fixtures.rootProof, { ...FIXTURE_ROOT_CTX, nowMs: fixtures.rootProof.expiresAtMs + 1 }),
      "UNAUTHORIZED",
      "root_proof_expired",
    );
    expectRejection(
      verifyRootProof(fixtures.rootProof, { ...FIXTURE_ROOT_CTX, nowMs: fixtures.rootProof.issuedAtMs - 1 }),
      "UNAUTHORIZED",
      "root_proof_not_yet_valid",
    );
  });

  test("challenge o audiencia ajenos, MAC inválida o instancia distinta se rechazan", () => {
    const fixtures = referenceFixtures();
    expectRejection(
      verifyRootProof(fixtures.rootProof, { ...FIXTURE_ROOT_CTX, challenge: "chal_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      "UNAUTHORIZED",
      "root_proof_challenge_mismatch",
    );
    expectRejection(
      verifyRootProof(fixtures.rootProof, { ...FIXTURE_ROOT_CTX, audience: "otro-broker" }),
      "UNAUTHORIZED",
      "root_proof_audience_mismatch",
    );
    expectRejection(
      verifyRootProof({ ...fixtures.rootProof, mac: "0".repeat(64) }, FIXTURE_ROOT_CTX),
      "UNAUTHORIZED",
      "root_proof_invalid_mac",
    );
    expectRejection(
      verifyRootProof(fixtures.rootProof, { ...FIXTURE_ROOT_CTX, instanceId: "ins_00000000000000000000000000000000" }),
      "UNAUTHORIZED",
      "root_proof_subject_mismatch",
    );
  });

  test("es de un solo uso: consumida no vale de nuevo; rebind exige proof nueva", () => {
    const fixtures = referenceFixtures();
    const ledger = new RootProofLedger();
    const ctx = {
      ...FIXTURE_ROOT_CTX,
      isProofConsumed: (proofId: string) => ledger.isConsumed(proofId),
    };
    const first = expectAccepted(ledger.consume(fixtures.rootProof.proofId, fixtures.rootProof.expiresAtMs));
    expect(first).toBe(true);
    expectRejection(
      evaluateRootBindingClaim({ kind: "root_proof", proof: fixtures.rootProof }, ctx),
      "UNAUTHORIZED",
      "root_proof_consumed",
    );
    // Rebind explícito con la MISMA proof también falla (uso único).
    expectRejection(ledger.rebind(fixtures.rootProof, ctx), "UNAUTHORIZED", "root_proof_consumed");

    // Una proof NUEVA (nuevo proofId) sí puede rebind, y queda consumida.
    const newProofInput = {
      ...fixtures.rootProofMacInput,
      proofId: "rp_b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
    };
    const signed = { ...newProofInput, mac: computeRootProofMac(newProofInput, FIXTURE_MAC_KEY) };
    expectAccepted(ledger.rebind(signed, ctx));
    expectRejection(ledger.rebind(signed, ctx), "UNAUTHORIZED", "root_proof_consumed");
  });

  test("un subagente con environment copiado falla el registro aunque traiga IDs", () => {
    expectRejection(
      evaluateRootBindingClaim(
        {
          kind: "environment",
          variables: {
            OMP_SESSION: FIXTURE_NATIVE_SESSION_ID,
            OMP_INSTANCE: FIXTURE_INSTANCE_ID,
            OMP_PROJECT: FIXTURE_PROJECT_ID,
            OMP_WORKSPACE: FIXTURE_WORKSPACE_ID,
          },
        },
        FIXTURE_ROOT_CTX,
      ),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
  });

  test("una root proof de otra instancia no sirve para reclamar raíz ajena", () => {
    const fixtures = referenceFixtures();
    // Mismo challenge/audiencia, instancia propia de OTRO proceso.
    const foreignInput = {
      ...fixtures.rootProofMacInput,
      subject: {
        instanceId: "ins_00000000000000000000000000000000",
        nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      },
    };
    const foreignProof = { ...foreignInput, mac: computeRootProofMac(foreignInput, FIXTURE_MAC_KEY) };
    expectRejection(verifyRootProof(foreignProof, FIXTURE_ROOT_CTX), "UNAUTHORIZED", "root_proof_subject_mismatch");
  });
});

describe("controlEpoch", () => {
  test("epoch obsoleto se rechaza; el vigente pasa", () => {
    const fixtures = referenceFixtures();
    expectAccepted(assertControlEpoch(fixtures.controlLease, 4, FIXTURE_INSTANCE_ID, FIXTURE_NOW_MS));
    expectRejection(
      assertControlEpoch(fixtures.controlLease, 3, FIXTURE_INSTANCE_ID, FIXTURE_NOW_MS),
      "STALE_CONTROL_EPOCH",
      "stale_control_epoch",
    );
  });

  test("la instancia que no sostiene el lease se rechaza como stale", () => {
    const fixtures = referenceFixtures();
    expectRejection(
      assertControlEpoch(fixtures.controlLease, 4, "ins_00000000000000000000000000000000", FIXTURE_NOW_MS),
      "STALE_INSTANCE",
      "stale_instance",
    );
  });

  test("renovar/tomar control incrementa el epoch e invalida el anterior", () => {
    const fixtures = referenceFixtures();
    const renewed = fixtureRenewedControlLease();
    expect(renewed.epoch).toBe(fixtures.controlLease.epoch + 1);
    expectRejection(
      assertControlEpoch(renewed, fixtures.controlLease.epoch, FIXTURE_INSTANCE_ID, FIXTURE_NOW_MS),
      "STALE_CONTROL_EPOCH",
      "stale_control_epoch",
    );
    expectAccepted(assertControlEpoch(renewed, renewed.epoch, FIXTURE_INSTANCE_ID, FIXTURE_NOW_MS));
    // Sin lease vigente no hay control.
    expectRejection(assertControlEpoch(undefined, 1, FIXTURE_INSTANCE_ID, FIXTURE_NOW_MS), "STALE_CONTROL_EPOCH", "stale_control_epoch");
  });

  test("lease expirado deja de autorizar control", () => {
    const fixtures = referenceFixtures();
    expectRejection(
      assertControlEpoch(fixtures.controlLease, 4, FIXTURE_INSTANCE_ID, fixtures.controlLease.expiresAtMs + 1),
      "EXPIRED",
      "grant_expired",
    );
  });
});
