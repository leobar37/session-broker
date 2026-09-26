/**
 * Fixtures de referencia del contrato (consumibles por `@session-broker/protocol/fixtures`).
 *
 * Deterministas (sin aleatoriedad ni red): los pares requestId/hash ilustran
 * la semántica de dedup y los fixtures inválidos documentan el rechazo
 * estable (code + reason) que todo consumidor debe observar. Los valores son
 * FAKE y no corresponden a credenciales reales.
 */

import { computeRootProofMac, evaluateRootBindingClaim, type RootProof, type RootProofMacInput, type VerifyRootProofContext } from "./root-proof";
import { type Result } from "./validation";
import { type ProtocolError, type ProtocolErrorCode, type ProtocolErrorReason } from "./errors";
import {
  evaluateGrant,
  parseGrant,
  renewControlLease,
  assertControlEpoch,
  type ControlLease,
  type Grant,
  type GrantAction,
} from "./grants";
import { checkWorkspaceIdentity, parseProjectFile, parseWorkspaceFile, type WorkspaceFile } from "./identity";
import { checkFrameSize, validateRequestEnvelope } from "./envelope";
import { validateHello, validateWelcome } from "./handshake";
import { applyRequestEvent, classifyAskCompletion, type RequestEventType, type RequestState } from "./states";
import { evaluateDedup, computeRequestPayloadHash, type RequestRecord } from "./dedup";
import { checkOperationSupport, type Capability } from "./capabilities";
import { type Operation } from "./operations";
import { LIMITS } from "./limits";

export const FIXTURE_NOW_MS = 1_700_000_000_000;
export const FIXTURE_PROJECT_ID = "prj_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const FIXTURE_WORKSPACE_ID = "wsp_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export const FIXTURE_INSTANCE_ID = "ins_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
export const FIXTURE_CONNECTION_ID = "con_bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc";
export const FIXTURE_REQUEST_ID = "req_d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
export const FIXTURE_ASK_REQUEST_ID = "req_d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5";
export const FIXTURE_REPLY_REQUEST_ID = "req_d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6";
export const FIXTURE_EVENT_ID = "evt_e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6";
export const FIXTURE_GRANT_ID = "grt_f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7";
export const FIXTURE_PROOF_ID = "rp_a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9";
export const FIXTURE_CHALLENGE = "chal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXTURE_TARGET = "omp";
export const FIXTURE_NATIVE_SESSION_ID = "session-0001";
export const FIXTURE_MAC_KEY = "fixture-mac-key-not-a-real-secret";
export const FIXTURE_CREDENTIAL = "fixture-credential-not-a-real-secret";
export const FIXTURE_AUDIENCE = "broker-fixture";

const FIXTURE_SESSION_REF = {
  projectId: FIXTURE_PROJECT_ID,
  scope: "workspace",
  workspaceId: FIXTURE_WORKSPACE_ID,
  target: FIXTURE_TARGET,
  nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
} as const;

const FIXTURE_PROJECT_SCOPE_REF = {
  projectId: FIXTURE_PROJECT_ID,
  scope: "project",
  target: FIXTURE_TARGET,
  nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
} as const;

const FIXTURE_GRANT_JSON = {
  grantId: FIXTURE_GRANT_ID,
  subject: "agent-fixture",
  scope: {
    projectId: FIXTURE_PROJECT_ID,
    workspaceIds: [FIXTURE_WORKSPACE_ID],
    targets: [FIXTURE_TARGET],
    // Scope explícito por sesión: demuestra el filtrado por sesión del grant.
    // El wildcard "*" queda cubierto por un test dedicado en tests/protocol.
    sessions: [FIXTURE_NATIVE_SESSION_ID],
    capabilities: [
      "session.identity",
      "session.observe",
      "session.prompt.when_idle",
      "session.reply_tool",
      "session.notify",
      "session.control.prompt",
      "session.control.abort",
    ],
  },
  issuedBy: "coordinator-fixture",
  issuedAtMs: FIXTURE_NOW_MS - 60_000,
  expiresAtMs: FIXTURE_NOW_MS + 3_600_000,
} as const;

const FIXTURE_CONTROL_LEASE: ControlLease = {
  scopeProjectId: FIXTURE_PROJECT_ID,
  scopeTarget: FIXTURE_TARGET,
  scopeNativeSessionId: FIXTURE_NATIVE_SESSION_ID,
  epoch: 4,
  holderInstanceId: FIXTURE_INSTANCE_ID,
  issuedAtMs: FIXTURE_NOW_MS - 60_000,
  expiresAtMs: FIXTURE_NOW_MS + 3_600_000,
};

export const FIXTURE_ROOT_CTX: VerifyRootProofContext = {
  nowMs: FIXTURE_NOW_MS,
  challenge: FIXTURE_CHALLENGE,
  audience: FIXTURE_AUDIENCE,
  instanceId: FIXTURE_INSTANCE_ID,
  macKey: FIXTURE_MAC_KEY,
  isProofConsumed: () => false,
};

function requestEnvelope(
  requestId: string,
  operation: "query" | "ask" | "reply" | "control" | "notify",
  payload: unknown,
  extra?: { controlEpoch?: number },
): Record<string, unknown> {
  return {
    v: 1,
    kind: "request",
    requestId,
    operation,
    target: { target: FIXTURE_TARGET, session: FIXTURE_SESSION_REF },
    payload,
    grantId: FIXTURE_GRANT_ID,
    sentAtMs: FIXTURE_NOW_MS,
    ...(extra?.controlEpoch === undefined ? {} : { controlEpoch: extra.controlEpoch }),
  };
}

export interface ReferenceFixtures {
  readonly projectFile: unknown;
  readonly workspaceFile: unknown;
  readonly workspaceFileOtherRoot: unknown;
  readonly sessionRefProjectScope: unknown;
  readonly grant: unknown;
  readonly controlLease: ControlLease;
  readonly hello: unknown;
  readonly welcome: unknown;
  readonly rootProof: RootProof;
  readonly rootProofMacInput: RootProofMacInput;
  readonly requestQuery: unknown;
  readonly requestAsk: unknown;
  readonly requestReply: unknown;
  readonly requestControl: unknown;
  readonly requestNotify: unknown;
}

export function referenceFixtures(): ReferenceFixtures {
  const rootProofMacInput: RootProofMacInput = {
    proofVersion: 1,
    proofId: FIXTURE_PROOF_ID,
    issuer: `omp-adapter:${FIXTURE_INSTANCE_ID}`,
    subject: { instanceId: FIXTURE_INSTANCE_ID, nativeSessionId: FIXTURE_NATIVE_SESSION_ID, pid: 4242 },
    challenge: FIXTURE_CHALLENGE,
    audience: FIXTURE_AUDIENCE,
    issuedAtMs: FIXTURE_NOW_MS - 1_000,
    expiresAtMs: FIXTURE_NOW_MS + 299_000,
  };
  return {
    projectFile: {
      schemaVersion: 1,
      projectId: FIXTURE_PROJECT_ID,
      createdAtMs: FIXTURE_NOW_MS - 86_400_000,
      name: "fixture-project",
    },
    workspaceFile: {
      schemaVersion: 1,
      workspaceId: FIXTURE_WORKSPACE_ID,
      projectId: FIXTURE_PROJECT_ID,
      rootPath: "/tmp/checkout-a",
      createdAtMs: FIXTURE_NOW_MS - 3_600_000,
    },
    workspaceFileOtherRoot: {
      schemaVersion: 1,
      workspaceId: FIXTURE_WORKSPACE_ID,
      projectId: FIXTURE_PROJECT_ID,
      rootPath: "/tmp/checkout-b",
      createdAtMs: FIXTURE_NOW_MS - 3_600_000,
    },
    sessionRefProjectScope: FIXTURE_PROJECT_SCOPE_REF,
    grant: FIXTURE_GRANT_JSON,
    controlLease: FIXTURE_CONTROL_LEASE,
    hello: {
      kind: "hello",
      v: 1,
      protocolVersions: ["1.0.0"],
      clientName: "session-broker-client",
      clientVersion: "0.1.0",
      projectId: FIXTURE_PROJECT_ID,
      workspaceId: FIXTURE_WORKSPACE_ID,
      instanceId: FIXTURE_INSTANCE_ID,
      nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      grantId: FIXTURE_GRANT_ID,
      credential: FIXTURE_CREDENTIAL,
      capabilities: ["session.identity", "session.observe"],
    },
    welcome: {
      kind: "welcome",
      v: 1,
      protocolVersion: "1.0.0",
      connectionId: FIXTURE_CONNECTION_ID,
      serverChallenge: FIXTURE_CHALLENGE,
      serverCapabilities: [
        "session.identity",
        "session.observe",
        "session.prompt.when_idle",
        "session.reply_tool",
      ],
      maxFrameBytes: LIMITS.maxFrameBytes,
      heartbeatMs: LIMITS.heartbeatMs,
    },
    rootProof: { ...rootProofMacInput, mac: computeRootProofMac(rootProofMacInput, FIXTURE_MAC_KEY) },
    rootProofMacInput,
    requestQuery: requestEnvelope(FIXTURE_REQUEST_ID, "query", { query: "sessions", limit: 10 }),
    requestAsk: requestEnvelope(FIXTURE_ASK_REQUEST_ID, "ask", {
      question: "¿estado actual del proyecto?",
      deadlineMs: 300_000,
      policy: "when_idle",
    }),
    requestReply: requestEnvelope(FIXTURE_REPLY_REQUEST_ID, "reply", {
      replyTo: FIXTURE_ASK_REQUEST_ID,
      body: { answer: "todo en orden" },
      summary: "ok",
    }),
    requestControl: requestEnvelope(FIXTURE_REPLY_REQUEST_ID, "control", { verb: "abort" }, { controlEpoch: 4 }),
    requestNotify: requestEnvelope(FIXTURE_REQUEST_ID, "notify", {
      topic: "session.status",
      data: { state: "idle" },
    }),
  };
}

export type ValidFixtureName =
  | "project_file"
  | "workspace_file"
  | "session_ref_project_scope"
  | "grant"
  | "hello"
  | "welcome"
  | "root_proof"
  | "request_query"
  | "request_ask"
  | "request_reply"
  | "request_control"
  | "request_notify";

/** Valida un fixture de referencia con el validador oficial; ok => aceptado. */
export function checkValidFixture(name: ValidFixtureName, fixtures: ReferenceFixtures = referenceFixtures()): Result<unknown, ProtocolError> {
  switch (name) {
    case "project_file":
      return parseProjectFile(fixtures.projectFile);
    case "workspace_file":
      return parseWorkspaceFile(fixtures.workspaceFile);
    case "session_ref_project_scope":
      return validateRequestEnvelope({
        ...(fixtures.requestQuery as Record<string, unknown>),
        target: { target: FIXTURE_TARGET, session: fixtures.sessionRefProjectScope },
      });
    case "grant":
      return parseGrant(fixtures.grant);
    case "hello":
      return validateHello(fixtures.hello);
    case "welcome":
      return validateWelcome(fixtures.welcome);
    case "root_proof":
      return evaluateRootBindingClaim({ kind: "root_proof", proof: fixtures.rootProof }, FIXTURE_ROOT_CTX);
    case "request_query":
      return validateRequestEnvelope(fixtures.requestQuery);
    case "request_ask":
      return validateRequestEnvelope(fixtures.requestAsk);
    case "request_reply":
      return validateRequestEnvelope(fixtures.requestReply);
    case "request_control":
      return validateRequestEnvelope(fixtures.requestControl);
    case "request_notify":
      return validateRequestEnvelope(fixtures.requestNotify);
  }
}

export type InvalidFixtureCategory =
  | "envelope"
  | "frame"
  | "hello"
  | "identity"
  | "workspace"
  | "root"
  | "grant_eval"
  | "control_epoch"
  | "dedup"
  | "ask_state"
  | "state"
  | "support";

export interface ReferenceInvalidFixture {
  readonly name: string;
  readonly category: InvalidFixtureCategory;
  /** Entrada cruda para consumidores; el dispatcher la procesa según categoría. */
  readonly value: unknown;
  readonly expected: {
    readonly code: ProtocolErrorCode;
    readonly reason: ProtocolErrorReason;
  };
}

/**
 * Fixtures negativos deterministas: cada uno debe rechazarse con exactamente
 * el `code` + `reason` esperados (rechazo estable entre ramas).
 */
export function referenceInvalidFixtures(): ReferenceInvalidFixture[] {
  const base = referenceFixtures();
  const queryHashInput = {
    operation: "query" as const,
    target: { target: FIXTURE_TARGET },
    payload: { query: "sessions", limit: 10 },
  };
  const queryHash = computeRequestPayloadHash(queryHashInput);
  const queryRecord: RequestRecord = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: FIXTURE_REQUEST_ID,
    operation: "query",
    target: queryHashInput.target,
    payloadHash: queryHash.ok ? queryHash.value : "",
    state: "queued",
    createdAtMs: FIXTURE_NOW_MS,
    updatedAtMs: FIXTURE_NOW_MS,
    receipts: [],
  };
  return [
    {
      name: "incompatible_version_envelope",
      category: "envelope",
      value: { ...(base.requestQuery as Record<string, unknown>), v: 99 },
      expected: { code: "INCOMPATIBLE_VERSION", reason: "incompatible_version" },
    },
    {
      name: "frame_exceeded",
      category: "frame",
      value: `{"padding":"${"x".repeat(LIMITS.maxFrameBytes)}"}`,
      expected: { code: "INVALID_INPUT", reason: "frame_too_large" },
    },
    {
      name: "schema_malformed_envelope",
      category: "envelope",
      value: "not-an-object",
      expected: { code: "INVALID_INPUT", reason: "schema_malformed" },
    },
    {
      name: "invalid_request_id",
      category: "envelope",
      value: { ...(base.requestQuery as Record<string, unknown>), requestId: 42 },
      expected: { code: "INVALID_INPUT", reason: "invalid_format" },
    },
    {
      name: "unknown_capability_hello",
      category: "hello",
      value: { ...(base.hello as Record<string, unknown>), capabilities: ["cap.unknown"] },
      expected: { code: "UNSUPPORTED_CAPABILITY", reason: "unknown_capability" },
    },
    {
      name: "unknown_operation_envelope",
      category: "envelope",
      value: { ...(base.requestQuery as Record<string, unknown>), operation: "execute" },
      expected: { code: "UNSUPPORTED_CAPABILITY", reason: "unsupported_operation" },
    },
    {
      name: "unknown_control_verb",
      category: "envelope",
      value: {
        ...(base.requestControl as Record<string, unknown>),
        payload: { verb: "nuke" },
      },
      expected: { code: "UNSUPPORTED_CAPABILITY", reason: "unsupported_control_verb" },
    },
    {
      name: "payload_too_large",
      category: "envelope",
      value: {
        ...(base.requestReply as Record<string, unknown>),
        payload: {
          replyTo: FIXTURE_ASK_REQUEST_ID,
          body: "y".repeat(LIMITS.maxPayloadBytes + 1),
        },
      },
      expected: { code: "INVALID_INPUT", reason: "payload_too_large" },
    },
    {
      name: "reply_to_self",
      category: "envelope",
      value: {
        ...(base.requestReply as Record<string, unknown>),
        payload: { replyTo: FIXTURE_REPLY_REQUEST_ID, body: { answer: "x" } },
      },
      expected: { code: "INVALID_INPUT", reason: "reply_to_mismatch" },
    },
    {
      name: "payload_conflict_pair",
      category: "dedup",
      value: {
        existing: queryRecord,
        input: {
          projectId: FIXTURE_PROJECT_ID,
          requestId: FIXTURE_REQUEST_ID,
          operation: "query",
          target: { target: FIXTURE_TARGET },
          payload: { query: "different", limit: 5 },
          nowMs: FIXTURE_NOW_MS,
        },
      },
      expected: { code: "PAYLOAD_CONFLICT", reason: "payload_conflict" },
    },
    {
      name: "ids_only_root_claim",
      category: "root",
      value: { kind: "environment", variables: { OMP_SESSION: FIXTURE_NATIVE_SESSION_ID, PID: "4242" } },
      expected: { code: "UNAUTHORIZED", reason: "root_claim_not_proven" },
    },
    {
      name: "reusable_token_root_claim",
      category: "root",
      value: { kind: "reusable_token", token: "static-token-copied-by-subagent" },
      expected: { code: "UNAUTHORIZED", reason: "root_claim_not_proven" },
    },
    {
      name: "future_project_file",
      category: "identity",
      value: {
        schemaVersion: 2,
        projectId: FIXTURE_PROJECT_ID,
        createdAtMs: FIXTURE_NOW_MS,
      },
      expected: { code: "INVALID_INPUT", reason: "unsupported_schema_version" },
    },
    {
      name: "workspace_copy_mismatch",
      category: "workspace",
      value: { file: base.workspaceFileOtherRoot, currentRootPath: "/tmp/checkout-a" },
      expected: { code: "INVALID_INPUT", reason: "workspace_identity_mismatch" },
    },
    {
      name: "expired_grant",
      category: "grant_eval",
      value: {
        grant: {
          ...(base.grant as Record<string, unknown>),
          issuedAtMs: FIXTURE_NOW_MS - 7_200_000,
          expiresAtMs: FIXTURE_NOW_MS - 3_600_000,
        },
        action: {
          projectId: FIXTURE_PROJECT_ID,
          workspaceId: FIXTURE_WORKSPACE_ID,
          target: FIXTURE_TARGET,
          nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
          capability: "session.observe",
        },
        nowMs: FIXTURE_NOW_MS,
      },
      expected: { code: "EXPIRED", reason: "grant_expired" },
    },
    {
      name: "stale_control_epoch",
      category: "control_epoch",
      value: { claimedEpoch: 3, instanceId: FIXTURE_INSTANCE_ID, nowMs: FIXTURE_NOW_MS },
      expected: { code: "STALE_CONTROL_EPOCH", reason: "stale_control_epoch" },
    },
    {
      name: "ask_complete_without_reply",
      category: "ask_state",
      value: { state: "submitted", event: "complete", operation: "ask" },
      expected: { code: "INVALID_INPUT", reason: "ask_requires_explicit_reply" },
    },
    {
      name: "outcome_unknown_replay",
      category: "state",
      value: { state: "outcome_unknown", event: "submit", operation: "query" },
      expected: { code: "INVALID_INPUT", reason: "outcome_unknown_no_replay" },
    },
    {
      name: "missing_capability_support",
      category: "support",
      value: { operation: "control", verb: "steer", supported: ["session.observe"] },
      expected: { code: "UNSUPPORTED_CAPABILITY", reason: "missing_capability" },
    },
    {
      name: "agent_end_does_not_complete_ask",
      category: "ask_state",
      value: { state: "submitted", event: "complete", operation: "ask", signal: { kind: "agent_end" } },
      expected: { code: "INVALID_INPUT", reason: "ask_requires_explicit_reply" },
    },
  ];
}

/**
 * Dispatcher oficial de fixtures negativos: ejecuta el validador que
 * corresponde a la categoría y devuelve el error observado.
 */
export function checkInvalidFixture(fixture: ReferenceInvalidFixture): Result<unknown, ProtocolError> {
  const base = referenceFixtures();
  const value = fixture.value as Record<string, unknown>;
  switch (fixture.category) {
    case "envelope":
      return validateRequestEnvelope(fixture.value);
    case "frame":
      return checkFrameSize(fixture.value as string);
    case "hello":
      return validateHello(fixture.value);
    case "identity":
      return parseProjectFile(fixture.value);
    case "workspace": {
      const parsed = parseWorkspaceFile(value.file);
      if (!parsed.ok) return parsed;
      return checkWorkspaceIdentity(parsed.value as WorkspaceFile, value.currentRootPath as string);
    }
    case "root":
      return evaluateRootBindingClaim(fixture.value, FIXTURE_ROOT_CTX);
    case "grant_eval": {
      const parsed = parseGrant(value.grant);
      if (!parsed.ok) return parsed;
      return evaluateGrant(parsed.value as Grant, value.action as GrantAction, value.nowMs as number);
    }
    case "control_epoch":
      return assertControlEpoch(
        base.controlLease,
        value.claimedEpoch,
        value.instanceId,
        value.nowMs as number,
      );
    case "dedup":
      return evaluateDedup(value.existing as RequestRecord, value.input as Parameters<typeof evaluateDedup>[1]);
    case "ask_state": {
      const signal = value.signal as { kind: string } | undefined;
      if (signal !== undefined && signal.kind === "agent_end") {
        const classified = classifyAskCompletion({ kind: "agent_end" }, FIXTURE_ASK_REQUEST_ID);
        if (!classified.ok) return classified;
        // agent_end no produce transición: el estado permanece y el evento "complete" es inválido para ask.
      }
      return applyRequestEvent(value.state as RequestState | "new", value.event as RequestEventType, {
        operation: value.operation as Operation,
      });
    }
    case "state":
      return applyRequestEvent(value.state as RequestState | "new", value.event as RequestEventType, {
        operation: value.operation as Operation,
      });
    case "support":
      return checkOperationSupport(value.operation as string, value.verb as string, value.supported as readonly Capability[]);
  }
}

/** Par válido de dedup: mismo requestId + mismo hash => replay idempotente. */
export function idempotentReplayExample(): {
  existing: RequestRecord;
  input: Parameters<typeof evaluateDedup>[1];
} {
  const input = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: FIXTURE_REQUEST_ID,
    operation: "query" as const,
    target: { target: FIXTURE_TARGET },
    payload: { query: "sessions", limit: 10 },
    nowMs: FIXTURE_NOW_MS,
  };
  const hash = computeRequestPayloadHash(input);
  const existing: RequestRecord = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: FIXTURE_REQUEST_ID,
    operation: "query",
    target: { target: FIXTURE_TARGET },
    payloadHash: hash.ok ? hash.value : "",
    state: "queued",
    createdAtMs: FIXTURE_NOW_MS,
    updatedAtMs: FIXTURE_NOW_MS,
    receipts: [{ state: "queued", atMs: FIXTURE_NOW_MS, eventId: FIXTURE_EVENT_ID, eventSeq: 1 }],
  };
  return { existing, input };
}

/** Referencias auxiliares exportadas para consumidores (P-002/P-003/P-006). */
export function fixtureRenewedControlLease(): ControlLease {
  return renewControlLease(FIXTURE_CONTROL_LEASE, {
    scopeProjectId: FIXTURE_PROJECT_ID,
    scopeTarget: FIXTURE_TARGET,
    scopeNativeSessionId: FIXTURE_NATIVE_SESSION_ID,
    holderInstanceId: FIXTURE_INSTANCE_ID,
    issuedAtMs: FIXTURE_NOW_MS,
    expiresAtMs: FIXTURE_NOW_MS + 3_600_000,
  });
}

export const FIXTURE_VALID_NAMES: readonly ValidFixtureName[] = [
  "project_file",
  "workspace_file",
  "session_ref_project_scope",
  "grant",
  "hello",
  "welcome",
  "root_proof",
  "request_query",
  "request_ask",
  "request_reply",
  "request_control",
  "request_notify",
];

/** Errores esperados agregados; útil para consumidores que validan el contrato. */
export function expectedErrorTable(): ReadonlyArray<{ name: string; code: ProtocolErrorCode; reason: ProtocolErrorReason }> {
  return referenceInvalidFixtures().map((fixture) => ({
    name: fixture.name,
    code: fixture.expected.code,
    reason: fixture.expected.reason,
  }));
}
