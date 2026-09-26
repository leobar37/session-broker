# CORRECTIVE HANDOFF — P-001 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-001/G-001 en /home/leobar37/code/broker. Éxito observable: contrato con 5 nombres+exports+versión+exitcodes+ownership congelados, fixtures negativos estables, identidad distinguida no heredable, dedup/outcome_unknown/reply explícito correctos, matriz OMP con evidencia; `bun run typecheck` y `bun run test:protocol` exit 0 reproducidos por el coordinador.

## Contexto de corrección (coordinador reprodujo los gates sobre tu entrega)
El wiring raíz YA quedó resuelto por el coordinador (symlink de workspace vía devDependency raíz): la resolución de `@session-broker/protocol` funciona. Reproduje `bun run typecheck` y `bun run test:protocol`: quedan EXACTAMENTE 3 gaps abiertos que son tuyos. Reglas iguales: EDIT-ONLY (sin ejecutar tests/typecheck/builds/formatters/installs), ownership `packages/protocol/**`, `tests/protocol/**`, `docs/contracts/**`, `docs/compatibility/**`; sin tocar raíz, `.plans/**`, Climier, git, monorepo ni dotfiles. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`) en el reporte.

## Gaps a corregir (evidencia exacta observada por el coordinador)

1. `tests/protocol/identity.test.ts:54` — FAIL: `expect(isNativeSessionId(FIXTURE_PROJECT_ID)).toBe(true)`… recibido `true`, esperado `false`. El contrato congelado exige que cada tipo de identificador viva en su propio espacio de nombres (docs/contracts/identity.md): los validadores DEBEN ser disjuntos, i.e. `isNativeSessionId` no puede aceptar un `prj_…` (ni IDs de otros namespaces: `wsp_`, `inst_`, `cn_`, `req_`, `evt_`, `grant_`, `rp_`, `chal_`, etc.). Endurece los validadores en `packages/protocol/src/ids.ts` para que rechacen el prefijo reservado ajeno (mantén el formato opaco que congelaste para IDs nativas ajenas al broker), y ajusta la documentación/freeze si el texto quedara ambiguo. Si consideras que el TEST contradice el contrato, corrige el test para reflejar la semántica disjunta congelada; nunca aflojes el contrato.

2. `tests/protocol/grants-root.test.ts:84` — FAIL: test «fuera de scope se deniega sin filtrar existencia» esperaba rechazo `UNAUTHORIZED/unauthorized_scope` y la operación FUE ACEPTADA. FR-004/NFR-001 lo exigen: un grant válido solo autoriza dentro de su scope (proyecto/workspace/target/sesión/capability); fuera de scope => `UNAUTHORIZED/unauthorized_scope` sin filtrar existencia. Revisa `evaluateGrant`/`parseGrant` (y su uso en los validadores de operación) para que deniegue correctamente ese caso del test (probablemente falta comprobar el scope de la operación objetivo o el alcance de proyecto/target). Mantén el resto de denegaciones existentes funcionando.

3. `tests/protocol/contract-freeze.test.ts(110,32)` y `(111,35)` — TS2769: `expect(manifest.name).toBe(entry?.name)` y `expect(manifest.version).toBe(entry?.version)` reciben `string | undefined` porque `entry?.name`/`entry?.version` son opcionales. Tras `expect(entry).toBeDefined()`, añade un guard explícito (`if (!entry) throw new Error("freeze entry @session-broker/protocol ausente");`) y usa `entry.name`/`entry.version`. Nota de entorno: TypeScript 7 resuelve acceso por índice/opcional como `T | undefined`; escribe el resto del código con eso en cuenta.

## Validación pendiente (solo el coordinador la ejecuta)
Tras tus correcciones el coordinador reproducirá `bun run typecheck` (exit 0) y `bun run test:protocol` (exit 0). Tú NO ejecutes nada. En tu reporte: razonamiento estático de cada fix, archivos tocados y cualquier efecto sobre freeze.json/docs si aplica.

## Reporte
Empieza restatando el Task Anchor; luego modelo efectivo confirmado, archivos modificados, explicación estática de los 3 fixes, evidencia, pendientes y bloqueos mínimos. Cierra con STOP.
