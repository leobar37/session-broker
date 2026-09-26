# Autenticación, grants y control (FR-004 / NFR-001)

Fuente ejecutable: `packages/protocol/src/grants.ts`.

## Principios

1. La autenticación deriva de la **credencial del grant** presentada en el
   handshake (transporte), no del contenido del payload. Un payload jamás
   autoconcede roles.
2. **IDs = selectores, no credenciales.** `idsAloneAuthenticate()` documenta la
   negación permanente (`UNAUTHORIZED/ids_are_not_credentials`).
3. Lectura, envío y control se separan en capacidades distintas
   ([capabilities.md](capabilities.md)).
4. Respuestas fuera de scope → `NOT_FOUND_OR_FORBIDDEN` (no filtra existencia).
5. Secretos (credencial del grant, MAC key) fuera de logs, fixtures, transcripts
   y handoff. En código solo se persiste un hash de credencial
   (`GrantTokenRecord.credentialHash`).
6. Mensajes remotos son datos no confiables: jamás instrucciones
   administrativas ni autorización para gastar, publicar o ampliar scope.

## Grant congelado

```ts
interface Grant {
  grantId: GrantId;
  subject: string;                 // principal autenticado
  scope: {
    projectId: ProjectId;
    workspaceIds?: WorkspaceId[] | "*";
    targets?: TargetId[] | "*";
    sessions?: NativeSessionId[] | "*";
    capabilities: Capability[];    // no vacío
  };
  issuedBy: string;
  issuedAtMs: number;
  notBeforeMs?: number;
  expiresAtMs: number;             // expiresAtMs - issuedAtMs ≤ grantTtlMsMax
  revokedAtMs?: number;
}
```

Evaluación (`evaluateGrant`), en orden: revocación → vigencia (`notBefore`) →
expiración (`EXPIRED/grant_expired`) → TTL máximo → proyecto → workspace →
target → sesión → capability. Cualquier desajuste es
`UNAUTHORIZED/unauthorized_scope` (o `grant_revoked`/`grant_not_yet_valid`),
sin revelar qué dimensión falló más allá del `path`.

Regla fail-closed por dimensión (congelada): si el grant restringe una
dimensión (workspace/sesión) a una **lista**, toda acción debe declarar un
valor incluido en esa lista; una acción que **omita** la dimensión abarcaría
datos fuera de la lista y se deniega. Solo el wildcard `"*"` permite acciones
sin valor en esa dimensión o con cualquier valor. Una dimensión omitida en el
grant solo permite acciones que tampoco la declaren.

TTLs: `grantTtlMsDefault` = 86 400 000 ms (24 h), `grantTtlMsMax` =
2 592 000 000 ms (30 d). Un grant con TTL mayor se rechaza al validar
(`INVALID_INPUT/invalid_field`).

## Transporte

- Remoto: **WSS obligatorio**. Cualquier `ws://` inseguro requiere una política
  local explícita y solo aplica a fixtures/entornos locales acordados; la red
  privada NUNCA sustituye a la autorización de aplicación.
- La credencial viaja en el `hello` del handshake y no se registra jamás.
- Rechazos de auth: `UNAUTHORIZED` (credencial/grant) y `NOT_FOUND_OR_FORBIDDEN`
  (ámbito); jamás se filtran datos fuera del scope del llamador.

## `controlEpoch` — control obsoleto imposible

- Todo lease de control (`ControlLease`) tiene un `epoch` entero ≥ 1
  (0 = sin lease) ligado a `(projectId, target, nativeSessionId)`.
- **Toda acción mutante de control** (`prompt`/`steer`/`follow_up`/`abort`)
  lleva `controlEpoch` en el envelope (obligatorio para `control`; sin él →
  `STALE_CONTROL_EPOCH/stale_control_epoch`).
- **Comparación atómica:** el broker compara `claimed === lease.epoch` dentro de
  la MISMA transacción que aplica la acción. Distinto →
  `STALE_CONTROL_EPOCH/stale_control_epoch`. Instancia distinta a la del lease →
  `STALE_INSTANCE/stale_instance`. Lease vencido → `EXPIRED/grant_expired`.
- **Renovación/takeover/revoke** incrementa el epoch
  (`renewControlLease`: `previous.epoch + 1`), invalidando todo control previo.
  No hay excepciones por heartbeat perdido: un heartbeat ausente no demuestra
  que el escritor anterior murió y **no** autoriza takeover mientras exista
  resultado incierto (`OUTCOME_UNKNOWN`).
- Un solo escritor autorizado por ámbito; el cambio de epoch o de instancia
  invalida el control antiguo de inmediato.

## Grants revocables y cuotas

- Revocación efectiva desde `revokedAtMs` (comprobada en cada evaluación).
- Cuotas aplicadas por grant/proyecto: `maxInFlightRequestsPerGrant` = 32,
  `maxRequestsPerMinutePerGrant` = 120 (exceso → `RATE_LIMITED`),
  `maxQueuedAsksPerSession` = 8 (exceso → `QUEUE_FULL`). Ver
  [limits.md](limits.md).
