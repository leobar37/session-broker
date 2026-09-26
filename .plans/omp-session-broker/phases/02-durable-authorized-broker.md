---
id: P-002
goal: G-001
title: Broker durable con autorización scoped y entrega observable
status: completed
owner: coordinator
phase_type: implementation
description: Implementar el servidor standalone y su almacenamiento durable usando el contrato congelado y clientes falsos independientes de P-003.
end_state: El servidor aplica grants y controlEpoch, conserva dedup y recibos tras reinicio y distingue presencia de ejecución; bun run typecheck y bun run test:broker terminan con exit 0 en fixtures aisladas.
verification:
  - "bun run typecheck"
  - "bun run test:broker"
  - "Revisión del coordinador: exports server coinciden con P-001 y ninguna prueba usa DB, proveedor o sesiones reales"
deliverables:
  - Servidor publicable solo en sentido de frontera de paquete en apps/broker, sin publicación efectiva
  - Schema y persistencia SQLite internos del servidor
  - Clientes/adaptadores falsos y suite en tests/broker
entry_criteria:
  - P-001 aceptada por coordinador tras reproducir su verification
  - Protocolo, exports, exitcodes, root proof y límites fijados; manifests y scripts raíz preparados por coordinador
  - Proyección Climier reconciliada antes del claim
dependencies: [P-001]
requirements: [FR-001, FR-003, FR-004, FR-005, FR-006, FR-007, FR-009, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-002 de .plans/omp-session-broker/phases/02-durable-authorized-broker.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  servidor durable autorizado, no cliente ni adaptador. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-002/G-001: broker durable y autenticado en `/home/leobar37/code/broker`, no CLI ni integración OMP real.
- **Éxito observable futuro:** servidor probado con peers falsos, permisos por proyecto, dedup persistente y recibos coherentes tras restart; typecheck/test:broker exit 0 reproducidos por coordinador.

## Contexto y dependencias

El servidor es Bun/TypeScript + SQLite, standalone, sin imports Elena. Acepta conexiones outbound WS/WSS de clientes y adaptadores; solo hay un servidor escritor por store. DB y journals viven en user data fuera de checkout/worktrees. No aloja un motor de herramientas o inferencia, ni relanza OMP al restaurar estado. P-001 congela los contratos; P-003 puede avanzar en paralelo con mocks del mismo protocolo, sin usar código en desarrollo de esta fase.

**Confirmado:** esta fase depende únicamente de P-001. **Inferido:** peers de contrato falsos permiten verificar servidor sin bloquear al cliente. **Desconocido hasta ejecución:** implementación concreta de schema/transacciones; debe cumplir el contrato, no modificarlo unilateralmente. Esta entrega es solo planificación: no existen por ello DB, scripts ni resultados de test.

## Áreas y ownership futuro

- Crear/modificar `apps/broker/`: entrypoint, API pública `@session-broker/server` fijada por P-001, transporte, autorización, store SQLite, journal y health mínimo. Mantener schema/migraciones propias dentro del área; ningún store real se toca durante tests.
- Crear/modificar `tests/broker/`: fixtures, fake clients/adapters y suite de servidor; todos sus recursos tienen TMP único y teardown.
- Solo lectura: `packages/protocol/`, decisiones de `docs/contracts/` y matriz OMP. No importar implementaciones privadas de CLI/cliente/adaptador.
- Prohibido editar `packages/client/`, `apps/cli/`, `packages/omp-adapter/`, monorepo, dotfiles y estado real de usuario. Root manifests, lockfiles y scripts son del coordinador; remitir cambios requeridos en vez de editarlos. Un conflicto del contrato vuelve al dueño de P-001, sin apropiarse del archivo.

## Requisitos y contrato funcional

1. **FR-001/003:** registro explícito de raíz autenticada con prueba no heredable P-001; asociar projectId/workspaceId/nativeSessionId/sessionRef/instanceId sin confundir sesión persistida y proceso vivo. Environment heredado, IDs conocidos o sesión duplicada no dan registro/control. Registrar/reconectar no genera inferencia.
2. **FR-004/NFR-001:** validar grant y proyecto en handshake, registro, cada query, suscripción, entrega y control; revalidar conexiones tras revoke/expiry según contrato. Separar permisos de lectura, envío y control. Takeover autorizado incrementa `controlEpoch` atómicamente; una acción del dueño anterior se rechaza incluso ante carrera. Eventos, historial, errores y listados no filtran recursos de otros proyectos. No logs de credenciales ni payload sensible por defecto.
3. **FR-005:** list/inspect/history/query/subscribe leen registros/eventos con scope, paginación/cursores y límites; ausencia/desconexión no inicia agentes, llama proveedores ni manda prompts. Presencia online/offline/heartbeat, estado de entrega request y job status nativo son dimensiones separadas; no hay scheduler de jobs.
4. **FR-006:** ask crea pregunta broker durable a target explícito para entrega nativa when_idle; notify no se transforma en ask. Reply exige `replyTo=requestId`, sessionRef/instanceId y autoridad del destinatario; viene de herramienta explícita del agente y no de agent_end/siguiente texto. No resolver preguntas humanas de tools OMP. Reply duplicado/ajeno/tardío, target ambiguo, control unsupported, permisos faltantes y deadline vencido tienen error congelado sin efectos.
5. **FR-007:** `queued` solo después de commit broker; `received` solo con journal incoming durable cliente/adaptador; `submitted` indica API OMP; `completed` exige resultado propio de operación (ask: reply explícito). Alternos `rejected`, `failed`, `expired`, `cancelled`, `outcome_unknown`. Transacciones mantienen request/hash/recibos/journal coherentes. Dedup scoped proyecto + requestId: mismo hash recupera operación; hash distinto da conflicto; concurrencia no crea solicitudes/efectos duplicados. Sin evidencia suficiente conservar outcome_unknown, nunca resubmit ciego. No replicación de herramientas ni estados accepted/delivered alternativos.
6. **FR-009/NFR-004:** cursores monotónicos según ámbito congelado, replay de eventos retenidos y respuesta explícita de gap/expired cursor; colas, frames, payloads y historial acotados. Consumidor lento se controla/desconecta sin crecer indefinidamente ni bloquear a otros. P-005 endurece recovery/backup; esta fase ya respeta las fronteras y límites básicos.
7. **NFR-002/003:** toda prueba usa fake model y fake peers; endpoints, HOME/config/data/SQLite aislados. Tests no realizan llamadas externas, relanzamientos OMP ni mutan cuentas. No añadir integración con Elena, publicación, UI, replicación distribuida o supervisor de sesiones.

## Criterios binarios y casos failure

- [ ] Grant válido ve solo su proyecto; grant ausente/expirado/revocado y lectura/acción cross-project fallan con código estable sin datos filtrados.
- [ ] Dos controladores en carrera no pueden aplicar el mismo control con epochs obsoletos; owner viejo no puede entregar después del takeover/revoke.
- [ ] Registro root válido funciona; prueba consumida por otra instancia, environment heredado y workspace/session falsificados fallan.
- [ ] requestId/hash repetido, incluso concurrente y tras restart, produce una sola identidad durable; hash distinto se rechaza y no envía un segundo mensaje.
- [ ] Crash/restart después de queued conserva request/journal; entrega sin resultado verificable queda outcome_unknown consultable, sin replay ciego.
- [ ] list/inspect/history/subscribe no incrementan inferencia ni envíos; desconexión cambia presence sin completar/cancelar request ni job nativo por deducción.
- [ ] Reply con replyTo erróneo, control unsupported y target ambiguo no generan efectos; reply explícito válido completa el ask exacto, agent_end/siguiente texto no lo hacen.
- [ ] Cursor inválido/expirado, frame gigante y consumidor lento se resuelven de forma explícita y acotada; ninguna fuga entre proyectos.
- [ ] Store no permite segundo escritor incompatible; shutdown/restart no ejecuta herramientas ni inicia OMP. Tests limpian sockets, timers, conexiones y temporales aun en failure.

## Validación futura y evidencia pendiente

Scripts **a implementar**, no ejecutados ahora: `bun run typecheck` y `bun run test:broker`, exit 0. Solo el **coordinador** ejecuta/reproduce verification al integrar; workers **edit-only**, sin tests, gates, formateadores ni comandos de validación. Preparan servidor efímero/SQLite TMP, reloj/fault injection, peers/modelo falsos, guardas de proveedor/red/rutas reales y teardown. Coordinador serializa verificación cuando P-002/P-003 estén estables; no suite global concurrente.

**Evidencia pendiente:** requests ficticios, transiciones/recibos sin secretos, restart/counters, outputs/exitcodes, teardown y exports. Worker entrega pruebas preparadas con validación pendiente; coordinador produce evidencia real y reproduce `verification` antes de aceptar.

## Gobernanza y riesgos

Task `T-BROKER-P002`, initiative `omp-session-broker`, dependency local P-001; paralela a P-003 con ownership disjunto, ambas necesarias para P-004. Frontmatter/journal tienen único escritor coordinador; Climier lleva claims/submissions y proyección reconciliada **antes de claim**, nunca estado canónico competidor. Worker no cambia status/owner/journal ni autoacepta.

`G-BROKER-LIVE` (G-LIVE, inferencia/proveedor real/gasto) y `G-BROKER-SERVICE` (G-SERVICE, persistencia como servicio) requieren decisión explícita del operador y están fuera del DoD hijo. No usar estos gates como excusa para probar con estado real: esta fase se acepta sin ellos. Goal G-001 no es un gate.

**Riesgos:** SQLite no es atómico con efectos externos: reconocer `outcome_unknown`, no prometer exactly-once. Revocación/epoch con colas/reconexiones es frontera de seguridad. Si root proof no es implementable, pausar esa unidad y remitir evidencia a P-001; no environment/PID sustitutos. Maestro externo no autoriza cambios aquí.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-002/G-001; éxito: servidor durable autorizado con dedup/recibos/fencing y outcome_unknown seguro; typecheck/test:broker exit 0 reproducidos por coordinador.
>
> **Rol/objetivo/contexto:** task especialista de servidor durable, skill feature-executor; leer completa `/home/leobar37/code/broker/.plans/omp-session-broker/phases/02-durable-authorized-broker.md` y contrato P-001 aceptado. Implementar servidor Bun/SQLite standalone y tests con peers falsos; no depender de P-003 en desarrollo. Preservar grants scoped, controlEpoch, prueba root no heredable, consulta sin inferencia y no replay ciego/relaunch/tools replication.
>
> **Ownership/validación:** solo `apps/broker` y `tests/broker`; protocolo/decisiones read-only; raíz/manifests/lockfile/scripts coordinador. Worker **edit-only: no ejecutar tests, gates, formateadores ni validación**; preparar fixtures seguridad/concurrencia/restart. Coordinador reproduce futuros `bun run typecheck` y `bun run test:broker` exit 0 en TMP/fake model. LIVE/SERVICE opt-in fuera DoD; sin estado/proveedores/servicios reales. Reconciliar antes de claim; no status/owner/journal/autoaccept.
>
> **Scope/findings/STOP:** solo objetivo/ownership; reparar regresiones propias. Hallazgos ajenos intactos: ubicación/fallo/impacto mínimo, causa incierta; no investigar, reparar ni delegar. Bloqueo pausa solo unidad afectada y se comunica a coordinador/owner sin apropiación; nadie autoamplía scope. No limpiar/revertir/stage cambios ajenos. STOP al entregar artefactos/pruebas preparadas; coordinador valida.
>
> **Reporte:** iniciar con anchor objetivo/unidad/éxito; archivos, contratos preservados, pruebas preparadas y validación pendiente explícita, limitaciones/bloqueos mínimos. No inventar exitcodes; coordinador reproduce gate, registra journal y acepta.
