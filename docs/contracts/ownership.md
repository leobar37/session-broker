# Ownership por fase (proyección de `context.md`)

Fuente: `.plans/omp-session-broker/context.md` → «Superficie futura y
ownership». Esta tabla es contrato de fronteras entre fases; no se edita desde
las ramas de implementación.

| Área | Responsable de fase | Contrato |
| --- | --- | --- |
| `packages/protocol/`, `docs/contracts/`, fixtures contractuales | P-001; cambios posteriores coordinados | Protocolo versionado, identidad, schemas, exports y errores |
| `apps/broker/`, `tests/broker/` | P-002 | SQLite, auth, routing, estado durable |
| `packages/client/`, `apps/cli/`, `tests/cli/` | P-003 | Cliente reusable, init idempotente y configuración |
| `packages/omp-adapter/`, `tests/omp/` | P-004 | Binding raíz, API nativa, journal incoming |
| `tests/recovery/`, `ops/`, operación/backup | P-005 | Recovery determinista y servicio opt-in |
| `tests/handoff/`, `docs/handoff/` | P-006 | Consumo público aislado y evidencia final |
| Manifiestos raíz, lockfile y wiring de scripts | Solo coordinador | Integra cambios de fases sin escrituras concurrentes |

## Reglas adicionales congeladas en P-001

- `tests/protocol/` pertenece a P-001 (contrato); el resto de suites pertenecen
  a su fase.
- `docs/compatibility/` lo escribe P-001; su revisión ante API drift la coordina
  el coordinador (P-004 consume la matriz).
- Instalación OMP: solo lectura (archivos, tipos, `--help`); nunca modificación
  global ni arranque de sesiones/proveedores.
- Ninguna fase edita `.plans/**`, frontmatter, journal ni la raíz
  (`package.json`, `tsconfig.json`, `scripts/*`, `bun.lock`): las necesidades de
  raíz se reportan al coordinador.
- Tras el freeze, los cambios en `packages/protocol/**` y `docs/contracts/**`
  se serializan con el coordinador; P-002/P-003 no los modifican en paralelo.
