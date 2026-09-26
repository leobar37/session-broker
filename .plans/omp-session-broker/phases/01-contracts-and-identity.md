---
id: P-001
goal: G-001
title: Contratos públicos e identidad congelados antes del paralelismo
status: completed
owner: coordinator
phase_type: design
description: Investigar las APIs OMP instaladas sin inferencia y fijar una foundation standalone verificable para broker, cliente y adaptador.
end_state: Contrato versionado, matriz OMP con evidencia local y ownership publicados dentro del proyecto; bun run typecheck y bun run test:protocol terminan con exit 0 en aislamiento.
verification:
  - "bun run typecheck"
  - "bun run test:protocol"
  - "Revisión del coordinador: exports, versiones, exitcodes, capacidades OMP y ownership están fijados sin pendientes que bloqueen P-002/P-003"
deliverables:
  - Foundation Bun/TypeScript standalone y contrato en packages/protocol
  - Fixtures deterministas en tests/protocol
  - Decisiones versionadas en docs/contracts y evidencia de APIs instaladas en docs/compatibility
  - Matriz de ownership y exports públicos congelados para cinco paquetes
entry_criteria:
  - Ejecución futura autorizada explícitamente; esta entrega solo prepara planificación
  - Coordinador reconcilió frontmatter canónico y proyección Climier antes de claim
  - Lectura de goal y requisitos locales; no hay prerrequisito del plan maestro
dependencies: []
requirements: [FR-001, FR-002, FR-003, FR-004, FR-006, FR-007, FR-008, FR-011, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-001 de .plans/omp-session-broker/phases/01-contracts-and-identity.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  contratos e identidad verificables antes del paralelismo. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-001 de G-001 en `/home/leobar37/code/broker`: contratos, identidad y foundation, no el broker funcional.
- **Éxito observable futuro:** decisiones y exports consumibles sin ambigüedad por P-002/P-003; fixtures del protocolo y typecheck con exit 0, reproducidos por el coordinador.

## Contexto y certeza

El hijo construirá un broker genérico Bun/TypeScript + SQLite, independiente de Elena, con servidor único y clientes outbound WS/WSS. El primer adaptador conserva la TUI nativa OMP. No se implementa ni ejecuta nada durante la preparación de este plan: los comandos y entregables de esta fase son futuros, no existentes ni aprobados por haber sido escritos aquí.

**Confirmado por el contrato de planificación:** separación proyecto/workspace/instancia/sesión, root binding no heredable, auth por grants de proyecto, durabilidad y handoff local sin publicación. **Inferido:** un protocolo compartido con fixtures evita dependencia circular entre servidor y cliente. **Desconocido hasta esta fase:** versión/exports OMP, APIs de envío nativo when_idle y registro de herramienta explícita de respuesta broker, control y límites cuantitativos. No inventar APIs. Ask/reply es comunicación entre sesiones broker, no resolución de preguntas humanas de una tool OMP.

El maestro `/home/leobar37/.herdr/worktrees/theelena/control-de-caja/.plans/omp-broker-pilot/` es referencia de consumo, no prerrequisito ni superficie editable. Este hijo debe poder completarse sin ejecutarlo.

## Áreas y ownership futuro

| Área | Responsabilidad |
| --- | --- |
| `packages/protocol/` | Tipos, validadores, versión, errores, fixtures de referencia exportables; sin runtime de broker. |
| `tests/protocol/` | Pruebas aisladas del contrato y consumidores falsos; ningún proveedor real. |
| `docs/contracts/` | Contrato público, identidad, estados, garantías, ownership y códigos de salida fijados. |
| `docs/compatibility/` | Matriz de APIs OMP, versión instalada, paths/símbolos/líneas inspeccionados, conocidos/desconocidos y riesgos. |
| Instalación OMP | Solo lectura de archivos, tipos y ayuda que no arranque sesión/modelo; nunca modificación global. |
| Manifests, lockfiles, configuración y scripts de raíz | **Solo coordinador** crea/modifica la foundation y registra scripts acordados. El worker entrega necesidades, no los edita. |

P-001 entrega la especificación de scripts y pruebas, no comandos vacíos que siempre retornen 0. Los paquetes futuros son `@session-broker/protocol` (`packages/protocol`), `@session-broker/client` (`packages/client`), `@session-broker/server` (`apps/broker`), `@session-broker/cli` (`apps/cli`) y `@session-broker/omp-adapter` (`packages/omp-adapter`). P-001 fija esos nombres, sus versiones iniciales, export maps, símbolos/signaturas públicas, dependencias permitidas y consumo local. No se publica en npm. El adaptador es la única frontera autorizada con APIs OMP; el protocolo no depende de OMP/Elena ni de SQLite.

## Contratos a congelar

1. **Identidad y rutas — FR-001/002/003.** `projectId` estable/versionado en `.broker/project.json`; `workspaceId` único por checkout local en `.broker/workspace.json`, ignorado por Git. Una copia de un archivo local no acredita otro checkout: fijar detección de clone/move y regeneración explícita sin sobrescritura silenciosa. `nativeSessionId` identifica la sesión nativa persistible; `sessionRef` la referencia broker con su ámbito explícito; `instanceId` cambia en cada proceso. DB y journals en user data fuera de worktrees; endpoint y credenciales en user config, nunca en archivos versionados. Fijar precedencia, schemas, error ante formato futuro y permisos/redacción.
2. **Root binding — FR-003/008.** Diseñar prueba emitida por un actor local confiable, de uso acotado y ligada al proceso/instancia raíz y su sesión. Environment heredado, PID sin prueba, cwd, IDs o un token reusable en variables no prueban raíz. Subagentes con environment copiado deben fallar registro. Definir expiración, consumo, reconexión de la misma raíz y rebind explícito sin transferir privilegios a otra instancia. Si no se puede justificar una prueba no heredable con APIs disponibles, bloquear únicamente integración root, no inventar un fallback.
3. **Auth — FR-004/NFR-001.** Grants autenticados con scope de proyecto y operaciones; separar lectura, envío y control. IDs son selectores, no credenciales. `controlEpoch` cerca de toda acción mutante debe impedir control obsoleto tras takeover/revoke; fijar renovación, revocación y comparación atómica. WSS para remoto; cualquier WS inseguro requiere una política local explícita. Secretos fuera de logs, fixtures y handoff; mensajes remotos tratados como datos no confiables, no instrucciones administrativas.
4. **Protocolo — FR-006/NFR-004.** Fijar versión, envelopes, `requestId`, `replyTo=requestId`, target/sessionRef/instanceId, capacidades, errores tipados y exitcodes numéricos CLI. Ask encola una pregunta broker como prompt nativo seguro `when_idle`; el agente destinatario responde con una herramienta explícita registrada por API pública OMP (nombre a fijar, p.ej. `session_reply`) que envía reply estructurado al broker. Ni `agent_end` ni siguiente texto implican respuesta. No integrar herramientas de preguntas humanas AskUserQuestion/question tool: fuera de scope. Congelar query/list/inspect/history/subscribe/ask/reply/notify/control y errores invalid input, unauthorized, forbidden, not found, ambiguous target, conflict, unsupported, incompatible version, expired y timeout.
5. **Durabilidad — FR-007.** Dedup autenticado scoped por proyecto + `requestId` y hash canónico de payload/target/operación: mismo ID/hash recupera operación/recibos; hash distinto da conflicto sin efectos. Congelar estados únicos: `queued` = commit durable broker; `received` = journal incoming durable cliente/adaptador; `submitted` = API OMP; `completed` = resultado definido por operación, en ask solo reply explícito; alternos `rejected`, `failed`, `expired`, `cancelled`, `outcome_unknown`. No agregar accepted/delivered como estados competidores. Fijar fronteras transaccionales, TTL/retención y consulta tras reconexión. Presence, request state y job status nativo son distintos; no implementar job scheduler. `outcome_unknown` conserva incertidumbre: jamás reenvío ciego ni garantía exactly-once externo. Reinicio broker no relanza OMP ni replica herramientas.
6. **Capacidades — FR-008.** Matriz por versión OMP: identidad/lifecycle, observación sin inferencia, envío when_idle y registro de herramienta de reply broker como core; notify/control opcionales según mappings seguros. Cada capacidad necesita evidencia; opcionales ausentes/desconocidas devuelven `unsupported`. Si falta core ask/reply/root binding, bloquear la unidad afectada, no aceptar un stub ni redefinir DoD. Mantener TUI e historial nativos; no RPC headless obligatorio, scraping, Enter artificial o shell sustituto. Leer archivos/tipos/help no abre sesiones ni llama proveedores.
7. **Límites — NFR-002/004.** Fijar tamaños máximos de frame/payload/historial, cuotas por grant/proyecto, timeouts, TTL, orden y retención de eventos, cursor, backpressure y presupuesto de recursos con valores verificables. Tests en TMP y fake transport/model con guardas que fallen si se usan proveedores, HOME/config/data reales o red externa.

## Criterios binarios y fallos obligatorios

- [ ] Contrato fija los cinco nombres y exports públicos, versión del protocolo, tabla numérica de exitcodes y ownership antes de abrir P-002/P-003; no queda decisión de esos contratos delegada a ambas ramas.
- [ ] Fixtures válidos se aceptan; versión incompatible, frame excedido, schema malformado y capacidad desconocida se rechazan de forma estable.
- [ ] Fixtures distinguen proyecto, checkout, sesión e instancia; environment heredado y IDs solos nunca satisfacen autenticación/root binding.
- [ ] requestId igual/hash igual y requestId igual/hash distinto tienen semánticas diferentes; `outcome_unknown` no autoriza repetición; ask solo alcanza completed mediante reply explícito, no agent_end.
- [ ] Matriz OMP incluye evidencia local reproducible por lectura y explicita todos los unknown; ningún soporte se afirma por conveniencia.
- [ ] Exports y ejemplos de consumo de protocolo se comprueban realmente con typecheck/pruebas; un paquete vacío o una matriz sin evidencias no cumple.
- [ ] Ningún archivo del monorepo/dotfiles ni runtime OMP/servicio real cambia.

## Validación futura y evidencia pendiente

Scripts **a implementar**: `bun run typecheck` y `bun run test:protocol`, exit 0. Solo el **coordinador** ejecuta/reproduce verification al integrar; workers **edit-only**, sin tests, gates, formateadores ni comandos de validación. Preparan fixtures reales TMP/config/data aislados, fake model, guardas contra proveedores/red externa y teardown. Coordinador registra scripts raíz; no existen por estar descritos aquí. Leer APIs instaladas sin inferencia no requiere G-LIVE.

**Evidencia pendiente:** versión/referencias OMP, contratos/exports/exitcodes, outputs y prueba de aislamiento. No hay ejecución en esta entrega. Worker remite decisiones y pruebas preparadas con validación pendiente; coordinador ejecuta gates, registra evidencia/journal y cambia estado tras reproducir toda `verification`.

## Gobernanza, dependencias y límites

`P-001 -> {P-002, P-003} -> P-004 -> P-005 -> P-006`. Task `T-BROKER-P001` en initiative `omp-session-broker`; sin dependencies. Frontmatter es canónico y, junto con journal, de escritura exclusiva del coordinador. Climier representa claims, submissions y proyección DAG, no una segunda verdad; reconciliar antes de claim. Worker no autoacepta, no cambia status/owner/journal. P-002 y P-003 no se habilitan antes del gate reproducido de esta fase.

Gates opt-in `G-BROKER-LIVE` (semántica G-LIVE: proveedor/inferencia real/gasto) y `G-BROKER-SERVICE` (G-SERVICE: persistencia/instalación de servicio) no se confunden con goal G-001, no son prerrequisitos del DoD aislado, y solo el operador los autoriza explícitamente. Esta fase no requiere ninguno; no provisiona servicios/DB reales, inicializa Git ni publica paquetes.

**Riesgos/open questions:** API drift exige revisar matriz/contrato antes de consumo; capacidad opcional faltante devuelve unsupported. Ausencia de root proof o APIs core de envío/herramienta reply bloquea únicamente la unidad afectada con evidencia, nunca habilita registrar hijos o aceptar un stub. Cambios tras freeze se serializan con coordinador; no se resuelven unilateralmente en ramas paralelas.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-001/G-001; éxito: contrato público, identidad, matriz OMP y foundation verificados con typecheck/test:protocol exit 0, reproducibles por coordinador.
>
> **Rol/objetivo/contexto:** task especialista de contratos; leer skill feature-executor y esta fase completa en `/home/leobar37/code/broker/.plans/omp-session-broker/phases/01-contracts-and-identity.md`. Ejecución solo en sesión futura autorizada. Investigar OMP instalado por lectura sin inferencia; fijar nombres, exports, versiones, exitcodes, límites, auth/root proof, dedup y ownership antes del paralelismo. No implementar servidor/cliente/adaptador ni inventar soporte nativo.
>
> **Ownership y validación:** solo `packages/protocol`, `tests/protocol`, `docs/contracts`, `docs/compatibility`; instalación OMP read-only; raíz/manifests/lockfile/scripts del coordinador. Worker **edit-only: no ejecutar tests, gates, formateadores ni validación**. Preparar fixtures TMP/fake model; coordinador reproduce futuros `bun run typecheck` y `bun run test:protocol` exit 0. Entregar necesidades de raíz sin editarla. Reconciliar antes de claim; no frontmatter/journal/autoaccept. LIVE/SERVICE opt-in fuera DoD, sin proveedores/servicios reales.
>
> **Scope/findings/STOP:** solo objetivo y ownership autorizados; reparar regresiones propias. Hallazgos ajenos intactos: ubicación/fallo/impacto mínimo y causa incierta; no investigar, reparar ni delegarlos. Bloqueo pausa solo unidad afectada y se comunica al coordinador/owner sin tomar control; nadie autoamplía scope. No limpiar/revertir/stage cambios ajenos. STOP al entregar artefactos y pruebas preparadas; coordinador valida.
>
> **Reporte:** comenzar repitiendo anchor objetivo/unidad/éxito; archivos, decisiones/exports, evidencia de lectura, pruebas preparadas y validación pendiente, límites y bloqueos mínimos. No inventar exitcodes ni aceptar fase: coordinador reproduce gate y es único escritor del estado.
