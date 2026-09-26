# FREEZE de los cinco paquetes (P-001 → P-002/P-003/P-004/P-006)

Estado: **CONGELADO**. Nombres, versiones iniciales, export maps y símbolos
públicos de abajo son contrato que DEBEN existir con esas firmas. Ninguna
decisión de esta lista queda pendiente para las ramas paralelas. Los cambios
posteriores se serializan con el coordinador.

Verificación automática: `freeze.json` + `tests/protocol/contract-freeze.test.ts`
(cotejan nombres/versiones/exports con `packages/protocol/package.json` real).

## Tabla de paquetes

| Paquete npm | Carpeta | Versión | Export map | Dependencias runtime permitidas |
| --- | --- | --- | --- | --- |
| `@session-broker/protocol` | `packages/protocol` | 0.1.0 | `".": "./src/index.ts"`, `"./fixtures": "./src/fixtures.ts"`, `"./package.json"` | ninguna (solo builtins: `node:crypto`) |
| `@session-broker/client` | `packages/client` | 0.1.0 | `".": "./src/index.ts"` | `@session-broker/protocol` |
| `@session-broker/server` | `apps/broker` | 0.1.0 | `".": "./src/index.ts"` | `@session-broker/protocol` (+ `bun:sqlite`, `Bun.serve`) |
| `@session-broker/cli` | `apps/cli` | 0.1.0 | `".": "./src/index.ts"` | `@session-broker/protocol`, `@session-broker/client` |
| `@session-broker/omp-adapter` | `packages/omp-adapter` | 0.1.0 | `".": "./src/index.ts"` | `@session-broker/protocol` (+ tipos OMP del host) |

Reglas comunes a los cinco:
- `"type": "module"`, exports **source-first** (`./src/index.ts`), sin build step.
- Sin publicación npm; `"private": true`.
- Subimports privados prohibidos para consumidores: solo los exports públicos.
- Todo consumidor externo (incluido el maestro) usa únicamente esta superficie.

## `@session-broker/protocol` (ya implementado en P-001)

Superficie pública = `src/index.ts` (ver docblock del archivo) + `src/fixtures.ts`.
Incluye: versión/handshake, identidad, root proof, grants/`controlEpoch`,
envelopes, operaciones, estados, dedup, capacidades, límites, errores/exit
codes y fixtures de referencia. Nada de esto cambia sin coordinador.

## `@session-broker/client` — firmas DEBIDAS (P-003)

```ts
import type {
  ControlEpoch, ControlPayload, EventEnvelope, AskPayload, GrantId, HistoryPayload,
  InstanceId, InspectPayload, ListPayload, NotifyPayload, ProjectId, QueryPayload,
  ReplyPayload, RequestEnvelope, ResponseEnvelope, SubscribePayload, TargetRef,
  WelcomeMessage, WorkspaceId,
} from "@session-broker/protocol";

export interface ClientOptions {
  endpoint: string;                 // wss://… ; ws:// solo con política local explícita
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  instanceId: InstanceId;
  grantId: GrantId;
  credential: string;               // jamás persistido ni logueado
  protocolVersions?: readonly string[];   // default ["1.0.0"]
  now?: () => number;               // reloj inyectable para tests
}

export interface Subscription {
  readonly topic: string;
  close(): void;
}

export interface BrokerClient {
  connect(): Promise<WelcomeMessage>;
  close(): Promise<void>;
  request(envelope: RequestEnvelope): Promise<ResponseEnvelope>;
  query(payload: QueryPayload, target: TargetRef): Promise<ResponseEnvelope>;
  list(payload: ListPayload, target: TargetRef): Promise<ResponseEnvelope>;
  inspect(payload: InspectPayload, target: TargetRef): Promise<ResponseEnvelope>;
  history(payload: HistoryPayload, target: TargetRef): Promise<ResponseEnvelope>;
  subscribe(
    payload: SubscribePayload,
    target: TargetRef,
    onEvent: (event: EventEnvelope) => void,
  ): Subscription;
  ask(payload: AskPayload, target: TargetRef): Promise<ResponseEnvelope>;
  reply(payload: ReplyPayload, target: TargetRef): Promise<ResponseEnvelope>;
  notify(payload: NotifyPayload, target: TargetRef): Promise<ResponseEnvelope>;
  control(payload: ControlPayload, target: TargetRef, controlEpoch: ControlEpoch): Promise<ResponseEnvelope>;
}

export function createClient(options: ClientOptions): BrokerClient;
```

Garantías: el cliente traduce errores del protocolo a `ResponseEnvelope.error`
sin reintentos ciegos; los reintentos solo con mismo `requestId` + mismo hash y
solo si `PROTOCOL_ERROR_TABLE[code].retrySafe` es `true`.

## `@session-broker/server` — firmas DEBIDAS (P-002)

```ts
export interface BrokerServerOptions {
  host?: string;                    // default 127.0.0.1
  port: number;                     // 0 = efímero (fixtures)
  dataDir: string;                  // SQLite + journals (TMP en tests)
  macKey?: string;                  // HMAC de root proofs (config de usuario)
  now?: () => number;
}

export interface BrokerServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly activeConnections: number;
}

export function createBrokerServer(options: BrokerServerOptions): BrokerServer;
```

Todo lo demás (almacenamiento, rutas, auth interna) es **privado**; los tests de
P-002 consumen solo estos exports y fixtures de `@session-broker/protocol`.

## `@session-broker/cli` — firmas DEBIDAS (P-003)

```ts
/** Devuelve el exit code numérico de docs/contracts/exit-codes.md (0..17). */
export function runCli(argv: readonly string[]): Promise<number>;
```

Superficie de comandos congelada (nombres literales):
`init`, `status`, `sessions list|inspect|history`, `ask`, `reply`, `notify`,
`control`, `grants create|revoke`, `handoff` (implementado en P-006).
Flags globales congelados: `--root <dir>`, `--json`, `--timeout-ms <n>`,
`--help`, `--version`. Toda salida de error termina con el exit code de la
tabla única; nunca texto como código.

## `@session-broker/omp-adapter` — firmas DEBIDAS (P-004)

```ts
import type { Capability, NativeSessionId, ProjectId, WorkspaceId, InstanceId, GrantId, RootProof } from "@session-broker/protocol";

export interface OmpAdapterOptions {
  endpoint: string;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  instanceId: InstanceId;
  nativeSessionId: NativeSessionId;
  grantId: GrantId;
  credential: string;
  replyToolName?: string;            // default "session_reply"
  now?: () => number;
}

export interface OmpAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Capacidades realmente soportadas por esta versión OMP (evidencia en docs/compatibility). */
  readonly capabilities: readonly Capability[];
}

export function createOmpAdapter(options: OmpAdapterOptions): OmpAdapter;

/** Emite la root proof de bootstrap (actor local confiable; un solo uso). */
export function issueRootProof(input: {
  macKey: string;
  issuer: string;
  instanceId: InstanceId;
  nativeSessionId: NativeSessionId;
  challenge: string;
  audience: string;
  nowMs: number;
  ttlMs?: number;                    // default 300000, máx rootProofTtlMsMax
}): RootProof;
```

El adaptador es la **única frontera autorizada** con APIs OMP; registra la
herramienta de respuesta (`session_reply`) con la API pública del runtime y
envía el `reply` estructurado al broker. Si una capacidad core no puede
sustentarse con evidencia, se declara `unsupported` y se bloquea la unidad
afectada (sin stubs).
