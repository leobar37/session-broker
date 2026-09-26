# Consumo local reproducible (sin npm publicado) — receta congelada

P-006 implementa esta receta en `docs/handoff/`; aquí queda fijada para que el
consumidor externo (maestro) pueda usar los exports públicos sin publicación ni
dependencias absolutas de esta máquina.

## Objetivo

Un consumidor copia un snapshot portable a cualquier ruta (otra máquina, otro
usuario, un TMP) e instala/consume los cinco paquetes **sin red npm publicada**
y **sin referencias `file:/home/...`**. Todo el consumo ocurre por los export
maps congelados en [packages.md](packages.md).

## Layout congelado del snapshot

```
docs/handoff/snapshot/
  package.json            # name: "@session-broker/handoff-snapshot", private, workspaces: ["packages/*","apps/*"]
  bun.lock                # generado por P-006 con specs relativos (opcional)
  packages/
    protocol/             # fuente completa (src/, package.json)
    client/
    omp-adapter/
  apps/
    broker/
    cli/
  consumer-smoke/
    package.json          # dependencias con spec relativa (ver abajo)
    smoke.test.ts         # consumidor externo: solo exports públicos
```

## Receta de empaquetado (P-006 la ejecuta; determinista)

1. Copiar las fuentes de los cinco workspaces al snapshot (sin `node_modules`,
   sin `dist`, sin outputs generados).
2. Empaquetar cada workspace como tarball relativo con las herramientas del
   propio runtime (p. ej. `bun pm pack` dentro de cada carpeta) dejando los
   `.tgz` en `docs/handoff/snapshot/vendor/` (nota: `"private": true` bloquea
   `publish`, no `pack`):
   - `vendor/session-broker-protocol-0.1.0.tgz`
   - `vendor/session-broker-client-0.1.0.tgz`
   - `vendor/session-broker-server-0.1.0.tgz`
   - `vendor/session-broker-cli-0.1.0.tgz`
   - `vendor/session-broker-omp-adapter-0.1.0.tgz`
3. En `consumer-smoke/package.json`, referencias **relativas** (portables):

```json
{
  "name": "consumer-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@session-broker/protocol": "file:../vendor/session-broker-protocol-0.1.0.tgz",
    "@session-broker/client": "file:../vendor/session-broker-client-0.1.0.tgz",
    "@session-broker/omp-adapter": "file:../vendor/session-broker-omp-adapter-0.1.0.tgz",
    "@session-broker/cli": "file:../vendor/session-broker-cli-0.1.0.tgz",
    "@session-broker/server": "file:../vendor/session-broker-server-0.1.0.tgz"
  }
}
```

Alternativa equivalente (sin tarballs): workspaces dentro del snapshot con
`"@session-broker/protocol": "file:../packages/protocol"`. En ambos casos la
referencia es **relativa** y sobrevive a copiar el snapshot a otra ruta.

## Prohibiciones verificables (P-006 las hace cumplir con grep/test)

- **Ningún** `file:/home/`, `file:///`, `/home/` ni ruta absoluta en ningún
  `package.json`/lock del snapshot.
- Ningún `npm publish`, `bun add`/`bun install` con red, ni registro npm.
- Ningún import de rutas privadas (`@session-broker/*/src/...`) desde el
  consumidor: solo los exports públicos (`.` y `./fixtures` del protocolo).
- Ninguna dependencia runtime externa en los cinco paquetes.

## Verificación de consumo (forma del check de P-006)

1. Copiar `docs/handoff/snapshot/` a un TMP **fuera** del repo
   (`omp-session-broker-test-*`).
2. `bun install` **offline** dentro de `consumer-smoke/` (resuelve los `file:`
   relativos).
3. Ejecutar `consumer-smoke/smoke.test.ts`: importa `@session-broker/protocol`
   y `@session-broker/protocol/fixtures`, valida fixtures de referencia y
   comprueba versión `1.0.0`, tabla de errores y exit codes.
4. Comprobar que el snapshot no contiene secretos (credenciales/MAC keys) ni
   salidas generadas dentro del alcance del hash de fuente.
5. Declarar en el handoff la revisión/hash del repo y el algoritmo/alcance del
   manifiesto de fuente (excluyendo outputs generados para evitar hash
   circular), sin exigir commits.
