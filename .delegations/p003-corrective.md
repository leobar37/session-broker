# CORRECTIVE HANDOFF — P-003 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-003/G-001 en /home/leobar37/code/broker (init/CLI + cliente reutilizable). Éxito observable: `bun run typecheck` y `bun run test:cli` exit 0 reproducidos por el coordinador; consumo solo por exports públicos; sin dependencia de P-002.

## Contexto de corrección (coordinador reprodujo `bun run test:cli`)
Resultado observado: 8 pass / 6 fail. Los 6 fallos son UNA sola causa raíz: `jsonOutput(run)` = `JSON.parse(run.stdout)` recibe la salida HUMANA de la CLI (`apps/cli/src/output.ts:34` escribe `ok ${command} ...` en modo no-JSON) porque los tests NO pasan `--json`. Detalle exacto:
- `SyntaxError: JSON Parse error: Unexpected identifier "ok"` en `tests/cli/helpers.ts` `jsonOutput`, disparado desde `tests/cli/init.test.ts` (4 tests: «init repetido conserva IDs…», «projectId sobrevive a dos checkouts…», «copia de workspace.json no acredita otro checkout…», «repo ausente: init funciona sin crear Git…») y desde los `beforeAll` de `tests/cli/client.test.ts:46` y el test sin nombre restante (cascada del mismo `beforeAll`).

## Gaps a corregir (edit-only; ownership inalterado)
1. Haz consistente el contrato de salida CLI ↔ tests. Diseño esperado (salvo que tu contrato congelado diga otra cosa, en cuyo case REPÓRTA la divergencia): salida humana `ok <command> …` por defecto y EXACTAMENTE un objeto JSON por línea cuando se pasa `--json` (`output.ts:31`). Entonces los tests que asertan JSON deben pasar `--json` en sus `captureCli([...])`, y debe existir cobertura explícita de AMBOS formatos (humano y `--json`), incluyendo que el modo `--json` emite JSON parseable incluso ante errores (con `ok:false` y código) y que ambos modos redactan secretos. Ajusta `jsonOutput`/helpers solo dentro de `tests/cli/`.
2. Revisa que ningún test dependa de que `init` sea JSON sin `--json` (afina `tests/cli/init.test.ts`, `client.test.ts`, `cli.test.ts`, `consumer.test.ts` según corresponda). No cambies la semántica de exit codes congelada ni las firmas públicas (`runCli(argv): Promise<number>`, `createClient`, `BrokerClient`, `ClientOptions`, `Subscription`).
3. No toques `packages/protocol`, `docs/contracts`, `apps/broker`, `tests/broker` ni raíz/.plans. Si hallas un defecto de contrato, repórtalo en vez de parchear.

## Reglas
EDIT-ONLY: no ejecutes tests/typecheck/builds/formatters/installs; el coordinador reproduce `bun run typecheck` y `bun run test:cli` después. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`) en el reporte. Sin monorepo/dotfiles/git/Climier/publicación/servicios/inferencia real.

## Reporte
Anchor restatado, modelo efectivo, archivos modificados, explicación estática del fix del contrato de salida, cobertura añadida, pendientes y bloqueos mínimos. Cierra con STOP.
