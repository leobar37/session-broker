---
id: P-006
goal: G-001
title: Handoff real verificable con SDK y adaptador consumibles sin publicación
status: completed
owner: coordinator
phase_type: integration
description: Integrar la verificación aislada completa y producir un handoff trazable al código real con consumo portable de paquetes públicos fuera del repositorio.
end_state: bun run verify y bun run test:handoff terminan con exit 0; existen docs/handoff/omp-broker-v1.json y .md con hashes reales, exports y evidencia reproducible de SDK y adaptador sin editar el monorepo ni publicar paquetes.
verification:
  - "bun run verify"
  - "bun run test:handoff"
  - "bun run --cwd /home/leobar37/code/broker test:handoff"
  - "Revisión del coordinador: hashes, versiones, exports, comandos, exitcodes, capabilities y limitaciones corresponden al código y evidencia actuales"
deliverables:
  - Harness agregador verify registrado por coordinador y suite tests/handoff
  - Handoff real docs/handoff/omp-broker-v1.json y docs/handoff/omp-broker-v1.md
  - Fixture consumidora portable de los cinco paquetes públicos con SDK y adaptador componibles
  - Evidencia reproducible aislada y trazabilidad FR/NFR a suites y resultados
entry_criteria:
  - P-005 aceptada y P-001 a P-004 verificadas; contratos públicos y límites estabilizados
  - Coordinador reunió cambios y es único ejecutor de gates; no workers escribiendo superficies verificadas
  - Proyección Climier reconciliada antes del claim
dependencies: [P-005]
requirements: [FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, NFR-001, NFR-002, NFR-003, NFR-004]
subagent: task
subagent_prompt: >-
  Ejecuta únicamente P-006 de .plans/omp-session-broker/phases/06-verified-consumer-handoff.md.
  Lee esa fase completa y usa literalmente su Task Anchor y Prompt de delegación compacto:
  handoff real reproducible sin editar el consumidor. Ownership y prohibiciones son los de esa fase.
  Trabaja edit-only; el coordinador reproduce verification. No edites frontmatter/journal ni aceptes tu tarea.
  Hallazgos ajenos se reportan sin investigar, reparar ni delegar. STOP tras entregables y reporte con anchor.
---

## Task Anchor

- **Objetivo del usuario, literal:** «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- **Unidad:** P-006/G-001 de `/home/leobar37/code/broker`: evidencia integrada y handoff del producto real; no implementar la integración en el monorepo.
- **Éxito observable futuro:** verify y test:handoff exit 0 reproducidos por coordinador; JSON/Markdown de handoff contienen hashes reales y consumo portable de SDK/adaptador público, sin commits/publicación obligatorios ni gates opt-in.

## Contexto y certeza

El hijo es un proyecto standalone Bun/TypeScript/SQLite con broker único, CLI, cliente reutilizable y primer adaptador OMP nativo; P-001 fija la frontera pública y P-005 la recuperación. Solo ahora, después de implementar y verificar, se puede producir un handoff veraz. No crear esos archivos ahora, ni completarlos con placeholders, exitcodes supuestos, hashes inventados o capabilities no comprobadas.

**Confirmado:** el maestro `/home/leobar37/.herdr/worktrees/theelena/control-de-caja/.plans/omp-broker-pilot/` debe bloquear su integración hasta consumir este handoff verificado; no es prerrequisito para terminar el hijo. **Inferido:** un consumidor temporal externo al workspace del broker demuestra mejor la reutilización que imports internos. **Desconocido hasta ejecución:** source hash/revision, versiones finales y resultados concretos; se derivan del código y gates reales, nunca de esta planificación.

## Áreas y ownership futuro

- `tests/handoff/`: consumidor temporal externo, validación de manifest/exports/versiones/hashes, portabilidad y guardas de aislamiento; su fixture no modifica el monorepo.
- `docs/handoff/omp-broker-v1.json` y `docs/handoff/omp-broker-v1.md`: **crear únicamente durante ejecución futura con evidencia real**. JSON machine-readable y Markdown legible deben representar la misma información.
- Harness agregador dentro de `tests/handoff/` y/o áreas de tests ya transferidas expresamente; root scripts/manifests/lockfiles exclusivamente coordinador, incluidos `verify` y `test:handoff`.
- Código de paquetes y suites previas son read-only para esta unidad salvo corrección propia dentro de ownership o transferencia explícita de defecto concreto a su owner por coordinador. No solucionar bugs ajenos desde la fase de handoff ni apropiarse de root.
- Monorepo, plan maestro, dotfiles, config/data reales y registro npm son fuera de ownership. No crear commits/repos por conveniencia, publicar paquetes, instalar servicios ni iniciar OMP/proveedores reales.

## Contrato público y consumo portable — FR-011

Los nombres propuestos que P-001 debe haber fijado, no publicar ahora:

| Paquete | Origen | Prueba de consumo requerida |
| --- | --- | --- |
| `@session-broker/protocol` | `packages/protocol` | Tipos/validadores/versiones mediante export map público. |
| `@session-broker/client` | `packages/client` | SDK reusable sin CLI, OMP ni internals de server. |
| `@session-broker/server` | `apps/broker` | Bootstrap/lifecycle público de servidor efímero sin inferencia. |
| `@session-broker/cli` | `apps/cli` | Entrypoint/contrato CLI y exitcodes reales de fixture. |
| `@session-broker/omp-adapter` | `packages/omp-adapter` | Composición del adaptador existente con SDK/contrato nativo y fake model; no reimplementación downstream. |

- Usar exactamente símbolos/signaturas/export maps fijados por P-001, no inventarlos durante validación. El handoff enumera exports y compatibilidad de Bun/TypeScript/OMP/protocolo según evidencia.
- Consumidor vive bajo TMP **fuera del árbol del broker**, importa por nombre de paquete y exports públicos. No aliases a `src/`, imports relativos privados ni lecturas de internals como workaround.
- Consumo sin npm mediante artefactos locales empaquetados o snapshot/copias y dependencias relativas portables definidos por P-001. No dependencias persistidas `file:/home/...` específicas de máquina, symlinks absolutos ni uso del monorepo como parte del build. Una ruta absoluta en instrucciones del operador no debe filtrarse al manifest de dependencias del consumidor.
- Probar relocalización: mover/copiar bundle y consumidor a segundo TMP, resolver los cinco paquetes otra vez sin el path original y repetir el smoke fake. Resolver tipos solamente no demuestra runtime; el fixture compone cliente, servidor y adaptador existente y ejecuta un ciclo de request/reply broker correlacionado por herramienta explícita del agente fixture, sin proveedor real.
- Capturar scripts de consumo, inputs, versiones y resultados necesarios para repetir. Ninguna integración en Elena, credencial real ni repo Git es necesaria para esta prueba.

## Handoff real: contenido mínimo obligatorio

1. **Identificación:** schema/version del handoff, protocolo, nombres/versiones/export maps y símbolos públicos fijados en P-001; fecha de evidencia y origen local del bundle sin datos sensibles.
2. **Trazabilidad de código:** source revision si existe y es útil; siempre hash determinista del conjunto fuente relevante con algoritmo, lista/regla de inclusión y exclusión explícita. No exigir commit ni inventar Git SHA; si no hay Git, declararlo. Excluir el propio handoff/evidencia generada, temporales y dependencias del hash para evitar autorreferencia, pero incluir contratos, manifests, source, lockfile si existe y tests/harness que determinan comportamiento. No permitir hash vacío o sólo de documentación.
3. **Verificación:** comandos exactos, cwd/entorno aislado, exitcodes reales, suites/casos cubiertos, identificadores/hash de resultados cuando corresponda y observación de teardown. No cambiar failure por pending o exit 0 ficticio para generar el archivo.
4. **Capacidades y limitaciones:** OMP versión/API evidenciada; ask/reply broker explícito disponible, capabilities opcionales supported/unsupported, root proof, grants/controlEpoch, entrega/dedup, límites y `outcome_unknown`. Presence/request state/job status separados. Core ask/reply no se declara cubierto mediante stub ni completion implícito en agent_end.
5. **Consumo:** receta reproducible offline/local del SDK y adaptador, compatibilidad y bundle hash, ningún import privado o paquete Elena, ninguna publicación requerida. Adaptador se reutiliza tal cual: no pedir al monorepo rehacer el bridge OMP.
6. **Operación/gates:** rutas conceptuales config/data fuera de worktrees, política de backup/restore y secretos, ausencia de live inference y service activation. G-LIVE/G-SERVICE quedan opt-in fuera del DoD hijo. Enumerar evidencia no realizada honestamente, sin vender preparación como ejecución real.

## DoD binario y fallos obligatorios

- [ ] `verify` invoca y espera typecheck más las seis suites declaradas (protocol, broker, cli, omp, recovery, handoff; siete verificaciones en total), propaga failure con exit distinto de 0, sin suites vacías/saltadas ni red externa/proveedores; cada suite tiene teardown.
- [ ] Suite `test:handoff` comprueba JSON/Markdown reales y su source hash, versiones/exports; un source modificado después, hash corrupto, export faltante o incompatibilidad produce exit no cero y bloquea integración.
- [ ] El consumidor externo usa los cinco paquetes públicos y compone SDK+adaptador con fake model; relocalización no depende de `/home/leobar37` ni del path inicial.
- [ ] La prueba request/reply usa `replyTo=requestId` por herramienta del agente; ni texto siguiente ni `agent_end` completan respuesta; lecturas siguen con contador de inferencia cero.
- [ ] Secretos/datos reales/proveedores/publicación/servicios permanecen ausentes; no se requiere commit, no se modifica monorepo ni dotfiles.
- [ ] Handoff distingue evidencia real, restricciones y capabilities; unknown/unsupported opcionales no ocultan un core faltante.
- [ ] Coordinador reproduce los comandos y revisa hashes/artefactos antes de aceptar; un reporte worker, archivo generado o budget consumido no equivale a DoD.

## Validación futura y orden sin evidencia circular

Scripts **a implementar**, no existentes por estar escritos aquí:

- `bun run typecheck`
- `bun run test:protocol`
- `bun run test:broker`
- `bun run test:cli`
- `bun run test:omp`
- `bun run test:recovery`
- `bun run test:handoff`
- `bun run verify` — agrega todos los anteriores, fail-fast o recopilación de fallos explícita, exit 0 solo si todos pasan, cleanup aun si falla.

Workers **edit-only** preparan pruebas/harness y formato del handoff; no ejecutan tests, gates, formateadores ni declaran resultados. El coordinador ejecutará suites sobre código integrado estable y materializará handoff con resultados reales. Para evitar autorreferencia, separar evidencia base del resultado del gate: producir manifest real con hash de fuente y resultados ya observados; `test:handoff` valida fuente/exports/consumo y ese manifest sin exigir que contenga su propio exitcode antes de terminar; anexar luego su resultado real a evidencia excluida del hash. `verify` incluye test:handoff, no a la inversa. Repetir gate final con evidencia vigente; no fabricar resultado de verify para poder arrancarlo.

Gate del maestro futuro: `bun run --cwd /home/leobar37/code/broker test:handoff` debe poder ejecutarse desde otro cwd, resolver todo respecto al proyecto y salir 0 sin editar el maestro. El hijo registra cómo repetirlo; no ejecuta integración externa por iniciativa propia. Todos los harness usan TMP/HOME/config/data/DB nuevos, fake runtime/model, guardas de red/proveedores y teardown total. No resultados de tests de usuario ni estado OMP personal.

**Evidencia pendiente:** todos los outputs/exitcodes, source hash/revision, artefactos reales y smoke de relocalización. Esta planificación no los crea ni ejecuta validación alguna. Si falla una suite ajena, reportar evidencia mínima y pausar únicamente el gate dependiente; corrección vuelve al owner apropiado sin expansión de scope.

## Gobernanza y riesgos

Task `T-BROKER-P006` de initiative `omp-session-broker`, dependency P-005; cierre de G-001 solo después de evidencia reproducida. Frontmatter canónico y journal tienen escritor único coordinador. Climier mantiene claims/submissions/proyección reconciliada antes de claim; no segunda verdad ni autoaccept worker. Coordinador reproduce personalmente toda `verification` antes de actualizar estado.

`G-BROKER-LIVE` (G-LIVE: proveedor/inferencia real/gasto) y `G-BROKER-SERVICE` (G-SERVICE: servicio persistente) son del operador, opt-in y fuera del DoD hijo; no bloquear este handoff por no tenerlos ni afirmar que están autorizados. G-001 no es gate. El maestro bloquea su integración hasta este handoff verificado, pero no puede convertir su propio despliegue/consumo en prerrequisito del hijo.

**Riesgos:** hash sin cobertura o dependencias absolutas crean reproducibilidad aparente; fixtures deben detectar ambos. Un cambio de fuente tras generar evidencia invalida el handoff y requiere nuevo gate del coordinador. No resolver esa invalidez editando a mano exitcodes, hashes o versionados. Una capability no demostrada se describe como tal; core incompleto bloquea entrega, no se maquilla como limitación opcional.

## Prompt de delegación compacto

> **Task Anchor:** Usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,». Unidad P-006/G-001; éxito: verify/test:handoff exit 0 reproducidos por coordinador y handoff real con hashes, exports y consumidor portable de SDK+adaptador, sin editar monorepo/publicar/commit obligatorio.
>
> **Rol/objetivo/contexto:** task especialista integración/handoff, skill feature-executor; leer completa `/home/leobar37/code/broker/.plans/omp-session-broker/phases/06-verified-consumer-handoff.md`, P-005 aceptada y contrato P-001. Preparar harness completo, schema/validación y consumidor externo portable; handoff solo con evidencia real durante ejecución futura, nunca ahora ni con stubs. Maestro futuro consume `bun run --cwd /home/leobar37/code/broker test:handoff`, no es prerequisite del hijo.
>
> **Ownership/validación:** `tests/handoff`, `docs/handoff` cuando haya evidencia real; root scripts/manifests/lockfile y generación final/evidencia del coordinador. Worker **edit-only: no ejecutar tests, gates ni formateadores**; dejar verificación pendiente. Coordinador reproduce verify y test:handoff con TMP/fake model y teardown, valida hash sin autorreferencia y relocalización sin file: absoluto/imports privados. SDK y adaptador deben consumirse, no rehacerse downstream. LIVE/SERVICE opt-in fuera DoD. Reconciliar antes de claim; no frontmatter/journal/autoaccept.
>
> **Scope/findings/STOP:** solo objetivo/ownership; reparar regresiones propias autorizadas. Hallazgos ajenos intactos y evidencia mínima de ubicación/fallo/impacto con incertidumbre explícita; no investigar, reparar ni delegar. Bloqueos pausan solo unidad dependiente y se notifican al coordinador/owner sin tomar control; nadie puede ampliar alcance. No limpiar/revertir/stage cambios ajenos. STOP al entregar artefactos/pruebas preparadas; coordinador ejecuta gates y materializa evidencia veraz.
>
> **Reporte:** comenzar restatando anchor objetivo/unidad/éxito; archivos, contrato consumidor y cobertura de hash, pruebas preparadas, evidencia real disponible frente a pendiente, límites/bloqueos mínimos. No inventar exitcodes/hashes ni declarar G-001 completado: el cierre pertenece al coordinador.
