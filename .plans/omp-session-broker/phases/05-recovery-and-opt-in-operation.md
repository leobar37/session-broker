---
id: P-005
goal: G-001
title: Recuperación demostrable y operación persistente únicamente opt-in
status: completed
owner: coordinator
phase_type: implementation
description: Endurecer reconexión, crash recovery, backup y límites con fixtures aisladas, y generar configuración systemd user sin instalarla.
end_state: Crash boundaries y backup/restore preservan identidad, autorización y recibos sin replay ni relaunch; health y fixture systemd son verificables; bun run typecheck y bun run test:recovery terminan con exit 0 sin tocar servicios reales.
verification:
  - "bun run typecheck"
  - "bun run test:recovery"
  - "Revisión del coordinador: cero install/enable/start de servicios y evidencia de no relaunch OMP, no replay ciego, teardown y secretos redactados"
deliverables:
  - Recovery, backup y health endurecidos dentro de las áreas acordadas del proyecto
  - Suites y fault injection aislados en tests/recovery
  - Generador y fixtures de unidad systemd user sin instalar ni habilitar
  - Guía operativa futura en docs/operations con permisos, límites y recuperación honesta
entry_criteria:
  - P-004 aceptada tras reproducir verification y capacidades reales documentadas
  - Coordinador asignó explícitamente ownership de los componentes previos necesarios para recovery
  - Proyección Climier reconciliada antes del claim
dependencies: [P-004]
requirements: [FR-004, FR-007, FR-009, FR-010, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-005 de .plans/omp-session-broker/phases/05-recovery-and-opt-in-operation.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  recovery y operación probados sin servicios reales. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-005/G-001 de `/home/leobar37/code/broker`: demostrar recovery/operación con recursos de prueba, no desplegar un servicio personal.
- **Éxito observable futuro:** matriz de crashes, cursores, backup/restore y fixture systemd pasa con cero replay ciego/relaunch; coordinador obtiene typecheck/test:recovery exit 0 sin tocar estado real.

## Contexto y certeza

P-004 habrá integrado servidor y cliente con OMP nativo bajo fake model. Aquí se verifica la continuidad tras fallos sin convertir SQLite o el adaptador en un scheduler. Reiniciar broker restaura requests/recibos/journal; nunca arranca OMP ni reejecuta herramientas. Presence y job status nativo son observaciones distintas del estado de entrega de una solicitud.

**Confirmado:** un único servidor escritor; DB/journals fuera de worktrees; endpoints y credenciales en user config; `nativeSessionId` y `sessionRef` según P-001, `instanceId` nuevo por proceso. **Desconocido hasta ejecución:** fronteras efectivas de crash y características de backup de implementación elegida; se prueban, no se suponen. La entrega actual solo planifica: no se genera DB/servicio/handoff ni se corre ningún comando de validación.

## Áreas y ownership futuro

- `tests/recovery/`: fault injection, crash points deterministas, reloj fake, fixtures de procesos/runtime/modelo, store/backup y systemd; recursos por test y cleanup garantizado.
- `apps/broker/`: recovery de store/journal, backups, health, aislamiento de segundo escritor y límites. `packages/client/`: reconexión/cursor/backoff/disposal. `packages/omp-adapter/`: reconciliación de recibos/lifecycle sin relaunch. `apps/cli/`: superficies operativas y generación de unidad systemd acordadas en P-001.
- Estas modificaciones son una **transferencia explícita y serial** de ownership de los owners P-002/P-003/P-004, realizada por el coordinador antes de editar. No asumir permiso si un owner está corrigiendo su componente; pausar solo ese cambio y coordinar.
- `docs/operations/` y `ops/systemd/`: guía y templates/generación declarativa; ningún archivo en `~/.config/systemd`, dotfiles o config/data real.
- `packages/protocol/`/contrato públicos y monorepo read-only; cambios de interfaz requieren decisión coordinada, no ampliación automática. Root manifests/lockfile/scripts siguen siendo exclusivos del coordinador.

## Contratos y escenarios de recuperación

### FR-007: fronteras durables, no scheduler

Usar el vocabulario único congelado: `queued` = commit durable broker; `received` = journal incoming durable del cliente/adaptador; `submitted` = entrega a API OMP; `completed` = resultado definido por operación. Terminales alternos: `rejected`, `failed`, `expired`, `cancelled`, `outcome_unknown`. ACK/transporte no es ejecución ni job status. `outcome_unknown` representa la incertidumbre llamada «unknown» en la arquitectura; no es una orden de reintento.

| Frontera inyectada | Resultado exigido al recuperar |
| --- | --- |
| Antes de commit queued | No afirmar aceptación; reintento con mismo requestId/hash respeta dedup sin segundo efecto. |
| Después de queued y antes de envío | Request/journal existen y pueden consultarse; política de entrega se basa en recibos, deadline, grant y epoch actuales. |
| Después de envío y antes de journal received | Si no hay evidencia suficiente, outcome_unknown o reconciliación explícita según contrato; nunca entrega ciega. |
| Después de received y antes de ACK | Reenvío de recibos/consulta recupera la misma identidad, no un segundo efecto. |
| Antes/después de submitted y antes de resultado durable | No confundir llamada nativa con completed; duda se conserva como outcome_unknown. |
| Después de completed y antes de que consumidor lo vea | Consultar/replay de eventos devuelve resultado original sin nueva llamada OMP. |
| Revocación/takeover, timeout o expiración concurrentes | Fencing y permisos siguen vigentes; no resucitar autoridad vieja al restaurar DB/backup. |

También cubrir kill del broker, desconexión cliente, pérdida de ACK, restart de una instancia OMP fixture y retorno tardío de instancia vieja. Lo durable se reconcilia con evidencia; lo incierto se informa. No garantizar exactly-once externo ni replay de tools. `nativeSessionId`/`sessionRef`/`instanceId` no se colapsan durante restore.

### FR-009/NFR-004: cursores, límites y backup

- Cursor/replay conserva orden y scope de proyecto; consumidor con cursor retenido reanuda sin perder ni inventar eventos. Cursor fuera de retención devuelve gap/resync explícito; la CLI no oculta el hueco.
- Backpressure, reconnect storm, consumidor detenido y frames extremos permanecen dentro de límites P-001 con rechazo/desconexión explícitos. Medir con counters/clock fixtures, sin exigir benchmarks frágiles de wall time ni cargar equipos reales.
- Backup de SQLite/journals es consistente usando método soportado, no copia ingenua de un archivo activo ignorando WAL. Restore a directorio TMP nuevo verifica schema/version/integridad, correspondencia de journal y permisos; una copia corrupta/incompatible falla de forma explícita sin tocar el origen.
- Restore no revive conexiones, leases/epochs obsoletos ni grants revocados: documentar y verificar política conservadora de invalidación/reautorización tras backup. Dedup/retención no convierte un request antiguo incierto en nuevo trabajo.
- Segundo proceso sobre el mismo store se rechaza o se serializa como P-001 fijó; no dos servidores activos independientes. Fallos de disco/permiso/transacción producen errores observables, no recibos falsos de durabilidad.

### FR-010/NFR-001: operación y systemd opt-in

- Health distingue proceso accesible, store utilizable, schema compatible y disponibilidad de peers; no inferencia de prueba, no secretos ni historia privada en respuestas/logs.
- Shutdown ordenado cierra conexiones, timers y DB sin completar requests artificialmente. Logs estructurados/redactados registran causas y IDs scoped, nunca tokens o payloads sensibles por defecto.
- Generar unidad **systemd user** con rutas/argumentos de config explícitos, data fuera de worktrees, restart del broker únicamente y manejo seguro de secretos. No incluir tokens en ExecStart ni archivos versionados; no habilitar lingering.
- Suite valida contenido/escape y comportamiento del generador contra fixtures. No ejecuta install, enable, start, restart, daemon-reload ni escribe directorios systemd reales. Verificación de unidad, si se usa herramienta del sistema, se limita a archivos temporales y no contacta/muta al user manager.
- Guía declara permisos, backup/restore, límites, `outcome_unknown`, troubleshooting acotado y pasos de activación **condicionados** al gate. Generar instrucciones no constituye autorización para ejecutarlas.

## Criterios binarios

- [ ] Cada frontera de la tabla tiene fixture y resultado durable esperado; no hay transición silenciosa de outcome_unknown a submitted por reconexión.
- [ ] Duplicados/ACK perdidos/restarts conservan requestId/hash y resultado; ninguna prueba relanza OMP o replica tools.
- [ ] Cursor retenido, cursor expirado y consumidor lento producen semánticas distintas y recursos acotados; sin fuga cross-project.
- [ ] Restore válido a TMP pasa integridad y conserva recibos/dedup; backup corrupto/incompatible falla sin sobrescribir origen.
- [ ] Grants/epochs/instances obsoletos no vuelven a autorizar acciones tras restore; requisitos de reautorización quedan visibles.
- [ ] Segundo escritor, disco/permiso fallido, shutdown y timeout se manejan sin afirmar commits inexistentes.
- [ ] Health opera sin inferencia, logs no contienen secretos y fixture systemd es válida sin instalar/habilitar/iniciar servicio alguno.
- [ ] Tests dejan cero sockets/procesos/timers abiertos y no escriben fuera de TMP; teardown corre aun ante fallo.

## Validación futura y evidencia pendiente

Scripts **a implementar**: `bun run typecheck` y `bun run test:recovery`, exit 0. Solo el **coordinador** los ejecutará/reproducirá al integrar; workers son edit-only, no ejecutan gates/tests/formateadores ni suites paralelas. Tests usan TMP/HOME/config/data/DB aislados, fake runtime/model, bloqueo de proveedores/red externa y fault injection determinista; ninguna operación contra servicios/DB reales. Revisar assertions de no-replay/no-relaunch junto a resultados: exit 0 de un stub no es evidencia.

**Evidencia pendiente:** crash matrix con recibos/counters esperados y observados, backups restaurados en TMP, outputs/exitcodes, recursos cerrados y fixture systemd sin efectos sobre user manager. No hay validación ejecutada ahora. El coordinador registra evidencia y gate; el worker solo entrega los archivos y pruebas preparadas.

## Gobernanza, gates y riesgos

Task `T-BROKER-P005`, initiative `omp-session-broker`, dependency P-004. Reconciliar DAG Climier antes de claim; es proyección con claims/submissions, no verdad competidora. Frontmatter status/owner y journal tienen único escritor coordinador. Worker no autoacepta ni modifica esos campos; coordinador reproduce personalmente `verification` antes de aceptar.

`G-BROKER-SERVICE` (semántica G-SERVICE) solo lo resuelve el operador para persistencia real, instalación/enable/start de user service y cualquier efecto similar; fuera del DoD hijo. `G-BROKER-LIVE` (G-LIVE) protege proveedores/inferencia real/gasto, también fuera del DoD. Goal G-001 no equivale a esos gates. No tocar monorepo/dotfiles/infra de usuario. No solicitar gates para suplir fixtures faltantes.

**Riesgos:** un backup restaura datos, no confianza sobre lo ocurrido después: invalidar autoridad y conservar incertidumbre. El crash entre efecto OMP y escritura local no admite exactamente-una-vez demostrable; documentarlo. Ajustar recovery no autoriza un scheduler distribuido, supervisor de agentes ni rediseñar todas las APIs.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-005/G-001; éxito: crash recovery/backup/cursor y fixture systemd verificables sin replay/relaunch ni servicio real, typecheck/test:recovery exit 0 reproducidos por coordinador.
>
> **Rol/objetivo/contexto:** task especialista recovery, skill feature-executor; leer completa `/home/leobar37/code/broker/.plans/omp-session-broker/phases/05-recovery-and-opt-in-operation.md`, P-004 aceptada y contratos P-001. Implementar matriz queued/received/submitted/completed y terminales incluyendo outcome_unknown, backup/restore seguro, límites, health y generación systemd user sin instalación. No scheduler ni inferencia real.
>
> **Ownership/validación:** editar `tests/recovery`, `docs/operations`, `ops/systemd` y componentes de broker/cliente/CLI/adaptador únicamente tras transferencia explícita del coordinador. Protocolo/monorepo/OMP global read-only, raíz/manifests/lockfile/scripts solo coordinador. Worker **edit-only: no ejecutar tests, gates, formateadores ni verificación**; preparar fixtures. Coordinador reproduce futuros `bun run typecheck` y `bun run test:recovery` exit 0 en TMP/fake model y verifica teardown. G-SERVICE/G-LIVE opt-in fuera del DoD; nunca install/enable/start real. Reconciliar antes de claim; no status/owner/journal/autoaccept.
>
> **Scope/findings/STOP:** solo objetivo/ownership; reparar regresiones propias dentro de ese límite. Hallazgos ajenos intactos: reportar ubicación/fallo/impacto mínimo y causa incierta; no investigar, reparar ni delegar. Bloqueo pausa solo unidad afectada y se comunica a coordinador/owner sin apropiación; nadie autoamplía alcance. No limpiar/revertir/stage trabajo ajeno. STOP al entregar artefactos y pruebas preparadas; gates pertenecen al coordinador.
>
> **Reporte:** comenzar con anchor objetivo/unidad/éxito; archivos, crash cases y asserts preparados, límites y transferencias de ownership, validación pendiente explícita, bloqueos/evidencia mínima. No inventar exitcodes ni afirmar aceptación; coordinador ejecuta y registra evidencia real.
