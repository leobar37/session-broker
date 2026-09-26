# CORRECTIVE HANDOFF #4 — P-002 (misma unidad, mismo ownership)

## Task Anchor (restatélo en tu reporte)
- Objetivo literal del usuario: «no, mejor corremos esto ahi manualmente, yo abro el proyecto y ehecuta el script de orquestate sesion, este plan incluye un plan global que esta aqui en este repo, un plan dentro de la carpeta broker,».
- Unidad: P-002/G-001. Éxito observable: `bun run typecheck` y `bun run test:broker` exit 0 reproducidos por el coordinador.

## Contexto (coordinador reprodujo gates tras tu corrective #3)
Estado: typecheck exit 0 ✓, test:cli 63/0 ✓, test:broker = 45 pass / 1 fail. Tu fix (3) NO resolvió el fallo del crash test: sigue fallando exactamente igual.

Evidencia observada: `tests/broker/durability.test.ts:199` → `register()` (`durability.test.ts:75`): `expect(welcome).toBeDefined()` → `undefined`. La línea 199 es `await register(holder);` donde `holder = await adapter(newInstanceId(), sessionId, url)` y `url = ws://127.0.0.1:${child.port}` (el broker del PROCESO HIJO recién spawnado). Es decir: el primer hello contra el broker hijo no llega a welcome. Ojo: tu fix de grants del childDataDir es correcto y debe conservarse; el fallo es OTRO.

## Hipótesis con evidencia (verifícala por lectura y corrige la causa real)
1. RACE de welcome: `register()` lee `peer.welcome` inmediatamente, pero `FakePeer`/`openPeer` resuelven la conexión sin GARANTIZAR que el frame `welcome` ya haya llegado. Con el broker in-proceso el welcome llega «enseguida» y el race no se manifiesta; con un proceso hijo spawnado (latencia de arranque de bun + bind del puerto) el welcome llega tarde y `peer.welcome` aún es `undefined`. Revisa `tests/broker/helpers.ts` (`openPeer`/`FakePeer`): si resuelve al abrir el socket y no tras recibir `welcome`, haz que la obtención del welcome sea determinista (espera acotada del frame `welcome` con timeout explícito y error claro, o marca + `nextFrame`), sin sleeps arbitrarios.
2. READINESS del hijo: verifica `spawnBrokerProcess` — puede devolver antes de que el hijo escuche (¿espera el puerto/`GET /health`/línea de ready por stdout?). Si no hay barrera de readiness, añádela (acotada, con error explícito si el hijo no arranca), y asegúrate de que la conexión posterior no traga errores silenciosamente.
3. Si tras eliminar el race/asegurar readiness la evidencia muestra otro fallo real (p.ej. el hijo rechaza el hello por orden de adquisición del lock, WAL, o handshake con MAC), corrígelo dentro de ownership y descríbelo.

## Reglas
EDIT-ONLY: no ejecutes tests/typecheck/builds/formatters/installs; el coordinador reproduce `bun run typecheck` + `bun run test:broker`. Ownership: `apps/broker/**` y `tests/broker/**`; `packages/protocol` y `docs/contracts` READ-ONLY. No toques `packages/client`, `apps/cli`, `tests/cli`, raíz ni `.plans/**`. Sin debilitar aserciones ni maquillar verde. Confirma tu modelo efectivo (`xiaomi-token-plan-sgp/mimo-v2.6-pro`). Sin monorepo/dotfiles/git/Climier/publicación/servicios/inferencia real.

## Reporte
Anchor restatado, modelo efectivo, archivos modificados, causa real del fallo restante con su traza estática, fix aplicado, pendientes y bloqueos mínimos. Cierra con STOP.
