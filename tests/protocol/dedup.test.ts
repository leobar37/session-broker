/**
 * Criterio binario: mismo requestId + mismo hash es idempotente (recupera
 * operación/recibos, sin nuevos efectos); mismo requestId + hash distinto es
 * PAYLOAD_CONFLICT sin efectos.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  computeRequestPayloadHash,
  evaluateDedup,
  allowsAutomaticReExecution,
  isRetentionExpired,
  LIMITS,
} from "@session-broker/protocol";
import {
  FIXTURE_NOW_MS,
  FIXTURE_PROJECT_ID,
  FIXTURE_REQUEST_ID,
  FIXTURE_TARGET,
  idempotentReplayExample,
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

describe("dedup por requestId + hash canónico", () => {
  test("mismo requestId + mismo hash -> replay idempotente sin efectos nuevos", () => {
    const { existing, input } = idempotentReplayExample();
    const effectsBefore = isolation.fakeTransport.effectsCount;
    const decision = expectAccepted(evaluateDedup(existing, input));
    expect(decision.kind).toBe("idempotent_replay");
    if (decision.kind === "idempotent_replay") {
      expect(decision.record).toBe(existing);
    }
    // Replay idempotente no emite nada por el transporte (sin efectos).
    expect(isolation.fakeTransport.effectsCount).toBe(effectsBefore);
  });

  test("mismo requestId + hash distinto -> PAYLOAD_CONFLICT sin efectos", () => {
    const { existing } = idempotentReplayExample();
    const effectsBefore = isolation.fakeTransport.effectsCount;
    expectRejection(
      evaluateDedup(existing, {
        projectId: FIXTURE_PROJECT_ID,
        requestId: FIXTURE_REQUEST_ID,
        operation: "query",
        target: { target: FIXTURE_TARGET },
        payload: { query: "otra cosa", limit: 3 },
        nowMs: FIXTURE_NOW_MS,
      }),
      "PAYLOAD_CONFLICT",
      "payload_conflict",
    );
    expect(isolation.fakeTransport.effectsCount).toBe(effectsBefore);
  });

  test("cambiar solo el target o la operación también produce PAYLOAD_CONFLICT", () => {
    const { existing } = idempotentReplayExample();
    expectRejection(
      evaluateDedup(existing, {
        projectId: FIXTURE_PROJECT_ID,
        requestId: FIXTURE_REQUEST_ID,
        operation: "list",
        target: { target: FIXTURE_TARGET },
        payload: { query: "sessions", limit: 10 },
        nowMs: FIXTURE_NOW_MS,
      }),
      "PAYLOAD_CONFLICT",
      "payload_conflict",
    );
    expectRejection(
      evaluateDedup(existing, {
        projectId: FIXTURE_PROJECT_ID,
        requestId: FIXTURE_REQUEST_ID,
        operation: "query",
        target: { target: "otro-target" },
        payload: { query: "sessions", limit: 10 },
        nowMs: FIXTURE_NOW_MS,
      }),
      "PAYLOAD_CONFLICT",
      "payload_conflict",
    );
  });

  test("requestId sin previo crea registro nuevo en estado queued", () => {
    const decision = expectAccepted(
      evaluateDedup(undefined, {
        projectId: FIXTURE_PROJECT_ID,
        requestId: FIXTURE_REQUEST_ID,
        operation: "query",
        target: { target: FIXTURE_TARGET },
        payload: { query: "sessions", limit: 10 },
        nowMs: FIXTURE_NOW_MS,
      }),
    );
    expect(decision.kind).toBe("new");
    if (decision.kind === "new") {
      expect(decision.record.state).toBe("queued");
      expect(decision.record.receipts.length).toBe(1);
    }
  });

  test("el hash es estable y cubre operación/target/payload", () => {
    const a = expectAccepted(
      computeRequestPayloadHash({ operation: "query", target: { target: FIXTURE_TARGET }, payload: { query: "x" } }),
    );
    const b = expectAccepted(
      computeRequestPayloadHash({ operation: "query", target: { target: FIXTURE_TARGET }, payload: { query: "x" } }),
    );
    const c = expectAccepted(
      computeRequestPayloadHash({ operation: "query", target: { target: FIXTURE_TARGET }, payload: { query: "y" } }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("requestId de otro proyecto no es reutilizable (scoped por proyecto)", () => {
    const { existing } = idempotentReplayExample();
    expectRejection(
      evaluateDedup(existing, {
        projectId: "prj_00000000000000000000000000000000",
        requestId: FIXTURE_REQUEST_ID,
        operation: "query",
        target: { target: FIXTURE_TARGET },
        payload: { query: "sessions", limit: 10 },
        nowMs: FIXTURE_NOW_MS,
      }),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
  });

  test("solo los estados en vuelo permiten re-ejecución automática; outcome_unknown no", () => {
    expect(allowsAutomaticReExecution("queued")).toBe(true);
    expect(allowsAutomaticReExecution("received")).toBe(true);
    expect(allowsAutomaticReExecution("submitted")).toBe(true);
    expect(allowsAutomaticReExecution("outcome_unknown")).toBe(false);
    expect(allowsAutomaticReExecution("completed")).toBe(false);
  });

  test("fuera de retención obliga a snapshot (isRetentionExpired)", () => {
    expect(isRetentionExpired(FIXTURE_NOW_MS, FIXTURE_NOW_MS + LIMITS.eventRetentionMs + 1)).toBe(true);
    expect(isRetentionExpired(FIXTURE_NOW_MS, FIXTURE_NOW_MS + 1)).toBe(false);
  });
});
