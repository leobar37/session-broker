# Root binding / prueba de raíz (FR-003 / FR-008)

Fuente ejecutable: `packages/protocol/src/root-proof.ts`.

## Principio inquebrantable

Solo una **root proof** emitida por un actor local confiable acredita raíz.
Environment heredado, PID sin prueba, cwd, IDs o un token reutilizable en
variables **nunca** acreditan nada: todo claim de esos tipos se deniega con
`UNAUTHORIZED/root_claim_not_proven` sin importar su contenido
(`evaluateRootBindingClaim`). Un subagente con environment copiado falla el
registro por diseño.

## Actor local confiable

El emisor es el adaptador en proceso dentro del runtime nativo (extensión
cargada en el proceso de la sesión; ver matriz OMP). Es el único componente
que posee la MAC key (en configuración de usuario, jamás versionada) y puede
emitir pruebas. Si este actor no existe o no puede justificarse, la
**integración root queda bloqueada** (capacidad `root.binding` unsupported);
no se inventa ningún fallback.

## Estructura congelada (`RootProof`)

```ts
interface RootProof {
  proofVersion: 1;
  proofId: string;        // ^rp_[0-9a-f]{32}$ — jti de un solo uso
  issuer: string;         // p. ej. "omp-adapter:<instanceId>"
  subject: {
    instanceId: InstanceId;
    nativeSessionId: NativeSessionId;
    pid?: number;         // INFORMATIVO; jamás autentica por sí solo
  };
  challenge: string;      // ^chal_[0-9a-f]{32}$ — echo del challenge del broker
  audience: string;       // identidad del broker destinatario
  issuedAtMs: number;
  expiresAtMs: number;
  mac: string;            // HMAC-SHA256 sobre JSON canónico de los campos previos
}
```

`mac = HMAC-SHA256(macKey, canonicalJson(camposSinMac))`. La comparación de
MAC usa `timingSafeEqual`.

## Flujo de emisión y consumo

1. Handshake: el broker emite `welcome.serverChallenge` (nonce efímero,
   TTL `challengeTtlMs` = 300 000 ms).
2. El proceso raíz (adaptador) emite la proof ligada a
   `(instanceId, nativeSessionId, challenge, audience)` con
   `expiresAtMs - issuedAtMs ≤ rootProofTtlMsMax` (300 000 ms).
3. El broker verifica (`verifyRootProof`): versión, formato, MAC, ventana
   temporal, challenge de ESTA conexión, audiencia, `subject.instanceId` igual
   a la instancia que presenta la proof en esta conexión, y `proofId` no
   consumido.
4. **Consumo único:** al aceptar, el `proofId` se marca consumido
   (`RootProofLedger` como referencia; el broker lo mantiene durable). Una
   proof consumida vuelve a fallar con `UNAUTHORIZED/root_proof_consumed`.
5. **Reconexión de la misma raíz:** cada conexión exige su propio challenge;
   una proof anterior (challenge viejo o ya consumida) no sirve.
6. **Rebind explícito:** cambiar el binding (nueva instancia/sesión) requiere
   una proof NUEVA emitida para ese sujeto. Los privilegios jamás se
   transfieren a otra instancia; presentar la proof de otra instancia falla con
   `UNAUTHORIZED/root_proof_subject_mismatch`.

## Rechazos estables

| Situación | code | reason |
| --- | --- | --- |
| Claim por env/PID/cwd/IDs/token | `UNAUTHORIZED` | `root_claim_not_proven` |
| Proof malformada / campos desconocidos / versión no soportada | `UNAUTHORIZED` | `root_claim_not_proven` |
| MAC inválida | `UNAUTHORIZED` | `root_proof_invalid_mac` |
| TTL excesivo o vencida | `UNAUTHORIZED` | `root_proof_expired` |
| Aún no vigente | `UNAUTHORIZED` | `root_proof_not_yet_valid` |
| Challenge de otra conexión | `UNAUTHORIZED` | `root_proof_challenge_mismatch` |
| Audiencia de otro broker | `UNAUTHORIZED` | `root_proof_audience_mismatch` |
| Sujeto distinto al presentador | `UNAUTHORIZED` | `root_proof_subject_mismatch` |
| Ya consumida | `UNAUTHORIZED` | `root_proof_consumed` |

## Límites congelados

- `rootProofTtlMsMax` = 300 000 ms (5 min).
- `challengeTtlMs` = 300 000 ms.
- Uso único por `proofId` (sin excepciones ni reutilización por TTL).

## Alcance de la prueba

La root proof acredita **bootstrap raíz**: registro de la sesión raíz y su
ámbito. No habilita por sí sola operaciones de control (eso lo delimita el
grant y el `controlEpoch`, ver [auth.md](auth.md)).
