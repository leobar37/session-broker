/**
 * Configuración de usuario y rutas de datos (FR-002 / NFR-001).
 *
 * - Endpoints y credenciales viven SOLO en configuración de usuario
 *   (`$XDG_CONFIG_HOME/session-broker/config.json` o `$HOME/.config/...`),
 *   jamás en `.broker/project.json` ni en el checkout.
 * - Precedencia congelada por campo: flag de comando > variable de entorno
 *   `SESSION_BROKER_*` > archivo de configuración > error accionable.
 * - El data path se resuelve SOLO desde `XDG_DATA_HOME`/`HOME`; si no es
 *   resolvable se falla explícitamente, nunca se cae al checkout.
 * - Secretos: permisos restrictivos (0600) exigidos, redactados en toda
 *   salida y jamás impresos.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, isPlainObject, isSafeInteger, isString } from "@session-broker/protocol";
import { CliError } from "./errors";

const CONFIG_APP_DIR = "session-broker";
const CONFIG_FILE_NAME = "config.json";
const USER_CONFIG_SCHEMA_VERSION = 1;
const SECRET_FILE_MODE_MASK = 0o077;

export interface UserConfigFile {
  readonly schemaVersion: number;
  readonly endpoint?: string;
  readonly grantId?: string;
  readonly credential?: string;
  readonly allowInsecureWs?: boolean;
}

export interface ResolvedConnectionConfig {
  readonly configPath: string;
  readonly endpoint: string;
  readonly grantId: string;
  readonly credential: string;
  readonly allowInsecureWs: boolean;
  /** Valores secretos a redactar en toda salida (credential y userinfo del endpoint). */
  readonly secrets: readonly string[];
}

const CONFIG_ALLOWED_KEYS = ["schemaVersion", "endpoint", "grantId", "credential", "allowInsecureWs"];

function homeDir(): string {
  const home = process.env.HOME;
  if (typeof home === "string" && home.length > 0) return home;
  throw new CliError({
    code: "INVALID_INPUT",
    exitCode: EXIT_CODES.INVALID_INPUT,
    message: "no se puede resolver HOME; sin él no hay configuración de usuario ni data path",
    hint: "define HOME o las variables XDG_CONFIG_HOME/XDG_DATA_HOME explícitamente",
  });
}

/** Directorio base de configuración de usuario; error explícito si no es resolvable. */
export function resolveConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.length > 0) return xdg;
  return join(homeDir(), ".config");
}

/**
 * Data path del usuario (`.../session-broker`); NUNCA cae silenciosamente al
 * checkout: sin `XDG_DATA_HOME` ni `HOME` se falla con error accionable.
 */
export function resolveDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.length > 0) return join(xdg, CONFIG_APP_DIR);
  const home = process.env.HOME;
  if (typeof home === "string" && home.length > 0) return join(home, ".local", "share", CONFIG_APP_DIR);
  throw new CliError({
    code: "INVALID_INPUT",
    exitCode: EXIT_CODES.INVALID_INPUT,
    message: "no se puede resolver el data path (faltan XDG_DATA_HOME y HOME); jamás se usa el checkout como fallback",
    hint: "define XDG_DATA_HOME o HOME explícitamente; el data path nunca debe caer en el checkout",
  });
}

export interface UserConfigRead {
  readonly configPath: string;
  readonly file: UserConfigFile | undefined;
}

export function readUserConfig(): UserConfigRead {
  const configPath = join(resolveConfigHome(), CONFIG_APP_DIR, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return { configPath, file: undefined };
  }
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (cause) {
    throw new CliError({
      code: "INTERNAL_ERROR",
      exitCode: EXIT_CODES.INTERNAL_ERROR,
      message: `no se puede leer la configuración de usuario (${configPath}): ${describeIoError(cause)}`,
      hint: "revisa permisos del archivo de configuración",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // El contenido NUNCA se copia al mensaje: podría contener secretos.
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "schema_malformed",
      message: `la configuración de usuario no es JSON válido (${configPath})`,
      hint: "corrige el archivo o elimínalo para volver a configurar",
    });
  }
  return { configPath, file: parseUserConfig(configPath, raw) };
}

function parseUserConfig(configPath: string, raw: unknown): UserConfigFile {
  if (!isPlainObject(raw)) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "schema_malformed",
      message: `la configuración de usuario debe ser un objeto JSON (${configPath})`,
    });
  }
  const unknown = Object.keys(raw).filter((key) => !CONFIG_ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "unknown_fields",
      message: `campos desconocidos en la configuración de usuario: ${unknown.join(", ")}`,
    });
  }
  const schemaVersion: unknown = raw.schemaVersion;
  if (!isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "schema_malformed",
      message: "schemaVersion ausente o inválido en la configuración de usuario",
    });
  }
  if (schemaVersion !== USER_CONFIG_SCHEMA_VERSION) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "unsupported_schema_version",
      message: `schemaVersion ${String(schemaVersion)} no soportado en la configuración de usuario (soportado: ${USER_CONFIG_SCHEMA_VERSION})`,
    });
  }
  const endpoint = optionalStringField(raw.endpoint, "endpoint", configPath);
  const grantId = optionalStringField(raw.grantId, "grantId", configPath);
  const credential = optionalStringField(raw.credential, "credential", configPath);
  const allowInsecureWs = raw.allowInsecureWs;
  if (allowInsecureWs !== undefined && typeof allowInsecureWs !== "boolean") {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "invalid_field",
      message: `allowInsecureWs debe ser booleano (${configPath})`,
    });
  }
  return {
    schemaVersion: schemaVersion as number,
    endpoint,
    grantId,
    credential,
    allowInsecureWs: allowInsecureWs as boolean | undefined,
  };
}

function optionalStringField(value: unknown, field: string, configPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || value.length === 0) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      reason: "invalid_field",
      message: `${field} debe ser un string no vacío (${configPath})`,
    });
  }
  return value;
}

function describeIoError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code: unknown = cause.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "io_error";
}

export interface ResolveConnectionInput {
  endpointFlag?: string | undefined;
  grantFlag?: string | undefined;
  credentialFileFlag?: string | undefined;
  requireCredential: boolean;
}

/**
 * Resuelve endpoint/grant/credencial con la precedencia congelada
 * (flag > env `SESSION_BROKER_*` > config de usuario) y exige permisos
 * restrictivos cuando hay secretos en el archivo de configuración.
 */
export function resolveConnectionConfig(input: ResolveConnectionInput): ResolvedConnectionConfig {
  const { configPath, file } = readUserConfig();
  if (file?.credential !== undefined) {
    try {
      const mode = statSync(configPath).mode & 0o777;
      if ((mode & SECRET_FILE_MODE_MASK) !== 0) {
        throw new CliError({
          code: "UNAUTHORIZED",
          exitCode: EXIT_CODES.UNAUTHORIZED,
          message: `la configuración de usuario contiene secretos con permisos demasiado abiertos (${configPath})`,
          hint: `ejecuta: chmod 600 ${configPath}`,
        });
      }
    } catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw new CliError({
        code: "INTERNAL_ERROR",
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: `no se pueden comprobar permisos de ${configPath}: ${describeIoError(cause)}`,
      });
    }
  }
  const endpoint = input.endpointFlag ?? process.env.SESSION_BROKER_ENDPOINT ?? file?.endpoint;
  if (endpoint === undefined) {
    throw new CliError({
      code: "INVALID_INPUT",
      exitCode: EXIT_CODES.INVALID_INPUT,
      message: "endpoint del broker no configurado",
      hint: `define --endpoint, SESSION_BROKER_ENDPOINT o "endpoint" en ${configPath}`,
    });
  }
  const grantId = input.grantFlag ?? process.env.SESSION_BROKER_GRANT_ID ?? file?.grantId;
  if (grantId === undefined) {
    throw new CliError({
      code: "UNAUTHORIZED",
      exitCode: EXIT_CODES.UNAUTHORIZED,
      message: "grantId ausente: sin credencial de grant no hay operación autenticada",
      hint: `define --grant, SESSION_BROKER_GRANT_ID o "grantId" en ${configPath}`,
    });
  }
  let credential = process.env.SESSION_BROKER_CREDENTIAL ?? file?.credential;
  if (input.credentialFileFlag !== undefined) {
    try {
      credential = readFileSync(input.credentialFileFlag, "utf8").trim();
    } catch (cause) {
      throw new CliError({
        code: "INTERNAL_ERROR",
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: `no se puede leer el archivo de credencial (${input.credentialFileFlag}): ${describeIoError(cause)}`,
      });
    }
  }
  if (credential === undefined || credential.length === 0) {
    if (!input.requireCredential) {
      credential = "";
    } else {
      throw new CliError({
        code: "UNAUTHORIZED",
        exitCode: EXIT_CODES.UNAUTHORIZED,
        message: "credencial ausente: los IDs jamás autentican por sí solos",
        hint: `define SESSION_BROKER_CREDENTIAL, --credential-file o "credential" en ${configPath} (permisos 600)`,
      });
    }
  }
  const envInsecure = process.env.SESSION_BROKER_ALLOW_INSECURE_WS;
  const allowInsecureWs =
    envInsecure === "1" || envInsecure === "true" || envInsecure === "yes"
      ? true
      : file?.allowInsecureWs === true;
  const secrets: string[] = [];
  if (credential.length > 0) secrets.push(credential);
  const userinfo = /^[a-z]+:\/\/([^/@]+)@/i.exec(endpoint);
  if (userinfo !== null && userinfo[1] !== undefined) secrets.push(userinfo[1]);
  return { configPath, endpoint, grantId, credential, allowInsecureWs, secrets };
}
