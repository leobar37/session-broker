/**
 * Consumo desde un fixture EXTERNO al repo usando solo los exports públicos
 * (P-003 / G-001) — suite `test:cli`.
 *
 * El fixture vive en un TMP fuera del workspace y resuelve `@session-broker/*`
 * por nombre de paquete (como haría otro proyecto): sin imports internos, sin
 * internals del servidor, sin Elena ni OMP.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertModelUnused, setupCliIsolation, type Isolation } from "./helpers";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const PACKAGE_DIRS: Readonly<Record<string, string>> = {
  protocol: "packages/protocol",
  client: "packages/client",
  cli: "apps/cli",
};

const SMOKE_SOURCE = `
import { createClient, isBrokerClientError, BrokerClientError } from "@session-broker/client";
import { runCli } from "@session-broker/cli";
import { PROTOCOL_VERSION, LIMITS, EXIT_CODES, newRequestId } from "@session-broker/protocol";

if (typeof createClient !== "function") throw new Error("createClient ausente");
if (typeof runCli !== "function") throw new Error("runCli ausente");
if (typeof isBrokerClientError !== "function") throw new Error("isBrokerClientError ausente");
if (PROTOCOL_VERSION !== "1.0.0") throw new Error("versión de protocolo inesperada");
if (typeof LIMITS.maxFrameBytes !== "number") throw new Error("LIMITS ausente");
if (EXIT_CODES.OUTCOME_UNKNOWN !== 16) throw new Error("exit codes congelados rotos");
if (!newRequestId().startsWith("req_")) throw new Error("newRequestId inesperado");

const client = createClient({
  endpoint: "wss://broker.invalid",
  projectId: "prj_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  workspaceId: "wsp_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  instanceId: "ins_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  grantId: "grt_f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7",
  credential: "fixture-credential-not-a-real-secret",
});
const surface = client as unknown as Record<string, unknown>;
for (const name of [
  "connect",
  "close",
  "request",
  "query",
  "list",
  "inspect",
  "history",
  "subscribe",
  "ask",
  "reply",
  "notify",
  "control",
]) {
  if (typeof surface[name] !== "function") throw new Error("falta en la superficie: " + name);
}
const error = new BrokerClientError("timeout", "espera local agotada");
if (error.endsLocalWaitOnly !== true) throw new Error("semántica de espera local rota");
void client.close();
export const smokeOk = true;
`;

let isolation: Isolation;

beforeAll(() => {
  isolation = setupCliIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

describe("consumo externo por exports públicos", () => {
  test("un consumidor fuera del repo resuelve @session-broker/* sin internals", async () => {
    const consumerDir = join(isolation.tmpDir, "consumer");
    const scopedDir = join(consumerDir, "node_modules", "@session-broker");
    mkdirSync(scopedDir, { recursive: true });
    for (const [name, dir] of Object.entries(PACKAGE_DIRS)) {
      symlinkSync(join(repoRoot, dir), join(scopedDir, name), "dir");
    }
    // Sin imports internos en el consumidor: solo nombres de paquete público.
    expect(SMOKE_SOURCE).not.toContain("packages/");
    expect(SMOKE_SOURCE).not.toContain("apps/");
    expect(SMOKE_SOURCE).not.toContain("/src/");
    const smokePath = join(consumerDir, "smoke.ts");
    writeFileSync(smokePath, SMOKE_SOURCE);
    // Import dinámico deliberado: el fixture se genera en un TMP en runtime y
    // vive FUERA del repo; un import estático no puede apuntarlo.
    const smoke = (await import(pathToFileURL(smokePath).href)) as { smokeOk?: unknown };
    expect(smoke.smokeOk).toBe(true);
  });

  test("las fuentes de client/cli/tests solo importan exports públicos", () => {
    const roots = [
      join(repoRoot, "packages", "client", "src"),
      join(repoRoot, "apps", "cli", "src"),
      join(repoRoot, "tests", "cli"),
    ];
    for (const root of roots) {
      const entries = readdirSync(root, { recursive: true }) as string[];
      for (const entry of entries) {
        if (!entry.endsWith(".ts")) continue;
        const source = readFileSync(join(root, entry), "utf8");
        const importLines = source
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("import ") || line.startsWith("export {") || line.includes('from "'));
        for (const line of importLines) {
          expect(line).not.toContain("@session-broker/server");
          expect(line).not.toContain("@session-broker/omp-adapter");
          expect(line).not.toContain("@session-broker/protocol/src");
          expect(line).not.toContain("@session-broker/client/src");
          expect(line).not.toContain("../packages/");
          expect(line).not.toContain("../apps/");
        }
      }
    }
  });
});
