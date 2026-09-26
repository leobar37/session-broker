/**
 * Criterio binario (NFR-002/NFR-004): límites numéricos verificables y
 * aplicados por los validadores; backpressure nunca descarta en silencio.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BACKPRESSURE_POLICY,
  LIMITS,
  checkFrameSize,
  computeRootProofMac,
  frameByteLength,
  isRetentionExpired,
  parseGrant,
  validateRequestEnvelope,
  validateOperationPayload,
  verifyRootProof,
} from "@session-broker/protocol";
import {
  FIXTURE_MAC_KEY,
  FIXTURE_NOW_MS,
  FIXTURE_ROOT_CTX,
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

describe("límites de frame y payload", () => {
  test("frame en el límite pasa; un byte más se rechaza", () => {
    const padding = "p".repeat(LIMITS.maxFrameBytes - 10);
    const atLimit = `{"pad":"${padding}"}`;
    expect(frameByteLength(atLimit)).toBe(LIMITS.maxFrameBytes);
    expectAccepted(checkFrameSize(atLimit));
    const overLimit = `{"pad":"${padding}x"}`;
    expect(frameByteLength(overLimit)).toBeGreaterThan(LIMITS.maxFrameBytes);
    expectRejection(checkFrameSize(overLimit), "INVALID_INPUT", "frame_too_large");
  });

  test("payload sobre maxPayloadBytes se rechaza con payload_too_large", () => {
    const fixtures = referenceFixtures();
    const replyTo = (fixtures.requestReply as { payload: { replyTo: string } }).payload.replyTo;
    const big = {
      ...(fixtures.requestReply as Record<string, unknown>),
      payload: { replyTo, body: "b".repeat(LIMITS.maxPayloadBytes + 1) },
    };
    expectRejection(validateRequestEnvelope(big), "INVALID_INPUT", "payload_too_large");
  });
});

describe("límites de páginas, plazos y TTL", () => {
  test("limit de página respeta 1..maxHistoryPageItems", () => {
    expectAccepted(validateOperationPayload("history", { limit: LIMITS.maxHistoryPageItems }));
    expectRejection(
      validateOperationPayload("history", { limit: LIMITS.maxHistoryPageItems + 1 }),
      "INVALID_INPUT",
      "invalid_field",
    );
    expectRejection(validateOperationPayload("history", { limit: 0 }), "INVALID_INPUT", "invalid_field");
  });

  test("deadline de solicitud dentro de 1..requestTimeoutMsMax", () => {
    const fixtures = referenceFixtures();
    const withDeadline = {
      ...(fixtures.requestQuery as Record<string, unknown>),
      deadlineMs: LIMITS.requestTimeoutMsDefault,
    };
    expectAccepted(validateRequestEnvelope(withDeadline));
    expectRejection(
      validateRequestEnvelope({ ...withDeadline, deadlineMs: LIMITS.requestTimeoutMsMax + 1 }),
      "INVALID_INPUT",
      "deadline_out_of_bounds",
    );
    expectRejection(
      validateRequestEnvelope({ ...withDeadline, deadlineMs: 0 }),
      "INVALID_INPUT",
      "deadline_out_of_bounds",
    );
  });

  test("deadline de ask dentro de 1..askDeadlineMsMax", () => {
    expectAccepted(
      validateOperationPayload("ask", { question: "hola", deadlineMs: LIMITS.askDeadlineMsDefault, policy: "when_idle" }),
    );
    expectRejection(
      validateOperationPayload("ask", { question: "hola", deadlineMs: LIMITS.askDeadlineMsMax + 1, policy: "when_idle" }),
      "INVALID_INPUT",
      "deadline_out_of_bounds",
    );
    expectRejection(
      validateOperationPayload("ask", { question: "hola", deadlineMs: 0, policy: "when_idle" }),
      "INVALID_INPUT",
      "deadline_out_of_bounds",
    );
  });

  test("TTL de grant limitado por grantTtlMsMax", () => {
    const json = referenceFixtures().grant as Record<string, unknown>;
    const issuedAtMs = json.issuedAtMs as number;
    expectAccepted(parseGrant({ ...json, expiresAtMs: issuedAtMs + LIMITS.grantTtlMsDefault }));
    expectRejection(
      parseGrant({ ...json, expiresAtMs: issuedAtMs + LIMITS.grantTtlMsMax + 1 }),
      "INVALID_INPUT",
      "invalid_field",
    );
  });

  test("TTL de root proof limitado por rootProofTtlMsMax", () => {
    const fixtures = referenceFixtures();
    const tooLongInput = {
      ...fixtures.rootProofMacInput,
      issuedAtMs: FIXTURE_NOW_MS - 1_000,
      expiresAtMs: FIXTURE_NOW_MS - 1_000 + LIMITS.rootProofTtlMsMax + 1,
    };
    const tooLong = { ...tooLongInput, mac: computeRootProofMac(tooLongInput, FIXTURE_MAC_KEY) };
    expectRejection(verifyRootProof(tooLong, FIXTURE_ROOT_CTX), "UNAUTHORIZED", "root_proof_expired");
  });
});

describe("retención, cursores y backpressure", () => {
  test("fuera de retención isRetentionExpired es true (snapshot explícito obligatorio)", () => {
    expect(isRetentionExpired(0, LIMITS.eventRetentionMs)).toBe(false);
    expect(isRetentionExpired(0, LIMITS.eventRetentionMs + 1)).toBe(true);
    expect(isRetentionExpired(0, LIMITS.cursorTtlMs + 1, LIMITS.cursorTtlMs)).toBe(true);
  });

  test("la política de backpressure nunca descarta comandos durables", () => {
    expect(BACKPRESSURE_POLICY.onEventQueueOverflow).toBe("reject_with_QUEUE_FULL");
    expect(BACKPRESSURE_POLICY.durableCommandDrop).toBe("never");
    expect(BACKPRESSURE_POLICY.slowConsumerAction).toBe("close_subscription");
  });

  test("cuotas y ventanas de reconexión son coherentes", () => {
    expect(LIMITS.maxInFlightRequestsPerGrant).toBe(32);
    expect(LIMITS.maxRequestsPerMinutePerGrant).toBe(120);
    expect(LIMITS.maxQueuedAsksPerSession).toBe(8);
    expect(LIMITS.reconnectBackoffMsInitial).toBeLessThanOrEqual(LIMITS.reconnectBackoffMsMax);
    expect(LIMITS.reconnectJitterRatio).toBeGreaterThanOrEqual(0);
    expect(LIMITS.reconnectJitterRatio).toBeLessThanOrEqual(1);
    expect(LIMITS.requestTimeoutMsDefault).toBeLessThanOrEqual(LIMITS.requestTimeoutMsMax);
    expect(LIMITS.askDeadlineMsDefault).toBeLessThanOrEqual(LIMITS.askDeadlineMsMax);
    expect(LIMITS.grantTtlMsDefault).toBeLessThanOrEqual(LIMITS.grantTtlMsMax);
  });
});
