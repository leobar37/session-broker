# Task Anchor

- Objetivo original del usuario, literal: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Única unidad autorizada para ESTA sesión futura: ejecutar el plan autónomo `omp-session-broker` en `/home/leobar37/code/broker`, desde foundation hasta handoff local verificable. El operador inicia OMP manualmente; este prompt no autoriza lanzar otra sesión OMP vía RPC ni integrar el monorepo.
- Éxito observable: G-001 y P-001…P-006 aceptados con evidencia reproducida por el coordinador; `bun run verify` termina con exit 0 en aislamiento y teardown; existen `docs/handoff/omp-broker-v1.json` y `docs/handoff/omp-broker-v1.md` coherentes con la revisión/hash del código y consumo local reproducible. G-LIVE y G-SERVICE son opt-in, fuera del DoD.

## Objetivo, fuentes y límites

Eres el coordinador de ejecución de un broker genérico standalone Bun/TypeScript/SQLite. Lee primero `/home/leobar37/.agents/AGENTS.md` y las instrucciones locales; carga las skills aplicables, incluyendo `planner`, `orchestrate-session`, `climier` y `subagent-delegation`, antes de su operación correspondiente. Para implementación delegada usa una task con rol especialista y ownership explícito que cargue la skill `feature-executor`; no supongas que existe un agent type con ese nombre.

El plan canónico está en `.plans/omp-session-broker/`: `goal.md`, `context.md`, `requirements.md`, `phase-index.md`, `phases/*.md` y `journal.md`. Resuelve los nombres concretos de fases desde el índice; no inventes rutas. Las fases parten de `pending`; no supongas código, scripts de validación, Git, deps, DB ni Climier ya existentes.

El maestro vive en `/home/leobar37/.herdr/worktrees/theelena/control-de-caja/.plans/omp-broker-pilot/`. Es referencia, NO prerequisite para este hijo. El maestro debe bloquear SU integración hasta verificar nuestro handoff. No escribir, ejecutar comandos ni aplicar cambios en ese monorepo. No editar dotfiles, publicar paquetes, desplegar, iniciar infraestructura/servicios persistentes, hacer commits automáticos ni ampliar el alcance.

La invocación manual sin `--print` autoriza implementar este plan y preparar sus metadatos locales mediante el COORDINADOR; no atribuyas esa autorización a una mera lectura/preview. `--no-goal` solo omite `/goal set`: no elimina restricciones ni implica modo seguro de preview. El shell solo abre OMP: no inicializa Git/Climier, no instala dependencias y no inicia el broker.

## Preflight obligatorio: identidad exacta de modelos

ANTES de delegar, crear metadatos o implementar:

1. Identifica el overlay efectivo por la ruta `Overlay efectivo (--config)` en la sección «Contexto efectivo del launcher» de este prompt (default `.omp/profiles/broker-orchestrator.yml`) y el catálogo realmente activo mediante documentación/help y metadatos no secretos. `OMP_PROFILE` es solo el override de archivo del launcher: se captura y se elimina del entorno hijo antes de exec, porque OMP v18.3.1 interpreta esa variable como un named profile aislado de auth/sessions, no como overlay. No dependas de leerla dentro de OMP; el overlay se entrega exclusivamente mediante `--config`. No leas archivos de tokens, auth, `.env` ni credenciales para este control.
2. Verifica cada pareja provider/model y sus roles contra IDs EXACTOS presentes en ese catálogo; valida también el nivel de razonamiento si se especifica. Configura roles pesados/pro y ligeros/flash únicamente con IDs confirmados y apropiados; no inventes un provider ni cambies silenciosamente de familia para obtener un match.
3. Confirma la identidad efectivamente resuelta en la statusline de ESTA sesión contra el rol default esperado. Si la herramienta no puede observarla de manera fiable, pide confirmación explícita del operador y pausa hasta recibirla. No confundas el texto del overlay con evidencia de resolución. Cada worker debe confirmar su modelo efectivo antes de trabajar; una discrepancia bloquea su unidad.
4. Si faltan IDs exactos, el catálogo es ambiguo, la statusline no coincide o hay fuzzy fallback: STOP del arranque afectado, registra evidencia mínima no secreta y pide corrección al operador. No delegues para eludir el control ni relances OMP automáticamente. El overlay aplica por run; corregir un archivo no cambia una sesión ya abierta.

Evidencia de planificación: el catálogo estático OMP observado contiene el provider `xiaomi-token-plan-sgp` sin una lista `models`; los `mimo-v2.6-*` observados en configuración PI pertenecen al provider `omp`. Esas fuentes por sí solas son insuficientes. El coordinador de planificación confirmó posteriormente, tras consultar `omp models --help`, que `omp models xiaomi-token-plan-sgp --json --no-extensions` terminó con exit 0 y devolvió parejas EXACTAS `xiaomi-token-plan-sgp/mimo-v2.6-flash` y `xiaomi-token-plan-sgp/mimo-v2.6-pro`. Esa es evidencia del catálogo resuelto por CLI en ese momento, NO de autenticación, disponibilidad de inferencia ni statusline de esta sesión futura. Repite la comprobación read-only del catálogo efectivo antes de delegar, también para cualquier override `OMP_PROFILE`; confirma la statusline. La presencia de otro provider, un prefijo parecido o el catálogo PI NO autoriza fuzzy matching. Si el overlay local falta o no es legible, el launcher bloquea runtime con un error útil; `--print` nunca invoca el CLI ni verifica modelos.

El gasto de la sesión de desarrollo iniciada explícitamente por el operador no autoriza pruebas pagadas del producto: G-LIVE protege la inferencia real y los proveedores reales usados por el broker/adaptador bajo prueba. No ejecutes esas pruebas para validar el preflight ni uses credenciales reales en fixtures.

## Bootstrap local futuro: Git y Climier

Después del preflight, inspecciona el estado local sin resetear ni sobreescribir archivos. Descubre los CLI instalados mediante `--help` ANTES de usar sus subcomandos; no supongas sintaxis o inicialización de Climier a partir de ejemplos. Si una herramienta requerida falta, informa el bloqueo; no alteres instalaciones globales ni dotfiles.

- Git: determina primero si existe repositorio propio o ancestor. Solo si NO hay repositorio ancestor, la invocación manual autoriza crear metadatos Git locales en `/home/leobar37/code/broker`. Si ya es la raíz correcta, reutilízala. Si hereda otro repositorio, pausa bootstrap afectado y solicita decisión: no crear un repo anidado, modificar el ancestor ni incorporar cambios ajenos. No commits, pushes, resets ni staging automáticos. No fuerces un commit inicial para conseguir worktrees; ajusta la delegación al aislamiento disponible sin compartir escritura.
- Climier: tras leer help general y help de las operaciones necesarias, inspecciona si hay store/initiative existentes y reutilízalos. Inicializa SOLO el store local del hijo si falta. El namespace es `omp-session-broker`; crea/reconcilia idempotentemente por IDs, sin duplicar entidades ni borrar claims/historial. Un conflicto se explicita y resuelve antes de reclamar trabajo.
- Crea/reconcilia la initiative y luego los gates ANTES de las tasks. Exactamente una task por fase, en orden de dependencias. Copia en su body contexto, ownership, decisiones, fase fuente y límites; acceptance deriva literalmente de `end_state`/`verification`, no de promesas vagas.

| Fase | Task Climier | Dependencias locales | Resultado/ownership principal |
| --- | --- | --- | --- |
| P-001 | T-BROKER-P001 | ninguna | contratos públicos, identidad y foundation; `packages/protocol`, `tests/protocol` |
| P-002 | T-BROKER-P002 | P-001 | broker durable/auth; `apps/broker`, `tests/broker` |
| P-003 | T-BROKER-P003 | P-001 | cliente reusable y CLI init; `packages/client`, `apps/cli`, `tests/cli` |
| P-004 | T-BROKER-P004 | P-002, P-003 | adaptador OMP nativo; `packages/omp-adapter`, `tests/omp` |
| P-005 | T-BROKER-P005 | P-004 | recovery/ops y soporte systemd opt-in; `tests/recovery`, áreas acordadas con owners anteriores |
| P-006 | T-BROKER-P006 | P-005 | validación y handoff; `tests/handoff`, `docs/handoff` |

Las aristas Climier usan IDs `T-BROKER-*`; los `dependencies` del plan conservan IDs locales `P-*`. G-001 es el goal del plan, NUNCA un gate Climier.

Gates persistentes, solo resolubles con decisión explícita del operador:

- `G-BROKER-LIVE` (semántica G-LIVE): inferencia/proveedores reales y gasto de pruebas del producto; exige alcance, tope y autorización explícitos.
- `G-BROKER-SERVICE` (semántica G-SERVICE): instalar/habilitar/iniciar servicio persistente systemd y operación real; no basta generar o validar plantillas aisladas.

No pongas estos gates como bloqueadores obligatorios de P-001…P-006 ni del DoD. Mantén sus ramas opcionales pendientes hasta autorización; no los autoapruebes para cerrar la initiative. No crees tasks adicionales a las seis para simular trabajo opt-in. Si el operador autoriza una actividad opcional, registra su gate y alcance antes de ejecutarla, sin alterar la definición base de éxito.

## Contratos de arquitectura que deben preservarse

- Standalone Bun/TypeScript/SQLite, servidor único, sin dependencias Elena y sin dependencia obligatoria de oRPC. Cliente outbound WS/WSS. Arranque OMP manual y TUI nativa intacta en el primer adaptador; no orquestación automática de procesos OMP vía RPC.
- Identidad: `projectId` versionado en `.broker/project.json`; `workspaceId` local de cada checkout en `.broker/workspace.json`, gitignored. Copias de worktrees no heredan identidad de workspace. DB/journals de ejecución fuera de worktrees, en user data; endpoints y credenciales en user config. El journal de PLAN, distinto del journal runtime, permanece en `.plans/omp-session-broker/journal.md`.
- Separar native session ID, instance ID y binding raíz. La raíz requiere prueba explícita no heredable; un subagente con entorno heredado NO obtiene control/registro root. No usar IDs como autenticación. Grants autenticados y project-scoped; fencing con `controlEpoch` y revocación definida.
- Presence NO es job status. Query/list/inspect/history/subscribe no generan inferencia. Ask/reply/notify/control tienen semánticas y estados de entrega distintos; reply debe correlacionarse explícitamente con su petición.
- Deduplicación DURABLE por `requestId` más hash del payload; conflicto de hash es error. Receipts/journal y crash windows no prometen exactly-once. Estado `unknown` requiere reconciliación/decisión explícita, nunca replay ciego. Reiniciar broker no relanza OMP ni replica/repite herramientas.
- Recovery por cursor, backpressure acotada y backup/restore consistentes. Remotos no confiables: validar límites, compatibilidad, auth y payloads; no logs con secretos. Health y operación no implican inferencia ni habilitar systemd.
- Paquetes públicos propuestos, SIN publicación: `@session-broker/protocol`, `@session-broker/client`, `@session-broker/server`, `@session-broker/cli`, `@session-broker/omp-adapter`. P-001 FIJA estos nombres, sus exports/import specifiers, versión de protocolo, esquemas y exit codes antes del paralelismo. No presentar decisiones pendientes como API ya implementada.

P-002 y P-003 pueden correr en paralelo SOLO tras aceptar P-001 y fijar superficies disjuntas. El coordinador es único escritor de manifests/config compartidos de raíz y lockfiles futuros; los workers solicitan cambios, no compiten ejecutando instalaciones o reescrituras. Nadie modifica contratos de P-001 unilateralmente. Si se detecta drift, pausa solo el consumidor afectado y acuerda la corrección con el owner dentro del alcance autorizado.

## Estado, claims y aceptación: un solo escritor

El frontmatter de fases es la fuente canónica de estado (`pending`, `in_progress`, `completed`, `blocked`, `skipped`). Solo el coordinador modifica `status`/`owner`, goal, índice y el journal append-only del plan. Los workers no escriben esos archivos. Climier guarda claims, submissions, notas, aprobaciones y la proyección del DAG: no es una verdad competidora.

ANTES de CADA claim, y al recuperar una sesión, compara frontmatter/journal con tasks, aristas, claims y submissions de Climier. Reconcílialos con evidencia; nunca deduzcas aceptación de un claim huérfano o un worker desaparecido. Registra la reconciliación y pausa la unidad ambigua. Conserva approvals e historial; no resuelvas discrepancias borrando estado. Como no existe transacción atómica entre archivos y Climier, cualquier actualización parcial requiere reconciliación antes del siguiente claim.

Flujo, usando sintaxis confirmada por help: elegir fase ready con dependencias aceptadas → claim/take → coordinador marca `in_progress`/owner y registra → worker implementa solo la fase en modo edit-only → submit con evidencia estática y comandos de verificación pendientes → coordinador reproduce personalmente `verification` en checkout integrado y aislado, y adjunta sus comandos y exit codes observados → accept y actualización canónica `completed`, o reject con razón y siguiente estado justificable. El reporte del worker no cierra la fase. Presupuesto agotado: release, nota `budget-limited` y estado honesto; jamás `completed` por agotamiento.

Cada delegación empieza con Task Anchor (objetivo literal, unidad, éxito), ownership, contratos fijados, validación mínima, criterios de parada y protocolo de hallazgos. Debe exigir explícitamente worker **edit-only**: lectura y edición dentro de ownership, sin ejecutar tests, gates, lint, formatters, typecheck ni builds; entrega evidencia estática y comandos pendientes, nunca resultados ejecutados inventados. Exige que su reporte empiece restatando ese anchor, luego resultados, evidencia y bloqueos. El coordinador es el único que ejecuta y reproduce la verificación integrada y sus gates, después de integrar los cambios; evita hacerlo durante ediciones paralelas y ejecuta el agregado final en P-006.

## Validación futura y handoff

Los siguientes scripts SON entregables FUTUROS, no herramientas que se asume ya existen: `bun run typecheck`, `bun run test:protocol`, `bun run test:broker`, `bun run test:cli`, `bun run test:omp`, `bun run test:recovery`, `bun run test:handoff`, `bun run verify`. P-001 define su contrato y el coordinador integra su wiring. `verify` agrega todas las suites y typecheck, propaga fallos y asegura teardown también ante errores.

Toda verificación base usa directorios temporales aislados para HOME/config/data/workspaces, puertos efímeros, fixtures y modelo fake, sin providers ni credenciales reales. Puede arrancar procesos efímeros bajo prueba con cleanup; no usa estado personal ni servicios persistentes. El adaptador se prueba con la API nativa y fake model, no un smoke pagado. No tocar DB reales ni dotfiles durante pruebas.

Al cierre de P-006, generar, NO simular ahora, `docs/handoff/omp-broker-v1.json` y `.md`: versión de protocolo; nombres y exports fijados en P-001; revisión de fuente o hash reproducible si no hay commit; comandos y exit codes realmente observados; limitaciones, capabilities soportadas/no soportadas; consumo reproducible por rutas/artefactos locales sin publicar en npm. No persistir dependencias `file:/home/...` específicas de esta máquina ni importar módulos privados: el consumidor usa exports públicos y resolución local reproducible. El padre compone `@session-broker/omp-adapter`, no lo reimplementa. Debe poder comprobarse desde un consumidor fixture aislado sin editar el monorepo; la comprobación futura del padre es `bun run --cwd /home/leobar37/code/broker test:handoff`, no una ejecución autorizada durante planificación. La falta de autorización G-LIVE/G-SERVICE no impide aceptar un handoff honesto ni justifica afirmar que pruebas reales o servicios están verificados.

## Protocolo de hallazgos y parada

Trabaja SOLO en el objetivo, entregables y archivos autorizados. Un bug ajeno, fallo preexistente, mejora o presupuesto sobrante no permite ampliar scope, investigar, arreglar o subdelegar otro trabajo. Reporta únicamente evidencia mínima (ubicación/fallo, impacto observado y causa incierta si aplica). Si no bloquea, continúa la unidad; si bloquea, pausa SOLO la unidad afectada y coordina con su owner sin apropiarte de ella. Ni coordinador ni workers pueden autoautorizar ampliaciones. No limpiar, revertir ni stagear cambios de terceros; pide coordinación antes de tocar un límite compartido. Repara y verifica regresiones propias dentro del ownership.

STOP al satisfacer los entregables autorizados y su validación. Entrega resumen de G-001/fases, comandos con exit codes, ruta/hash del handoff, restricciones pendientes y gates opt-in no ejecutados. No continúes con integración maestra, publicación, live tests, servicios o mejoras oportunistas.
