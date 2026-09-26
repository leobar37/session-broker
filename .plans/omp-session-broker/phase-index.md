# Índice de fases — omp-session-broker

- Modo: structured autorizado, seis fases autónomas.
- Goal único: [G-001](goal.md), pendiente.
- Requisitos: [requirements.md](requirements.md).
- Contexto/ownership/gates: [context.md](context.md).
- Estado canónico: frontmatter de cada fase; este índice no mantiene otro status.
- Bitácora append-only: [journal.md](journal.md), escritor único coordinador.

## Fases y DAG

| Fase | Tipo | Archivo | Resultado | Dependencias locales | Task Climier futuro |
| --- | --- | --- | --- | --- | --- |
| P-001 | design | [Contratos e identidad](phases/01-contracts-and-identity.md) | Contratos, APIs, foundation y ownership congelados | Ninguna | T-BROKER-P001 |
| P-002 | implementation | [Broker durable autorizado](phases/02-durable-authorized-broker.md) | SQLite, grants, delivery y directorio | P-001 | T-BROKER-P002 |
| P-003 | implementation | [Init y cliente público](phases/03-project-init-and-client.md) | CLI idempotente y cliente reusable | P-001 | T-BROKER-P003 |
| P-004 | implementation | [Adaptador OMP nativo](phases/04-native-omp-adapter.md) | Outbound y binding raíz con journal | P-002, P-003 | T-BROKER-P004 |
| P-005 | implementation | [Recovery y operación opt-in](phases/05-recovery-and-opt-in-operation.md) | Recovery/fault tests y operación segura | P-004 | T-BROKER-P005 |
| P-006 | integration | [Handoff consumible verificado](phases/06-verified-consumer-handoff.md) | verify y entrega pública reproducible | P-005 | T-BROKER-P006 |

```text
P-001 ─┬─ P-002 ─┐
       └─ P-003 ─┴─ P-004 ─ P-005 ─ P-006
```

## Paralelismo y contratos

P-002 y P-003 pueden ejecutarse simultáneamente solo tras congelar contratos/fixtures/ownership en P-001. P-002 posee broker y sus tests; P-003 cliente/CLI y sus tests. Prueban contra el mismo contrato, no contra cambios no entregados del hermano. Solo coordinador integra manifiestos raíz, lockfile y scripts. Si aparece una necesidad de contrato compartido, pausar esa parte, acordar con dueño y volver a verificar contrato antes de continuar; no aceptar divergencias.

Fases restantes son secuenciales porque consumen entregables aceptados. Cada fase es una unidad delegable con Task Anchor, áreas, resultado y verificaciones, no una lista de microtareas independientes.

## Trazabilidad

| Requisito | Fases que lo declaran en frontmatter |
| --- | --- |
| FR-001 | P-001, P-002, P-003, P-006 |
| FR-002 | P-001, P-003, P-006 |
| FR-003 | P-001, P-002, P-004, P-006 |
| FR-004 | P-001, P-002, P-003, P-004, P-005, P-006 |
| FR-005 | P-002, P-003, P-004, P-006 |
| FR-006 | P-001, P-002, P-003, P-004, P-006 |
| FR-007 | P-001, P-002, P-003, P-004, P-005, P-006 |
| FR-008 | P-001, P-004, P-006 |
| FR-009 | P-002, P-005, P-006 |
| FR-010 | P-005, P-006 |
| FR-011 | P-001, P-003, P-006 |
| NFR-001 | P-001, P-002, P-003, P-004, P-005, P-006 |
| NFR-002 | P-001, P-002, P-003, P-004, P-005, P-006 |
| NFR-003 | P-001, P-002, P-003, P-004, P-005, P-006 |
| NFR-004 | P-001, P-002, P-003, P-004, P-005, P-006 |

Matriz reconciliada por lectura con el frontmatter de las seis fases. P-006 verifica la cobertura integrada de todos los requisitos; no sustituye la aceptación específica de cada unidad.

## Climier y bootstrap futuro

El DAG aún NO se ha creado. Al lanzamiento manual real, el coordinador verifica `climier --help` y ayuda específica vigente antes de elegir sintaxis. Si faltan Git o metadatos Climier, prepara solo metadatos locales e idempotentes; verifica que no opera dentro de un repositorio ancestro ajeno. Sin commits ni servicios automáticos.

1. Descubrir/crear iniciativa `omp-session-broker`, sin duplicar IDs.
2. Sembrar primero gates `G-BROKER-LIVE` (G-LIVE) y `G-BROKER-SERVICE` (G-SERVICE).
3. Crear exactamente un task por fase, en orden topológico, con `end_state` y `verification` como acceptance y decisiones/ownership en body.
4. Ninguno de los seis tasks base depende de gates opcionales de acciones reales. El software se completa con fixtures; el operador mantiene esos gates cerrados salvo autorización específica.
5. Reconciliar claims/submissions/aceptación con frontmatter y evidencia antes de tomar trabajo. Claims son exclusión operativa, no prueba de completado.
6. Worker entrega; coordinador reproduce personalmente verificaciones sobre unión integrada y acepta/rechaza. Solo después actualiza `status`/`owner` y journal. Si hay interrupción entre escrituras, registrar/reconciliar sin fingir atomicidad entre archivos y Climier.

El goal documental G-001 no es un gate Climier y nunca comparte ID con éstos. No se copian comandos frágiles de otra instalación ni se exige que el usuario haya sembrado un DAG antes de iniciar la sesión.

## Gate de integración con maestro

El plan hijo no depende de ejecución del maestro. P-006 entrega `docs/handoff/omp-broker-v1.json` + `.md`; el maestro valida esa evidencia y solo entonces puede continuar integración bajo su propia autorización. Ninguna fase del hijo modifica monorepo, inicia servicio real ni ejecuta el piloto.

## Verificación y parada

Comandos son scripts futuros a implementar: `bun run typecheck`, `test:protocol`, `test:broker`, `test:cli`, `test:omp`, `test:recovery`, `test:handoff`, `verify`. Coordinador los ejecuta al integrar cada fase; workers no corren gates/formatters en paralelo. La planificación actual no ejecuta ninguno. Hallazgos ajenos no autorizan arreglos ni delegaciones. STOP después de P-006 verificado; presupuesto agotado no equivale a completed.
