/**
 * CLI del session broker (P-003 / G-001) — `@session-broker/cli`.
 *
 * Superficie congelada (`docs/contracts/packages.md`):
 *   `runCli(argv): Promise<number>` devuelve el exit code numérico de
 *   `docs/contracts/exit-codes.md` (0..17); nunca texto como código.
 *   Comandos literales: `init`, `status`, `sessions list|inspect|history`,
 *   `ask`, `reply`, `notify`, `control`, `grants create|revoke`, `handoff`.
 *   Flags globales literales: `--root <dir>`, `--json`, `--timeout-ms <n>`,
 *   `--help`, `--version`. Se añaden `sessions query|subscribe` y flags
 *   explícitos de selección (`--target`, `--session`, `--reply-to`, `--epoch`).
 *
 * La CLI usa SOLO exports públicos de `@session-broker/client` y
 * `@session-broker/protocol`. El texto remoto jamás se ejecuta como shell ni
 * como flags ni modifica la configuración: viaja siempre como dato.
 */

import {
  EXIT_CODES,
  LIMITS,
  PROTOCOL_MAJOR,
  isNativeSessionId,
  isRequestId,
  isTargetId,
  newInstanceId,
  newRequestId,
  type ControlEpoch,
  type GrantId,
  type Operation,
  type ProjectId,
  type RequestEnvelope,
  type TargetRef,
  type WorkspaceId,
} from "@session-broker/protocol";
import { createClient, type Subscription } from "@session-broker/client";
import { CliError, cliErrorForState, cliErrorFromProtocol, exitCodeForState, toCliError } from "./errors";
import { Output } from "./output";
import { readUserConfig, resolveConfigHome, resolveConnectionConfig, resolveDataHome } from "./config";
import { initIdentity, readIdentity } from "./identity";

const CLI_VERSION = "0.1.0";

const BOOLEAN_FLAGS = new Set(["json", "help", "version", "regenerate-workspace"]);
const VALUE_FLAGS = new Set([
  "root",
  "timeout-ms",
  "name",
  "endpoint",
  "grant",
  "credential-file",
  "target",
  "session",
  "reply-to",
  "epoch",
  "verb",
  "question",
  "body",
  "summary",
  "topic",
  "data",
  "query",
  "topics",
  "from-seq",
  "limit",
  "cursor",
  "fields",
  "deadline-ms",
  "max-turns",
  "depth",
  "instruction",
  "request-id",
]);

const USAGE = `session-broker ${CLI_VERSION}

uso: session-broker <comando> [subcomando] [flags]

comandos:
  init                              inicializa identidad de proyecto/workspace (idempotente)
  status                            muestra identidad y configuración resuelta (sin secretos)
  sessions list|inspect|history|query|subscribe
  ask | reply | notify | control    operaciones de envío/control con target inequívoco
  grants create|revoke              no soportado en esta versión (explícito)
  handoff                           no soportado en esta versión (se implementa en P-006)

flags globales:
  --root <dir>        raíz del checkout (default: cwd)
  --json              salida JSON estable (JSON Lines para eventos)
  --timeout-ms <n>    espera/deadline local en ms (1..${LIMITS.requestTimeoutMsMax})
  --help              esta ayuda
  --version           versión del CLI

flags de selección/operación:
  --target <t> --session <nativeSessionId>   destino inequívoco
  --reply-to <requestId>                     reply exige el requestId del ask
  --epoch <n>                                control exige controlEpoch explícito
  --verb <prompt|steer|follow_up|abort> --instruction <texto>
  --question <texto> --deadline-ms <n> --body <texto|json> --summary <texto>
  --topic <tema> --data <json> --topics <a,b> --query <texto>
  --limit <n> --cursor <c> --from-seq <n> --fields <a,b>
  --endpoint <url> --grant <grantId> --credential-file <ruta>
  --request-id <requestId>                   reutiliza el ID (consulta idempotente)
  --name <nombre> --regenerate-workspace     init
`;

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

function invalidFlag(message: string, hint?: string): CliError {
  return new CliError({ code: "INVALID_INPUT", exitCode: EXIT_CODES.INVALID_INPUT, message, hint });
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw invalidFlag(`--${name} no recibe valor`);
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw invalidFlag(`flag desconocida: --${name}`, "consulta --help");
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw invalidFlag(`falta valor para --${name}`, "consulta --help");
      }
      value = next;
      index += 1;
    }
    flags.set(name, value);
  }
  return { positionals, flags };
}

function optionalFlagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireFlagValue(args: ParsedArgs, name: string): string {
  const value = optionalFlagValue(args, name);
  if (value === undefined) {
    throw invalidFlag(`falta --${name}`, "consulta --help para la sintaxis del comando");
  }
  return value;
}

function parseIntegerFlag(args: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = optionalFlagValue(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalidFlag(`--${name} debe ser un entero en ${min}..${max}`);
  }
  return parsed;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** `--body`/`--data`: JSON si interpreta, string crudo en caso contrario (sin ejecutar nada). */
function jsonOrString(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveRoot(args: ParsedArgs): string {
  return optionalFlagValue(args, "root") ?? process.cwd();
}

function parseTimeoutMs(args: ParsedArgs): number {
  return parseIntegerFlag(args, "timeout-ms", 1, LIMITS.requestTimeoutMsMax) ?? LIMITS.requestTimeoutMsDefault;
}

function parseRequestTarget(args: ParsedArgs, projectId: ProjectId, workspaceId: WorkspaceId, requireSession: boolean): TargetRef {
  const targetName = requireFlagValue(args, "target");
  if (!isTargetId(targetName)) {
    throw invalidFlag(`target inválido: ${targetName}`, "el target es un nombre opaco (p. ej. omp)");
  }
  const sessionName = optionalFlagValue(args, "session");
  if (sessionName === undefined) {
    if (requireSession) {
      throw invalidFlag("falta --session (nativeSessionId): el destino debe ser inequívoco", "pasa --target y --session explícitos");
    }
    return { target: targetName };
  }
  if (!isNativeSessionId(sessionName)) {
    throw invalidFlag(`session inválida: ${sessionName}`);
  }
  return {
    target: targetName,
    session: {
      projectId,
      scope: "workspace",
      workspaceId,
      target: targetName,
      nativeSessionId: sessionName,
    },
  };
}

function parseExplicitRequestId(args: ParsedArgs): string | undefined {
  const raw = optionalFlagValue(args, "request-id");
  if (raw === undefined) return undefined;
  if (!isRequestId(raw)) {
    throw invalidFlag(`--request-id inválido: ${raw}`);
  }
  return raw;
}

interface NetworkRequest {
  readonly command: string;
  readonly operation: Operation;
  readonly payload: unknown;
  readonly target: TargetRef;
  readonly timeoutMs: number;
  readonly requestId?: string;
  readonly controlEpoch?: ControlEpoch;
}

async function runNetworkCommand(request: NetworkRequest, args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const config = resolveConnectionConfig({
    endpointFlag: optionalFlagValue(args, "endpoint"),
    grantFlag: optionalFlagValue(args, "grant"),
    credentialFileFlag: optionalFlagValue(args, "credential-file"),
    requireCredential: true,
  });
  for (const secret of config.secrets) secrets.push(secret);
  const identity = readIdentity(resolveRoot(args));
  const client = createClient({
    endpoint: config.endpoint,
    projectId: identity.project.projectId,
    workspaceId: identity.workspace.workspaceId,
    instanceId: newInstanceId(),
    grantId: config.grantId as GrantId,
    credential: config.credential,
    allowInsecureWs: config.allowInsecureWs,
    requestTimeoutMs: request.timeoutMs,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close();
    throw error;
  }
  try {
    const base: RequestEnvelope = {
      v: PROTOCOL_MAJOR,
      kind: "request",
      requestId: request.requestId ?? newRequestId(),
      operation: request.operation,
      target: request.target,
      payload: request.payload,
      grantId: config.grantId as GrantId,
      sentAtMs: Date.now(),
      deadlineMs: request.timeoutMs,
    };
    const envelope: RequestEnvelope =
      request.controlEpoch === undefined ? base : { ...base, controlEpoch: request.controlEpoch };
    const response = await client.request(envelope);
    if (response.error !== undefined) {
      throw cliErrorFromProtocol(response.error, { requestId: response.requestId, state: response.state });
    }
    const fields: Record<string, unknown> = {
      requestId: response.requestId,
      state: response.state,
    };
    if (response.replyTo !== undefined) fields.replyTo = response.replyTo;
    fields.result = response.result ?? null;
    const exitCode = exitCodeForState(response.state);
    if (exitCode === EXIT_CODES.OK) {
      return output.success(request.command, fields);
    }
    throw cliErrorForState(response.state, response.requestId);
  } finally {
    await client.close();
  }
}

async function commandInit(args: ParsedArgs, output: Output): Promise<number> {
  const outcome = initIdentity({
    root: resolveRoot(args),
    name: optionalFlagValue(args, "name"),
    regenerateWorkspace: args.flags.get("regenerate-workspace") === true,
    nowMs: Date.now(),
  });
  return output.success("init", {
    rootPath: outcome.rootPath,
    projectFilePath: outcome.projectFilePath,
    workspaceFilePath: outcome.workspaceFilePath,
    projectId: outcome.projectId,
    workspaceId: outcome.workspaceId,
    created: {
      project: outcome.createdProject,
      workspace: outcome.createdWorkspace,
      workspaceRegenerated: outcome.regeneratedWorkspace,
    },
    gitignore: {
      applies: outcome.gitignoreApplies,
      rule: outcome.gitignoreRule,
      updated: outcome.gitignoreUpdated,
    },
  });
}

async function commandStatus(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const identity = readIdentity(resolveRoot(args));
  const configHome = resolveConfigHome();
  const dataPath = resolveDataHome();
  const { configPath, file } = readUserConfig();
  const endpoint = process.env.SESSION_BROKER_ENDPOINT ?? file?.endpoint;
  const grantId = process.env.SESSION_BROKER_GRANT_ID ?? file?.grantId;
  const credentialPresent = (process.env.SESSION_BROKER_CREDENTIAL ?? file?.credential) !== undefined;
  if (endpoint !== undefined) {
    const userinfo = /^[a-z]+:\/\/([^/@]+)@/i.exec(endpoint);
    if (userinfo !== null && userinfo[1] !== undefined) secrets.push(userinfo[1]);
  }
  return output.success("status", {
    rootPath: identity.rootPath,
    projectId: identity.project.projectId,
    workspaceId: identity.workspace.workspaceId,
    configHome,
    configPath,
    dataPath,
    endpoint: endpoint ?? "(no configurado)",
    grantId: grantId ?? "(no configurado)",
    credential: credentialPresent ? "(presente; jamás se muestra)" : "(ausente)",
    transport: endpoint === undefined ? "-" : /^[a-z]+:/.exec(endpoint)?.[0] ?? "(inválido)",
    insecureAllowed: process.env.SESSION_BROKER_ALLOW_INSECURE_WS !== undefined || file?.allowInsecureWs === true,
  });
}

async function commandSessions(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const subcommand = args.positionals[1];
  const timeoutMs = parseTimeoutMs(args);
  const root = resolveRoot(args);
  const identity = readIdentity(root);
  const projectId = identity.project.projectId;
  const workspaceId = identity.workspace.workspaceId;
  switch (subcommand) {
    case "list": {
      const limit = parseIntegerFlag(args, "limit", 1, LIMITS.maxHistoryPageItems);
      const cursor = optionalFlagValue(args, "cursor");
      const payload: Record<string, unknown> = {};
      if (limit !== undefined) payload.limit = limit;
      if (cursor !== undefined) payload.cursor = cursor;
      return await runNetworkCommand(
        {
          command: "sessions list",
          operation: "list",
          payload,
          target: parseRequestTarget(args, projectId, workspaceId, false),
          timeoutMs,
          requestId: parseExplicitRequestId(args),
        },
        args,
        output,
        secrets,
      );
    }
    case "inspect": {
      const fields = optionalFlagValue(args, "fields");
      const payload: Record<string, unknown> = {};
      if (fields !== undefined) payload.fields = splitList(fields);
      return await runNetworkCommand(
        {
          command: "sessions inspect",
          operation: "inspect",
          payload,
          target: parseRequestTarget(args, projectId, workspaceId, true),
          timeoutMs,
          requestId: parseExplicitRequestId(args),
        },
        args,
        output,
        secrets,
      );
    }
    case "history": {
      const fromEventSeq = parseIntegerFlag(args, "from-seq", 1, Number.MAX_SAFE_INTEGER);
      const limit = parseIntegerFlag(args, "limit", 1, LIMITS.maxHistoryPageItems);
      const cursor = optionalFlagValue(args, "cursor");
      const payload: Record<string, unknown> = {};
      if (fromEventSeq !== undefined) payload.fromEventSeq = fromEventSeq;
      if (limit !== undefined) payload.limit = limit;
      if (cursor !== undefined) payload.cursor = cursor;
      return await runNetworkCommand(
        {
          command: "sessions history",
          operation: "history",
          payload,
          target: parseRequestTarget(args, projectId, workspaceId, true),
          timeoutMs,
          requestId: parseExplicitRequestId(args),
        },
        args,
        output,
        secrets,
      );
    }
    case "query": {
      const query = requireFlagValue(args, "query");
      const limit = parseIntegerFlag(args, "limit", 1, LIMITS.maxHistoryPageItems);
      const payload: Record<string, unknown> = { query };
      if (limit !== undefined) payload.limit = limit;
      return await runNetworkCommand(
        {
          command: "sessions query",
          operation: "query",
          payload,
          target: parseRequestTarget(args, projectId, workspaceId, false),
          timeoutMs,
          requestId: parseExplicitRequestId(args),
        },
        args,
        output,
        secrets,
      );
    }
    case "subscribe": {
      return await commandSubscribe(args, output, secrets, projectId, workspaceId, timeoutMs);
    }
    default:
      throw invalidFlag(
        `subcomando de sessions desconocido: ${subcommand === undefined ? "(ausente)" : subcommand}`,
        "usa sessions list|inspect|history|query|subscribe",
      );
  }
}

async function commandSubscribe(
  args: ParsedArgs,
  output: Output,
  secrets: string[],
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  timeoutMs: number,
): Promise<number> {
  const topics = splitList(requireFlagValue(args, "topics"));
  const fromEventSeq = parseIntegerFlag(args, "from-seq", 1, Number.MAX_SAFE_INTEGER);
  const config = resolveConnectionConfig({
    endpointFlag: optionalFlagValue(args, "endpoint"),
    grantFlag: optionalFlagValue(args, "grant"),
    credentialFileFlag: optionalFlagValue(args, "credential-file"),
    requireCredential: true,
  });
  for (const secret of config.secrets) secrets.push(secret);
  const target = parseRequestTarget(args, projectId, workspaceId, false);
  const client = createClient({
    endpoint: config.endpoint,
    projectId,
    workspaceId,
    instanceId: newInstanceId(),
    grantId: config.grantId as GrantId,
    credential: config.credential,
    allowInsecureWs: config.allowInsecureWs,
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close();
    throw error;
  }
  let eventCount = 0;
  try {
    const subscription: Subscription = client.subscribe(
      fromEventSeq === undefined ? { topics } : { topics, fromEventSeq },
      target,
      (event) => {
        eventCount += 1;
        output.eventLine("sessions subscribe", event);
      },
    );
    await subscription.ack;
    const timeoutSignal = Promise.withResolvers<undefined>();
    setTimeout(() => timeoutSignal.resolve(undefined), timeoutMs);
    const outcome = await Promise.race([subscription.closed, timeoutSignal.promise]);
    if (outcome === undefined) {
      subscription.close();
      return output.success("sessions subscribe", { topics, events: eventCount, stopped: "timeout" });
    }
    if (outcome !== null) throw toCliError(outcome);
    return output.success("sessions subscribe", { topics, events: eventCount, stopped: "closed" });
  } finally {
    await client.close();
  }
}

async function commandAsk(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const root = resolveRoot(args);
  const identity = readIdentity(root);
  const question = requireFlagValue(args, "question");
  const deadlineMs = parseIntegerFlag(args, "deadline-ms", 1, LIMITS.askDeadlineMsMax) ?? LIMITS.askDeadlineMsDefault;
  const maxTurns = parseIntegerFlag(args, "max-turns", 1, 32);
  const depth = parseIntegerFlag(args, "depth", 0, 8);
  const payload: Record<string, unknown> = { question, deadlineMs, policy: "when_idle" };
  if (maxTurns !== undefined) payload.maxTurns = maxTurns;
  if (depth !== undefined) payload.depth = depth;
  return await runNetworkCommand(
    {
      command: "ask",
      operation: "ask",
      payload,
      target: parseRequestTarget(args, identity.project.projectId, identity.workspace.workspaceId, true),
      timeoutMs: parseTimeoutMs(args),
      requestId: parseExplicitRequestId(args),
    },
    args,
    output,
    secrets,
  );
}

async function commandReply(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const root = resolveRoot(args);
  const identity = readIdentity(root);
  const replyTo = requireFlagValue(args, "reply-to");
  if (!isRequestId(replyTo)) {
    throw invalidFlag(`--reply-to debe ser un requestId válido: ${replyTo}`, "usa el requestId del ask (replyTo=requestId explícito)");
  }
  const bodyRaw = optionalFlagValue(args, "body");
  if (bodyRaw === undefined) {
    throw invalidFlag("falta --body", "reply exige un body explícito");
  }
  const summary = optionalFlagValue(args, "summary");
  const payload: Record<string, unknown> = { replyTo, body: jsonOrString(bodyRaw) };
  if (summary !== undefined) payload.summary = summary;
  return await runNetworkCommand(
    {
      command: "reply",
      operation: "reply",
      payload,
      target: parseRequestTarget(args, identity.project.projectId, identity.workspace.workspaceId, true),
      timeoutMs: parseTimeoutMs(args),
      requestId: parseExplicitRequestId(args),
    },
    args,
    output,
    secrets,
  );
}

async function commandNotify(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const root = resolveRoot(args);
  const identity = readIdentity(root);
  const topic = requireFlagValue(args, "topic");
  return await runNetworkCommand(
    {
      command: "notify",
      operation: "notify",
      payload: { topic, data: jsonOrString(optionalFlagValue(args, "data")) },
      target: parseRequestTarget(args, identity.project.projectId, identity.workspace.workspaceId, false),
      timeoutMs: parseTimeoutMs(args),
      requestId: parseExplicitRequestId(args),
    },
    args,
    output,
    secrets,
  );
}

async function commandControl(args: ParsedArgs, output: Output, secrets: string[]): Promise<number> {
  const root = resolveRoot(args);
  const identity = readIdentity(root);
  const verb = requireFlagValue(args, "verb");
  const instruction = optionalFlagValue(args, "instruction");
  const payload: Record<string, unknown> = { verb };
  if (instruction !== undefined) payload.instruction = instruction;
  const epoch = parseIntegerFlag(args, "epoch", 0, Number.MAX_SAFE_INTEGER);
  if (epoch === undefined) {
    throw new CliError({
      code: "STALE_CONTROL_EPOCH",
      exitCode: EXIT_CODES.STALE_CONTROL_EPOCH,
      reason: "stale_control_epoch",
      message: "control exige un controlEpoch explícito; no se infiere ni se reutiliza en silencio",
      hint: "pasa --epoch <n> con el epoch vigente del lease de control",
    });
  }
  return await runNetworkCommand(
    {
      command: "control",
      operation: "control",
      payload,
      target: parseRequestTarget(args, identity.project.projectId, identity.workspace.workspaceId, true),
      timeoutMs: parseTimeoutMs(args),
      requestId: parseExplicitRequestId(args),
      controlEpoch: epoch,
    },
    args,
    output,
    secrets,
  );
}

/**
 * Punto de entrada de la CLI. Devuelve el exit code numérico (0..17) de la
 * tabla única; nunca lanza ni llama a `process.exit`.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const secrets: string[] = [];
  const jsonMode = argv.some((token) => token === "--json" || token.startsWith("--json="));
  const output = new Output(jsonMode, secrets);
  let commandLabel = "cli";
  try {
    const args = parseArgv(argv);
    if (args.flags.has("version")) {
      if (jsonMode) return output.success("version", { version: CLI_VERSION });
      output.raw(`${CLI_VERSION}\n`);
      return EXIT_CODES.OK;
    }
    const command = args.positionals[0];
    if (command === undefined || args.flags.has("help")) {
      // Con `--json` la salida es SIEMPRE exactamente un objeto JSON por línea.
      if (jsonMode) return output.success("help", { usage: USAGE });
      output.raw(USAGE);
      return EXIT_CODES.OK;
    }
    commandLabel = command;
    switch (command) {
      case "init":
        return await commandInit(args, output);
      case "status":
        return await commandStatus(args, output, secrets);
      case "sessions":
        commandLabel = `sessions ${args.positionals[1] ?? ""}`.trim();
        return await commandSessions(args, output, secrets);
      case "ask":
        return await commandAsk(args, output, secrets);
      case "reply":
        return await commandReply(args, output, secrets);
      case "notify":
        return await commandNotify(args, output, secrets);
      case "control":
        return await commandControl(args, output, secrets);
      case "grants":
      case "handoff":
        throw new CliError({
          code: "UNSUPPORTED_CAPABILITY",
          exitCode: EXIT_CODES.UNSUPPORTED_CAPABILITY,
          message: `${command} no está soportado en esta versión (explícito, sin fallback silencioso)`,
          hint:
            command === "handoff"
              ? "handoff se implementa en la fase P-006"
              : "la gestión de grants no forma parte de las operaciones congeladas disponibles desde la CLI",
        });
      default:
        throw invalidFlag(`comando desconocido: ${command}`, "usa --help");
    }
  } catch (error) {
    const cliError = toCliError(error);
    return output.failure(commandLabel, cliError);
  }
}
