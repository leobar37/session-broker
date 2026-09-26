---
id: P-004
goal: G-001
title: Adaptador OMP nativo con raíz verificable y TUI preservada
status: completed
owner: coordinator
phase_type: implementation
description: Integrar cliente y broker mediante APIs OMP verificadas, con capabilities explícitas y root binding no heredable sin sustituir la TUI.
end_state: Una raíz OMP fixture se conecta por el cliente público y ejecuta solo capacidades nativas demostradas; hijos heredados no se registran y lecturas no infieren; bun run typecheck y bun run test:omp terminan con exit 0.
verification:
  - "bun run typecheck"
  - "bun run test:omp"
  - "Revisión del coordinador: capabilities y versión OMP tienen evidencia, TUI nativa se preserva y unknown/unsupported nunca activan fallbacks peligrosos"
deliverables:
  - Adaptador público en packages/omp-adapter
  - Harness nativo con modelo falso y pruebas en tests/omp
  - Matriz de compatibilidad OMP actualizada con evidencia de integración
entry_criteria:
  - P-002 y P-003 aceptadas tras reproducir verification; contrato P-001 disponible
  - Matriz OMP vigente y mecanismo de root proof implementable con evidencia
  - Proyección Climier reconciliada antes del claim
dependencies: [P-002, P-003]
requirements: [FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-004 de .plans/omp-session-broker/phases/04-native-omp-adapter.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  adaptador outbound con raíz verificable y TUI nativa. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-004/G-001 en `/home/leobar37/code/broker`: primer adaptador OMP nativo, no motor OMP alternativo ni automatización de la TUI.
- **Éxito observable futuro:** integración servidor/cliente con runtime y modelo falsos prueba root binding, capacidades, correlación de reply y ausencia de inferencia en inspección; typecheck/test:omp exit 0 reproducidos por coordinador.

## Contexto y evidencia disponible

P-001 habrá identificado versión, tipos, exports y lifecycle de la instalación OMP por lectura sin inferencia; P-002 y P-003 aportan broker y cliente aceptados. El adaptador usa esos contratos públicos. Servidor/cliente genéricos no importan OMP; la dependencia nativa queda dentro de `@session-broker/omp-adapter`. Conserva la sesión, TUI e historial de OMP y conecta outbound WS/WSS: no requiere un reemplazo headless ni replica herramientas.

**Confirmado:** ask/reply es comunicación broker entre sesiones, con root proof no heredable, correlación explícita y lecturas sin inferencia. Ask encola prompt nativo seguro when_idle; agente destinatario usa herramienta explícita del adaptador para devolver replyTo=requestId. No resolver preguntas humanas AskUserQuestion/question tool OMP. **Desconocido hasta integración:** API pública exacta de envío/registro tools y mappings opcionales notify/control; verificar matriz instalada. Opcionales sin prueba devuelven unsupported; faltar core bloquea la unidad, no habilita un stub. Esta fase escrita no es ejecución.

## Áreas y ownership futuro

- `packages/omp-adapter/`: exports fijados en P-001, bridge con API nativa, handshake de capacidades, root binding, eventos, correlación y lifecycle cleanup.
- `tests/omp/`: harness con APIs nativas controladas y fake model/transport, fixtures de sesiones raíz/hija, integración con servidor/cliente y contadores de efectos. Demostrar frontera real de tipos/hooks; un mock que repite su propia suposición sin contrastarla con API instalada no basta.
- `docs/compatibility/`: actualizar matriz/versiones/evidencia perteneciente al adaptador, después de coordinar con dueño de P-001; no cambiar contrato congelado unilateralmente.
- `apps/broker`, `apps/cli`, `packages/client`, `packages/protocol`, instalación OMP y maestro externo son read-only. Defectos de otra unidad vuelven a su owner/coordinador. Manifests/lockfile/scripts raíz solo coordinador; no extensiones globales ni dotfiles.

## Contratos a implementar

1. **Root/session/instance — FR-003.** Conectar solo raíz con prueba no heredable P-001; ni environment/cwd/PID/nativeSessionId/sessionRef acreditan raíz. Hijo con environment copiado no consume prueba ni se registra. Reconexión y cambio de nativeSessionId respetan binding/sessionRef; proceso nuevo cambia instanceId sin heredar owner/epoch. Nada de parent env registration ni registrar descendants.
2. **Control scoped — FR-004/NFR-001.** Validar target/sessionRef/instanceId/epoch y permisos según contrato; recibir frame no prueba vigencia. Revocación/takeover quita autoridad pendiente sin afirmar cancelación de efectos ocurridos. Texto remoto no es shell ni instrucción administrativa; grant/secretos nunca forman parte del prompt.
3. **Observación — FR-005/008.** Leer estado, identidad, historial/eventos por hooks/API nativa sin llamar send/prompt/completion. Subscribe no inicia un turno. Presence representa canal/lifecycle, no resultado del trabajo. Preservar TUI y su entrada local, timeline nativo e historial; adapter no escribe eventos falsos para aparentar salida del modelo.
4. **Ask/notify/control — FR-006/008.** Ask es pregunta broker entregada como prompt por API nativa segura con política `when_idle`, sin interrumpir una sesión ocupada ni confundir queued durable con submitted. Revisar permiso/epoch/deadline antes de entregar. Notify/control solo con mapping seguro evidenciado; opcionales ausentes responden unsupported antes de efectos. Nunca teclas/Enter, scraping, nueva sesión, shell o inferencia oculta como fallback.
5. **Herramienta de respuesta broker — FR-006/008.** Registrar por API pública OMP una herramienta explícita para el agente destinatario (nombre fijado P-001, p.ej. `session_reply`) que envía al broker respuesta estructurada con `replyTo=requestId` y autoridad/sessionRef/instanceId válidos. Request pendiente, duplicado, target ajeno, instancia vieja y respuesta tardía tienen semántica congelada. Solo ese reply explícito completa ask: ni `agent_end`, ni siguiente texto, ni finalizar tool ajena son respuesta. No resolver herramientas nativas de preguntas HUMANAS; su API no es requisito ni causa para marcar reply broker unsupported. Si no se puede registrar la herramienta/envío core por API segura, bloquear unidad con evidencia sin emulación ni success stub.
6. **Durabilidad/lifecycle — FR-007.** Estados únicos: queued commit broker, received journal incoming durable, submitted API OMP, completed resultado propio de operación (ask: reply explícito); rejected/failed/expired/cancelled/outcome_unknown. Guardar requestId/recibos según P-001 fuera de worktrees. Presence/request state/job nativo separados, sin scheduler. Caída incierta conserva outcome_unknown, no replay ciego. Restart broker no relanza OMP ni replica tools; cleanup desuscribe recursos sin destruir TUI.
7. **Compatibilidad — NFR-004.** Version/capabilities negociadas con APIs evidenciadas; opcionales ausentes/desconocidas fallan unsupported y core faltante bloquea, no se adivina. Límites/frame/backpressure cumplen P-001 sin bloquear entrada local TUI.

## Criterios binarios y casos failure

- [ ] Fixture raíz válida se registra; hijo con environment completo heredado y otra instancia reutilizando prueba fallan sin autoridad residual.
- [ ] Cambio de nativeSessionId/sessionRef/instanceId/reconexión respeta binding; evento de instancia vieja no recibe reply/control actual.
- [ ] Lecturas y subscribe mantienen contador de llamadas a inferencia en cero; no abren sesiones ni generan turnos con modelo falso.
- [ ] Ask autorizado se encola when_idle y solo pasa a submitted por API nativa al estar permitido; busy no provoca interrupción/fallback; stale epoch/cross-project/deadline impiden efectos.
- [ ] Herramienta explícita envía replyTo=requestId y completa solo ask correlacionado; cubrir duplicado/tardío/target ajeno/instancia vieja. Agent_end, siguiente texto y tool de pregunta humana no completan ask. API core faltante bloquea sin success stub.
- [ ] Notify/control desconocidos se rechazan antes de efectos; jamás teclas, shell o prompt sustituto. El fixture no anuncia más de lo que demuestra la matriz instalada.
- [ ] TUI nativa conserva input local, eventos e historial bajo harness; adapter no modifica internals ni configura OMP globalmente.
- [ ] Restart broker/ACK perdido no relanza OMP ni duplica inferencia/herramientas; outcome_unknown se conserva sin success/failure inventado.
- [ ] Teardown elimina hooks/timers/conexiones; tests bloquean todo proveedor/red externa y config/data reales.

## Validación futura y evidencia pendiente

Scripts **a implementar**: `bun run typecheck` y `bun run test:omp`, exit 0. Solo el **coordinador** ejecuta/reproduce verification al integrar; workers **edit-only**, sin tests, gates, formateadores ni comandos de validación. Preparar harness de broker/cliente reales con runtime/modelo falso, TMP/DB/journals/HOME/config/data aislados, guardas de red/proveedor y teardown. Contrastar firmas/hooks de envío y registro tools con instalación P-001 sin modelo. Harness no representativo implica evidencia pendiente, no live test implícito.

**Evidencia pendiente:** matriz API/versiones, traces redactados de root/ask/reply, counters y outputs/exitcodes, TUI preservada/cleanup. Worker entrega código/pruebas preparadas sin afirmar ejecución; coordinador reproduce verification y registra supported/unsupported/no probado. Core ask/reply no se reduce a capacidad opcional.

## Gobernanza, gates y riesgos

Task `T-BROKER-P004`, initiative `omp-session-broker`, dependencies P-002 y P-003. Ambas deben estar aceptadas; no basta claim o submit. Antes de claim, coordinador reconcilia proyección Climier con frontmatter canónico. Claims/submissions viven en Climier; status/owner y journal solo los escribe coordinador, y workers no autoaceptan.

`G-BROKER-LIVE` (G-LIVE: proveedor/inferencia real/gasto) y `G-BROKER-SERVICE` (G-SERVICE: servicio persistente) son opt-in del operador, distintos de goal G-001 y fuera del DoD. Una smoke real adicional, si se autoriza después, no sustituye el harness determinista ni habilita otras capacidades/gasto. Prohibido tocar monorepo o dotfiles para facilitar integración.

**Riesgos/open questions:** APIs de envío seguro/registro de herramienta explícita, root proof y preservación TUI son core: ausencia bloquea solo unidad afectada con evidencia, no se acepta stub. API de responder preguntas humanas está fuera de scope y no afecta reply broker. Drift requiere revisión coordinada, no cambiar OMP upstream ni sustituir por scraping/shell.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-004/G-001; éxito: adaptador nativo con TUI preservada, raíz no heredable y capacidades/reply honestas; typecheck/test:omp exit 0 reproducibles con fake model.
>
> **Rol/objetivo/contexto:** task especialista OMP, skill feature-executor; leer completa `/home/leobar37/code/broker/.plans/omp-session-broker/phases/04-native-omp-adapter.md`, matriz P-001 y P-002/P-003 aceptadas. Ask broker usa prompt nativo when_idle; herramienta explícita registrada por API pública envía replyTo=requestId. No agent_end/texto implícito ni resolver preguntas humanas. Inspección sin inferencia; opcionales notify/control desconocidos devuelven unsupported, core faltante bloquea. Sin shell/teclas/nueva sesión/parent env registration.
>
> **Ownership/validación:** solo `packages/omp-adapter`, `tests/omp` y `docs/compatibility` coordinada; servidor/cliente/protocolo/OMP instalado read-only; raíz/manifests/scripts/lockfile coordinador. Worker **edit-only: no ejecutar tests, gates, formateadores ni validación**; preparar pruebas root/hijos/ask-reply/cero inferencia/no replay. Coordinador reproduce futuros typecheck/test:omp exit 0 en TMP/fake runtime/model. LIVE/SERVICE opt-in fuera DoD; sin pruebas reales implícitas. Reconciliar antes de claim; no frontmatter/journal/autoaccept.
>
> **Scope/findings/STOP:** solo objetivo/ownership; reparar regresiones propias. Hallazgos ajenos intactos: ubicación/fallo/impacto mínimo y causa incierta; no investigar, reparar ni delegar. Bloqueo pausa solo unidad afectada y se escala a coordinador/owner sin tomar control; nadie autoamplía scope. No limpiar/revertir/stage trabajo ajeno. STOP al entregar artefactos/pruebas preparadas; coordinador valida.
>
> **Reporte:** empezar por anchor objetivo/unidad/éxito; archivos/APIs evidenciadas, capabilities, pruebas preparadas y validación pendiente explícita, límites/bloqueos mínimos. No inventar exitcodes ni aceptar core incompleto; coordinador reproduce gate y acepta.
