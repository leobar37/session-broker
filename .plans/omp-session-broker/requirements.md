# Requisitos — omp-session-broker

Estado de planificación: pendiente; requisitos de software a implementar, no capacidades existentes. El [goal G-001](goal.md) es único. Los nombres de paquetes son fronteras públicas propuestas que P-001 debe congelar; este documento describe resultados, no clases internas.

## Funcionales

### FR-001 — Broker standalone y genérico

Un único servicio lógico Bun/TypeScript, SQLite inicial, conecta clientes outbound WS/WSS sin listeners por sesión ni dependencias de productos Elena. Al menos fixtures de dos dominios (revisión y videos) usan el mismo protocolo sin campos de dominio obligatorios. No requiere contenedores, cluster, Redis, scheduler ni inferencia propia.

### FR-002 — Proyecto, checkout y configuración

Init idempotente establece `projectId` versionable y `workspaceId` local distinto por checkout. Repetir init no rota IDs ni borra configuración ajena; no sobrescribe conflictos silenciosamente. Clones/worktrees conservan proyecto pero no identidad de checkout. Endpoints/credenciales permanecen en configuración de usuario y datos durables fuera de worktrees; ningún secreto entra en Git. Flags/rutas y exit codes públicos se fijan en P-001.

### FR-003 — Identidad lógica y bootstrap raíz

Distinguir sesión nativa, registro lógico, instancia de proceso, conexión y solicitud. Reconectar mismo proceso conserva instancia; reiniciar crea otra; reanudar sesión verificada puede conservar registro lógico. Cambiar sesión/branch invalida binding anterior. El bootstrap autentica proceso raíz y su ámbito; variables o extensiones heredadas por subagentes no registran otra sesión ni reclaman control. Copias de historial, alias, PID y cwd no son prueba de identidad.

### FR-004 — Autenticación, grants y control

La autenticación deriva origen y ámbitos; payloads no autoconceden roles. Credenciales revocables y grants por proyecto/workspace/target/sesión/capability filtran directorio, historial y eventos. Conocer un ID nunca autoriza. Las respuestas no filtran existencia fuera de ámbito. Lease y `controlEpoch` invalidan control viejo; una sola escritora autorizada, sin takeover por heartbeat perdido mientras exista resultado incierto.

### FR-005 — Consultas sin inferencia

Capacidades `sessions.list`, `sessions.inspect`, `sessions.history`, `sessions.subscribe` consultan proyecciones/fragmentos autorizados y acotados sin llamar al modelo. Snapshot contiene procedencia, `observedAt`, disponibilidad y antigüedad; offline o resumen inexistente no se inventa. Historial ausente retorna unavailable; cursor expirado obliga a snapshot explícito. Alias ambiguo falla, no escoge silenciosamente.

### FR-006 — Mensajes y control correlacionados

`notify` no promete respuesta ni activa inferencia por defecto. `ask` define destinatario, plazo, presupuesto, profundidad y política `when_idle`; no interrumpe una tarea ocupada por defecto. `reply` se deduplica y correlaciona por `replyTo` autorizado. `control` ofrece `prompt`, `steer`, `follow_up`, `abort` únicamente si la API nativa/capability verificada los soporta; unsupported es explícito. Abort reconoce cancelación solicitada, no rollback. `agent_end` nunca completa por sí mismo pregunta, trabajo ni aceptación de negocio. Cancelar espera local no cancela implícitamente trabajo remoto.

`ask/reply` comunica agentes a través del broker: el destinatario emite una respuesta estructurada explícita a la solicitud broker. No significa responder automáticamente una tool nativa que pregunta al operador humano, ni requiere implementar esa capacidad ajena. El siguiente texto libre del modelo tampoco se toma como respuesta implícita.

### FR-007 — Persistencia, deduplicación e incertidumbre

Confirmar queued solo tras commit durable; separar received, submitted y resultado final definido por operación. Mismo requestId y payload hash obtiene resultado/idempotencia; payload distinto se rechaza. Recibos incoming y eventos pendientes sobreviven en journal local donde la frontera de efectos lo requiere. Caídas entre aplicar a OMP y persistir resultado producen `OUTCOME_UNKNOWN` y reconciliación, no reejecución ciega. Expirar/cancelar no revierte efectos. No se promete exactamente-una-vez universal.

### FR-008 — Adaptador OMP nativo

OMP es primer adaptador y mantiene TUI, tools e historial originales. Se utiliza API pública verificada; no fork ni segundo runtime escribiendo la conversación. Se exponen capacidades concedidas y respuesta correlacionada explícita; ningún shell remoto genérico. Reiniciar broker no relanza OMP ni replica tools; una sesión sin broker sigue mostrando indisponibilidad sin fingir control realtime.

### FR-009 — Recovery y límites

Reconexión con backoff/jitter/heartbeat/cursores, dedup de eventId y secuencia durable. Colas, tamaño de frame, rate limits y retención acotados; cliente lento no agota memoria y no se descartan comandos durables silenciosamente. Instancia/control obsoletos se rechazan. Backup/restore probado en copia aislada; no se afirma recuperación por tener IDs. Perder journal o disco produce límites explícitos y no reenvíos peligrosos.

### FR-010 — Operación y autoarranque opt-in

Health/status distingue proceso disponible, persistencia operable y cliente conectado; presencia no es estado de tarea. Configuración de un servidor global con almacenamiento de usuario, logs redactados y diagnóstico accionable. Artefacto systemd user permite autoarranque opt-in con gate humano; no se instala/enable/start como efecto de init o pruebas. Pruebas usan fixture/service-manager fake, sin modificar sesión real del usuario.

### FR-011 — Fronteras públicas y entrega reproducible

Consumidor externo usa únicamente paquetes/exports públicos versionados, sin importar implementación privada. Fronteras propuestas: `@session-broker/protocol`, `@session-broker/client`, `@session-broker/server`, `@session-broker/cli`, `@session-broker/omp-adapter`; nombres/exports definitivos se fijan en P-001. Entrega incluye versión de protocolo, fuente identificable, capabilities, limitaciones, comandos/exit codes reales y consumo local reproducible sin publicación npm. El hijo no necesita cambios ni ejecución del monorepo maestro.

## No funcionales

- **NFR-001 — Seguridad:** no secretos ni razonamiento privado en logs/transcripts/repos; tokens restringidos, inputs remotos no confiables; aislamiento de proyectos probado con denegaciones y suplantación. Transporte privado no reemplaza autorización.
- **NFR-002 — Verificación aislada:** suites deterministas en temporales, DB/journals/config/sesiones fake, relojes/fault injection controlados, sin inferencia ni estado real; teardown incluso al fallar. `verify` cubre todas las suites y falla ante scripts ausentes o suites vacías.
- **NFR-003 — Gobernanza:** coordinador único escribe frontmatter/journal; reconcile antes de claims; evidencia personal antes de completado. Gates humanos preceden acciones de gasto/servicio. Ningún agente amplía scope o acepta su propia entrega.
- **NFR-004 — Compatibilidad y límites:** protocolo versionado, handshake negociado, errores estables, payloads validados y límites explícitos verificables. Incompatibilidad y capacidades ausentes fallan cerradas; sin fuzzy fallback de identidad o modelo.

## Errores observables mínimos

`UNAUTHORIZED`, `NOT_FOUND_OR_FORBIDDEN`, `INCOMPATIBLE_VERSION`, `UNSUPPORTED_CAPABILITY`, `TARGET_OFFLINE`, `TARGET_BUSY`, `STALE_INSTANCE`, `STALE_CONTROL_EPOCH`, `PAYLOAD_CONFLICT`, `EXPIRED`, `RATE_LIMITED`, `QUEUE_FULL`, `CURSOR_EXPIRED`, `OUTCOME_UNKNOWN`. P-001 fija schema, terminalidad y mapeo CLI sin filtrar datos fuera de ámbito.

## Gates que NO forman parte del DoD software

G-LIVE (`G-BROKER-LIVE`): pruebas con inferencia/proveedores reales o gasto, aprobación y límite explícitos. G-SERVICE (`G-BROKER-SERVICE`): instalar/habilitar/arrancar servicio persistente, aprobación explícita. Diseñar y probar offline estas capacidades sí forma parte del plan; ejecutar acciones reales no. El piloto del maestro no bloquea completar G-001.

## Fuera de alcance

Publicación npm, despliegue real, infraestructura de productos, Docker, migración de DB real, orquestador de negocio, edición del monorepo, TUI alternativa, reemplazar Herdr, oRPC como dependencia y gasto automático. Hallazgos ajenos: evidencia mínima y pausa solo de unidad afectada si bloquea, sin investigar/arreglar/subdelegar.
