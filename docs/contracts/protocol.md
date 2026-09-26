# Protocolo: versión, handshake, envelopes, operaciones y estados (FR-006 / NFR-004)

Fuente ejecutable: `packages/protocol/src/version.ts`, `handshake.ts`,
`envelope.ts`, `operations.ts`, `states.ts`, `errors.ts`.

## Versión y handshake

- Versión congelada: **1.0.0** (`PROTOCOL_VERSION`, major 1 / minor 0 / patch 0).
- Compatibilidad: mismo `major` y `minor` cliente ≤ `minor` servidor; `patch`
  no negocia. Todo lo demás → `INCOMPATIBLE_VERSION/incompatible_version`
  (`negotiateProtocolVersion`), sin fuzzy matching ni degradación.
- Flujo: `hello` (versiones soportadas, identidad declarada, `grantId` +
  credencial, capacidades) → `welcome` (versión acordada, `connectionId`,
  `serverChallenge`, capacidades del servidor, `maxFrameBytes`, `heartbeatMs`)
  o `error`. Opcional: `bind_root` con root proof ligada al challenge
  ([root-proof.md](root-proof.md)).

## Envelopes

Todo mensaje es JSON con `v` (major del protocolo) y `kind` discriminante.

```ts
interface RequestEnvelope {
  v: number;                       // === 1
  kind: "request";
  requestId: RequestId;
  operation: Operation;
  target: { target: TargetId; session?: SessionRef; instanceId?: InstanceId };
  payload: unknown;                // validado por operación
  grantId: GrantId;
  sentAtMs: number;
  deadlineMs?: number;             // 1..requestTimeoutMsMax
  controlEpoch?: number;           // OBLIGATORIO en operation === "control"
  requiredCapabilities?: Capability[];
}

interface ResponseEnvelope {
  v: number; kind: "response";
  requestId: RequestId;
  replyTo?: RequestId;             // en respuestas de reply: el ask que responde
  state: RequestState;
  eventId: EventId; eventSeq: EventSeq; atMs: number;
  result?: unknown;
  error?: ProtocolError;
}

interface EventEnvelope {
  v: number; kind: "event";
  eventId: EventId; eventSeq: EventSeq;
  topic: string; data: unknown; atMs: number;
}
```

Validación (`validateRequestEnvelope`) con rechazos estables:

| Situación | code | reason |
| --- | --- | --- |
| No-objeto / `kind` incorrecto | `INVALID_INPUT` | `schema_malformed` |
| Campos desconocidos (target, sessionRef, hello, grant…) | `INVALID_INPUT` | `unknown_fields` |
| `v` ≠ 1 | `INCOMPATIBLE_VERSION` | `incompatible_version` |
| Identificador con formato inválido | `INVALID_INPUT` | `invalid_format` |
| Campo fuera de rango | `INVALID_INPUT` | `invalid_field` |
| `deadlineMs` fuera de 1..max | `INVALID_INPUT` | `deadline_out_of_bounds` |
| Frame > `maxFrameBytes` | `INVALID_INPUT` | `frame_too_large` |
| Payload canónico > `maxPayloadBytes` | `INVALID_INPUT` | `payload_too_large` |
| Operación desconocida | `UNSUPPORTED_CAPABILITY` | `unsupported_operation` |
| Capacidad desconocida | `UNSUPPORTED_CAPABILITY` | `unknown_capability` |
| Capacidad no soportada por el objetivo | `UNSUPPORTED_CAPABILITY` | `missing_capability` |
| Verbo de control desconocido | `UNSUPPORTED_CAPABILITY` | `unsupported_control_verb` |
| `control` sin `controlEpoch` | `STALE_CONTROL_EPOCH` | `stale_control_epoch` |
| `replyTo` = requestId de la propia reply | `INVALID_INPUT` | `reply_to_mismatch` |

## Operaciones congeladas

| Operación | Categoría | Capacidades requeridas | Payload |
| --- | --- | --- | --- |
| `query` | read | `session.observe` | `{query, limit?}` |
| `list` | read | `session.observe` | `{limit?, cursor?}` |
| `inspect` | read | `session.observe` | `{fields?}` |
| `history` | read | `session.observe` | `{fromEventSeq?, limit?, cursor?}` |
| `subscribe` | read | `session.observe` | `{topics, fromEventSeq?}` |
| `ask` | send | `session.prompt.when_idle` + `session.reply_tool` | `{question, deadlineMs, maxTurns?, depth?, policy:"when_idle"}` |
| `reply` | send | `session.reply_tool` | `{replyTo, body, summary?}` |
| `notify` | send | `session.notify` | `{topic, data}` |
| `control` | control | según verbo | `{verb, instruction?}` |

Verbos de control: `prompt`, `steer`, `follow_up`, `abort`
(→ capacidades `session.control.*`). Cualquier otro verbo se rechaza;
`unsupported` es explícito, nunca silencioso.

Semántica congelada:
- `notify` no promete respuesta ni activa inferencia por defecto.
- `ask` encola una pregunta broker como **prompt nativo seguro `when_idle`**:
  no interrumpe una tarea ocupada por defecto. El destinatario responde con la
  **herramienta explícita de reply** (`session_reply`, registrada por API
  pública OMP) que envía un `reply` estructurado con `replyTo = requestId`.
  **Ni `agent_end` ni el siguiente texto del modelo implican respuesta.**
  Herramientas de preguntas humanas (AskUserQuestion/question tool) están fuera
  de scope.
- `abort` reconoce cancelación solicitada, no rollback. Cancelar una espera
  local no cancela trabajo remoto implícitamente.
- Alias/selector ambiguo → `AMBIGUOUS_TARGET/ambiguous_target` (nunca elección
  silenciosa).

## Estados únicos (sin competidores)

`queued` (commit durable del broker) → `received` (journal incoming durable del
cliente/adaptador) → `submitted` (API OMP) → `completed` (resultado definido por
operación; en `ask` SOLO reply explícito). Alternos terminales: `rejected`,
`failed`, `expired`, `cancelled`, `outcome_unknown`. **No** existen
`accepted`/`delivered` ni equivalentes.

Máquina (`applyRequestEvent`):

| Desde | Evento → destino |
| --- | --- |
| `new` | `commit` → `queued` |
| `queued` | `receive`→`received`, `reject`→`rejected`, `fail`→`failed`, `expire`→`expired`, `cancel`→`cancelled`, `crash_window`→`outcome_unknown` |
| `received` | `submit`→`submitted`, `reject`→`rejected`, `fail`→`failed`, `expire`→`expired`, `cancel`→`cancelled`, `crash_window`→`outcome_unknown` |
| `submitted` | `complete`→`completed` (no-ask), `reply`→`completed` (solo ask), `fail`→`failed`, `expire`→`expired`, `cancel`→`cancelled`, `crash_window`→`outcome_unknown` |
| `outcome_unknown` | SOLO `reconcile_completed`→`completed`, `reconcile_failed`→`failed` |
| terminales (resto) | — (ninguna) |

Reglas:
- `complete` sobre un `ask` → `INVALID_INPUT/ask_requires_explicit_reply`.
- `reply` sobre no-ask → `INVALID_INPUT/invalid_transition`.
- Evento sobre estado terminal → `INVALID_INPUT/terminal_state`.
- Transición inexistente → `INVALID_INPUT/invalid_transition`.
- `outcome_unknown` + cualquier evento que no sea reconciliación →
  `INVALID_INPUT/outcome_unknown_no_replay` (**no autoriza repetición**).

Clasificación de señales nativas (`classifyAskCompletion`): `agent_end` y
`next_text` → `null` (no producen transición); `reply_tool` con
`replyTo === ask.requestId` y fuente autorizada → evento `reply`; `replyTo`
distinto → `INVALID_INPUT/reply_to_mismatch`; no autorizado → `UNAUTHORIZED`.

## Errores y exit codes

Tabla única en [exit-codes.md](exit-codes.md) / `freeze.json`; en código:
`PROTOCOL_ERROR_CODES`, `PROTOCOL_ERROR_TABLE` (terminalidad + retrySafe +
exitCode) y `cliExitCodeForError`. Ningún consumidor define su propia tabla.
