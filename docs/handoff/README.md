# Handoff verificado del omp-session-broker (P-006 / G-001)

Este directorio contiene los artefactos de handoff **materializados con evidencia
real** por el coordinador. Este README documenta cómo generarlos; **no** es un
sustituto de los artefactos.

- `omp-broker-v1.json` — handoff machine-readable (fuente única de verdad).
- `omp-broker-v1.md` — proyección Markdown determinista del JSON (se genera, no se edita).
- `evidence/consumer.fragment.json` — fragmento REAL del bloque `consumer` que
  escribe la suite del consumidor (ver «Fragmento del consumidor»).

Ambos artefactos **solo se crean ejecutando el generator con evidencia real**:
no existen placeholders ni stubs, y `bun run test:handoff` FALLA con un mensaje
claro mientras no estén materializados.

## Pipeline de DOS ESTADOS (sin evidencia circular)

`test:handoff`, `verify` y `test:handoff-other-cwd` solo pueden dar exit 0
cuando los artefactos YA existen. Por eso el evidence input tiene un campo
`stage` y los resultados aún no observados se marcan **explícitamente** como
`pending` con `exitCode: null` — nunca se fabrica un 0 para poder arrancar.

**Orden exacto que ejecuta el coordinador:**

```sh
# 1) Gates base (siempre resultados REALES, en verde):
bun run typecheck
bun run test:protocol
bun run test:broker
bun run test:cli
bun run test:omp
bun run test:recovery

# 2) Suite del consumidor: escribe el fragmento real (ver abajo)
bun test tests/handoff/consumer.test.ts

# 3) Materializar en stage PRE-GATE (evidence-pre-gate.json con los tres
#    comandos autorreferenciales y la suite "handoff" en pending/null):
bun tests/handoff/build-handoff.ts --evidence <ruta>/evidence-pre-gate.json --stage pre-gate

# 4) Gates que dependen de los artefactos (REALES ahora sí):
bun run test:handoff
bun run verify
bun run --cwd /home/leobar37/code/broker test:handoff

# 5) Evidence FINAL: los 9 comandos con exit codes REALES (0) y las 6 suites
#    con resultados REALES (incluida "handoff"); ningún pending.
bun tests/handoff/build-handoff.ts --evidence <ruta>/evidence-final.json --stage final

# 6) Repetir con la evidencia vigente (los artefactos finales deben validar):
bun run test:handoff
bun run verify
```

Si en el paso 6 los resultados difieren de los registrados en el evidence
final, se corrige el evidence con lo realmente observado y se regenera:
**nunca** se editan a mano hashes, exit codes, versiones o el Markdown.

## Comando exacto del generator

```sh
bun tests/handoff/build-handoff.ts --evidence <ruta-al-evidence.json> [--stage pre-gate|final] [--out <dir>] [--repo-root <dir>] [--check]
```

| flag | significado |
| --- | --- |
| `--evidence <path>` | (obligatorio) evidence input real, schema `omp-session-broker-evidence/1` |
| `--stage pre-gate\|final` | (opcional) exige que el `stage` del evidence coincida |
| `--out <dir>` | directorio de salida (default `docs/handoff`) |
| `--repo-root <dir>` | raíz del repo (default: este checkout) |
| `--check` | valida y calcula SIN escribir artefactos |

Exit codes del generator: `0` ok · `1` evidencia/coherencia inválida · `2` error
de uso. Determinismo: mismo evidence + misma fuente ⇒ mismos bytes (sin relojes
propios: la fecha viene del evidence; las rutas absolutas de esta máquina se
normalizan a `<repo>` / `~` y si queda alguna, falla). El source hash es
idéntico entre stages: solo cambian los campos de evidencia.

## Fragmento del consumidor (bloque `consumer` REAL)

`bun test tests/handoff/consumer.test.ts` ejecuta el smoke del consumidor FUERA
del repo (snapshot + `bun pm pack` + `bun install --offline`) y, **solo si ambos
smokes pasan**, escribe:

```
docs/handoff/evidence/consumer.fragment.json
```

con el bloque `consumer` observado (`smokeExitCode`, `relocationExitCode`,
`vendorArtifacts` con sha256/bytes reales de los `.tgz`). Ruta estable, excluida
del source hash (`docs/handoff/**`); también se imprime en stdout.

**Fusión:** copiar el objeto `consumer` del fragmento literalmente al campo
`consumer` del evidence input (ambos stages). El generator lo cruza si el
fragmento existe: exit codes y nombres de artefactos deben coincidir.

**Exit codes reproducibles:** `smokeExitCode`/`relocationExitCode` son los exit
codes de los dos smoke (snapshot inicial y relocalización); equivalen a que
`bun test tests/handoff/consumer.test.ts` termine en 0. Un fragmento ausente
significa que esa corrida no estuvo en verde (la suite lo borra al arrancar y
solo lo reescribe con resultados reales).

## Schema del evidence input (`omp-session-broker-evidence/1`)

Los valores de abajo son ILUSTRATIVOS: el generator exige los conteos y exit
codes **observados** en tu corrida real (nunca los rellenes a mano). Ejemplo en
stage `pre-gate` (los pendientes van explícitos):

```jsonc
{
  "schema": "omp-session-broker-evidence/1",
  "stage": "pre-gate",
  "evidenceDate": "2026-09-26T12:00:00Z",
  "operator": "coordinator",
  "environment": { "bun": "1.4.2", "typescript": "7.0.2", "os": "linux" },

  "commands": [
    { "id": "typecheck", "command": "bun run typecheck", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "test:protocol", "command": "bun run test:protocol", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "test:broker", "command": "bun run test:broker", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "test:cli", "command": "bun run test:cli", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "test:omp", "command": "bun run test:omp", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "test:recovery", "command": "bun run test:recovery", "cwd": ".", "status": "ok", "exitCode": 0 },
    { "id": "verify", "command": "bun run verify", "cwd": ".", "status": "pending", "exitCode": null },
    { "id": "test:handoff", "command": "bun run test:handoff", "cwd": ".", "status": "pending", "exitCode": null },
    { "id": "test:handoff-other-cwd",
      "command": "bun run --cwd <repo> test:handoff", "cwd": ".", "status": "pending", "exitCode": null }
  ],

  "suites": [
    { "suite": "protocol", "status": "ok", "tests": 83, "failures": 0, "skipped": 0, "exitCode": 0 },
    { "suite": "broker",   "status": "ok", "tests": 46, "failures": 0, "skipped": 0, "exitCode": 0 },
    { "suite": "cli",      "status": "ok", "tests": 63, "failures": 0, "skipped": 0, "exitCode": 0 },
    { "suite": "omp",      "status": "ok", "tests": 25, "failures": 0, "skipped": 0, "exitCode": 0 },
    { "suite": "recovery", "status": "ok", "tests": 46, "failures": 0, "skipped": 0, "exitCode": 0 },
    { "suite": "handoff",  "status": "pending", "tests": null, "failures": null, "skipped": null, "exitCode": null }
  ],

  "teardown": "observación REAL de teardown (TMP con prefijo, HOME/XDG efímeros, fake model, red bloqueada)",

  "consumer": {
    "smokeExitCode": 0,
    "relocationExitCode": 0,
    "vendorArtifacts": [
      { "file": "session-broker-protocol-0.1.0.tgz",    "sha256": "<64 hex>", "bytes": 12345 },
      { "file": "session-broker-client-0.1.0.tgz",     "sha256": "<64 hex>", "bytes": 12345 },
      { "file": "session-broker-server-0.1.0.tgz",     "sha256": "<64 hex>", "bytes": 12345 },
      { "file": "session-broker-cli-0.1.0.tgz",        "sha256": "<64 hex>", "bytes": 12345 },
      { "file": "session-broker-omp-adapter-0.1.0.tgz","sha256": "<64 hex>", "bytes": 12345 }
    ]
  },

  "omp": { "version": "omp v18.3.1 (binario) con fuentes 18.3.1", "notes": "opcional" },

  "capabilities": [
    { "name": "session.identity",         "status": "supported",   "evidence": "tests/omp/…; consumer smoke" },
    { "name": "session.observe",          "status": "supported",   "evidence": "…" },
    { "name": "session.prompt.when_idle", "status": "supported",   "evidence": "…" },
    { "name": "session.reply_tool",       "status": "supported",   "evidence": "…" },
    { "name": "root.binding",             "status": "supported",   "evidence": "…" },
    { "name": "session.notify",           "status": "partial",     "evidence": "solo tema reservado broker.session.status" },
    { "name": "session.control.prompt",   "status": "unsupported", "evidence": "matriz §5" },
    { "name": "session.control.steer",    "status": "unsupported", "evidence": "matriz §5" },
    { "name": "session.control.follow_up","status": "unsupported", "evidence": "matriz §5" },
    { "name": "session.control.abort",    "status": "unsupported", "evidence": "matriz §5" }
  ],

  "limitations": [
    "… (al menos una, honesta; p. ej. el shim real de binding OMP no se construyó aquí)"
  ],

  "notPerformed": [
    "G-BROKER-LIVE: no se ejecutó inferencia real ni se contactó proveedores",
    "G-BROKER-SERVICE: no se instaló/habilitó/arrancó ningún servicio"
  ],

  "requirements": [
    { "id": "FR-001", "suites": ["broker", "cli"], "result": "pass" },
    { "id": "FR-002", "suites": ["cli"], "result": "pass" },
    { "id": "FR-003", "suites": ["omp", "broker"], "result": "pass" },
    { "id": "FR-004", "suites": ["broker"], "result": "pass" },
    { "id": "FR-005", "suites": ["broker", "cli"], "result": "pass" },
    { "id": "FR-006", "suites": ["omp", "broker"], "result": "pass" },
    { "id": "FR-007", "suites": ["recovery"], "result": "pass" },
    { "id": "FR-008", "suites": ["omp"], "result": "pass" },
    { "id": "FR-009", "suites": ["recovery"], "result": "pass" },
    { "id": "FR-010", "suites": ["recovery", "cli"], "result": "pass" },
    { "id": "FR-011", "suites": ["handoff"], "result": "pass" },
    { "id": "NFR-001", "suites": ["broker", "omp"], "result": "pass" },
    { "id": "NFR-002", "suites": ["handoff", "recovery"], "result": "pass" },
    { "id": "NFR-003", "suites": ["handoff"], "result": "pass" },
    { "id": "NFR-004", "suites": ["protocol", "broker"], "result": "pass" }
  ]
}
```

### Reglas por stage (la validación las hace cumplir)

- `commands`: los nueve `id` son OBLIGATORIOS y sus `command` deben coincidir
  literalmente (`EXPECTED_COMMANDS`). `status: "pending"` exige `exitCode: null`
  y solo se permite en stage `pre-gate` para `verify`, `test:handoff` y
  `test:handoff-other-cwd` (`SELF_REFERENTIAL_COMMAND_IDS`). En stage `final`
  los nueve van `status: "ok"` con exit code REAL 0. Cualquier exit code ≠ 0 es
  inconsistencia y bloquea la generación/validación.
- `suites`: las seis suites, `tests > 0` cuando hay resultados. `pending` solo
  en stage `pre-gate` y solo para la suite `handoff` (`SELF_REFERENTIAL_SUITE`),
  con todos los números en `null`. En `final`, todas `ok` con números reales
  (`failures = 0`, `skipped = 0`, `exitCode = 0`).
- `generatedFrom.stage` debe coincidir con `verification.stage`: artefactos de
  un stage con evidencia de otro ⇒ fallo.
- `consumer`: siempre real (fragmento del consumidor), en ambos stages.
- `capabilities`: exactamente las capacidades de `docs/contracts/freeze.json`;
  las CORE (`session.identity`, `session.observe`, `session.prompt.when_idle`,
  `session.reply_tool`, `root.binding`) deben estar `supported` — un core
  faltante bloquea la entrega, no se convierte en «limitación».
- `requirements`: una fila por FR-001..FR-011 y NFR-001..NFR-004; `result` es
  `"pass"` o `"partial"` (y `"partial"` exige `notes`).
- `limitations` y `notPerformed` no pueden estar vacíos: el handoff distingue
  evidencia real, restricciones y capabilities sin ocultar lo no realizado.

En el Markdown, los resultados pendientes se renderizan como
`pending — se anexa al cierre del gate` (en JSON y MD, misma información), y el
handoff declara su `stage` para distinguir qué era pending al materializar de
qué está observado.

## Source hash (trazabilidad sin commits)

El repo está inicializado **sin commits**: el handoff declara «sin commit» y usa
el hash determinista `sha256-canonical-file-manifest-v1`
(`tests/handoff/lib/source-hash.ts`), sobre contratos, manifests, lockfile,
source, tests/handoff y artefactos operativos, excluyendo el propio handoff,
`docs/handoff/**` (incluido el fragmento del consumidor), `.plans/**`,
`node_modules`, `.git`, dist/coverage y temporales. La suite re-computa el hash
en cada `test:handoff`: fuente modificada tras generar ⇒ fallo (`source-hash-mismatch`).

## Qué NO hace este directorio

- No publica npm, no crea commits, no instala servicios, no ejecuta inferencia
  real ni toca el monorepo maestro. G-BROKER-LIVE y G-BROKER-SERVICE son gates
  humanos opt-in FUERA del DoD.
- No almacena secretos: credenciales/MAC keys jamás aparecen en el handoff.
