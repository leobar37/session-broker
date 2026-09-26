/**
 * Entrypoint operativo del broker (P-005, **opt-in**): arranca el servidor
 * durable con configuración EXPLÍCITA y cierra ordenadamente con SIGTERM.
 *
 * Este archivo existe para que la unidad systemd user tenga un `ExecStart`
 * real y auditable. Arrancarlo manualmente o como servicio es una decisión del
 * operador (gate `G-BROKER-SERVICE` para persistencia/autoarranque); importar
 * este módulo NO arranca nada (`import.meta.main`).
 *
 * Configuración (flags > entorno):
 *   --data-dir <ruta>          / SESSION_BROKER_DATA_DIR   (obligatorio, absoluta)
 *   --host <host>              / SESSION_BROKER_HOST       (default 127.0.0.1)
 *   --port <n>                 / SESSION_BROKER_PORT       (default 8791)
 *   --mac-key-file <ruta>      / SESSION_BROKER_MAC_KEY    (opcional; root binding)
 *
 * Los secretos viven en el EnvironmentFile (permisos 600) o en un archivo
 * referenciado por flag: JAMÁS en la línea de comandos ni en logs.
 */

import { readFileSync } from "node:fs";
import { createBrokerServer } from "./index";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const ARG_NAMES: Record<string, true> = {
  "--data-dir": true,
  "--host": true,
  "--port": true,
  "--mac-key-file": true,
};

interface ServeConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly macKey: string | undefined;
}

/** Pares flag→valor de argv; los valores desconocidos fallan explícitos. */
function parseServeArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (ARG_NAMES[name] !== true) {
      throw new Error(`serve: flag desconocido ${name} (usos: ${Object.keys(ARG_NAMES).join(", ")})`);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`serve: falta valor para ${name}`);
      value = next;
      index += 1;
    }
    out[name] = value;
  }
  return out;
}

function resolveServeConfig(argv: readonly string[], env: Record<string, string | undefined>): ServeConfig {
  const flags = parseServeArgs(argv);
  const dataDir = flags["--data-dir"] ?? env.SESSION_BROKER_DATA_DIR;
  if (dataDir === undefined || dataDir.length === 0) {
    throw new Error("serve: falta el data dir (--data-dir o SESSION_BROKER_DATA_DIR); sin él no hay store");
  }
  if (!dataDir.startsWith("/")) {
    throw new Error(`serve: el data dir debe ser una ruta absoluta (fuera de worktrees): ${dataDir}`);
  }
  const host = flags["--host"] ?? env.SESSION_BROKER_HOST ?? DEFAULT_HOST;
  const portRaw = flags["--port"] ?? env.SESSION_BROKER_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`serve: puerto inválido: ${portRaw}`);
  }
  const keyFile = flags["--mac-key-file"];
  let macKey = env.SESSION_BROKER_MAC_KEY;
  if (keyFile !== undefined) {
    macKey = readFileSync(keyFile, "utf8").trim();
    if (macKey.length === 0) throw new Error(`serve: el archivo de MAC key está vacío: ${keyFile}`);
  }
  return { host, port, dataDir, macKey };
}

async function main(): Promise<void> {
  const config = resolveServeConfig(process.argv.slice(2), process.env);
  const server = createBrokerServer({
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    ...(config.macKey === undefined ? {} : { macKey: config.macKey }),
  });
  const address = await server.listen();
  // Una sola línea JSON de readiness (sin secretos): útil para systemd/tests.
  process.stdout.write(`${JSON.stringify({ ready: true, host: address.host, port: address.port })}\n`);
  // Shutdown ordenado: conexiones/timers/DB se cierran; NINGÚN request se
  // completa artificialmente ni se relanza OMP/ninguna otra cosa.
  const shutdown = (signal: string): void => {
    process.stdout.write(`${JSON.stringify({ shutdown: true, signal })}\n`);
    void server
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        process.stderr.write(`serve: cierre con error: ${String(error)}\n`);
        process.exitCode = 1;
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // Mensaje accionable; jamás valores de secretos (solo la causa).
    process.stderr.write(`serve: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
