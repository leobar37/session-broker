/**
 * Criterio binario: fixtures válidos se aceptan; versión incompatible, frame
 * excedido, schema malformado y capacidad desconocida se rechazan de forma
 * estable (code + reason exactos).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  checkFrameSize,
  checkOperationSupport,
  frameByteLength,
  negotiateHelloVersion,
  validateHello,
  validateRequestEnvelope,
  validateWelcome,
  LIMITS,
} from "@session-broker/protocol";
import { referenceFixtures } from "@session-broker/protocol/fixtures";
import { assertModelUnused, expectAccepted, expectRejection, setupIsolation, type Isolation } from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

describe("envelopes válidos", () => {
  test("query/ask/reply/control/notify de referencia se aceptan", () => {
    const fixtures = referenceFixtures();
    expectAccepted(validateRequestEnvelope(fixtures.requestQuery));
    expectAccepted(validateRequestEnvelope(fixtures.requestAsk));
    expectAccepted(validateRequestEnvelope(fixtures.requestReply));
    expectAccepted(validateRequestEnvelope(fixtures.requestControl));
    expectAccepted(validateRequestEnvelope(fixtures.requestNotify));
  });

  test("hello/welcome de referencia se aceptan y negocian 1.0.0", () => {
    const fixtures = referenceFixtures();
    const hello = expectAccepted(validateHello(fixtures.hello));
    const welcome = expectAccepted(validateWelcome(fixtures.welcome));
    expectAccepted(negotiateHelloVersion(hello, ["1.0.0"]));
    expect(welcome.protocolVersion).toBe("1.0.0");
  });
});

describe("rechazos estables", () => {
  test("versión de protocolo incompatible -> INCOMPATIBLE_VERSION/incompatible_version", () => {
    const fixtures = referenceFixtures();
    const bad = { ...(fixtures.requestQuery as Record<string, unknown>), v: 99 };
    expectRejection(validateRequestEnvelope(bad), "INCOMPATIBLE_VERSION", "incompatible_version");
  });

  test("negociación imposible -> INCOMPATIBLE_VERSION (fail-closed, sin fuzzy)", () => {
    const fixtures = referenceFixtures();
    const hello = expectAccepted(validateHello(fixtures.hello));
    expectRejection(
      negotiateHelloVersion({ ...hello, protocolVersions: ["2.0.0"] }, ["1.0.0"]),
      "INCOMPATIBLE_VERSION",
      "incompatible_version",
    );
  });

  test("frame excedido -> INVALID_INPUT/frame_too_large", () => {
    const oversized = `{"padding":"${"x".repeat(LIMITS.maxFrameBytes)}"}`;
    expect(frameByteLength(oversized)).toBeGreaterThan(LIMITS.maxFrameBytes);
    expectRejection(checkFrameSize(oversized), "INVALID_INPUT", "frame_too_large");
    const fixtures = referenceFixtures();
    expectRejection(
      validateRequestEnvelope(fixtures.requestQuery, { frameJson: oversized }),
      "INVALID_INPUT",
      "frame_too_large",
    );
  });

  test("schema malformado -> INVALID_INPUT/schema_malformed o invalid_format", () => {
    expectRejection(validateRequestEnvelope("not-an-object"), "INVALID_INPUT", "schema_malformed");
    expectRejection(validateRequestEnvelope(null), "INVALID_INPUT", "schema_malformed");
    const fixtures = referenceFixtures();
    const badId = { ...(fixtures.requestQuery as Record<string, unknown>), requestId: 42 };
    expectRejection(validateRequestEnvelope(badId), "INVALID_INPUT", "invalid_format");
  });

  test("capacidad desconocida -> UNSUPPORTED_CAPABILITY/unknown_capability", () => {
    const fixtures = referenceFixtures();
    const badHello = { ...(fixtures.hello as Record<string, unknown>), capabilities: ["cap.unknown"] };
    expectRejection(validateHello(badHello), "UNSUPPORTED_CAPABILITY", "unknown_capability");
  });

  test("operación desconocida -> UNSUPPORTED_CAPABILITY/unsupported_operation", () => {
    const fixtures = referenceFixtures();
    const badOp = { ...(fixtures.requestQuery as Record<string, unknown>), operation: "execute" };
    expectRejection(validateRequestEnvelope(badOp), "UNSUPPORTED_CAPABILITY", "unsupported_operation");
  });

  test("capacidad no soportada por el objetivo -> UNSUPPORTED_CAPABILITY/missing_capability", () => {
    expectRejection(
      checkOperationSupport("control", "steer", ["session.observe"]),
      "UNSUPPORTED_CAPABILITY",
      "missing_capability",
    );
    expectAccepted(checkOperationSupport("ask", undefined, ["session.prompt.when_idle", "session.reply_tool"]));
  });

  test("verbo de control desconocido -> UNSUPPORTED_CAPABILITY/unsupported_control_tern", () => {
    const fixtures = referenceFixtures();
    const badVerb = {
      ...(fixtures.requestControl as Record<string, unknown>),
      payload: { verb: "nuke" },
    };
    expectRejection(validateRequestEnvelope(badVerb), "UNSUPPORTED_CAPABILITY", "unsupported_control_verb");
  });

  test("payload excedido -> INVALID_INPUT/payload_too_large", () => {
    const fixtures = referenceFixtures();
    const bigBody = {
      ...(fixtures.requestReply as Record<string, unknown>),
      payload: {
        replyTo: (fixtures.requestReply as { payload: { replyTo: string } }).payload.replyTo,
        body: "y".repeat(LIMITS.maxPayloadBytes + 1),
      },
    };
    expectRejection(validateRequestEnvelope(bigBody), "INVALID_INPUT", "payload_too_large");
  });

  test("reply a sí misma -> INVALID_INPUT/reply_to_mismatch", () => {
    const fixtures = referenceFixtures();
    const selfReply = {
      ...(fixtures.requestReply as Record<string, unknown>),
      payload: {
        replyTo: (fixtures.requestReply as { requestId: string }).requestId,
        body: { answer: "x" },
      },
    };
    expectRejection(validateRequestEnvelope(selfReply), "INVALID_INPUT", "reply_to_mismatch");
  });

  test("control sin controlEpoch -> STALE_CONTROL_EPOCH/stale_control_epoch", () => {
    const fixtures = referenceFixtures();
    const control = fixtures.requestControl as Record<string, unknown>;
    const withoutEpoch = { ...control };
    delete withoutEpoch.controlEpoch;
    expectRejection(validateRequestEnvelope(withoutEpoch), "STALE_CONTROL_EPOCH", "stale_control_epoch");
  });
});
