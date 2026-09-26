/**
 * Criterio binario: los fixtures distinguen proyecto, checkout, sesión e
 * instancia; environment heredado e IDs solos nunca satisfacen autenticación
 * ni root binding.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  checkWorkspaceIdentity,
  createProjectFile,
  createWorkspaceFile,
  idsAloneAuthenticate,
  newInstanceId,
  newProjectId,
  newRequestId,
  newWorkspaceId,
  parseProjectFile,
  parseWorkspaceFile,
  validateSessionRef,
  isProjectId,
  isWorkspaceId,
  isInstanceId,
  isConnectionId,
  isRequestId,
  isEventId,
  isGrantId,
  isTargetId,
  isNativeSessionId,
  ID_PATTERNS,
  evaluateRootBindingClaim,
} from "@session-broker/protocol";
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_NATIVE_SESSION_ID,
  FIXTURE_NOW_MS,
  FIXTURE_PROJECT_ID,
  FIXTURE_REQUEST_ID,
  FIXTURE_TARGET,
  FIXTURE_WORKSPACE_ID,
  FIXTURE_ROOT_CTX,
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

describe("identidad distinguida", () => {
  test("cada tipo de identificador vive en su propio espacio de nombres", () => {
    expect(isProjectId(FIXTURE_PROJECT_ID)).toBe(true);
    expect(isWorkspaceId(FIXTURE_PROJECT_ID)).toBe(false);
    expect(isInstanceId(FIXTURE_PROJECT_ID)).toBe(false);
    expect(isRequestId(FIXTURE_PROJECT_ID)).toBe(false);
    expect(isNativeSessionId(FIXTURE_PROJECT_ID)).toBe(false);
    expect(isTargetId(FIXTURE_PROJECT_ID)).toBe(false);

    expect(isWorkspaceId(FIXTURE_WORKSPACE_ID)).toBe(true);
    expect(isProjectId(FIXTURE_WORKSPACE_ID)).toBe(false);
    expect(isInstanceId(FIXTURE_INSTANCE_ID)).toBe(true);
    expect(isProjectId(FIXTURE_INSTANCE_ID)).toBe(false);
    expect(isNativeSessionId(FIXTURE_NATIVE_SESSION_ID)).toBe(true);
    expect(isProjectId(FIXTURE_NATIVE_SESSION_ID)).toBe(false);
    expect(isTargetId(FIXTURE_TARGET)).toBe(true);
  });

  test("los validadores son disjuntos: ningún namespace acepta IDs con prefijo reservado ajeno", () => {
    const reservedSamples: ReadonlyArray<[string, (value: unknown) => boolean]> = [
      [FIXTURE_PROJECT_ID, isProjectId],
      [FIXTURE_WORKSPACE_ID, isWorkspaceId],
      [FIXTURE_INSTANCE_ID, isInstanceId],
      ["con_bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc", isConnectionId],
      [FIXTURE_REQUEST_ID, isRequestId],
      ["evt_e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6", isEventId],
      ["grt_f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7", isGrantId],
      ["rp_a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9", (value) => ID_PATTERNS.proofId.test(String(value))],
      ["chal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", (value) => ID_PATTERNS.challenge.test(String(value))],
    ];
    for (const [sample, ownerValidator] of reservedSamples) {
      // Solo su propio validador de namespace lo acepta…
      expect(ownerValidator(sample)).toBe(true);
      // …y los identificadores opacos jamás lo aceptan (target y sesión nativa).
      expect(isTargetId(sample)).toBe(false);
      expect(isNativeSessionId(sample)).toBe(false);
    }
    // Los prefijos reservados quedan vetados incluso con contenido ajeno al hex.
    expect(isNativeSessionId("req_cualquier-cosa")).toBe(false);
    expect(isNativeSessionId("prj_cualquier-cosa")).toBe(false);
    expect(isTargetId("evt_cualquier-cosa")).toBe(false);
    // El formato opaco de la sesión nativa se conserva fuera de prefijos reservados.
    expect(isNativeSessionId("session-0001")).toBe(true);
    expect(isNativeSessionId("sesiones/proyecto/session-0001")).toBe(true);
    expect(isNativeSessionId("Session:0001")).toBe(true);
    expect(isNativeSessionId("")).toBe(false);
    expect(isNativeSessionId("x".repeat(129))).toBe(false);
  });

  test("proyecto (compartido), checkout (local), sesión e instancia no se sustituyen", () => {
    // Proyecto compartido por clones: el mismo projectId vive en dos checkouts.
    const checkoutA = createWorkspaceFile({ projectId: FIXTURE_PROJECT_ID, rootPath: "/tmp/checkout-a", nowMs: FIXTURE_NOW_MS });
    const checkoutB = createWorkspaceFile({ projectId: FIXTURE_PROJECT_ID, rootPath: "/tmp/checkout-b", nowMs: FIXTURE_NOW_MS });
    expect(checkoutA.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(checkoutB.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(checkoutA.workspaceId).not.toBe(checkoutB.workspaceId);

    // Sesión e instancia son independientes del proyecto/checkout.
    const ref = validateSessionRef({
      projectId: FIXTURE_PROJECT_ID,
      scope: "workspace",
      workspaceId: checkoutA.workspaceId,
      target: "omp",
      nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
    });
    const sessionRef = expectAccepted(ref);
    expect(sessionRef.nativeSessionId).toBe(FIXTURE_NATIVE_SESSION_ID);
    expect(sessionRef.workspaceId).toBe(checkoutA.workspaceId);
  });

  test("sessionRef exige ámbito explícito: workspaceId solo con scope=workspace", () => {
    expectRejection(
      validateSessionRef({
        projectId: FIXTURE_PROJECT_ID,
        scope: "workspace",
        target: "omp",
        nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      }),
      "INVALID_INPUT",
      "invalid_field",
    );
    expectRejection(
      validateSessionRef({
        projectId: FIXTURE_PROJECT_ID,
        scope: "project",
        workspaceId: FIXTURE_WORKSPACE_ID,
        target: "omp",
        nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      }),
      "INVALID_INPUT",
      "invalid_field",
    );
    expectAccepted(
      validateSessionRef({
        projectId: FIXTURE_PROJECT_ID,
        scope: "project",
        target: "omp",
        nativeSessionId: FIXTURE_NATIVE_SESSION_ID,
      }),
    );
  });

  test("los ids generados son distintos en cada proceso/solicitud", () => {
    expect(newProjectId()).not.toBe(newProjectId());
    expect(newWorkspaceId()).not.toBe(newWorkspaceId());
    expect(newInstanceId()).not.toBe(newInstanceId());
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("archivos de identidad", () => {
  test("project.json acepta formato vigente y rechaza formato futuro", () => {
    const file = expectAccepted(
      parseProjectFile({ schemaVersion: 1, projectId: FIXTURE_PROJECT_ID, createdAtMs: FIXTURE_NOW_MS, name: "demo" }),
    );
    expect(file.projectId).toBe(FIXTURE_PROJECT_ID);
    expectRejection(
      parseProjectFile({ schemaVersion: 2, projectId: FIXTURE_PROJECT_ID, createdAtMs: FIXTURE_NOW_MS }),
      "INVALID_INPUT",
      "unsupported_schema_version",
    );
    expectRejection(
      parseProjectFile({ schemaVersion: 1, projectId: FIXTURE_PROJECT_ID, createdAtMs: FIXTURE_NOW_MS, extra: true }),
      "INVALID_INPUT",
      "unknown_fields",
    );
  });

  test("una copia de workspace.json no acredita otro checkout (clone/move)", () => {
    const original = expectAccepted(
      parseWorkspaceFile({
        schemaVersion: 1,
        workspaceId: FIXTURE_WORKSPACE_ID,
        projectId: FIXTURE_PROJECT_ID,
        rootPath: "/tmp/checkout-a",
        createdAtMs: FIXTURE_NOW_MS,
      }),
    );
    // Misma raíz: identidad válida.
    expectAccepted(checkWorkspaceIdentity(original, "/tmp/checkout-a/"));
    // Copia movida a otra raíz: mismatch explícito, sin sobrescritura silenciosa.
    expectRejection(checkWorkspaceIdentity(original, "/tmp/checkout-b"), "INVALID_INPUT", "workspace_identity_mismatch");
  });

  test("createProjectFile/createWorkspaceFile producen formatos que sus parsers aceptan", () => {
    const project = createProjectFile(FIXTURE_NOW_MS, "demo");
    expectAccepted(parseProjectFile(project));
    const workspace = createWorkspaceFile({ projectId: project.projectId, rootPath: "/tmp/checkout-c", nowMs: FIXTURE_NOW_MS });
    expectAccepted(parseWorkspaceFile(workspace));
  });
});

describe("IDs y environment no autentican ni acreditan raíz", () => {
  test("conocer IDs nunca es credencial", () => {
    expectRejection(idsAloneAuthenticate(), "UNAUTHORIZED", "ids_are_not_credentials");
  });

  test("claim por environment heredado se deniega aunque traiga todos los IDs", () => {
    expectRejection(
      evaluateRootBindingClaim(
        {
          kind: "environment",
          variables: {
            OMP_SESSION: FIXTURE_NATIVE_SESSION_ID,
            OMP_INSTANCE: FIXTURE_INSTANCE_ID,
            OMP_PROJECT: FIXTURE_PROJECT_ID,
            PID: "4242",
          },
        },
        FIXTURE_ROOT_CTX,
      ),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
  });

  test("claims por PID, cwd, IDs o token reutilizable se deniegan siempre", () => {
    expectRejection(
      evaluateRootBindingClaim({ kind: "pid", pid: 4242 }, FIXTURE_ROOT_CTX),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
    expectRejection(
      evaluateRootBindingClaim({ kind: "cwd", cwd: "/tmp/checkout-a" }, FIXTURE_ROOT_CTX),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
    expectRejection(
      evaluateRootBindingClaim(
        { kind: "ids", instanceId: FIXTURE_INSTANCE_ID, nativeSessionId: FIXTURE_NATIVE_SESSION_ID },
        FIXTURE_ROOT_CTX,
      ),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
    expectRejection(
      evaluateRootBindingClaim({ kind: "reusable_token", token: "copied-by-subagent" }, FIXTURE_ROOT_CTX),
      "UNAUTHORIZED",
      "root_claim_not_proven",
    );
  });
});
