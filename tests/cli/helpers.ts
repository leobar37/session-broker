/**
 * Helpers aislados de `tests/cli` (NFR-001/002/003).
 *
 * Cada archivo de prueba crea un TMP con el prefijo reservado
 * `omp-session-broker-test-`, desvía HOME/XDG_CONFIG_HOME/XDG_DATA_HOME hacia
 * ese TMP, instala guardas que FALLAN ante red externa o proveedores reales y
 * usa fake model que lanza si se invoca. El teardown corre en `afterAll`
 * incluso ante fallo. Nada toca configuración/identidad/data reales.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@session-broker/cli";

export const TMP_PREFIX = "omp-session-broker-test-";

export class FakeModel {
  readonly calls: string[] = [];

  complete(prompt: string): string {
    this.calls.push(prompt);
    throw new Error("fake model invocado: tests/cli no deben ejecutar inferencia ni proveedores");
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLoopback(rawUrl: string, kind: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`guarda de red activa: URL no interpretable para ${kind}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`guarda de red activa: ${kind} solo permite loopback, se intentó ${url.hostname}`);
  }
}

interface GuardedGlobals {
  restore(): void;
}

function installNetworkGuard(): GuardedGlobals {
  const globals = globalThis as Record<string, unknown>;
  const originalFetch = globals.fetch;
  const originalWebSocket = globals.WebSocket;
  globals.fetch = (input: unknown) => {
    let rawUrl: unknown = input;
    if (typeof input === "object" && input !== null && "url" in input) rawUrl = input.url;
    const url = String(rawUrl);
    assertLoopback(url, "fetch");
    // Ninguna prueba usa fetch: solo WebSocket loopback al broker falso.
    throw new Error("guarda de red activa: fetch está prohibido en tests/cli");
  };
  const originalCtor = originalWebSocket as new (url: string) => unknown;
  // Función constructora: `new` devuelve el socket real del runtime (solo loopback).
  globals.WebSocket = function GuardedWebSocket(url: string): unknown {
    assertLoopback(url, "WebSocket");
    return new originalCtor(url);
  };
  return {
    restore(): void {
      globals.fetch = originalFetch;
      globals.WebSocket = originalWebSocket;
    },
  };
}

export interface Isolation {
  readonly tmpDir: string;
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly fakeModel: FakeModel;
  /** Checkout de prueba (sin Git salvo que se cree `.git` a mano en el test). */
  readonly checkout: string;
  teardown(): void;
}

export function setupCliIsolation(): Isolation {
  const tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const home = join(tmpDir, "home");
  const configHome = join(tmpDir, "config");
  const dataHome = join(tmpDir, "data");
  const checkout = join(tmpDir, "checkout");
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  const original = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;
  const guard = installNetworkGuard();
  const fakeModel = new FakeModel();
  let done = false;
  return {
    tmpDir,
    home,
    configHome,
    dataHome,
    checkout,
    fakeModel,
    teardown(): void {
      if (done) return;
      done = true;
      guard.restore();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Guarda defensiva: ninguna suite debe haber invocado el fake model. */
export function assertModelUnused(fakeModel: FakeModel): void {
  if (fakeModel.calls.length > 0) {
    throw new Error(`fake model invocado ${fakeModel.calls.length} vez/veces`);
  }
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Ejecuta `runCli` capturando stdout/stderr sin tocar la salida real del proceso. */
export async function captureCli(argv: readonly string[]): Promise<CliRun> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    outChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    const code = await runCli(argv);
    return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

const NORMALIZERS: ReadonlyArray<[RegExp, string]> = [
  [/prj_[0-9a-f]{32}/g, "<projectId>"],
  [/wsp_[0-9a-f]{32}/g, "<workspaceId>"],
  [/ins_[0-9a-f]{32}/g, "<instanceId>"],
  [/req_[0-9a-f]{32}/g, "<requestId>"],
  [/evt_[0-9a-f]{32}/g, "<eventId>"],
  [/con_[0-9a-f]{32}/g, "<connectionId>"],
  [/grt_[0-9a-f]{32}/g, "<grantId>"],
  [/chal_[0-9a-f]{32}/g, "<challenge>"],
  [/\b\d{12,14}\b/g, "<ts>"],
  [/:\d{4,5}\b/g, ":<port>"],
];

/** Normaliza IDs/timestamps/puertos para comparar outputs estables. */
export function normalizeStable(text: string, tmpDir?: string): string {
  let out = text;
  if (tmpDir !== undefined) out = out.split(tmpDir).join("<tmp>");
  for (const [pattern, replacement] of NORMALIZERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface UserConfigInput {
  endpoint?: string;
  grantId?: string;
  credential?: string;
  allowInsecureWs?: boolean;
}

/** Escribe config de usuario (0600) en el XDG_CONFIG_HOME de la isolación. */
export function writeUserConfig(isolation: Isolation, config: UserConfigInput): string {
  const dir = join(isolation.configHome, "session-broker");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        endpoint: config.endpoint,
        grantId: config.grantId,
        credential: config.credential,
        allowInsecureWs: config.allowInsecureWs,
      },
      null,
      2,
    )}\n`,
  );
  chmodSync(path, 0o600);
  return path;
}

export function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function writeRawFile(path: string, content: string, mode?: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Simula un checkout Git creando solo `.git` (sin init real, sin stage/commit). */
export function markAsGitCheckout(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

/**
 * Parsea la salida de un `captureCli` ejecutado con `--json` (un objeto JSON
 * por ejecución). Sin `--json` la CLI escribe formato humano (`ok <command>`);
 * el error deja claro el desajuste en lugar de fallar como JSON.parse crudo.
 */
export function jsonOutput(run: CliRun): Record<string, unknown> {
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `la salida de la CLI no es JSON (¿falta --json en captureCli?): ${JSON.stringify(run.stdout.slice(0, 200))}`,
    );
  }
}

export function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Espera activa acotada para condiciones asíncronas de red locales. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 20);
    await delay.promise;
  }
  throw new Error("waitFor: condición no cumplida dentro del tiempo límite");
}
