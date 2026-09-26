# Handoff verificado del omp-session-broker (SDK + adaptador OMP consumibles sin publicación)

> Archivo GENERADO por `bun tests/handoff/build-handoff.ts` a partir de evidencia real.
> No editar a mano: la suite `tests/handoff` compara este Markdown byte a byte con la
> proyección del JSON y re-valida hashes/exports contra el repo vivo.

- Schema del handoff: `omp-session-broker-handoff/1` (`omp-broker-v1`)
- Stage de evidencia: `final` (pre-gate = resultados aún no observados marcados como pending; final = todo observado)
- Fecha de evidencia: 2026-09-26T18:16:04Z
- Generado desde evidencia: `omp-session-broker-evidence/1` (operador: coordinator)

## 1. Identificación

- Versión de protocolo: `1.0.0`
- Origen del bundle: local-checkout, npm publicado: false, secretos: none, rutas de máquina: none

| Paquete | Versión | Workspace | Export map | Símbolos públicos clave |
| --- | --- | --- | --- | --- |
| `@session-broker/protocol` | 0.1.0 | `packages/protocol` | . → ./src/index.ts ; ./fixtures → ./src/fixtures.ts ; ./package.json → ./package.json | PROTOCOL_VERSION, PROTOCOL_MAJOR, PROTOCOL_ERROR_TABLE, EXIT_CODES, LIMITS, CAPABILITIES, CORE_CAPABILITIES, OPTIONAL_CAPABILITIES, REQUEST_STATES, OPERATIONS, ROOT_PROOF_VERSION, validateHello, validateWelcome, negotiateHelloVersion, validateRequestEnvelope, validateResponseEnvelope, validateEventEnvelope, canonicalJson, computePayloadHash, sha256Hex, evaluateGrant, parseGrant, assertControlEpoch, computeRootProofMac, verifyRootProof, evaluateRootBindingClaim, RootProofLedger, evaluateDedup, allowsAutomaticReExecution, applyRequestEvent, classifyAskCompletion, protocolError, cliExitCodeForError, exitCodeForErrorCode, checkOperationSupport, newProjectId, newWorkspaceId, newInstanceId, newRequestId, newGrantId, newRootProofId, referenceFixtures, checkValidFixture, referenceInvalidFixtures, checkInvalidFixture |
| `@session-broker/client` | 0.1.0 | `packages/client` | . → ./src/index.ts | createClient, reconnectDelayMs, BrokerClientError, isBrokerClientError, BrokerClient, ClientOptions, Subscription, ClientErrorKind |
| `@session-broker/server` | 0.1.0 | `apps/broker` | . → ./src/index.ts | createBrokerServer, BrokerServerOptions, BrokerServer, createBackup, verifyBackup, restoreBackup, BACKUP_FORMAT_VERSION, RESTORE_POLICY, createLogger, redactLogValue |
| `@session-broker/cli` | 0.1.0 | `apps/cli` | . → ./src/index.ts | runCli, renderSystemdUserUnit, assertOutsideWorktrees, escapeSystemdValue, SYSTEMD_UNIT_NAME, SESSION_BROKER_ENV_FILE_NAME |
| `@session-broker/omp-adapter` | 0.1.0 | `packages/omp-adapter` | . → ./src/index.ts | createOmpAdapter, OmpAdapter, OmpAdapterOptions, issueRootProof, IssueRootProofInput, OmpExtensionHost, OmpToolDefinition, OmpToolResult, OmpHostEvent, OmpRunState, OmpSendUserMessageOptions, OmpToolContext, OmpBrokerOps, OmpNativeSnapshot, PendingAskView |

## 2. Trazabilidad de código

- VCS: git; commits: 0; commit declarado: null
- Repo Git inicializado SIN commits: no hay SHA que declarar y no se inventa. La trazabilidad se sostiene en el hash determinista del conjunto fuente (algoritmo y reglas incluidas abajo); un cambio de fuente tras generar el handoff invalida el hash y exige un nuevo gate.

- Algoritmo del source hash: `sha256-canonical-file-manifest-v1`
- Source hash: `sha256:adcda6cfe725cd32b19a5f5ece8b5873cfbe4a2d097df4a205169c9674ca0c04` (archivos incluidos: 120)

Reglas de inclusión del hash:
- package.json, tsconfig.json, bun.lock (si existe) y README.md en la raíz
- packages/<workspace>/{package.json,src/**}
- apps/<workspace>/{package.json,src/**}
- tests/** (suites y harness, incluido tests/handoff)
- scripts/** (verify.ts y utilidades de verificación)
- docs/contracts/**, docs/compatibility/**, docs/operations/**
- ops/** (artefactos operativos de ejemplo)

Reglas de exclusión del hash:
- docs/handoff/** (handoff y evidencia generada: evita autorreferencia)
- .plans/** (planificación, no producto)
- .git/**, node_modules/**, **/dist/**, **/coverage/**
- prompts/** (material de agentes, no determina comportamiento del producto)
- *.tgz y otros empaquetados generados

## 3. Verificación

- Entorno observado: bun 1.4.2, typescript 7.0.2, os linux x64

| id | comando exacto | cwd | exit code observado | notas |
| --- | --- | --- | --- | --- |
| `typecheck` | `bun run typecheck` | `.` | 0 |  |
| `test:protocol` | `bun run test:protocol` | `.` | 0 |  |
| `test:broker` | `bun run test:broker` | `.` | 0 |  |
| `test:cli` | `bun run test:cli` | `.` | 0 |  |
| `test:omp` | `bun run test:omp` | `.` | 0 |  |
| `test:recovery` | `bun run test:recovery` | `.` | 0 |  |
| `verify` | `bun run verify` | `.` | 0 | 7/7 PASS (typecheck + 6 suites) |
| `test:handoff` | `bun run test:handoff` | `.` | 0 | 28 tests, 0 fail |
| `test:handoff-other-cwd` | `bun run --cwd <repo> test:handoff` | `.` | 0 | ejecutado desde /tmp: 28 tests, 0 fail |

| suite | status | tests | failures | skipped | exit code | notas |
| --- | --- | --- | --- | --- | --- | --- |
| tests/protocol | ok | 83 | 0 | 0 | 0 |  |
| tests/broker | ok | 46 | 0 | 0 | 0 |  |
| tests/cli | ok | 63 | 0 | 0 | 0 |  |
| tests/omp | ok | 25 | 0 | 0 | 0 |  |
| tests/recovery | ok | 46 | 0 | 0 | 0 |  |
| tests/handoff | ok | 28 | 0 | 0 | 0 |  |

- Teardown observado: Observado en las suites: TMP con prefijo omp-session-broker-test-* (barrido incluso en fallo vía scripts/verify.ts y afterAll por suite), HOME/XDG/config/data/DB/puertos efímeros, FakeModel que lanza si se invoca, guarda de red (solo loopback).
- Smoke consumidor (fuera del repo): exit 0; relocalización a segundo TMP: exit 0

Artefactos empaquetados observados (bundle hash por corrida):

| archivo | sha256 | bytes |
| --- | --- | --- |
| `vendor/session-broker-protocol-0.1.0.tgz` | `a8489268f2d762a21542088cc954269902b81e0c7f8dad04ec2860bafb1eb53d` | 30783 |
| `vendor/session-broker-client-0.1.0.tgz` | `37f63f78f4911b5e70dba76db81a2a585e12b293d46c1817b970d2e413d654e6` | 9587 |
| `vendor/session-broker-server-0.1.0.tgz` | `c9619902e6685de03c48a70edc194b230561f0aa18aae789fbe9da3ab22c89b0` | 40107 |
| `vendor/session-broker-cli-0.1.0.tgz` | `90d963ab009672031af6ad690d535eafefdcfdc23a9748e5ce2b0cff17cd8949` | 16523 |
| `vendor/session-broker-omp-adapter-0.1.0.tgz` | `3a9039a33859ee3d2bab4b50ba4caca0ac64e9f619918311a151b787d5cf43c2` | 19185 |

## 4. Capacidades y limitaciones

- Versión OMP evidenciada: omp v18.3.1 (binario) con fuentes pi-coding-agent 18.3.1

| capability | estado | evidencia |
| --- | --- | --- |
| `session.identity` | supported | tests/omp/root-binding.test.ts; docs/compatibility/omp-api-matrix.md §A1 |
| `session.observe` | supported | tests/omp/reads-observation.test.ts (contador de inferencia 0); §A2 |
| `session.prompt.when_idle` | supported | tests/omp/ask-reply.test.ts; §A3 (idle→sendUserMessage, ocupado→deliverAs followUp) |
| `session.reply_tool` | supported | tests/omp/ask-reply.test.ts (session_reply con replyTo=requestId); §A4 |
| `root.binding` | supported | tests/omp/root-binding.test.ts (claims heredados denegados); §A5 |
| `session.notify` | partial | solo tema reservado broker.session.status (runState); §A7 |
| `session.control.prompt` | unsupported | §A8: sin mapping verificado; UNSUPPORTED_CAPABILITY antes de efectos |
| `session.control.steer` | unsupported | §A8; tests/omp/unsupported.test.ts |
| `session.control.follow_up` | unsupported | §A8; tests/omp/unsupported.test.ts |
| `session.control.abort` | unsupported | §A8; tests/omp/unsupported.test.ts |

Limitaciones declaradas:
- El binding root y la entrega when_idle se verifican contra puertos estructurales de la API OMP con FakeOmpHost + fake model; un shim de producción corriendo sobre un OMP vivo queda fuera del DoD (exigiría G-BROKER-LIVE)
- session.control.* y notify con temas arbitrarios quedan unsupported: no existe mapping nativo verificado sin fallback
- No se garantiza exactly-once externo: los resultados inciertos quedan en outcome_unknown y exigen reconciliación explícita (durability.md)

El core ask/reply (`session.prompt.when_idle` + `session.reply_tool` + `root.binding`) se declara cubierto SOLO con evidencia de herramienta explícita `session_reply` (`replyTo = requestId`): ni `agent_end` ni el siguiente texto del modelo completan un ask. `presence` ≠ `request state` ≠ `job status` nativo, y `session.control.*` queda `unsupported` explícito.

## 5. Consumo reproducible offline/local

- 1. Copiar las fuentes de los cinco workspaces al snapshot (src/ + package.json; sin node_modules, dist ni salidas generadas) bajo un TMP fuera del repo.
- 2. Normalizar en el snapshot las specs internas `workspace:*` a la versión concreta publicada en cada manifest (0.1.0): el consumidor no depende de npm publicado.
- 3. Empaquetar cada workspace con `bun pm pack` (corre en tiempo de test) y dejar los tarballs relativos en `snapshot/vendor/` con los nombres canónicos.
- 4. `consumer-smoke/package.json` referencia los cinco tarballs con specs RELATIVAS `file:../vendor/<nombre>.tgz` (mismas specs en `overrides` para las dependencias transitivas).
- 5. `bun install --offline` dentro de `consumer-smoke/` (HOME/XDG/BUN_INSTALL_CACHE_DIR efímeros): resuelve solo rutas relativas, sin registro npm.
- 6. Ejecutar `bun test smoke.test.ts` en `consumer-smoke/`: importa SOLO exports públicos de los cinco paquetes y compone createBrokerServer + createClient + createOmpAdapter/issueRootProof con FakeOmpHost y fake model.
- 7. Repetir el smoke tras copiar bundle+consumidor a un SEGUNDO TMP (relocalización): sin editar el monorepo y sin rutas absolutas de esta máquina en ningún manifest.

Layout del snapshot:

```text
snapshot/package.json          # @session-broker/handoff-snapshot (private, workspaces packages/* + apps/*)
snapshot/packages/{protocol,client,omp-adapter}/{package.json,src/**}
snapshot/apps/{broker,cli}/{package.json,src/**}
snapshot/vendor/session-broker-{protocol,client,server,cli,omp-adapter}-0.1.0.tgz
snapshot/consumer-smoke/package.json   # deps file:../vendor/*.tgz (relativas)
snapshot/consumer-smoke/smoke.test.ts  # consumidor externo: solo exports públicos
```

- El adaptador se reutiliza TAL CUAL (`@session-broker/omp-adapter` desde los tarballs): el consumidor no reimplementa el bridge OMP, no toca `packages/omp-adapter` y no pide al monorepo rehacer nada. El binding con el runtime real (shim de extensión sobre la API pública OMP) queda fuera de este handoff y es integración futura declarada.

Prohibiciones verificables:
- Sin imports privados: solo los export maps públicos (`.` y `./fixtures` del protocolo); prohibido `@session-broker/*/src/...`.
- Sin dependencias con rutas absolutas de esta máquina en manifests del consumidor: prohibido el esquema `file:` con ruta absoluta o con tres barras, y los symlinks absolutos.
- Sin `npm publish`, registro npm, red externa ni `bun add`/`bun install` con red: el consumo es offline con artefactos locales.
- Sin secretos (credenciales, MAC keys) en el snapshot, el consumidor ni el handoff.

Bundle hash (mismos artefactos de la sección 3):

| archivo | sha256 | bytes |
| --- | --- | --- |
| `vendor/session-broker-protocol-0.1.0.tgz` | `a8489268f2d762a21542088cc954269902b81e0c7f8dad04ec2860bafb1eb53d` | 30783 |
| `vendor/session-broker-client-0.1.0.tgz` | `37f63f78f4911b5e70dba76db81a2a585e12b293d46c1817b970d2e413d654e6` | 9587 |
| `vendor/session-broker-server-0.1.0.tgz` | `c9619902e6685de03c48a70edc194b230561f0aa18aae789fbe9da3ab22c89b0` | 40107 |
| `vendor/session-broker-cli-0.1.0.tgz` | `90d963ab009672031af6ad690d535eafefdcfdc23a9748e5ce2b0cff17cd8949` | 16523 |
| `vendor/session-broker-omp-adapter-0.1.0.tgz` | `3a9039a33859ee3d2bab4b50ba4caca0ac64e9f619918311a151b787d5cf43c2` | 19185 |

## 6. Operación y gates

- Rutas config/data: Config de usuario (`$XDG_CONFIG_HOME/session-broker/config.json`, permisos 600) y data del broker (`$XDG_DATA_HOME/session-broker`, fuera de worktrees; grants solo por `credentialHash` sha256). Journal de recibos del adaptador en user data. Nada de esto vive en el checkout ni se versiona.
- Backup/restore: Backup por `VACUUM INTO` (`createBackup`/`verifyBackup`/`restoreBackup` de `@session-broker/server`); el restore es conservador: sin `grants.json` (fail-closed, reautorización explícita), leases invalidados, `control_epoch` incrementado, writer lock NO heredado, ledger de root proofs íntegro y `outcome_unknown` conservado tal cual.
- Inferencia real: ausente (fake model que lanza si se invoca)
- Activación de servicio: ausente (solo artefactos de ejemplo y service manager fake)

| gate | estado | nota |
| --- | --- | --- |
| G-BROKER-LIVE | opt-in-out-of-dod | Inferencia/proveedores reales y gasto: opt-in del operador, FUERA del DoD. Ninguna suite ni el consumidor ejecutan inferencia real (fake model que lanza si se invoca). |
| G-BROKER-SERVICE | opt-in-out-of-dod | Servicio systemd user persistente: opt-in del operador, FUERA del DoD. Solo artefactos de ejemplo en `ops/systemd/` y service manager fake en tests; nada instalado/habilitado/arrancado. |

Evidencia NO realizada (enumerada honestamente):
- G-BROKER-LIVE: no se ejecutó inferencia real ni se contactó proveedores (fake model en todas las suites)
- G-BROKER-SERVICE: no se instaló/habilitó/arrancó ningún servicio (fixtures y service manager fake)
- En el momento del gate: sin commit ni publicación npm ni integración con el monorepo maestro (trazabilidad por source hash)

## 7. Trazabilidad requisitos → suite → resultado

| requisito | título | suites | resultado | notas |
| --- | --- | --- | --- | --- |
| FR-001 | Broker standalone y genérico | broker, cli | pass | servidor único y clientes outbound; fixtures multi-dominio en tests/broker |
| FR-002 | Proyecto, checkout y configuración | cli | pass | init idempotente con projectId versionado y workspaceId local |
| FR-003 | Identidad lógica y bootstrap raíz | omp, broker | pass | root binding no heredable verificado con claims heredados denegados |
| FR-004 | Autenticación, grants y control | broker | pass | grants scoped + controlEpoch con fencing probado |
| FR-005 | Consultas sin inferencia | broker, cli | pass | lecturas sin inferencia (contador 0) y presencia≠request≠job status |
| FR-006 | Mensajes y control correlacionados | protocol, broker, cli, omp | pass | ask/reply correlacionado con replyTo vía herramienta explícita; agent_end/next-text no completan |
| FR-007 | Persistencia, deduplicación e incertidumbre | protocol, broker, omp, recovery | pass | dedup durable por requestId+hash, outcome_unknown sin replay, crash matrix completa |
| FR-008 | Adaptador OMP nativo | omp | pass | adaptador nativo con TUI preservada y capabilities honestas |
| FR-009 | Recovery y límites | broker, recovery | pass | cursores, backpressure acotado, backup/restore con política conservadora |
| FR-010 | Operación y autoarranque opt-in | recovery | pass | health sin inferencia; generador systemd user sin instalación; guía condicionada a G-BROKER-SERVICE |
| FR-011 | Fronteras públicas y entrega reproducible | cli, handoff | pass | consumidor externo portable con relocalización y handoff validado (test:handoff 26/0) |
| NFR-001 | Seguridad | broker, cli, omp | pass | secretos redactados, permisos, no-filtrado de existencia |
| NFR-002 | Verificación aislada | recovery, handoff | pass | suites aisladas con teardown; verify agrega typecheck + 6 suites y falla ante suites ausentes/vacías |
| NFR-003 | Gobernanza | protocol | pass | gobernanza: coordinador único de estado/journal; workers edit-only |
| NFR-004 | Compatibilidad y límites | protocol, broker | pass | protocolo versionado fail-closed con límites explícitos verificables |

