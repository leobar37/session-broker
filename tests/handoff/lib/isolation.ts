/**
 * Helpers de aislamiento de la suite `tests/handoff` (NFR-002 / P-006).
 *
 * Reglas que estos helpers hacen cumplir:
 *  - Todo artefacto temporal vive bajo `os.tmpdir()` con el prefijo reservado
 *    `omp-session-broker-test-` (fuera del árbol del repo).
 *  - Los procesos hijos (bun install / bun pm pack / smoke) corren con
 *    HOME/XDG/BUN_INSTALL_CACHE_DIR efímeros dentro del TMP del test.
 *  - Red externa bloqueada: solo loopback (el broker de fixtures es
 *    `ws://127.0.0.1:<puerto efímero>`).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TMP_PREFIX = "omp-session-broker-test-";

/** Crea un directorio temporal propio (prefijo reservado) bajo os.tmpdir(). */
export function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${TMP_PREFIX}${label}-`));
}

/** Teardown total del directorio temporal (best-effort, idempotente). */
export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };

/**
 * Guarda de red pura (sin efectos): cualquier host no-loopback se rechaza.
 * Los esquemas no-red (`file:`, `data:`, …) se aceptan.
 */
export function assertUrlAllowed(raw: string | URL, context: string): void {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : new URL(raw.href);
  } catch {
    throw new Error(`URL no interpretable (${context}): ${String(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return;
  }
  if (LOOPBACK_HOSTS[url.hostname] !== true) {
    throw new Error(`red externa bloqueada (${context}): ${url.protocol}//${url.hostname}`);
  }
}

/**
 * Instala la guardas de red sobre `fetch` y el `WebSocket` global del proceso.
 * Devuelve la función de restauración (teardown). Asignación vía cast para no
 * chocar con la inmutabilidad de los tipos globales (patrón de tests/omp).
 */
export function installNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  (globalThis as Record<string, unknown>)["fetch"] = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    assertUrlAllowed(href, "fetch");
    return originalFetch(input, init);
  };
  (globalThis as Record<string, unknown>)["WebSocket"] = function GuardedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
    assertUrlAllowed(String(url), "WebSocket");
    return protocols === undefined ? new originalWebSocket(url) : new originalWebSocket(url, protocols);
  };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    (globalThis as Record<string, unknown>)["fetch"] = originalFetch;
    (globalThis as Record<string, unknown>)["WebSocket"] = originalWebSocket;
  };
}

/**
 * Entorno para procesos hijos: HOME/XDG/cache de Bun efímeros dentro del TMP.
 * Ninguna ruta de esta máquina se hereda por esas variables.
 */
export function childEnv(tmp: string): Record<string, string> {
  const home = join(tmp, "home");
  const config = join(tmp, "config");
  const data = join(tmp, "data");
  const cache = join(tmp, "bun-cache");
  for (const dir of [home, config, data, cache]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["HOME"] = home;
  env["XDG_CONFIG_HOME"] = config;
  env["XDG_DATA_HOME"] = data;
  env["BUN_INSTALL_CACHE_DIR"] = cache;
  return env;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Ejecuta un comando en un cwd concreto con entorno aislado; nunca lanza. */
export async function runCommand(
  cmd: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
