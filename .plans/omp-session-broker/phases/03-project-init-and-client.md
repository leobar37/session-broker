---
id: P-003
goal: G-001
title: Identidad de proyecto y cliente reutilizable sin dependencia del servidor
status: completed
owner: coordinator
phase_type: implementation
description: Implementar CLI init y cliente público WS/WSS usando mocks del contrato P-001 y ownership separado del broker.
end_state: Init preserva projectId y genera workspaceId local seguro; el cliente y CLI exponen operaciones y errores congelados; bun run typecheck y bun run test:cli terminan con exit 0 usando broker falso y TMP.
verification:
  - "bun run typecheck"
  - "bun run test:cli"
  - "Revisión del coordinador: consumo de exports públicos sin imports internos y sin dependencia de implementación P-002"
deliverables:
  - Cliente reusable en packages/client
  - CLI e init en apps/cli
  - Broker falso y pruebas de cliente/CLI en tests/cli
entry_criteria:
  - P-001 aceptada con exports, schema de identidad, auth, exitcodes y errores congelados
  - Coordinador preparó manifests y scripts raíz; protocolo disponible como contrato estable
  - Proyección Climier reconciliada antes del claim
dependencies: [P-001]
requirements: [FR-001, FR-002, FR-004, FR-005, FR-006, FR-007, FR-011, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-003 de .plans/omp-session-broker/phases/03-project-init-and-client.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  init idempotente y cliente reusable contra broker falso. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-003/G-001: init/CLI y cliente reusable de `/home/leobar37/code/broker`, sin implementar broker ni adaptador.
- **Éxito observable futuro:** fixtures aisladas de identidad/init y cliente público pasan, incluidos errores y exitcodes; typecheck/test:cli exit 0 reproducidos por coordinador sin requerir P-002.

## Contexto y certeza

El broker se consumirá desde proyectos distintos sin depender de Elena ni publicar paquetes. P-001 define `@session-broker/client` y `@session-broker/cli`, schemas y export maps. P-002 implementa el servidor en paralelo; esta fase usa un broker falso conforme al protocolo, nunca imports privados ni suposiciones sobre trabajo incompleto del servidor.

**Confirmado:** `.broker/project.json` versionado representa proyecto; `.broker/workspace.json` local gitignored identifica checkout. DB/journals van en user data fuera de worktrees; endpoints/credenciales, en user config. **Inferido:** identidad/init y API de cliente pueden verificarse con filesystem/transport de fixtures. **Desconocido hasta P-001:** símbolos/signaturas, precedencia exacta de configuración y tabla numérica de exitcodes; aquí se consumen, no se inventan. Los scripts abajo son futuros, no evidencia de implementación actual.

## Áreas y ownership futuro

- `packages/client/`: API pública autenticada, lifecycle WS/WSS outbound, correlación, cancelación local de espera, timeout, reconexión segura, suscripción y errores. No importar SQLite ni APIs OMP.
- `apps/cli/`: init, resolución de config, selección explícita de proyecto/workspace/target, comandos de lectura/ask/reply/notify/control y representación de resultados según P-001. La CLI usa solo exports públicos del cliente/protocolo.
- `tests/cli/`: fake broker de contrato, fixtures de filesystem/checkouts y consumo del cliente; incluye pruebas de librería aunque el script se llame `test:cli`.
- Read-only: `packages/protocol/`, `docs/contracts/`, código/contratos de P-002 cuando se estabilicen. Prohibidos cambios en `apps/broker/`, `packages/omp-adapter/`, monorepo y dotfiles.
- Manifests/lockfiles/scripts/configuración de raíz son exclusivos del coordinador. Modificar `.gitignore` de **fixtures** desde init es parte del test; modificar `.gitignore` real del proyecto broker requiere coordinador. No inicializar Git real ni generar identidad real durante planificación.

## Requisitos y contratos

1. **Init/identidad — FR-002.** Primera inicialización produce schema versionado de proyecto y workspace válido; repeticiones conservan IDs, no duplican reglas ignore ni borran datos. Proyecto preexistente mantiene projectId entre checkouts; cada checkout obtiene workspaceId propio. Probar copia accidental del archivo local, reubicación, colisión y versión incompatible conforme a P-001; no aceptar identidad stale en silencio. Ante JSON corrupto, permisos denegados o write interrumpido, error explícito y ningún archivo parcial que parezca válido. Soportar directorio sin Git sin crear repo; en checkout Git usar política ignore acordada, sin stage/commit. Versionado significa apto para control de versiones, no commit automático.
2. **Separación de configuración — FR-002/NFR-001.** project.json no contiene endpoints, tokens, grants ni rutas privadas. Config del usuario resuelve endpoint/credenciales con precedencia congelada y errores accionables; data path nunca cae silenciosamente al checkout. Init no emite permisos ni registra sesiones OMP. Garantizar permisos de secretos, redacción y ninguna exportación accidental en stdout/stderr/history.
3. **Cliente público — FR-001/011.** Librería reusable por scripts/otros repos sin CLI, globals OMP/Elena ni inicialización de servicios. Exportar exactamente tipos/factories/operaciones fijados en P-001, con disposal y errores tipados. Constructor/import no conecta ni ejecuta inferencia por efecto lateral. CLI solo adapta esas APIs; ningún import a internals del servidor ni dependencia de P-002 para pasar la suite propia.
4. **Lecturas — FR-005.** list/query/inspect/history/subscribe no envían prompts ni crean sesiones; separar presence, estado request y job status nativo. Filtros scoped, paginación, cursor/output estable. Estados de entrega únicos P-001: queued/received/submitted/completed y rejected/failed/expired/cancelled/outcome_unknown. Exit 0 respeta semántica congelada; no ocultar unsupported/outcome_unknown ni errores parciales.
5. **Mutaciones — FR-004/006/007.** Ask broker, reply, notify/control envían grant y epoch requerido con target inequívoco. Reply usa `replyTo=requestId` y autoridad del destinatario; no «última pregunta», next text o agent_end. Cliente reusable permite a herramienta explícita del adaptador responder; no resuelve preguntas humanas OMP. requestId/hash estables ante ACK perdido; no nuevo ID automático. Notify no es prompt implícito; opcionales ausentes devuelven unsupported y auth/epoch no provoca escalada.
6. **Reconexión — FR-007/NFR-004.** Handshake/versiones, timeout, abort de espera, backoff/cursor/shutdown siguen P-001. Abort/timeout no afirma cancelar ejecución remota. Tras ACK perdido consultar requestId original y mostrar estado durable/outcome_unknown; no replay ciego ni relaunch OMP. No ocultar cursor expirado/backpressure con eventos inventados.
7. **Seguridad/isolation — NFR-001/002/003.** Texto remoto no se ejecuta como shell/flags ni modifica config. WSS remoto y política WS explícita; no degradar seguridad automáticamente. Tests bloquean proveedores/red externa y usan HOME/config/data/TMP efímeros con teardown. Credenciales falsas claramente sintéticas.

## Criterios binarios y fallos obligatorios

- [ ] Init repetido es idempotente; projectId sobrevive a dos checkouts y workspaceId difiere; solo project.json es compartible, workspace.json está ignorado.
- [ ] Repo ausente, JSON corrupto, schema futuro, permiso denegado y escritura interrumpida se manejan según contrato sin init Git, sobrescrituras ni secretos expuestos.
- [ ] Importar/instanciar cliente no conecta ni dispara inferencia; todas las funciones públicas pueden consumirse desde fixture externa sin internals/Elena/OMP.
- [ ] Fake broker demuestra autenticación scoped y propagación de epoch; forbidden y stale epoch se presentan como errores, sin retry privilegiado.
- [ ] Ask produce requestId; reply con replyTo erróneo/ambiguo se rechaza; next text/agent_end no completan ask. Notify/control unsupported no se convierten en ask/shell.
- [ ] ACK perdido/reconexión conserva requestId y consulta estado; outcome_unknown visible no genera segunda ejecución ni nuevo ID.
- [ ] Abort/timeout distingue espera de cancelación remota; server offline no implica request ni job nativo fallido/terminado.
- [ ] Pruebas cubren output estable, todos los exitcodes congelados pertinentes, cursor/backpressure/version mismatch y redacción de secretos.
- [ ] test:cli usa exclusivamente broker falso; puede pasar antes de integrar P-002. No test o fixture escribe config/identidad/data reales ni comparte temporales con P-002.

## Validación futura y evidencia pendiente

Scripts **a implementar**: `bun run typecheck` y `bun run test:cli`, exit 0. Solo el **coordinador** ejecuta/reproduce verification al integrar; workers **edit-only**, sin tests, gates, formateadores ni comandos de validación. Preparan broker falso y fixtures TMP/HOME/config/data para cliente/init: archivos/ignore/IDs, redacción/output/exitcodes, contadores y teardown. Nunca init real como prueba.

Coordinador registra scripts/manifests y evita suites concurrentes con P-002. **Evidencia pendiente:** outputs/exitcodes, identidad/retry, consumo público, aislamiento/teardown. Worker entrega pruebas preparadas sin afirmar ejecución; coordinador reproduce `verification` y registra evidencia antes de aceptar.

## Gobernanza y riesgos

Task `T-BROKER-P003` en `omp-session-broker`, dependency P-001; paralela a P-002 y prerequisite conjunto de P-004. Frontmatter canónico y journal son single-writer coordinador; reconciliar proyección Climier antes de claim, usarla para claims/submissions, sin verdad competidora. Worker no cambia status/owner/journal ni autoaccept.

Gates `G-BROKER-LIVE` (G-LIVE: proveedor/inferencia real/gasto) y `G-BROKER-SERVICE` (G-SERVICE: persistencia de servicio) son opt-in del operador, fuera del DoD hijo y distintos de G-001. Esta fase no requiere ni solicita ejecución real para considerarse completa. El maestro externo puede consumir después del handoff verificado, no se edita ni se convierte en dependencia.

**Riesgos:** timeout no equivale a fallo de ejecución; fixture must assert esa diferencia. Un workspace copiado no se arregla regenerando projectId. Si contrato/mocks y servidor divergen, documentar diferencia para coordinador/P-001: no parchar servidor ni cambiar protocolo unilateralmente. Ausencia de credenciales no autoriza inventarlas o leer secretos de otro producto.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-003/G-001; éxito: init/identidades y cliente/CLI público verificados con broker falso, typecheck/test:cli exit 0 reproducibles.
>
> **Rol/objetivo/contexto:** task especialista cliente/CLI, skill feature-executor; leer completa `/home/leobar37/code/broker/.plans/omp-session-broker/phases/03-project-init-and-client.md` y contrato P-001 aceptado. Implementar sin depender del servidor en desarrollo; preservar projectId versionado, workspaceId local ignorado, config/data fuera del checkout, correlación explícita, auth/epoch y retries sin replay ciego.
>
> **Ownership/validación:** solo `packages/client`, `apps/cli`, `tests/cli`; protocolo/servidor read-only; raíz/manifests/lockfile/scripts del coordinador. Worker **edit-only: no ejecutar tests, gates, formateadores ni validación**. Preparar pruebas; coordinador reproduce futuros `bun run typecheck` y `bun run test:cli` exit 0 con broker falso/TMP/HOME/config/data aislados. Sin init Git/identidad real/proveedores/OMP/servicios; LIVE/SERVICE opt-in fuera DoD. Reconciliar antes de claim; no status/owner/journal/autoaccept.
>
> **Scope/findings/STOP:** solo objetivo/ownership; reparar regresiones propias. Hallazgos ajenos intactos con ubicación/fallo/impacto mínimo y causa incierta; no investigar, reparar ni delegar. Bloqueo pausa solo unidad afectada y se escala a coordinador/owner sin apropiarse de archivos; nadie autoamplía scope. No limpiar/revertir/stage trabajo ajeno. STOP al entregar artefactos/pruebas preparadas; coordinador valida.
>
> **Reporte:** comenzar repitiendo anchor objetivo/unidad/éxito; archivos, exports consumidos, pruebas preparadas y validación pendiente explícita, límites/desviaciones/bloqueos mínimos. No inventar exitcodes; coordinador reproduce gate y acepta.
