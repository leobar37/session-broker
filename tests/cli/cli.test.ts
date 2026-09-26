/**
 * CLI: salida estable, exit codes congelados, redacción de secretos e
 * isolation (P-003 / G-001) — suite `test:cli`.
 *
 * Cada escenario usa broker falso + TMP/HOME/config/data efímeros; ningún
 * test escribe configuración/identidad/data reales ni comparte temporales con
 * otras suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Grant, GrantScope, ProjectId, WorkspaceId } from "@session-broker/protocol";
import { ALL_CAPABILITIES } from "@session-broker/protocol";
import { FakeBroker, FIXTURE_CREDENTIAL, type FakeBrokerOptions } from "./fake-broker";
import {
  assertModelUnused,
  captureCli,
  jsonOutput,
  setupCliIsolation,
  waitFor,
  writeUserConfig,
  type Isolation,
  type UserConfigInput,
} from "./helpers";

const GRANT_ID = "grt_abababababababababababababababab";
const OUTCOME_REQUEST_ID = "req_12121212121212121212121212121212";

let isolation: Isolation;
let projectId: ProjectId;
let workspaceId: WorkspaceId;
const brokers: FakeBroker[] = [];

beforeAll(async () => {
  isolation = setupCliIsolation();
  const init = await captureCli(["init", "--root", isolation.checkout, "--json"]);
  if (init.code !== 0) throw new Error(`init de fixture falló: ${init.stderr}`);
  const identity = jsonOutput(init);
  projectId = identity.projectId as ProjectId;
  workspaceId = identity.workspaceId as WorkspaceId;
});

afterAll(() => {
  for (const broker of brokers) broker.close();
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function makeGrant(scopeOverrides?: Partial<GrantScope>, expiresAtMs?: number): Grant {
  return {
    grantId: GRANT_ID,
    subject: "tests/cli",
    scope: {
      projectId,
      workspaceIds: "*",
      targets: "*",
      sessions: "*",
      capabilities: ALL_CAPABILITIES,
      ...scopeOverrides,
    },
    issuedBy: "tests/cli",
    issuedAtMs: Date.now() - 60_000,
    expiresAtMs: expiresAtMs ?? Date.now() + 3_600_000,
  };
}

interface Scenario {
  readonly broker: FakeBroker;
  readonly configPath: string;
}

function startScenario(options: Partial<FakeBrokerOptions> = {}, config: UserConfigInput = {}): Scenario {
  const broker = FakeBroker.start({ grant: makeGrant(), ...options });
  brokers.push(broker);
  const configPath = writeUserConfig(isolation, {
    endpoint: broker.endpoint,
    grantId: GRANT_ID,
    credential: FIXTURE_CREDENTIAL,
    allowInsecureWs: true,
    ...config,
  });
  return { broker, configPath };
}

function askArgs(extra: readonly string[] = []): string[] {
  return [
    "ask",
    "--root",
    isolation.checkout,
    "--target",
    "omp",
    "--session",
    "session-0001",
    "--question",
    "hola",
    "--timeout-ms",
    "3000",
    ...extra,
  ];
}

function controlArgs(extra: readonly string[] = []): string[] {
  return [
    "control",
    "--root",
    isolation.checkout,
    "--target",
    "omp",
    "--session",
    "session-0001",
    "--verb",
    "abort",
    "--timeout-ms",
    "3000",
    ...extra,
  ];
}

describe("CLI: salida, exit codes y secretos", () => {
  test("--version y --help son estables y exit 0 en ambos formatos", async () => {
    const version = await captureCli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toBe("0.1.0\n");
    const help = await captureCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("uso:");
    expect(help.stdout).toContain("init");
    const empty = await captureCli([]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe(help.stdout);

    // Con --json la salida es exactamente un objeto JSON por línea.
    const versionJson = await captureCli(["--version", "--json"]);
    expect(versionJson.code).toBe(0);
    expect(versionJson.stdout.trim().split("\n").length).toBe(1);
    const parsedVersion = jsonOutput(versionJson);
    expect(parsedVersion.ok).toBe(true);
    expect(parsedVersion.version).toBe("0.1.0");
    const helpJson = await captureCli(["--help", "--json"]);
    expect(helpJson.code).toBe(0);
    expect(helpJson.stdout.trim().split("\n").length).toBe(1);
    expect(jsonOutput(helpJson).ok).toBe(true);
  });

  test("comando/flag desconocidos → INVALID_INPUT (exit 2)", async () => {
    const unknownCommand = await captureCli(["volcan"]);
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toContain("INVALID_INPUT");
    const unknownFlag = await captureCli(["init", "--root", isolation.checkout, "--inventada"]);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.stderr).toContain("flag desconocida");
  });

  test("grants y handoff: unsupported explícito (exit 6), sin fallback", async () => {
    const grants = await captureCli(["grants", "create"]);
    expect(grants.code).toBe(6);
    expect(grants.stderr).toContain("UNSUPPORTED_CAPABILITY");
    const handoff = await captureCli(["handoff"]);
    expect(handoff.code).toBe(6);
    expect(handoff.stderr).toContain("P-006");
  });

  test("reply exige replyTo explícito y control exige epoch explícito", async () => {
    const reply = await captureCli(["reply", "--root", isolation.checkout, "--target", "omp", "--session", "session-0001", "--body", "hola"]);
    expect(reply.code).toBe(2);
    expect(reply.stderr).toContain("--reply-to");
    const control = await captureCli(controlArgs());
    expect(control.code).toBe(10);
    expect(control.stderr).toContain("STALE_CONTROL_EPOCH");
  });

  test("status --json es estable entre ejecuciones", async () => {
    const first = await captureCli(["status", "--root", isolation.checkout, "--json"]);
    const second = await captureCli(["status", "--root", isolation.checkout, "--json"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const parsed = jsonOutput(first);
    expect(parsed.ok).toBe(true);
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.workspaceId).toBe(workspaceId);
  });

  test("secrets jamás aparecen en stdout/stderr en NINGÚN formato; userinfo se redacta", async () => {
    const scenario = startScenario({}, { endpoint: "wss://user:super-secret-pass@127.0.0.1:1/x" });
    const humanStatus = await captureCli(["status", "--root", isolation.checkout]);
    const jsonStatus = await captureCli(["status", "--root", isolation.checkout, "--json"]);
    for (const run of [humanStatus, jsonStatus]) {
      expect(run.code).toBe(0);
      const all = `${run.stdout}${run.stderr}`;
      expect(all).not.toContain("super-secret-pass");
      expect(all).not.toContain(FIXTURE_CREDENTIAL);
      expect(all).toContain("[redacted]");
    }
    expect(humanStatus.stdout.startsWith("ok status")).toBe(true);
    expect(jsonOutput(jsonStatus).ok).toBe(true);

    // errores: mismo tratamiento de secretos y --json parseable con ok:false + code
    const offlineHuman = await captureCli(askArgs());
    const offlineJson = await captureCli([...askArgs(), "--json"]);
    expect(offlineHuman.code).toBe(7);
    expect(offlineJson.code).toBe(7);
    for (const run of [offlineHuman, offlineJson]) {
      const all = `${run.stdout}${run.stderr}`;
      expect(all).not.toContain(FIXTURE_CREDENTIAL);
      expect(all).not.toContain("super-secret-pass");
    }
    expect(offlineHuman.stderr).toContain("error TARGET_OFFLINE");
    expect(offlineJson.stdout.trim().split("\n").length).toBe(1);
    const parsedError = jsonOutput(offlineJson);
    expect(parsedError.ok).toBe(false);
    const errorDetail: unknown = parsedError.error;
    if (typeof errorDetail !== "object" || errorDetail === null || !("code" in errorDetail)) {
      throw new Error("el error JSON no expone code");
    }
    expect(errorDetail.code).toBe("TARGET_OFFLINE");
    expect(scenario.configPath).toContain("session-broker");
  });

  test("config con secretos y permisos abiertos → UNAUTHORIZED con hint accionable", async () => {
    const scenario = startScenario();
    chmodSync(scenario.configPath, 0o644);
    const run = await captureCli(askArgs());
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("chmod 600");
    chmodSync(scenario.configPath, 0o600);
    const ok = await captureCli(askArgs());
    expect(ok.code).toBe(0);
  });

  test("credencial ausente → UNAUTHORIZED (exit 3); endpoint ausente → INVALID_INPUT (exit 2)", async () => {
    const scenario = startScenario({}, { credential: undefined });
    const noCredential = await captureCli(askArgs());
    expect(noCredential.code).toBe(3);
    expect(noCredential.stderr).toContain("credencial");
    rmSync(scenario.configPath, { force: true });
    writeUserConfig(isolation, { grantId: GRANT_ID, credential: FIXTURE_CREDENTIAL, allowInsecureWs: true });
    const withoutEndpoint = await captureCli(askArgs());
    expect(withoutEndpoint.code).toBe(2);
    expect(withoutEndpoint.stderr).toContain("endpoint");
  });

  test("data path nunca cae silenciosamente al checkout", async () => {
    const originalHome = process.env.HOME;
    const originalData = process.env.XDG_DATA_HOME;
    delete process.env.HOME;
    delete process.env.XDG_DATA_HOME;
    try {
      const run = await captureCli(["status", "--root", isolation.checkout]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("data");
      expect(existsSync(join(isolation.checkout, "data"))).toBe(false);
      expect(existsSync(join(isolation.checkout, ".local"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalData;
    }
  });

  test("texto remoto jamás se ejecuta como shell ni como flags ni modifica config", async () => {
    const scenario = startScenario();
    const configBefore = readFileSync(scenario.configPath, "utf8");
    const run = await captureCli([
      "sessions",
      "list",
      "--root",
      isolation.checkout,
      "--target",
      "omp",
      "--timeout-ms",
      "3000",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("--root /tmp/evil");
    expect(run.stdout).toContain("touch pwned");
    expect(existsSync(join(isolation.tmpDir, "pwned"))).toBe(false);
    expect(existsSync(join(isolation.home, "pwned"))).toBe(false);
    expect(readFileSync(scenario.configPath, "utf8")).toBe(configBefore);
  });

  test("sessions subscribe con timeout termina en exit 0", async () => {
    startScenario();
    const run = await captureCli([
      "sessions",
      "subscribe",
      "--root",
      isolation.checkout,
      "--target",
      "omp",
      "--topics",
      "topic-a",
      "--timeout-ms",
      "300",
      "--json",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"stopped":"timeout"');
  });

  test("ask imprime requestId y estado sin ocultar nada", async () => {
    startScenario();
    const run = await captureCli([...askArgs(["--request-id", OUTCOME_REQUEST_ID]), "--json"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(OUTCOME_REQUEST_ID);
    expect(run.stdout).toContain('"state":"queued"');
  });

  describe("exit codes congelados", () => {
    test("7 TARGET_OFFLINE: server offline ≠ request fallido", async () => {
      const scenario = startScenario();
      scenario.broker.close();
      const run = await captureCli(askArgs());
      expect(run.code).toBe(7);
      expect(run.stderr).toContain("TARGET_OFFLINE");
    });

    test("3 UNAUTHORIZED: credencial incorrecta", async () => {
      startScenario({}, { credential: "credencial-equivocada" });
      const run = await captureCli(askArgs());
      expect(run.code).toBe(3);
    });

    test("4 NOT_FOUND_OR_FORBIDDEN: fuera del ámbito del grant, sin retry", async () => {
      const scenario = startScenario({ grant: makeGrant({ targets: ["otro"] }) });
      const run = await captureCli(askArgs());
      expect(run.code).toBe(4);
      expect(scenario.broker.requests.length).toBe(1);
    });

    test("5 INCOMPATIBLE_VERSION: sin degradación", async () => {
      startScenario({ serverProtocolVersions: ["0.9.0"] });
      const run = await captureCli(askArgs());
      expect(run.code).toBe(5);
    });

    test("6 UNSUPPORTED_CAPABILITY: notify sin capacidad no se convierte en ask", async () => {
      const scenario = startScenario({
        capabilities: ["session.identity", "session.observe", "session.prompt.when_idle", "session.reply_tool"],
      });
      const run = await captureCli([
        "notify",
        "--root",
        isolation.checkout,
        "--target",
        "omp",
        "--topic",
        "tema",
        "--timeout-ms",
        "3000",
      ]);
      expect(run.code).toBe(6);
      expect(scenario.broker.operationCounts.get("ask")).toBeUndefined();
      expect(scenario.broker.operationCounts.get("notify")).toBeUndefined();
    });

    test("8 TARGET_BUSY: sin reclasificar como fallo terminal", async () => {
      const scenario = startScenario();
      scenario.broker.busyOperations.add("ask");
      const run = await captureCli(askArgs());
      expect(run.code).toBe(8);
    });

    test("9 STALE_INSTANCE: la instancia del lease no coincide", async () => {
      const scenario = startScenario();
      scenario.broker.setLeaseInstance("ins_99999999999999999999999999999999");
      const run = await captureCli(controlArgs(["--epoch", "0"]));
      expect(run.code).toBe(9);
    });

    test("10 STALE_CONTROL_EPOCH: epoch obsoleto, sin retry privilegiado", async () => {
      const scenario = startScenario();
      scenario.broker.setControlEpoch(5);
      const run = await captureCli(controlArgs(["--epoch", "2"]));
      expect(run.code).toBe(10);
      expect(scenario.broker.requests.length).toBe(1);
    });

    test("11 PAYLOAD_CONFLICT: mismo requestId con payload distinto", async () => {
      startScenario();
      const first = await captureCli(askArgs(["--request-id", OUTCOME_REQUEST_ID]));
      expect(first.code).toBe(0);
      const second = await captureCli(askArgs(["--request-id", OUTCOME_REQUEST_ID, "--question", "otra"]));
      expect(second.code).toBe(11);
    });

    test("12 EXPIRED: grant vencido", async () => {
      startScenario({ grant: makeGrant(undefined, Date.now() - 1000) });
      const run = await captureCli(askArgs());
      expect(run.code).toBe(12);
    });

    test("13 RATE_LIMITED: cuota superada", async () => {
      const scenario = startScenario();
      scenario.broker.rateLimitAfter = 0;
      const run = await captureCli(askArgs());
      expect(run.code).toBe(13);
    });

    test("14 QUEUE_FULL: backpressure corta la suscripción", async () => {
      const scenario = startScenario();
      const pending = captureCli([
        "sessions",
        "subscribe",
        "--root",
        isolation.checkout,
        "--target",
        "omp",
        "--topics",
        "topic-a",
        "--timeout-ms",
        "5000",
      ]);
      await waitFor(() => scenario.broker.subscriptionCount > 0);
      scenario.broker.overflowSubscriptions();
      const run = await pending;
      expect(run.code).toBe(14);
    });

    test("15 CURSOR_EXPIRED: snapshot explícito", async () => {
      startScenario();
      const run = await captureCli([
        "sessions",
        "history",
        "--root",
        isolation.checkout,
        "--target",
        "omp",
        "--session",
        "session-0001",
        "--cursor",
        "caducado",
        "--timeout-ms",
        "3000",
      ]);
      expect(run.code).toBe(15);
    });

    test("16 OUTCOME_UNKNOWN: visible, sin segunda ejecución ni ID nuevo", async () => {
      const scenario = startScenario();
      const first = await captureCli([...askArgs(["--request-id", OUTCOME_REQUEST_ID]), "--json"]);
      expect(first.code).toBe(0);
      scenario.broker.crashWindow(OUTCOME_REQUEST_ID);
      const consult = await captureCli([...askArgs(["--request-id", OUTCOME_REQUEST_ID]), "--json"]);
      expect(consult.code).toBe(16);
      const combined = `${consult.stdout}${consult.stderr}`;
      expect(combined).toContain("outcome_unknown");
      expect(combined).toContain(OUTCOME_REQUEST_ID);
      expect(scenario.broker.executionCount).toBe(1);
    });

    test("17 AMBIGUOUS_TARGET: sin elección silenciosa", async () => {
      const scenario = startScenario();
      scenario.broker.ambiguousTargets.add("omp");
      const run = await captureCli(askArgs());
      expect(run.code).toBe(17);
    });

    test("0 OK y estados progresivos visibles", async () => {
      startScenario();
      const run = await captureCli([...askArgs(["--request-id", OUTCOME_REQUEST_ID]), "--json"]);
      expect(run.code).toBe(0);
      const parsed = jsonOutput(run);
      expect(parsed.state).toBe("queued");
      expect(parsed.requestId).toBe(OUTCOME_REQUEST_ID);
    });
  });
});
