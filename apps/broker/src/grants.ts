/**
 * Registro de grants del broker (FR-004 / NFR-001).
 *
 * Provisión (única vía de entrada de credenciales al servidor):
 * `<dataDir>/grants.json` con la forma `{ "schemaVersion": 1, "grants":
 * GrantTokenRecord[] }` donde `credentialHash` es el sha256 hex de la
 * credencial. La credencial EN CLARO jamás se persiste, se registra ni viaja
 * fuera del `hello` del handshake. El archivo lo escribe el operador (o la CLI
 * `grants create` de P-003) fuera de worktrees; el servidor lo recarga cuando
 * cambia (mtime+tamaño) para que revocación/expiración revaliden conexiones.
 *
 * Evaluación: se usa SIEMPRE el evaluador congelado `evaluateGrant` del
 * protocolo; no hay atajos ni scopes implícitos. La comprobación del handshake
 * exige `session.identity` y cubre exactamente las dimensiones que el `hello`
 * declara (fail-closed por dimensión: una dimensión restringida a lista exige
 * valor declarado incluido; una dimensión omitida en el grant solo permite
 * acciones que tampoco la declaren).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITIES,
  evaluateGrant,
  isTargetId,
  parseGrant,
  protocolError,
  type Grant,
  type GrantAction,
  type GrantId,
  type GrantTokenRecord,
  type ProtocolError,
  type Result,
  type TargetId,
} from "@session-broker/protocol";

export const GRANTS_FILE_NAME = "grants.json";
export const GRANTS_SCHEMA_VERSION = 1;

interface HandshakeIdentity {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly nativeSessionId?: string;
}

export interface GrantsRegistryOptions {
  readonly dataDir: string;
  readonly now: () => number;
}

interface GrantsFileShape {
  readonly schemaVersion: number;
  readonly grants: readonly GrantTokenRecord[];
}

function sha256HexOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function credentialsMatch(credentialHash: string, credential: string): boolean {
  const presented = sha256HexOf(credential);
  if (presented.length !== credentialHash.length) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(credentialHash, "utf8"));
}

/**
 * El handshake aún no ha elegido target; la acción de identidad se evalúa con
 * un target satisfecho por el propio scope del grant (el primer target de la
 * lista, o un sentinel válido con wildcard). Las peticiones posteriores se
 * evalúan por target concreto, que es donde el scope es vinculante.
 */
function handshakeTargetFor(grant: Grant): TargetId {
  const targets = grant.scope.targets;
  if (targets === undefined || targets === "*") return "session-broker-handshake";
  const first = targets[0];
  return first !== undefined && isTargetId(first) ? first : "session-broker-handshake";
}

export class GrantsRegistry {
  readonly #path: string;
  readonly #now: () => number;
  #signature = "";
  #records: readonly GrantTokenRecord[] = [];

  constructor(options: GrantsRegistryOptions) {
    this.#path = join(options.dataDir, GRANTS_FILE_NAME);
    this.#now = options.now;
  }

  /** Ruta del archivo de provisión (para diagnóstico de tests/operador). */
  get path(): string {
    return this.#path;
  }

  /**
   * (Re)carga el registro si el archivo cambió. Un archivo malformado deja el
   * registro VACÍO (fail-closed: sin grants válidos no hay autenticación).
   */
  refresh(): void {
    let signature: string;
    try {
      const stat = statSync(this.#path);
      signature = `${stat.mtimeMs}:${stat.size}`;
      if (signature === this.#signature) return;
      const parsed = this.#parseFile();
      if (parsed === undefined) {
        this.#signature = signature;
        this.#records = [];
        return;
      }
      this.#signature = signature;
      this.#records = parsed;
    } catch {
      // Sin archivo no hay grants; cualquier acceso se deniega.
      this.#signature = "";
      this.#records = [];
    }
  }

  #parseFile(): readonly GrantTokenRecord[] | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return undefined;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const file = raw as Partial<GrantsFileShape>;
    if (file.schemaVersion !== GRANTS_SCHEMA_VERSION) return undefined;
    if (!Array.isArray(file.grants)) return undefined;
    const out: GrantTokenRecord[] = [];
    for (const entry of file.grants) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const record = entry as Partial<GrantTokenRecord>;
      const hash: unknown = record.credentialHash;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
      const grant = parseGrant(record.grant);
      if (!grant.ok) return undefined;
      out.push({ credentialHash: hash, grant: grant.value });
    }
    return out;
  }

  find(grantId: GrantId): GrantTokenRecord | undefined {
    this.refresh();
    for (const record of this.#records) {
      if (record.grant.grantId === grantId) return record;
    }
    return undefined;
  }

  /** Verifica credencial (hash con comparación en tiempo constante). */
  verifyCredential(record: GrantTokenRecord, credential: string): Result<true, ProtocolError> {
    if (!credentialsMatch(record.credentialHash, credential)) {
      return {
        ok: false,
        error: protocolError("UNAUTHORIZED", "unauthorized_scope", "credencial no corresponde al grant", "credential"),
      };
    }
    return { ok: true, value: true };
  }

  /**
   * Comprobación del handshake: credencial + vigencia + proyecto/workspace
   * declarados + capability `session.identity`. Firma igual a la de las
   * acciones de petición para que todo pase por `evaluateGrant`.
   */
  evaluateHandshake(
    record: GrantTokenRecord,
    identity: HandshakeIdentity,
    nowMs: number,
  ): Result<true, ProtocolError> {
    const action: GrantAction = {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      target: handshakeTargetFor(record.grant),
      nativeSessionId: identity.nativeSessionId,
      capability: CAPABILITIES.identity,
    };
    return evaluateGrant(record.grant, action, nowMs);
  }

  /**
   * Evalúa una acción concreta (una capability por llamada) contra el grant.
   * El resultado es literalmente el del evaluador congelado.
   */
  evaluateAction(record: GrantTokenRecord, action: GrantAction, nowMs: number): Result<true, ProtocolError> {
    return evaluateGrant(record.grant, action, nowMs);
  }

  /** Vigencia del grant para revalidar conexiones vivas (revocación/expiración). */
  revalidate(record: GrantTokenRecord, identity: HandshakeIdentity, nowMs: number): Result<true, ProtocolError> {
    return this.evaluateHandshake(record, identity, nowMs);
  }

  /** Número de grants provisionados (health; sin secretos). */
  get size(): number {
    this.refresh();
    return this.#records.length;
  }
}


