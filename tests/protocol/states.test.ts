/**
 * Criterio binario: ask solo alcanza `completed` mediante reply explícito
 * (ni `agent_end` ni el siguiente texto); `outcome_unknown` no autoriza
 * repetición; la máquina de estados tiene transiciones únicas y congeladas.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyRequestEvent,
  classifyAskCompletion,
  isTerminalState,
  TERMINAL_STATES,
  REQUEST_STATES,
} from "@session-broker/protocol";
import { FIXTURE_ASK_REQUEST_ID, FIXTURE_REPLY_REQUEST_ID } from "@session-broker/protocol/fixtures";
import { assertModelUnused, expectAccepted, expectRejection, setupIsolation, type Isolation } from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

describe("flujo de estados", () => {
  test("la lista de estados es exactamente la congelada (sin accepted/delivered)", () => {
    expect([...REQUEST_STATES]).toEqual([
      "queued",
      "received",
      "submitted",
      "completed",
      "rejected",
      "failed",
      "expired",
      "cancelled",
      "outcome_unknown",
    ]);
  });

  test("camino feliz de una lectura: queued -> received -> submitted -> completed", () => {
    let state = expectAccepted(applyRequestEvent("new", "commit", { operation: "query" }));
    expect(state).toBe("queued");
    state = expectAccepted(applyRequestEvent(state, "receive", { operation: "query" }));
    expect(state).toBe("received");
    state = expectAccepted(applyRequestEvent(state, "submit", { operation: "query" }));
    expect(state).toBe("submitted");
    state = expectAccepted(applyRequestEvent(state, "complete", { operation: "query" }));
    expect(state).toBe("completed");
    expect(isTerminalState(state)).toBe(true);
  });

  test("los estados terminales no aceptan más eventos", () => {
    for (const state of TERMINAL_STATES) {
      if (state === "outcome_unknown") continue;
      expectRejection(applyRequestEvent(state, "submit", { operation: "query" }), "INVALID_INPUT", "terminal_state");
      expectRejection(applyRequestEvent(state, "complete", { operation: "query" }), "INVALID_INPUT", "terminal_state");
    }
  });

  test("transiciones inválidas se rechazan de forma estable", () => {
    expectRejection(applyRequestEvent("new", "submit", { operation: "query" }), "INVALID_INPUT", "invalid_transition");
    expectRejection(applyRequestEvent("queued", "complete", { operation: "query" }), "INVALID_INPUT", "invalid_transition");
    expectRejection(applyRequestEvent("received", "commit", { operation: "query" }), "INVALID_INPUT", "invalid_transition");
  });
});

describe("ask solo se completa con reply explícito", () => {
  test("evento complete genérico nunca completa un ask", () => {
    expectRejection(
      applyRequestEvent("submitted", "complete", { operation: "ask" }),
      "INVALID_INPUT",
      "ask_requires_explicit_reply",
    );
  });

  test("agent_end y siguiente texto no producen transición alguna", () => {
    expect(expectAccepted(classifyAskCompletion({ kind: "agent_end" }, FIXTURE_ASK_REQUEST_ID))).toBe(null);
    expect(expectAccepted(classifyAskCompletion({ kind: "next_text" }, FIXTURE_ASK_REQUEST_ID))).toBe(null);
    // Ni siquiera desde outcome_unknown ni desde submitted autorizan progreso.
    expectRejection(
      applyRequestEvent("submitted", "complete", { operation: "ask" }),
      "INVALID_INPUT",
      "ask_requires_explicit_reply",
    );
  });

  test("reply_tool autorizado con replyTo correcto produce el evento reply", () => {
    const event = expectAccepted(
      classifyAskCompletion(
        {
          kind: "reply_tool",
          requestId: FIXTURE_REPLY_REQUEST_ID,
          replyTo: FIXTURE_ASK_REQUEST_ID,
          authorized: true,
        },
        FIXTURE_ASK_REQUEST_ID,
      ),
    );
    expect(event).toBe("reply");
    const state = expectAccepted(applyRequestEvent("submitted", "reply", { operation: "ask" }));
    expect(state).toBe("completed");
  });

  test("reply con replyTo distinto o no autorizado se rechaza", () => {
    expectRejection(
      classifyAskCompletion(
        {
          kind: "reply_tool",
          requestId: FIXTURE_REPLY_REQUEST_ID,
          replyTo: FIXTURE_REPLY_REQUEST_ID,
          authorized: true,
        },
        FIXTURE_ASK_REQUEST_ID,
      ),
      "INVALID_INPUT",
      "reply_to_mismatch",
    );
    expectRejection(
      classifyAskCompletion(
        {
          kind: "reply_tool",
          requestId: FIXTURE_REPLY_REQUEST_ID,
          replyTo: FIXTURE_ASK_REQUEST_ID,
          authorized: false,
        },
        FIXTURE_ASK_REQUEST_ID,
      ),
      "UNAUTHORIZED",
      "unauthorized_scope",
    );
  });

  test("reply solo aplica a operaciones ask", () => {
    expectRejection(applyRequestEvent("submitted", "reply", { operation: "query" }), "INVALID_INPUT", "invalid_transition");
  });
});

describe("outcome_unknown", () => {
  test("no autoriza repetición ni progreso automático", () => {
    expectRejection(
      applyRequestEvent("outcome_unknown", "submit", { operation: "query" }),
      "INVALID_INPUT",
      "outcome_unknown_no_replay",
    );
    expectRejection(
      applyRequestEvent("outcome_unknown", "complete", { operation: "query" }),
      "INVALID_INPUT",
      "outcome_unknown_no_replay",
    );
    expectRejection(
      applyRequestEvent("outcome_unknown", "reply", { operation: "ask" }),
      "INVALID_INPUT",
      "outcome_unknown_no_replay",
    );
    expectRejection(
      applyRequestEvent("outcome_unknown", "commit", { operation: "query" }),
      "INVALID_INPUT",
      "outcome_unknown_no_replay",
    );
  });

  test("solo la reconciliación explícita lo resuelve", () => {
    expect(expectAccepted(applyRequestEvent("outcome_unknown", "reconcile_completed", { operation: "query" }))).toBe("completed");
    expect(expectAccepted(applyRequestEvent("outcome_unknown", "reconcile_failed", { operation: "query" }))).toBe("failed");
  });

  test("la ventana de crash se modela desde submitted/received", () => {
    expect(expectAccepted(applyRequestEvent("submitted", "crash_window", { operation: "ask" }))).toBe("outcome_unknown");
    expect(expectAccepted(applyRequestEvent("received", "crash_window", { operation: "query" }))).toBe("outcome_unknown");
    expect(expectAccepted(applyRequestEvent("queued", "crash_window", { operation: "query" }))).toBe("outcome_unknown");
  });
});
