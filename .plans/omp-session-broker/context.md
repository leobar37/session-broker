# Contexto — broker de sesiones independiente

## Task Anchor

Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».

Unidad autorizada ahora: redactar este subplan autónomo y su launcher manual. Éxito de planificación: seis fases pendientes, requisitos trazables, prompts y preview preparados; ningún broker, sesión de implementación, Git, Climier, servicio o base de datos iniciado. El usuario abrirá `/home/leobar37/code/broker` y ejecutará el script personalmente. La aclaración no solicita oRPC ni lanzamiento remoto por RPC.

## Estado y evidencia

**PLANNING ONLY** — 2026-09-25. Los comandos y paquetes de software descritos son entregables futuros; no existen ni se consideran verificados por estar nombrados aquí.

- **Verificado:** autorización de dos planes structured relacionados, uno maestro y otro independiente. Proyecto hijo sin infraestructura inicial, destino previamente comprobado inexistente.
- **Verificado:** `~/code/dotfiles/omp/profiles/video-maker-plan.yml` declara los roles pesados `xiaomi-token-plan-sgp/mimo-v2.6-pro` y ligeros `xiaomi-token-plan-sgp/mimo-v2.6-flash:high`. La lectura programática de `catalog.json` fue insuficiente (provider OMP sin modelos); la consulta complementaria permitida `omp models xiaomi-token-plan-sgp --json --no-extensions` terminó con exit 0 y confirmó ambos pares exactos. No verifica autenticación ni inferencia; status line y overrides requieren preflight en cada lanzamiento.
- **Verificado:** `omp --help`, exit 0, informa v18.3.1 y soporta `--config`/`--cwd`. `OMP_PROFILE` nativo significa perfil aislado nombrado; el launcher captura ese nombre como override de overlay por contrato, lo retira del entorno hijo antes de `exec` y transmite la ruta efectiva vía `--config` y prompt. Solo ayuda consultada, no se abrió una sesión.
- **Verificado:** la propuesta histórica describe broker único outbound, autoridad durable y semántica de recovery. Su ownership monorepo/CLI fue SUPERADO por la decisión de proyecto independiente.
- **Decidido:** Bun/TypeScript con SQLite inicial, sin contenedores; OMP es primer adaptador, no el núcleo genérico.
- **Por comprobar en P-001:** vigencia de versión y API pública OMP instalada, capabilities exactas, dependencias compatibles, nombres/exports públicos, límites de protocolo y comandos/exit codes definitivos.
- **Inferido, no probado:** una única instancia lógica con SQLite es suficiente para el alcance inicial; no se promete HA ni escala distribuida.

## Fuente y relación entre planes

Este plan es la fuente autónoma de requisitos de broker. La [propuesta histórica](../../../../.herdr/worktrees/theelena/control-de-caja/.proposals/omp-session-broker/context.mdx) es contexto conceptual, no una dependencia de ejecución; su ubicación absoluta es `/home/leobar37/.herdr/worktrees/theelena/control-de-caja/.proposals/omp-session-broker/context.mdx`. No copiar su contenido completo ni seguir sus antiguas ubicaciones internas.

Plan maestro: `/home/leobar37/.herdr/worktrees/theelena/control-de-caja/.plans/omp-broker-pilot/`. **El hijo no depende de ejecutar el maestro.** El maestro espera la entrega verificada del hijo antes de integrar. Ninguna fase del hijo puede editar monorepo, importar código privado Elena, publicar paquetes o iniciar el piloto del padre.

Entrega futura en `docs/handoff/omp-broker-v1.json` y `.md`: versión del protocolo; lista exacta de paquetes/exports públicos fijados en P-001, incluyendo adaptador OMP y SDK; revisión de fuente o hash determinista y algoritmo/alcance; comandos y exit codes reproducidos; capabilities soportadas/no soportadas; limitaciones; consumo local reproducible sin publicar npm, sin imports privados y sin persistir dependencias `file:/home/...` de esta máquina. El maestro verificará mediante `bun run --cwd /home/leobar37/code/broker test:handoff` y compondrá el adaptador público en su plugin, sin reimplementar broker/SDK. No generar esos archivos ahora como si existiera software.

## Arquitectura y límites obligatorios

1. Un servidor lógico global, con clientes salientes WS/WSS; cada sesión carece de listener propio. WSS o canal privado explícitamente seguro fuera de fixtures; la red privada no sustituye la autenticación de aplicación.
2. `.broker/project.json` versionado conserva `projectId`; `.broker/workspace.json` ignorado por Git identifica únicamente este checkout. La configuración de usuario contiene endpoints y credenciales; datos SQLite, backups y journals viven fuera de worktrees. Un clon no hereda secretos ni `workspaceId`.
3. `sessionRef`, `nativeSessionId`, `instanceId`, `connectionId`, `requestId`, `eventId`, `eventSeq` y `controlEpoch` tienen vidas separadas. Alias/PID/pane/cwd/UUID conocido no prueban identidad ni permisos. Registro raíz requiere un binding autenticado no heredable por subagentes.
4. Grants autenticados y revocables limitan proyecto/workspace/target/sesión/capability. Un controlador vigente por ámbito; cambio de epoch o instancia invalida control antiguo. Heartbeat ausente no demuestra que el escritor anterior murió.
5. Consultas existentes no llaman a modelos. `ask` admite inferencia explícita con presupuesto/plazo; solo `replyTo` autorizado completa la respuesta. Presencia, actividad de runtime, entrega y estado de trabajo/aceptación son dimensiones distintas.
6. Broker confirma solo tras persistencia. Redelivery reutiliza ID/hash; payload diferente es conflicto. Journal incoming local durable cubre frontera entre recepción y OMP. La ventana de resultado desconocido requiere reconciliación: no replay ciego, ni promesa exactamente-una-vez.
7. Reiniciar broker reconstruye estado y recibe reconexiones, sin relanzar OMP ni replicar tools. Adaptador utiliza API pública y preserva TUI nativa/historial. No shell remoto genérico, scheduler, nueva TUI ni runtime paralelo de inferencia.
8. Datos remotos son entrada no confiable, jamás instrucciones de sistema o autorización para publicar, gastar o expandir scope. Historial compartido explícito y acotado; sin secretos, prompts internos o razonamiento privado.

## Superficie futura y ownership

| Área futura | Responsable de fase | Contrato |
| --- | --- | --- |
| `packages/protocol/`, `docs/contracts/`, fixtures contractuales | P-001; cambios posteriores coordinados | Protocolo versionado, identidad, schemas, exports y errores |
| `apps/broker/`, `tests/broker/` | P-002 | SQLite, auth, routing, estado durable |
| `packages/client/`, `apps/cli/`, `tests/cli/` | P-003 | Cliente reusable, init idempotente y configuración |
| `packages/omp-adapter/`, `tests/omp/` | P-004 | Binding raíz, API nativa, journal incoming |
| `tests/recovery/`, `ops/`, operación/backup | P-005 | Recovery determinista y servicio opt-in |
| `tests/handoff/`, `docs/handoff/` | P-006 | Consumo público aislado y evidencia final |
| Manifiestos raíz, lockfile y wiring de scripts | Solo coordinador | Integra cambios de fases sin escrituras concurrentes |

Paquetes propuestos (no publicados): `@session-broker/protocol`, `@session-broker/client`, `@session-broker/server`, `@session-broker/cli`, `@session-broker/omp-adapter`. P-001 fija nombres/exports y mapa a carpetas antes de P-002/P-003. Consumidores nunca importan servidor privado ni Elena.

## Gobernanza y bootstrap futuro

Al ejecutar manualmente el launcher en modo real, el usuario autoriza al coordinador a ejecutar el plan y preparar **metadatos locales** Git/Climier si faltan. El shell solo arma el prompt e inicia OMP; nunca hace init por sí mismo. El coordinador verifica raíz real y ausencia de repositorio ancestro ajeno antes de Git init; no realiza commits automáticos. Descubre la CLI Climier instalada con help y reutiliza registros existentes idempotentemente. No instala herramientas faltantes ni infraestructura a escondidas.

Frontmatter de fases es el estado canónico; coordinador único modifica `status`, `owner` y journal append-only. Climier gestiona DAG/claims/submissions y proyecta avance; no es otra verdad de aceptación. Antes de tomar trabajo y tras recovery, reconciliar IDs, dependencias, claims y evidencia con frontmatter. Ante drift, registrar y pausar unidad afectada; no sobrescribir completado sin evidencia. Workers entregan código/notas, nunca cierran sus propios gates ni escriben journal.

Iniciativa Climier `omp-session-broker`; tareas `T-BROKER-P001`…`T-BROKER-P006`. Gates `G-BROKER-LIVE` (G-LIVE) y `G-BROKER-SERVICE` (G-SERVICE), distintos del goal documental `G-001`. Sembrar gates antes de tareas, un task por fase, copiando decisiones y acceptance del plan. Ninguna fase base depende de gates opcionales; éstos controlan únicamente acciones reales expresamente autorizadas. No se presupone un DAG ya sembrado.

## Gates y validación

- **G-LIVE:** inferencia real de prueba, proveedores, tráfico pago, pilotos o gastos adicionales. Requiere alcance, límite y aprobación humana. La sesión de desarrollo iniciada manualmente usa su perfil; eso no autoriza a sus pruebas a llamar proveedores.
- **G-SERVICE:** instalación/enable/start de systemd user o cualquier servicio persistente. Diseñar y probar artefactos con fixtures no abre el gate.
- Publicación, despliegue, commits, cambios en otros repositorios y contenedores no se autorizan por estos gates; requieren autorización separada.

Los scripts `bun run typecheck`, `test:protocol`, `test:broker`, `test:cli`, `test:omp`, `test:recovery`, `test:handoff` y `verify` deben IMPLEMENTARSE. Cada prueba usa temporales, configuración/DB/journals de prueba, sockets efímeros y fake model; no estado ni sesiones reales. Solo el coordinador ejecuta gates al integrar cada fase y registra exit codes. El goal software no depende de instalar servicio real ni de piloto pago del maestro.

## Riesgos y reglas de parada

Unknown outcomes, APIs OMP no soportadas, confusión de IDs/autorización, drift del catálogo y pérdida del journal requieren errores observables, no fallback silencioso. Si un API indispensable no existe, P-001 debe explicitar bloqueo o capability no soportada compatible con requisitos, no prometer un fork oculto.

Ni coordinador ni subagentes amplían autorización. Hallazgos ajenos se reportan con ubicación/evidencia mínima, sin investigar, arreglar ni subdelegar. Bloqueadores externos pausan solo la unidad afectada; no otorgan ownership. Terminar al alcanzar entregables y verificaciones propias; no convertir capacidad disponible en trabajo adicional.
