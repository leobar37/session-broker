/**
 * Root binding / prueba de raíz (FR-003/FR-008).
 *
 * La prueba la emite un actor local confiable (el adaptador en proceso dentro
 * del runtime nativo) y es de uso acotado: ligada al proceso/instancia raíz y
 * a su sesión, con challenge de un solo intercambio, expiración corta y
 * consumo único. REGLA INQUEBRANTABLE: environment heredado, PID sin prueba,
 * cwd, IDs o un token reutilizable en variables NUNCA acreditan raíz. Un
 * subagente con environment copiado falla el registro. El rebind es siempre
 * explícito y no transfiere privilegios a otra instancia.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { err, ok, isPlainObject, isString, isFiniteNumber, type Result } from "./validation";
import { protocolError, type ProtocolError } from "./errors";
import {
  ID_PATTERNS,
  isInstanceId,
  isNativeSessionId,
  type InstanceId,
  type NativeSessionId,
} from "./ids";
import { canonicalJson } from "./canonical";
import { LIMITS } from "./limits";

export const ROOT_PROOF_VERSION = 1;

export interface RootProof {
  readonly proofVersion: number;
  readonly proofId: string;
  /** Actor local confiable que emite la prueba (p. ej. `omp-adapter:<instanceId>`). */
  readonly issuer: string;
  readonly subject: {
    readonly instanceId: InstanceId;
    readonly nativeSessionId: NativeSessionId;
    /** Informativo; jamás autentica por sí solo. */
    readonly pid?: number;
  };
  /** Echo del challenge emitido por el broker en esta conexión. */
  readonly challenge: string;
  readonly audience: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** HMAC-SHA256 sobre la serialización canónica de los campos anteriores. */
  readonly mac: string;
}

export type RootProofMacInput = Omit<RootProof, "mac">;

export interface VerifyRootProofContext {
  readonly nowMs: number;
  readonly challenge: string;
  /** Identidad del broker (audiencia esperada). */
  readonly audience: string;
  /** Instancia que presenta la prueba en ESTA conexión. */
  readonly instanceId: InstanceId;
  readonly macKey: string;
  readonly isProofConsumed: (proofId: string) => boolean;
}

export function computeRootProofMac(input: RootProofMacInput, macKey: string): string {
  const canonical = canonicalJson(
    {
      proofVersion: input.proofVersion,
      proofId: input.proofId,
      issuer: input.issuer,
      subject: input.subject,
      challenge: input.challenge,
      audience: input.audience,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: input.expiresAtMs,
    },
    "$.rootProof",
  );
  // canonicalJson solo falla con valores no serializables; estos campos ya son primitivas.
  const payload = canonical.ok ? canonical.value : "";
  return createHmac("sha256", macKey).update(payload, "utf8").digest("hex");
}

function macMatches(expected: string, actual: unknown): boolean {
  if (!isString(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

/**
 * Verificación estricta de una root proof. Cualquier fallo es cerrado: no hay
 * degradación a PID/cwd/environment/IDs ni a tokens reutilizables.
 */
export function verifyRootProof(proof: unknown, ctx: VerifyRootProofContext): Result<RootProof, ProtocolError> {
  if (!isPlainObject(proof)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "root proof ausente o malformada", "rootProof"));
  }
  const unknown = Object.keys(proof).filter(
    (key) =>
      !["proofVersion", "proofId", "issuer", "subject", "challenge", "audience", "issuedAtMs", "expiresAtMs", "mac"].includes(key),
  );
  if (unknown.length > 0) {
    return err(
      protocolError("UNAUTHORIZED", "root_claim_not_proven", `root proof con campos desconocidos: ${unknown.join(", ")}`, "rootProof"),
    );
  }
  if (proof.proofVersion !== ROOT_PROOF_VERSION) {
    return err(
      protocolError("UNAUTHORIZED", "root_claim_not_proven", "versión de root proof no soportada", "rootProof.proofVersion"),
    );
  }
  if (!isString(proof.proofId) || !ID_PATTERNS.proofId.test(proof.proofId)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "proofId inválido", "rootProof.proofId"));
  }
  if (!isString(proof.issuer) || proof.issuer.length === 0 || proof.issuer.length > LIMITS.maxAliasChars) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "issuer inválido", "rootProof.issuer"));
  }
  if (!isPlainObject(proof.subject)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "subject inválido", "rootProof.subject"));
  }
  const subjectKeys = Object.keys(proof.subject).filter((key) => key !== "instanceId" && key !== "nativeSessionId" && key !== "pid");
  if (subjectKeys.length > 0) {
    return err(
      protocolError("UNAUTHORIZED", "root_claim_not_proven", "subject con campos desconocidos", "rootProof.subject"),
    );
  }
  if (!isInstanceId(proof.subject.instanceId)) {
    return err(
      protocolError("UNAUTHORIZED", "root_claim_not_proven", "subject.instanceId inválido", "rootProof.subject.instanceId"),
    );
  }
  if (!isNativeSessionId(proof.subject.nativeSessionId)) {
    return err(
      protocolError(
        "UNAUTHORIZED",
        "root_claim_not_proven",
        "subject.nativeSessionId inválido",
        "rootProof.subject.nativeSessionId",
      ),
    );
  }
  if (proof.subject.pid !== undefined && (!isFiniteNumber(proof.subject.pid) || proof.subject.pid <= 0)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "subject.pid inválido", "rootProof.subject.pid"));
  }
  if (!isString(proof.challenge) || !ID_PATTERNS.challenge.test(proof.challenge)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "challenge inválido", "rootProof.challenge"));
  }
  if (!isString(proof.audience) || proof.audience.length === 0 || proof.audience.length > LIMITS.maxAliasChars) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "audience inválido", "rootProof.audience"));
  }
  if (!isFiniteNumber(proof.issuedAtMs) || !isFiniteNumber(proof.expiresAtMs)) {
    return err(
      protocolError("UNAUTHORIZED", "root_claim_not_proven", "marcas temporales inválidas", "rootProof.issuedAtMs"),
    );
  }
  const macInput: RootProofMacInput = {
    proofVersion: ROOT_PROOF_VERSION,
    proofId: proof.proofId as string,
    issuer: proof.issuer as string,
    subject:
      proof.subject.pid === undefined
        ? {
            instanceId: proof.subject.instanceId as InstanceId,
            nativeSessionId: proof.subject.nativeSessionId as NativeSessionId,
          }
        : {
            instanceId: proof.subject.instanceId as InstanceId,
            nativeSessionId: proof.subject.nativeSessionId as NativeSessionId,
            pid: proof.subject.pid as number,
          },
    challenge: proof.challenge as string,
    audience: proof.audience as string,
    issuedAtMs: proof.issuedAtMs as number,
    expiresAtMs: proof.expiresAtMs as number,
  };
  const expectedMac = computeRootProofMac(macInput, ctx.macKey);
  if (!macMatches(expectedMac, proof.mac)) {
    return err(protocolError("UNAUTHORIZED", "root_proof_invalid_mac", "MAC de root proof inválida", "rootProof.mac"));
  }
  if (macInput.expiresAtMs - macInput.issuedAtMs > LIMITS.rootProofTtlMsMax) {
    return err(
      protocolError("UNAUTHORIZED", "root_proof_expired", "root proof con TTL excesivo", "rootProof.expiresAtMs"),
    );
  }
  if (ctx.nowMs >= macInput.expiresAtMs) {
    return err(protocolError("UNAUTHORIZED", "root_proof_expired", "root proof expirada", "rootProof.expiresAtMs"));
  }
  if (ctx.nowMs < macInput.issuedAtMs) {
    return err(
      protocolError("UNAUTHORIZED", "root_proof_not_yet_valid", "root proof aún no vigente", "rootProof.issuedAtMs"),
    );
  }
  if (macInput.challenge !== ctx.challenge) {
    return err(
      protocolError("UNAUTHORIZED", "root_proof_challenge_mismatch", "challenge no corresponde a esta conexión", "rootProof.challenge"),
    );
  }
  if (macInput.audience !== ctx.audience) {
    return err(
      protocolError("UNAUTHORIZED", "root_proof_audience_mismatch", "audiencia no corresponde a este broker", "rootProof.audience"),
    );
  }
  if (macInput.subject.instanceId !== ctx.instanceId) {
    return err(
      protocolError(
        "UNAUTHORIZED",
        "root_proof_subject_mismatch",
        "la prueba no pertenece a la instancia que la presenta",
        "rootProof.subject.instanceId",
      ),
    );
  }
  if (ctx.isProofConsumed(macInput.proofId)) {
    return err(
      protocolError("UNAUTHORIZED", "root_proof_consumed", "root proof ya consumida (uso único)", "rootProof.proofId"),
    );
  }
  return ok({ ...macInput, mac: expectedMac });
}

/**
 * Tipos de claim de raíz. Solo `root_proof` puede acreditar raíz; el resto se
 * deniega SIEMPRE, sin importar su contenido, porque son heredables/copiables.
 */
export type RootBindingClaim =
  | { readonly kind: "root_proof"; readonly proof: unknown }
  | { readonly kind: "environment"; readonly variables: Readonly<Record<string, string>> }
  | { readonly kind: "pid"; readonly pid: number }
  | { readonly kind: "cwd"; readonly cwd: string }
  | { readonly kind: "ids"; readonly instanceId?: string; readonly nativeSessionId?: string }
  | { readonly kind: "reusable_token"; readonly token: string };

const NON_PROOF_CLAIM_KINDS = ["environment", "pid", "cwd", "ids", "reusable_token"] as const;

export function evaluateRootBindingClaim(
  claim: unknown,
  ctx: VerifyRootProofContext,
): Result<RootProof, ProtocolError> {
  if (!isPlainObject(claim)) {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "claim de raíz malformado", "rootBinding"));
  }
  const kind: unknown = claim.kind;
  if (kind !== "root_proof" && (NON_PROOF_CLAIM_KINDS as readonly unknown[]).includes(kind)) {
    return err(
      protocolError(
        "UNAUTHORIZED",
        "root_claim_not_proven",
        `claim de tipo ${String(kind)} no acredita raíz (environment/PID/cwd/IDs/tokens heredables no prueban nada)`,
        "rootBinding.kind",
      ),
    );
  }
  if (kind !== "root_proof") {
    return err(protocolError("UNAUTHORIZED", "root_claim_not_proven", "tipo de claim de raíz desconocido", "rootBinding.kind"));
  }
  return verifyRootProof(claim.proof, ctx);
}

/**
 * Registro de proofs consumidas (uso único). El broker lo mantiene en su
 * almacenamiento durable; esta implementación en memoria sirve de referencia
 * y de prueba del contrato de consumo.
 */
export class RootProofLedger {
  readonly #consumed: Map<string, number> = new Map();

  consume(proofId: string, expiresAtMs: number): Result<true, ProtocolError> {
    if (this.#consumed.has(proofId)) {
      return err(
        protocolError("UNAUTHORIZED", "root_proof_consumed", "root proof ya consumida (uso único)", "rootProof.proofId"),
      );
    }
    this.#consumed.set(proofId, expiresAtMs);
    return ok(true);
  }

  isConsumed(proofId: string): boolean {
    return this.#consumed.has(proofId);
  }

  /** Rebind explícito: exige una proof NUEVA; nunca reutiliza la anterior. */
  rebind(newProof: RootProof, ctx: VerifyRootProofContext): Result<RootProof, ProtocolError> {
    const verified = verifyRootProof(newProof, {
      ...ctx,
      isProofConsumed: (proofId: string) => this.#consumed.has(proofId),
    });
    if (!verified.ok) return verified;
    const consumed = this.consume(verified.value.proofId, verified.value.expiresAtMs);
    if (!consumed.ok) return consumed;
    return verified;
  }
}
