/**
 * Init idempotente e identidad (FR-002 / P-003) — suite `test:cli`.
 *
 * Criterios binarios: init repetido idempotente; projectId sobrevive a dos
 * checkouts con workspaceId distinto; solo project.json es compartible y
 * workspace.json está ignorado; repo ausente/JSON corrupto/schema futuro/
 * permiso denegado/escritura interrumpida se manejan según contrato sin init
 * Git, sobrescrituras silenciosas ni secretos expuestos.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertModelUnused,
  captureCli,
  isRootUser,
  jsonOutput,
  markAsGitCheckout,
  normalizeStable,
  readJsonFile,
  setupCliIsolation,
  writeRawFile,
  writeUserConfig,
  type Isolation,
} from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupCliIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function newCheckout(name: string): string {
  const root = join(isolation.tmpDir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("init idempotente e identidad", () => {
  test("init repetido conserva IDs, no duplica reglas ignore ni borra datos ajenos", async () => {
    const root = newCheckout("checkout-idempotent");
    markAsGitCheckout(root);
    const first = await captureCli(["init", "--root", root, "--json"]);
    expect(first.code).toBe(0);
    const firstJson = jsonOutput(first);

    // dato ajeno en .broker que init jamás debe borrar
    writeRawFile(join(root, ".broker", "extra.json"), '{"mio": true}\n');
    markAsGitCheckout(root);

    const second = await captureCli(["init", "--root", root, "--json"]);
    expect(second.code).toBe(0);
    const secondJson = jsonOutput(second);
    expect(secondJson.projectId).toBe(firstJson.projectId);
    expect(secondJson.workspaceId).toBe(firstJson.workspaceId);
    const created = secondJson.created as Record<string, unknown>;
    expect(created.project).toBe(false);
    expect(created.workspace).toBe(false);

    const ignoreLines = readFileSync(join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line.trim() === ".broker/workspace.json");
    expect(ignoreLines.length).toBe(1);
    expect(existsSync(join(root, ".broker", "extra.json"))).toBe(true);

    const third = await captureCli(["init", "--root", root]);
    expect(third.code).toBe(0);
    const ignoreAfterThird = readFileSync(join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line.trim() === ".broker/workspace.json");
    expect(ignoreAfterThird.length).toBe(1);
  });

  test("projectId sobrevive a dos checkouts y workspaceId difiere; solo project.json es compartible", async () => {
    const rootA = newCheckout("checkout-a");
    markAsGitCheckout(rootA);
    const initA = await captureCli(["init", "--root", rootA, "--json"]);
    expect(initA.code).toBe(0);
    const projectA = readJsonFile(join(rootA, ".broker", "project.json"));

    // clon limpio: SOLO viaja project.json (compartible); workspace.json es local
    const rootB = newCheckout("checkout-b");
    markAsGitCheckout(rootB);
    mkdirSync(join(rootB, ".broker"), { recursive: true });
    copyFileSync(join(rootA, ".broker", "project.json"), join(rootB, ".broker", "project.json"));
    const initB = await captureCli(["init", "--root", rootB, "--json"]);
    expect(initB.code).toBe(0);
    const jsonB = jsonOutput(initB);
    expect(jsonB.projectId).toBe(projectA.projectId);
    expect(jsonB.workspaceId).not.toBe(jsonOutput(initA).workspaceId);

    for (const root of [rootA, rootB]) {
      const ignore = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
      expect(ignore).toContain(".broker/workspace.json");
      expect(ignore).not.toContain(".broker/project.json");
      expect(ignore).not.toContain(".broker/");
    }
  });

  test("copia de workspace.json no acredita otro checkout: error explícito y regeneración solo con flag", async () => {
    const rootA = newCheckout("checkout-source");
    markAsGitCheckout(rootA);
    const initA = await captureCli(["init", "--root", rootA, "--json"]);
    expect(initA.code).toBe(0);
    const originalWorkspaceId = jsonOutput(initA).workspaceId;

    const rootC = newCheckout("checkout-copied");
    markAsGitCheckout(rootC);
    mkdirSync(join(rootC, ".broker"), { recursive: true });
    copyFileSync(join(rootA, ".broker", "project.json"), join(rootC, ".broker", "project.json"));
    copyFileSync(join(rootA, ".broker", "workspace.json"), join(rootC, ".broker", "workspace.json"));

    const rejected = await captureCli(["init", "--root", rootC]);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("workspace_identity_mismatch");

    const regenerated = await captureCli(["init", "--root", rootC, "--regenerate-workspace", "--json"]);
    expect(regenerated.code).toBe(0);
    const jsonC = jsonOutput(regenerated);
    expect(jsonC.workspaceId).not.toBe(originalWorkspaceId);
    const archived = readdirSync(join(rootC, ".broker")).filter((name) => name.startsWith("workspace.json.conflict-"));
    expect(archived.length).toBe(1);
    const newWorkspace = readJsonFile(join(rootC, ".broker", "workspace.json"));
    expect(newWorkspace.workspaceId).not.toBe(originalWorkspaceId);
  });

  test("JSON corrupto, schema futuro y campos desconocidos fallan sin sobrescribir", async () => {
    const corruptRoot = newCheckout("checkout-corrupt");
    mkdirSync(join(corruptRoot, ".broker"), { recursive: true });
    const corruptPath = join(corruptRoot, ".broker", "project.json");
    writeRawFile(corruptPath, '{"projectId": ');
    const corrupt = await captureCli(["init", "--root", corruptRoot]);
    expect(corrupt.code).toBe(2);
    expect(corrupt.stderr).toContain("schema_malformed");
    expect(readFileSync(corruptPath, "utf8")).toBe('{"projectId": ');

    const futureRoot = newCheckout("checkout-future");
    mkdirSync(join(futureRoot, ".broker"), { recursive: true });
    const futurePath = join(futureRoot, ".broker", "project.json");
    const futureContent = '{"schemaVersion": 2, "projectId": "prj_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"}\n';
    writeRawFile(futurePath, futureContent);
    const future = await captureCli(["init", "--root", futureRoot]);
    expect(future.code).toBe(2);
    expect(future.stderr).toContain("unsupported_schema_version");
    expect(readFileSync(futurePath, "utf8")).toBe(futureContent);

    const unknownRoot = newCheckout("checkout-unknown-fields");
    mkdirSync(join(unknownRoot, ".broker"), { recursive: true });
    const unknownPath = join(unknownRoot, ".broker", "workspace.json");
    writeRawFile(
      unknownPath,
      '{"schemaVersion": 1, "workspaceId": "wsp_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "projectId": "prj_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", "rootPath": "/tmp/x", "createdAtMs": 1, "sorpresa": true}\n',
    );
    const unknown = await captureCli(["init", "--root", unknownRoot]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown_fields");
  });

  test("repo ausente: init funciona sin crear Git ni .gitignore", async () => {
    const root = newCheckout("checkout-no-git");
    const run = await captureCli(["init", "--root", root, "--json"]);
    expect(run.code).toBe(0);
    const json = jsonOutput(run);
    const gitignore = json.gitignore as Record<string, unknown>;
    expect(gitignore.applies).toBe(false);
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".broker", "project.json"))).toBe(true);
    expect(existsSync(join(root, ".broker", "workspace.json"))).toBe(true);
  });

  test("permiso denegado: error explícito sin archivos parciales válidos", async () => {
    if (isRootUser()) return; // root ignora permisos; el caso no es observable
    const root = newCheckout("checkout-eacces");
    mkdirSync(join(root, ".broker"), { recursive: true });
    chmodSync(join(root, ".broker"), 0o500);
    const run = await captureCli(["init", "--root", root]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("EACCES");
    expect(existsSync(join(root, ".broker", "project.json"))).toBe(false);
    expect(existsSync(join(root, ".broker", "workspace.json"))).toBe(false);
    const leftovers = readdirSync(join(root, ".broker")).filter((name) => name.includes(".tmp-"));
    expect(leftovers.length).toBe(0);
    chmodSync(join(root, ".broker"), 0o700);
  });

  test("escritura interrumpida: error explícito y temporales limpios", async () => {
    // El directorio destino impide crear `.broker` completo: fallo de IO explícito.
    const blockedRoot = newCheckout("checkout-write-blocked");
    writeRawFile(join(blockedRoot, ".broker"), "no soy un directorio\n");
    const blocked = await captureCli(["init", "--root", blockedRoot]);
    expect(blocked.code).toBe(1);
    expect(existsSync(join(blockedRoot, ".broker", "project.json"))).toBe(false);

    // Fallo de escritura sobre directorio de solo lectura: sin parciales válidos.
    if (!isRootUser()) {
      const root = newCheckout("checkout-interrupted");
      mkdirSync(join(root, ".broker"), { recursive: true });
      chmodSync(join(root, ".broker"), 0o500);
      const run = await captureCli(["init", "--root", root]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("EACCES");
      const leftovers = readdirSync(join(root, ".broker")).filter((name) => name.includes(".tmp-"));
      expect(leftovers.length).toBe(0);
      chmodSync(join(root, ".broker"), 0o700);
    }
  });

  test("project.json/workspace.json jamás contienen secretos; workspace.json es 0600", async () => {
    writeUserConfig(isolation, {
      endpoint: "wss://user:super-secret-pass@broker.example/x",
      grantId: "grt_f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7",
      credential: "super-secret-credential",
      allowInsecureWs: true,
    });
    const root = newCheckout("checkout-secrets");
    markAsGitCheckout(root);
    const human = await captureCli(["init", "--root", root]);
    expect(human.code).toBe(0);
    const json = await captureCli(["init", "--root", root, "--json"]);
    expect(json.code).toBe(0);

    const projectPath = join(root, ".broker", "project.json");
    const workspacePath = join(root, ".broker", "workspace.json");
    const project = readJsonFile(projectPath);
    const workspace = readJsonFile(workspacePath);
    expect(Object.keys(project).sort()).toEqual(["createdAtMs", "projectId", "schemaVersion"]);
    expect(Object.keys(workspace).sort()).toEqual(["createdAtMs", "projectId", "rootPath", "schemaVersion", "workspaceId"]);
    const serialized = `${JSON.stringify(project)}${JSON.stringify(workspace)}${human.stdout}${json.stdout}`;
    expect(serialized).not.toContain("super-secret-credential");
    expect(serialized).not.toContain("super-secret-pass");
    expect(serialized).not.toContain("wss://");
    expect(serialized).not.toContain("broker.example");
    expect(statSync(workspacePath).mode & 0o777).toBe(0o600);

    // Ambos formatos redactan secretos y son consistentes con su contrato.
    expect(human.stdout.startsWith("ok init")).toBe(true);
    expect(jsonOutput(json).ok).toBe(true);
  });

  test("--json emite JSON parseable incluso ante errores (ok:false + code)", async () => {
    const root = newCheckout("checkout-json-error");
    mkdirSync(join(root, ".broker"), { recursive: true });
    writeRawFile(join(root, ".broker", "project.json"), '{"projectId": ');

    // formato humano por defecto: error en stderr con `error <CODE>`, sin JSON
    const human = await captureCli(["init", "--root", root]);
    expect(human.code).toBe(2);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("error INVALID_INPUT");

    // formato --json: exactamente un objeto JSON por línea en stdout, con ok:false
    const json = await captureCli(["init", "--root", root, "--json"]);
    expect(json.code).toBe(2);
    expect(json.stderr).toBe("");
    expect(json.stdout.trim().split("\n").length).toBe(1);
    const parsed = jsonOutput(json);
    expect(parsed.ok).toBe(false);
    const error = parsed.error as Record<string, unknown>;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.reason).toBe("schema_malformed");
    expect(typeof error.message).toBe("string");
  });

  test("output estable: init produce la misma forma en humano y en --json", async () => {
    const rootX = newCheckout("checkout-stable-x");
    const rootY = newCheckout("checkout-stable-y");
    const runX = await captureCli(["init", "--root", rootX, "--name", "demo"]);
    const runY = await captureCli(["init", "--root", rootY, "--name", "demo"]);
    expect(runX.code).toBe(0);
    expect(runY.code).toBe(0);
    expect(runX.stdout.startsWith("ok init")).toBe(true);
    const normalizedX = normalizeStable(runX.stdout.split(rootX).join("<root>"), isolation.tmpDir);
    const normalizedY = normalizeStable(runY.stdout.split(rootY).join("<root>"), isolation.tmpDir);
    expect(normalizedX).toBe(normalizedY);

    const rootZ = newCheckout("checkout-stable-z");
    const rootW = newCheckout("checkout-stable-w");
    const jsonZ = await captureCli(["init", "--root", rootZ, "--name", "demo", "--json"]);
    const jsonW = await captureCli(["init", "--root", rootW, "--name", "demo", "--json"]);
    expect(jsonZ.code).toBe(0);
    expect(jsonW.code).toBe(0);
    expect(jsonZ.stdout.trim().split("\n").length).toBe(1);
    expect(jsonOutput(jsonZ).ok).toBe(true);
    const normalizedZ = normalizeStable(jsonZ.stdout.split(rootZ).join("<root>"), isolation.tmpDir);
    const normalizedW = normalizeStable(jsonW.stdout.split(rootW).join("<root>"), isolation.tmpDir);
    expect(normalizedZ).toBe(normalizedW);
  });

  test("status exige identidad existente (error accionable, sin inventar IDs)", async () => {
    const root = newCheckout("checkout-status-missing");
    const run = await captureCli(["status", "--root", root]);
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("init");
    expect(existsSync(join(root, ".broker"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
