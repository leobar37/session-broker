---
id: G-001
title: Broker standalone durable con adaptador OMP y entrega consumible
status: completed
end_state: "bun run verify finaliza con exit 0 y valida docs/handoff/omp-broker-v1.json y .md contra la fuente y exports públicos entregados, sin inferencia ni estado real."
verification:
  - "bun run verify # exit 0, suites aisladas completas y entrega validada"
  - "docs/handoff/omp-broker-v1.json y docs/handoff/omp-broker-v1.md existen y describen evidencia real reproducible"
budget: "Máximo 6 unidades de fase por ciclo; al alcanzar límite de contexto o presupuesto, liberar claims y registrar budget-limited, nunca completar por agotamiento. No se autoriza gasto de pruebas ni servicios persistentes."
---

# G-001 — Broker independiente verificable

## Task Anchor

Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».

Esta entrega actual prepara un subplan autónomo y launcher. La ejecución futura se habilita solo cuando el usuario abre broker y ejecuta el script manualmente. El éxito futuro es software standalone reproducible y handoff verificado, no un servicio real instalado ni un piloto pago.

## Description

Entregar un broker genérico Bun/TypeScript + SQLite con clientes outbound autenticados, identidad por proyecto/checkout/sesión, deduplicación durable y recovery honesto, cliente público/CLI y adaptador OMP que conserve TUI nativa. La entrega permite al maestro consumir exports públicos desde fuente local sin publicación npm ni dependencia inversa de Elena.

## End State

`bun run verify` termina con exit 0 sobre la revisión/fuente identificada en el handoff, incluyendo todas las suites no vacías y consumo por fixture externo aislado. Los archivos `docs/handoff/omp-broker-v1.json` y `.md` coinciden en versión de protocolo, exports, hash/revisión, comandos/exit codes, capabilities y límites. Seis fases completadas únicamente con evidencia personalmente reproducida por el coordinador.

## Deliverables futuros

- Contrato público versionado y boundaries de paquetes congelados en P-001.
- Broker único, almacenamiento SQLite, auth/grants, directorio y delivery durable.
- CLI de init idempotente y cliente reusable, sin secretos versionados.
- Adaptador OMP nativo con bootstrap raíz seguro y capacidades reales declaradas.
- Recovery, backup/restore, backpressure, diagnóstico y artefacto opt-in systemd user probado en fixtures.
- Suites aisladas y scripts de verificación; handoff reproducible JSON + Markdown.

## Definition of Done

Los siguientes scripts son **a IMPLEMENTAR**, no comandos disponibles en este estado PLANNING ONLY:

| Comando futuro | Resultado mínimo observable |
| --- | --- |
| `bun run typecheck` | Exit 0 para todos los paquetes/contratos y fixtures tipados |
| `bun run test:protocol` | Exit 0; schemas, versión, IDs, estados y errores válidos/negativos |
| `bun run test:broker` | Exit 0; permisos, persistencia y routing con SQLite temporal |
| `bun run test:cli` | Exit 0; init repetido/clones/checkout/config/exit codes y cliente mock |
| `bun run test:omp` | Exit 0; API fake, raíz/no-subagente, ask/reply, TUI no sustituida |
| `bun run test:recovery` | Exit 0; ventanas de crash, desconocidos sin replay, backup/restore y servicio fake |
| `bun run test:handoff` | Exit 0; consumidor externo y handoff source/exports/commands comprobados |
| `bun run verify` | Exit 0; agrega typecheck y todas las suites, no omite ausentes/vacías, teardown completo |

El handoff no se genera anticipadamente. P-006 define el manifiesto determinista de fuente (excluyendo outputs generados para evitar hash circular), valida revisión/hash sin exigir commits y registra evidencia real. El consumidor de prueba no usa imports privados ni necesita ejecutar el plan maestro.

## Constraints / Must Not Change

- Ámbito exclusivo `/home/leobar37/code/broker`; sin editar monorepo ni dotfiles compartidos.
- No inferencia real en suites; DB/config/journals/test sessions temporales. No contenedores ni acceso al estado del usuario.
- Presencia no es job status. No exactamente-una-vez; unknown requiere reconciliación. IDs/grants autenticados, no UUID como auth.
- Broker restart no relaunch OMP ni repetición de tools. TUI y runtime OMP permanecen nativos.
- Coordinador único escribe frontmatter/journal y verifica; workers no autoaceptan.

## Non-Goals y gates

Instalar/activar servicio real requiere G-SERVICE; inferencia/proveedores/pilotos reales requieren G-LIVE. Ambos gates son opcionales, quedan cerrados por defecto y **no bloquean este DoD software**. Tampoco se autorizan publicación, deployment, commits, cambios en productos ni lanzamiento por RPC. Abrir el plan o ejecutar `--print` no autoriza implementación.

## Budget y parada

El presupuesto no sustituye DoD. Ante agotamiento, conservar evidencia, liberar claim de forma segura y registrar `budget-limited` en journal sin inventar un status canónico nuevo. Una decisión o bloqueo externo pausa solo la unidad afectada. No investigar ni corregir hallazgos fuera de scope. STOP tras verificación y handoff propios; el usuario decide si procede con maestro/servicio/piloto.

## Decomposition

[P-001 → (P-002 || P-003) → P-004 → P-005 → P-006](phase-index.md). Todos pertenecen exclusivamente a G-001.

## Open Questions asignadas

P-001 verifica APIs OMP/versiones y congela contrato/exports/exit codes antes de paralelismo. El catálogo dotfiles carece de pares completos; la lectura complementaria del CLI confirmó los IDs del overlay local el 2026-09-25. En cada arranque sigue siendo obligatorio comprobar status line y cualquier override, sin aceptar fuzzy fallback.
