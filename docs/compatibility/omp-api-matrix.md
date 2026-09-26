# Matriz de compatibilidad OMP — APIs instaladas (P-001)

Método: **solo lectura** (`omp --help`, lectura de fuentes/tipos del paquete
instalado, `grep`/`strings` sobre el binario). No se abrió ninguna sesión, no
se llamó a modelos/proveedores, no se modificó nada. Estado por capacidad:
**conocido** (evidencia local reproducible), **desconocido** (sin evidencia
suficiente) o **unsupported** (evidencia de ausencia). **Ningún soporte se
afirma por conveniencia.**

## Versión instalada y artefactos

| Artefacto | Evidencia |
| --- | --- |
| Binario `omp` | `/home/leobar37/.bun/bin/omp` — ELF 64-bit x86-64, 278 107 616 bytes, BuildID `5afca2666bfab8605a934f1b6231dacae0518a5f`, mtime 2025-09-24 23:42 |
| Versión autoreportada | `omp --help` → línea 1: `omp v18.3.1` |
| Paquete JS inspeccionable | `/home/leobar37/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` — `package.json` `version: 17.4.2`, con `src/` y `dist/types/` completos |
| Otros paquetes `@oh-my-pi` | cache `~/.bun/install/cache/@oh-my-pi/`: versiones 16.5.2 / 17.0.7 / 18.1.18 / 18.2.8 de `pi-ai`, `pi-catalog`, `pi-natives`; NO hay fuentes de `pi-coding-agent` 18.x |

> **Drift explícito (unknown #1):** el binario se autoreporta **18.3.1** pero
> las fuentes/tipos disponibles para inspección son de **17.4.2**. Los símbolos
> citados abajo están verificados en 17.4.2 y su presencia física en el binario
> se confirma por conteo de cadenas; la semántica exacta en 18.3.1 debe
> re-verificarse antes de consumirse (P-004). No se asume compatibilidad total.

Conteo de símbolos dentro del binario 18.3.1 (`grep -a -c <símbolo>
/home/leobar37/.bun/bin/omp`): `sendUserMessage` 28, `registerTool` 20,
`deliverAs` 28, `followUp` 92, `getSessionId` 146, `agent_end` 45,
`session_reply` **0**, `queueUserMessage` 0.

## Matriz de capacidades

### 1. Identidad / lifecycle de sesión — **conocido**

| Evidencia (path : símbolo : línea) | Qué prueba |
| --- | --- |
| `…/pi-coding-agent/src/session/session-manager.ts:1946` `getSessionId(): string`; `:1950` `getSessionFile(): string \| undefined` | Identidad de sesión accesible desde el runtime |
| `…/src/session/session-manager.ts:363-364` (`ReadonlySessionManager` incluye `getSessionId`/`getSessionFile`) | Superficie de solo lectura para observación segura |
| `…/src/extensibility/extensions/types.ts:594-600` `ToolSessionEvent {reason:"start"\|"switch"\|"branch"\|"tree"\|"shutdown", previousSessionFile}` y `ToolDefinition.onSession` (mismo archivo, interface `ToolDefinition` línea 604) | Eventos de lifecycle (cambio/branch/shutdown) observables |
| `…/src/extensibility/custom-tools/types.ts:~97-120` `CustomToolSessionEvent` (mismos `reason`, `previousSessionFile`) | Lo mismo para custom tools |
| `…/src/session/session-paths.ts:185-196` `computeDefaultSessionDir(...)` | Dónde viven los archivos de sesión |
| `omp --help`: `--session-dir`, `--no-session`, `-c/--continue`, `-r/--resume=<ID>`, `--export` | Lifecycle gestionable por CLI |

### 2. Observación sin inferencia — **conocido**

| Evidencia | Qué prueba |
| --- | --- |
| `…/src/extensibility/extensions/types.ts:1240-1281` `ExtensionAPI.on(event, handler)` para `agent_start`, `agent_end`, `message_start/update/end`, `tool_execution_start/update/end`, `turn_start/end`, `session_*`, `context` | Stream de eventos observable sin tocar el modelo |
| `…/src/session/agent-session.ts:3734` `subscribe(listener): () => void`; `:3750` `subscribeRunState(listener: (state:"running"\|"idle") => void)` | Suscripción a estado (`idle`) e historia |
| `…/src/extensibility/extensions/types.ts:455-550` `ExtensionContext.isIdle()`, `hasPendingMessages()` (líneas ~477-483) | Estado observable desde herramientas/extensiones |
| `…/src/extensibility/custom-tools/types.ts:95-101` `CustomToolContext.isIdle()`, `hasQueuedMessages()`, `abort()` | Ídem para custom tools |

Nota: leer eventos/estado no dispara inferencia. Modo RPC existe
(`--mode rpc|json`; `…/src/jsonrpc/message-framing.ts`) pero **no es
obligatorio** y su alcance es **desconocido** para este contrato.

### 3. Envío de prompts `when_idle` — **conocido con mapping pendiente de verificación en runtime**

| Evidencia | Qué prueba |
| --- | --- |
| `…/src/extensibility/extensions/types.ts:1417-1421` `sendUserMessage(content, options?: {deliverAs?: "steer" \| "followUp"}): void` — doc: *"Send a user prompt: idle starts a turn; streaming queues as steer unless deliverAs is set"* | API de envío de prompt; con agente idle inicia turno |
| `…/src/extensibility/extensions/types.ts:1405-1413` `sendMessage(message, options?: {triggerTurn?: boolean; deliverAs?: "steer"\|"followUp"\|"nextTurn"})` | Entrega diferida sin interrumpir |
| `…/src/session/agent-session.ts:5509-5510` (`streamingBehavior === "followUp"` → `#queueUserMessage(...)`), `:6145-6162` (`#queueUserMessage(..., mode:"steer"\|"followUp")`), `:6367-6391` (`deliverAs === "followUp"`) | `followUp` encola hasta terminar el turno en curso |
| `…/src/extensibility/extensions/types.ts:555` `ExtensionCommandContext.waitForIdle(): Promise<void>` | Espera de idle |
| `…/src/session/agent-session.ts:5444` `async prompt(text: string, options?): Promise<boolean>` | Punto de entrada de prompt |

**Mapping propuesto (P-004 debe verificarlo contra 18.3.1):**
`ask` → si `isIdle()` entonces `sendUserMessage(pregunta)`; si no,
`sendUserMessage(pregunta, {deliverAs: "followUp"})` (entrega al quedar idle =
`when_idle`, sin interrumpir). La literal `when_idle` **no existe** en las
fuentes (`grep whenIdle\|when_idle` → 0 hits): es nombre de política del broker,
no de OMP.

### 4. Herramienta explícita de respuesta (`session_reply`) — **conocido (registro), nombre propio**

| Evidencia | Qué prueba |
| --- | --- |
| `…/src/extensibility/extensions/types.ts:1285` `registerTool<TParams, TDetails>(tool: ToolDefinition<…>): void`; impl `…/src/extensibility/extensions/loader.ts:179` | API pública de registro de herramientas |
| `…/src/extensibility/extensions/types.ts:602-660` `ToolDefinition` (`name`, `description`, `parameters`, `execute(toolCallId, params, signal, onUpdate, ctx)`, `onSession`) | Forma de la herramienta que responderá el agente |
| `…/src/extensibility/custom-tools/types.ts:1-120` (`CustomToolAPI`, `CustomToolContext`, `CustomToolSessionEvent`) | Alternativa de custom tools con acceso a `isIdle()`/`abort()` |
| Binario 18.3.1: `registerTool` 20 ocurrencias; `session_reply` **0** | El registro existe en el binario; `session_reply` NO es builtin: lo registra el adaptador |

El nombre `session_reply` queda fijado como herramienta del broker (registrable
por esta API). **No** se integran herramientas de preguntas humanas
(AskUserQuestion/question tool): fuera de scope.

### 5. notify / control (opcionales) — **desconocido / candidato; no se declara soporte**

| Candidato de mapping | Evidencia | Estado |
| --- | --- | --- |
| `control.steer` → `sendUserMessage(..., {deliverAs:"steer"})` | types.ts:1417-1421; agent-session.ts:6367-6391 | candidato; semántica de interrupción por verificar |
| `control.follow_up` → `{deliverAs:"followUp"}` | agent-session.ts:5509-5510 | candidato |
| `control.prompt` → `sendUserMessage(...)` con idle | types.ts:1417-1421 | candidato |
| `control.abort` → `ExtensionContext.abort()` / `CustomToolContext.abort()` | types.ts:~483; custom-tools/types.ts:~101 | candidato; abort = cancelación pedida, NO rollback (semántica por verificar) |
| `notify` → `appendEntry(customType, data)` («not sent to LLM») o `sendMessage(..., {triggerTurn:false})` | types.ts:1423-1425; 1405-1413 | candidato |

Hasta verificar en runtime (P-004, con API fake), estas capacidades se declaran
**`unsupported`** y responden `UNSUPPORTED_CAPABILITY`; jamás fallback
silencioso.

### 6. Root binding (prueba no heredable) — **desconocido a nivel de API nativa**

| Evidencia | Qué prueba |
| --- | --- |
| `omp --help`: `--hook`, `-e/--extension`, `--no-extensions` | El adaptador puede cargarse en proceso |
| `…/src/sdk.ts:696-758` `discoverExtensions`, `discoverSessionExtensionPaths`, `loadSessionExtensions` | Carga de extensiones dentro del proceso de sesión |
| `grep` en fuentes 17.4.2: sin primitiva de attestation de proceso (tipo credenciales de par de socket) | **No hay API OMP de attestation** (unknown #2) |

Conclusión honesta: el actor local confiable puede ser la extensión en proceso
(posesión de MAC key + emisión ligada al challenge), pero **la no-heredabilidad
no la garantiza OMP**; debe sustentarse en memoria en proceso + challenge de un
solo intercambio y verificarse en P-004. Si no puede justificarse, se bloquea
**únicamente** la integración root (capacidad `root.binding`), sin fallback.

## Unknowns explícitos (nº total: 5)

1. **Drift 18.3.1 vs 17.4.2**: semántica exacta de los símbolos citados en el binario 18.3.1.
2. **Attestation**: ausencia de primitiva de prueba de proceso en la API OMP.
3. **`when_idle` literal**: inexistente; mapping a `sendUserMessage`/`followUp` pendiente de verificación en runtime.
4. **Semántica de abort/steer** (interrupción vs cancelación; rollback imposible) sin verificar.
5. **Alcance del modo RPC/ACP** (`--mode rpc`, `src/jsonrpc/`, `src/modes/acp/`): canal opcional no evaluado; el contrato no depende de él.

## Cómo reproducir esta evidencia (solo lectura)

```bash
# Versión y flags (no abre sesión)
/home/leobar37/.bun/bin/omp --help | head -3

# Fuentes/tipos instalados (paquete JS)
PKG=/home/leobar37/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent
grep -n "getSessionId\|getSessionFile" $PKG/src/session/session-manager.ts
grep -n "registerTool\|sendUserMessage\|deliverAs\|ToolDefinition" $PKG/src/extensibility/extensions/types.ts
grep -n "followUp\|#queueUserMessage\|async prompt(" $PKG/src/session/agent-session.ts
grep -rn "whenIdle\|when_idle" $PKG/src   # (0 hits)

# Presencia física de símbolos en el binario 18.3.1
for s in sendUserMessage registerTool deliverAs followUp getSessionId agent_end session_reply; do
  printf '%s: ' "$s"; grep -a -c "$s" /home/leobar37/.bun/bin/omp
done

# Fuentes 18.3.1 (AÑADIDO en P-004; ver capa de integración abajo)
SRC18=/home/leobar37/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.3.1@@@1/src
grep -n "sendUserMessage\|registerTool\|isIdle\|abort\|appendEntry" $SRC18/extensibility/extensions/types.ts
grep -n "deliverAs === \"followUp\"\|async sendUserMessage" $SRC18/session/agent-session.ts
sed -n 393,399p $SRC18/session/agent-session-types.ts   # SendUserMessageOptions
```

---

# Capa de integración (P-004) — implementación del adaptador

Esta sección **añade** la capa de integración sobre la evidencia previa de
P-001 (que se conserva íntegra arriba). Quién consume qué: `@session-broker/omp-adapter`
(`packages/omp-adapter/src/ports.ts`, `adapter.ts`) y los fixtures de
`tests/omp/**` (fake host estructural + FAKE MODEL + broker/cliente reales).

## A1. Actualización del drift (unknown #1): fuentes 18.3.1 disponibles

El cache de Bun ahora contiene **`pi-coding-agent@18.3.1@@@1`** con `src/`
completo (`~/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.3.1@@@1`), la
misma versión que se autoreporta el binario `omp v18.3.1`. Los símbolos
citados por P-001 se **re-verificaron uno a uno contra 18.3.1**:

| Símbolo | 17.4.2 (instalado) | 18.3.1 (cache, versión del binario) |
| --- | --- | --- |
| `ExtensionAPI.on(event, handler)` | `extensibility/extensions/types.ts:1240-1281` | `types.ts:~1277-1317` (mismos eventos) |
| `registerTool(tool)` | `types.ts:1285` | `types.ts:1322` |
| `sendUserMessage(content, options?)` | `types.ts:1418-1421` | `types.ts:1461` (usa `SendUserMessageOptions`) |
| `SendUserMessageOptions` | inline `{deliverAs?: "steer"\|"followUp"}` | `session/agent-session-types.ts:393-399`: `{deliverAs?: "steer"\|"followUp"\|"aside"}` |
| `isIdle()` / `abort()` / `hasPendingMessages()` | `types.ts:481/483/485` | `types.ts:455/457/459` |
| `getSessionId()` / `getSessionFile()` | `session/session-manager.ts:1946/1950` | `session/session-manager.ts:2541/2545` |
| `subscribe` / `subscribeRunState` | `session/agent-session.ts:3734/3750` | `session/agent-session.ts:4724/4749` |
| `ToolDefinition.execute/onSession` | `types.ts:602-660` | `types.ts:611-660` |
| `AgentToolResult` | (pi-agent-core) | `pi-agent-core@18.3.1/src/types.ts:952-964` |

Drift residual honesto: la semántica en RUNTIME del binario sigue sin probarse
en vivo (la fase no ejecuta OMP ni inferencia); la verificación es a nivel de
fuentes de la misma versión + presencia de símbolos en el binario.

## A2. Mapping `when_idle` verificado (§3) — `session.prompt.when_idle` = supported

Evidencia 18.3.1 (`session/agent-session.ts:8083-8140`, doc + implementación):

- `sendUserMessage(q)` (sin `deliverAs`): *"Omitted `deliverAs` starts a turn when
  idle and queues as a steer while streaming"* → **idle: inicia turno**.
- `sendUserMessage(q, {deliverAs: "followUp"})`: `#queueUserMessage(text, images,
  "followUp", …)` → *"Explicit `deliverAs` queues without starting a turn in
  either state"* → **ocupado: cola nativa hasta el fin del turno, sin
  interrumpir jamás**.

Mapping EXACTO implementado por el adaptador (`adapter.ts`, `#deliverAsk`):

```text
host.isIdle()  →  host.sendUserMessage(question)                        // inicia turno
!host.isIdle() →  host.sendUserMessage(question, {deliverAs:"followUp"}) // cola, sin interrupción
```

`queued` (commit broker) → `received` (journal incoming) → `submitted`
(SOLO tras la llamada nativa) → `completed` (SOLO reply explícito).
`when_idle` es literal del broker, no de OMP (P-001 §3, sin cambios).

**Límite residual declarado:** la API documentada no permite cerrar la ventana
entre `isIdle()` y la llamada; si un turno arranca exactamente en esa ventana,
el camino interno del runtime es `steer`. El harness es determinista y cubre los
dos estados; el residuo se documenta como riesgo conocido (no se resuelve con
teclas, scraping ni shell).

## A3. `session_reply` por `registerTool` (§4) — `session.reply_tool` = supported

- Registro por API pública `registerTool` (`types.ts:1322`); forma de
  `ToolDefinition` (`types.ts:611-660`: `name`, `description`, `parameters`,
  `execute(toolCallId, params, signal, onUpdate, ctx)`, `onSession`).
- Nombre congelado `session_reply` (0 ocurrencias en el binario: NO es builtin).
- `execute` envía `reply {replyTo, body, summary?}` con `replyTo = requestId`
  exacto por la conexión **registrada** (el broker exige `peer.bound` en
  `#runReply`, `apps/broker/src/server.ts`). Semántica antes de efectos:
  pendiente → envía; duplicado → `INVALID_INPUT/terminal_state`; tardío →
  `EXPIRED/deadline_out_of_bounds`; ajeno/desconocido →
  `NOT_FOUND_OR_FORBIDDEN/unauthorized_scope`; instancia vieja →
  `STALE_INSTANCE/stale_instance` (o error del broker, mismo resultado).
- `agent_end` / siguiente texto: observados por hooks, **0 transiciones**
  (clasificación congelada `classifyAskCompletion`); herramientas de preguntas
  humanas fuera de scope (no se integran).
- `parameters` viaja como objeto JSON-schema desde el adaptador; el shim real de
  binding (fuera de esta fase) puede envolverlo en el TSchema del runtime.

## A4. Root binding no heredable (§6) — `root.binding` = supported con justificación

OMP **no** tiene primitiva de attestation de proceso (unknown #2 de P-001 se
mantiene). La no-heredabilidad se sustenta en (todo verificable/verificado por
`tests/omp/root-binding.test.ts`):

1. **MAC key fuera de la superficie heredable**: vive en configuración de
   usuario, entra por argumento explícito a `issueRootProof` y jamás se
   persiste, loguea ni exporta en environment/argv/archivos de worktree. Un
   hijo con environment copiado no puede emitir pruebas.
2. **Claims no-probados denegados por contrato**: `evaluateRootBindingClaim`
   (`@session-broker/protocol`) deniega SIEMPRE environment/PID/cwd/IDs/token
   (`root_claim_not_proven`); el adaptador solo emite `{kind:"root_proof", proof}`.
3. **Prueba de un solo intercambio**: ligada a `(instanceId, nativeSessionId,
   challenge=welcome.serverChallenge, audience=welcome.connectionId)`, TTL ≤
   300 000 ms y `proofId` de uso único. Una prueba copiada a otra conexión cae
   en `root_proof_challenge_mismatch`; la de otra instancia/sesión en
   `root_proof_subject_mismatch`; re-registro exige reconectar (el challenge
   rota tras cada bind) con prueba nueva.
4. **Proceso nuevo**: `instanceId` nueva por proceso (nunca heredada de
   environment); el broker incrementa `control_epoch` en cada
   registro/takeover (`store.registerSession`) sin heredar owner/epoch.

## A5. `notify` / `control` (§5) — alcance exacto

| Capability | Estado | Evidencia / mapping |
| --- | --- | --- |
| `session.notify` | **supported solo para el tema reservado** `broker.session.status` (data `{runState}` con valores `idle`\|`busy`) | Convención INTEROP (docblock `apps/broker/src/server.ts`, handlers `#declareRunState`/`#runSend`); NO requiere API nativa. Es el mapping de §5 verificado. |
| `session.notify` (temas arbitrarios) | **unsupported** | Sin mapping nativo verificado (`appendEntry`/`sendMessage` siguen siendo candidatos 17.4.2, no probados): el adaptador reporta el request como `rejected` + `UNSUPPORTED_CAPABILITY` ANTES de cualquier efecto nativo. |
| `session.control.prompt/steer/follow_up/abort` | **unsupported** | Semántica de interrupción/abort sin verificar (unknown #4); el adaptador NO anuncia estas capacidades y responde `UNSUPPORTED_CAPABILITY` antes de efectos (ni `abort()`, ni `sendUserMessage`, ni teclas). |

El fixture (`tests/omp`) anuncia exactamente: `session.identity`,
`session.observe`, `session.prompt.when_idle`, `session.reply_tool`,
`session.notify`, `root.binding` — y el test lo verifica contra el registro
broker (`inspect().capabilities`).

## A6. Puertos estructurales y preservación de la TUI

- `packages/omp-adapter/src/ports.ts` modela por INYECCIÓN la API pública OMP
  (tabla A1); el paquete jamás importa el host global ni sus privados. Un shim
  en proceso (extensión cargada en la sesión nativa, `omp -e/--extension`) será
  quien implemente los puertos con la API real; **ese binding no se construye en
  P-004** (sin runtime real ni inferencia) y queda como integración futura.
- El adaptador NO escribe eventos falsos de modelo, NO usa teclas/Enter, NO
  scraping/shell, NO segunda sesión, NO reemplaza la TUI: la única escritura
  nativa es `sendUserMessage` (entrega legítima de un `ask`) y el registro de
  `session_reply`. `tests/omp/reads-observation.test.ts` verifica input local,
  timeline e historial intactos bajo harness.
- Lecturas sin inferencia: `on(...)`/`isIdle`/`getSessionId`/`getSessionFile`/
  `subscribeRunState`; `subscribe` (broker) no inicia turnos; presencia
  (bind_root/cierre + lastSeenMs) ≠ estado de trabajo (runState).

## A7. Durabilidad y lifecycle del adaptador

- Journal de recibos en **user data** (`OmpAdapterOptions.dataDir`, fuera de
  worktrees): `<dataDir>/omp-adapter-receipts/<target>__<session>.json`; sin
  credenciales ni MAC keys.
- Ventana de crash: `submitting` (marcador persistido justo antes de la llamada
  nativa) → `outcome_unknown` + `crash_window` al recuperar; jamás replay ciego.
  `received` sin marcador ⇒ llamada nativa provablemente no hecha ⇒ reanudación
  segura una sola vez (guarda `#inFlight`).
- Restart del broker no relanza OMP ni replica herramientas (`registerTool`
  una sola vez por proceso); ACK perdido de un reply ⇒ `outcome_unknown` local,
  sin reintento. `cleanup`/`stop()` desuscribe hooks y cierra sockets sin tocar
  la TUI (`tests/omp/lifecycle.test.ts`).

## A8. Dependencias y desviación declarada del freeze

`docs/contracts/packages.md` fija para `@session-broker/omp-adapter` como
dependencia runtime permitida `@session-broker/protocol` (+ tipos OMP del host).
La delegación de P-004 exige además **`@session-broker/client`** para el canal
auxiliar (lecturas/`subscribe`/`ask`/`notify` salientes). La dependencia está
declarada en `packages/omp-adapter/package.json` (ambas workspace, sin deps
externas) y esta desviación queda **expuesta al coordinador** para serializarla
en el freeze o retirarla. Notas de wiring observadas:

- El `hello` congelado del cliente NO declara `nativeSessionId`; para operar
  sobre sesiones con scope `sessions` acotado, el grant del canal auxiliar debe
  permitir `sessions: "*"` (fail-closed del handshake). Las operaciones core
  (registro, `reply`, runState) viajan por el canal holder del adaptador y no
  dependen de esto.
- `bind_root`/`report` no existen en la superficie congelada del cliente; el
  adaptador los emite por su canal holder (`packages/omp-adapter/src/channel.ts`,
  privado) respetando el interop arbitrado (frames del docblock de
  `apps/broker/src/server.ts`).

## A9. Evidencia pendiente de validación (P-004)

`bun run typecheck` y `bun run test:omp` quedan preparados (suites
`tests/omp/*.test.ts`) y **PENDIENTES de ejecución por el coordinador** (los
workers son edit-only). Ningún resultado de ejecución se afirma aquí.
