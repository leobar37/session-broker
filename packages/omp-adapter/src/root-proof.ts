/**
 * Emisión de root proofs (FR-003). Firma congelada en `docs/contracts/packages.md`.
 *
 * `issueRootProof` es el **actor local confiable** de `docs/contracts/root-proof.md`:
 * el adaptador en proceso dentro del runtime nativo, único poseedor de la MAC
 * key (configuración de usuario, jamás versionada ni persistida por este
 * paquete). La prueba se emite ligada a `(instanceId, nativeSessionId,
 * challenge, audience)` con uso único por `proofId`:
 *
 * - **No heredable por environment**: la MAC key nunca viaja en variables de
 *   entorno, argv, archivos de worktree ni respuestas del adaptador. Un hijo
 *   con environment copiado no puede emitir pruebas.
 * - **No heredable por reuso**: el challenge es de un solo intercambio
 *   (`welcome.serverChallenge`), la audiencia es el `connectionId` de esa
 *   conexión y el `proofId` se consume en el primer registro; una prueba
 *   copiada falla (`root_proof_consumed` / `root_proof_challenge_mismatch` /
 *   `root_proof_subject_mismatch`).
 * - **Claims no-probados**: environment/PID/cwd/IDs/token reutilizable se
 *   deniegan SIEMPRE en el broker (`evaluateRootBindingClaim`); este paquete
 *   jamás envía un claim que no sea `{ kind: "root_proof", proof }`.
 *
 * OMP no ofrece una primitiva de attestation de proceso (matriz §6, unknown
 * #2): la no-heredabilidad se sustenta en la posesión de la MAC key fuera de
 * la superficie heredable + challenge de un solo intercambio + consumo único,
 * verificado por `tests/omp/root-binding.test.ts`.
 */

import {
  ID_PATTERNS,
  LIMITS,
  ROOT_PROOF_VERSION,
  computeRootProofMac,
  isInstanceId,
  isNativeSessionId,
  newRootProofId,
  type InstanceId,
  type NativeSessionId,
  type RootProof,
} from "@session-broker/protocol";

export interface IssueRootProofInput {
  /** MAC key del usuario (config de usuario). Jamás se registra ni persiste. */
  macKey: string;
  /** Actor emisor (p. ej. `omp-adapter:<instanceId>`). */
  issuer: string;
  instanceId: InstanceId;
  nativeSessionId: NativeSessionId;
  /** Echo del `welcome.serverChallenge` de ESTA conexión (`chal_…`). */
  challenge: string;
  /** Audiencia = `welcome.connectionId` de la conexión destinataria. */
  audience: string;
  nowMs: number;
  /** TTL en ms; default 300000, máximo `rootProofTtlMsMax` (300000). */
  ttlMs?: number;
}

function fail(message: string): never {
  throw new Error(`issueRootProof: ${message}`);
}

/**
 * Emite la root proof de bootstrap (actor local confiable; un solo uso).
 * Entrada inválida lanza `Error` local (fallo de bootstrap del proceso, no un
 * error de protocolo): la prueba emitida siempre pasa `verifyRootProof`.
 */
export function issueRootProof(input: IssueRootProofInput): RootProof {
  if (typeof input.macKey !== "string" || input.macKey.length === 0) {
    fail("macKey ausente");
  }
  if (typeof input.issuer !== "string" || input.issuer.length === 0 || input.issuer.length > LIMITS.maxAliasChars) {
    fail("issuer inválido");
  }
  if (!isInstanceId(input.instanceId)) {
    fail("instanceId inválido");
  }
  if (!isNativeSessionId(input.nativeSessionId)) {
    fail("nativeSessionId inválido");
  }
  if (typeof input.challenge !== "string" || !ID_PATTERNS.challenge.test(input.challenge)) {
    fail("challenge inválido (se espera el serverChallenge del welcome)");
  }
  if (typeof input.audience !== "string" || input.audience.length === 0 || input.audience.length > LIMITS.maxAliasChars) {
    fail("audience inválida (se espera el connectionId del welcome)");
  }
  if (!Number.isFinite(input.nowMs)) {
    fail("nowMs inválido");
  }
  const ttlMs = input.ttlMs ?? LIMITS.rootProofTtlMsMax;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > LIMITS.rootProofTtlMsMax) {
    fail(`ttlMs debe estar en 1..${LIMITS.rootProofTtlMsMax}`);
  }
  const macInput = {
    proofVersion: ROOT_PROOF_VERSION,
    proofId: newRootProofId(),
    issuer: input.issuer,
    subject: {
      instanceId: input.instanceId,
      nativeSessionId: input.nativeSessionId,
    },
    challenge: input.challenge,
    audience: input.audience,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + ttlMs,
  };
  return { ...macInput, mac: computeRootProofMac(macInput, input.macKey) };
}
