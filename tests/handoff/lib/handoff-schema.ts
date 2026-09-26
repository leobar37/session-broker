/**
 * Schema del handoff (`omp-broker-v1.json`) y del evidence input del generator.
 *
 * Dos piezas que deben evolucionar juntas:
 *  - `EvidenceInput` (`omp-session-broker-evidence/1`): lo que el coordinador
 *    entrega al generator tras ejecutar los gates REALES. Sin resultados
 *    observados el generator se niega a materializar nada.
 *  - `HandoffDoc` (`omp-session-broker-handoff/1`): el documento materializado
 *    en `docs/handoff/omp-broker-v1.json`, con su proyección determinista a
 *    `omp-broker-v1.md` (render-markdown.ts).
 *
 * El generator (`tests/handoff/build-handoff.ts`) transforma evidencia real +
 * hechos del repo (manifests, freeze, hash de fuente) en ambos archivos. La
 * suite (`tests/handoff/*.test.ts`) re-valida todo contra el repo vivo; jamás
 * se editan a mano los artefactos para cuadrar un resultado.
 */

import { isRecord } from "@session-broker/protocol";
import type { PackageFact, RepoFacts } from "./repo-facts";
import { SOURCE_HASH_EXCLUDE_RULES, SOURCE_HASH_INCLUDE_RULES, type SourceHashResult } from "./source-hash";

export const EVIDENCE_SCHEMA = "omp-session-broker-evidence/1";
export const HANDOFF_SCHEMA = "omp-session-broker-handoff/1";
export const HANDOFF_ID = "omp-broker-v1";
export const HANDOFF_JSON_NAME = "omp-broker-v1.json";
export const HANDOFF_MD_NAME = "omp-broker-v1.md";

/** Suites del proyecto (mismas que `scripts/verify.ts`). */
export const SUITE_NAMES = ["protocol", "broker", "cli", "omp", "recovery", "handoff"] as const;
export type SuiteName = (typeof SUITE_NAMES)[number];

/** Comandos exactos que el handoff debe documentar (tras normalizar rutas). */
export const EXPECTED_COMMANDS: Readonly<Record<string, string>> = {
  verify: "bun run verify",
  typecheck: "bun run typecheck",
  "test:protocol": "bun run test:protocol",
  "test:broker": "bun run test:broker",
  "test:cli": "bun run test:cli",
  "test:omp": "bun run test:omp",
  "test:recovery": "bun run test:recovery",
  "test:handoff": "bun run test:handoff",
  "test:handoff-other-cwd": "bun run --cwd <repo> test:handoff",
};

/**
 * Estados del evidence input (flujo de DOS ESTADOS, sin evidencia circular):
 *  - `pre-gate`: se materializa el handoff ANTES de los gates que dependen de
 *    sus propios artefactos (`test:handoff`, `verify`, `test:handoff-other-cwd`).
 *    Esos tres comandos —y la suite `handoff`— se registran EXPLÍCITAMENTE
 *    como `pending` con números `null`: jamás se inventa un exit 0 para poder
 *    arrancar. El resto de gates base exige resultados REALES en verde.
 *  - `final`: los nueve comandos y las seis suites llevan resultados REALES
 *    observados tras el cierre del gate; no queda ningún `pending`.
 */
export type EvidenceStage = "pre-gate" | "final";
export const EVIDENCE_STAGES: readonly EvidenceStage[] = ["pre-gate", "final"];

/** Comandos autorreferenciales (solo existen con artefactos ya materializados). */
export const SELF_REFERENTIAL_COMMAND_IDS: readonly string[] = [
  "verify",
  "test:handoff",
  "test:handoff-other-cwd",
];

/** Gates base (previos a la materialización): siempre resultados reales. */
export const BASE_COMMAND_IDS: readonly string[] = [
  "typecheck",
  "test:protocol",
  "test:broker",
  "test:cli",
  "test:omp",
  "test:recovery",
];

/** Suite autorreferencial: su resultado se anexa al cierre del gate. */
export const SELF_REFERENTIAL_SUITE: SuiteName = "handoff";

/** Texto con el que se renderiza un resultado aún no observado. */
export const PENDING_RENDER_TEXT = "pending — se anexa al cierre del gate";

/**
 * Fragmento REAL del bloque `consumer` que escribe la suite del consumidor
 * (`tests/handoff/consumer.test.ts`) y que el coordinador fusiona en su
 * evidence input. Vive bajo `docs/handoff/` ⇒ excluido del source hash.
 */
export const CONSUMER_FRAGMENT_SCHEMA = "omp-session-broker-evidence-consumer/1";
export const CONSUMER_FRAGMENT_RELATIVE_PATH = "docs/handoff/evidence/consumer.fragment.json";

/** Requisitos trazados (títulos de `.plans/omp-session-broker/requirements.md`). */
export const REQUIREMENT_TITLES: Readonly<Record<string, string>> = {
  "FR-001": "Broker standalone y genérico",
  "FR-002": "Proyecto, checkout y configuración",
  "FR-003": "Identidad lógica y bootstrap raíz",
  "FR-004": "Autenticación, grants y control",
  "FR-005": "Consultas sin inferencia",
  "FR-006": "Mensajes y control correlacionados",
  "FR-007": "Persistencia, deduplicación e incertidumbre",
  "FR-008": "Adaptador OMP nativo",
  "FR-009": "Recovery y límites",
  "FR-010": "Operación y autoarranque opt-in",
  "FR-011": "Fronteras públicas y entrega reproducible",
  "NFR-001": "Seguridad",
  "NFR-002": "Verificación aislada",
  "NFR-003": "Gobernanza",
  "NFR-004": "Compatibilidad y límites",
};

/** Símbolos públicos clave por paquete (verificados contra el `src` real). */
export const PUBLIC_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  "@session-broker/protocol": [
    "PROTOCOL_VERSION",
    "PROTOCOL_MAJOR",
    "PROTOCOL_ERROR_TABLE",
    "EXIT_CODES",
    "LIMITS",
    "CAPABILITIES",
    "CORE_CAPABILITIES",
    "OPTIONAL_CAPABILITIES",
    "REQUEST_STATES",
    "OPERATIONS",
    "ROOT_PROOF_VERSION",
    "validateHello",
    "validateWelcome",
    "negotiateHelloVersion",
    "validateRequestEnvelope",
    "validateResponseEnvelope",
    "validateEventEnvelope",
    "canonicalJson",
    "computePayloadHash",
    "sha256Hex",
    "evaluateGrant",
    "parseGrant",
    "assertControlEpoch",
    "computeRootProofMac",
    "verifyRootProof",
    "evaluateRootBindingClaim",
    "RootProofLedger",
    "evaluateDedup",
    "allowsAutomaticReExecution",
    "applyRequestEvent",
    "classifyAskCompletion",
    "protocolError",
    "cliExitCodeForError",
    "exitCodeForErrorCode",
    "checkOperationSupport",
    "newProjectId",
    "newWorkspaceId",
    "newInstanceId",
    "newRequestId",
    "newGrantId",
    "newRootProofId",
    "referenceFixtures",
    "checkValidFixture",
    "referenceInvalidFixtures",
    "checkInvalidFixture",
  ],
  "@session-broker/client": [
    "createClient",
    "reconnectDelayMs",
    "BrokerClientError",
    "isBrokerClientError",
    "BrokerClient",
    "ClientOptions",
    "Subscription",
    "ClientErrorKind",
  ],
  "@session-broker/server": [
    "createBrokerServer",
    "BrokerServerOptions",
    "BrokerServer",
    "createBackup",
    "verifyBackup",
    "restoreBackup",
    "BACKUP_FORMAT_VERSION",
    "RESTORE_POLICY",
    "createLogger",
    "redactLogValue",
  ],
  "@session-broker/cli": [
    "runCli",
    "renderSystemdUserUnit",
    "assertOutsideWorktrees",
    "escapeSystemdValue",
    "SYSTEMD_UNIT_NAME",
    "SESSION_BROKER_ENV_FILE_NAME",
  ],
  "@session-broker/omp-adapter": [
    "createOmpAdapter",
    "OmpAdapter",
    "OmpAdapterOptions",
    "issueRootProof",
    "IssueRootProofInput",
    "OmpExtensionHost",
    "OmpToolDefinition",
    "OmpToolResult",
    "OmpHostEvent",
    "OmpRunState",
    "OmpSendUserMessageOptions",
    "OmpToolContext",
    "OmpBrokerOps",
    "OmpNativeSnapshot",
    "PendingAskView",
  ],
};

/** Nombres canónicos de los tarballs del snapshot (receta congelada). */
export function canonicalVendorName(packageName: string, version: string): string {
  const segment = packageName.split("/")[1];
  return `session-broker-${segment}-${version}.tgz`;
}

// ------------------------------------------------------------------ evidencia

export type EvidenceEntryStatus = "ok" | "pending";

export interface EvidenceCommand {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  /** `pending` = aún no observado (solo permitido en stage `pre-gate`). */
  readonly status: EvidenceEntryStatus;
  /** Exit code observado; `null` SIEMPRE Y SOLO SI `status` es `pending`. */
  readonly exitCode: number | null;
  readonly notes?: string;
}

export interface EvidenceSuite {
  readonly suite: SuiteName;
  readonly status: EvidenceEntryStatus;
  readonly tests: number | null;
  readonly failures: number | null;
  readonly skipped: number | null;
  readonly exitCode: number | null;
  readonly notes?: string;
}

export interface EvidenceVendorArtifact {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface EvidenceRequirement {
  readonly id: string;
  readonly suites: readonly SuiteName[];
  readonly result: "pass" | "partial";
  readonly notes?: string;
}

export interface EvidenceCapability {
  readonly name: string;
  readonly status: "supported" | "partial" | "unsupported";
  readonly evidence: string;
}

export interface EvidenceConsumer {
  readonly smokeExitCode: number;
  readonly relocationExitCode: number;
  readonly vendorArtifacts: readonly EvidenceVendorArtifact[];
  readonly notes?: string;
}

export interface EvidenceEnvironment {
  readonly bun: string;
  readonly typescript?: string;
  readonly os: string;
  readonly notes?: string;
}

export interface EvidenceInput {
  readonly schema: typeof EVIDENCE_SCHEMA;
  /** `pre-gate` (con pendientes explícitos) o `final` (todo observado). */
  readonly stage: EvidenceStage;
  /** Fecha/hora de la evidencia (ISO 8601). La usa el handoff como fecha real. */
  readonly evidenceDate: string;
  readonly operator: string;
  readonly environment: EvidenceEnvironment;
  readonly commands: readonly EvidenceCommand[];
  readonly suites: readonly EvidenceSuite[];
  /** Observación de teardown de las suites (TMP/HOME/fake model/red). */
  readonly teardown: string;
  readonly consumer: EvidenceConsumer;
  readonly omp?: { readonly version: string; readonly notes?: string };
  readonly capabilities: readonly EvidenceCapability[];
  readonly limitations: readonly string[];
  readonly notPerformed: readonly string[];
  readonly requirements: readonly EvidenceRequirement[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Valida el evidence input (forma + coherencia interna + completitud exigida)
 * y devuelve la versión tipada. Lanza `Error` con TODOS los problemas.
 */
export function parseEvidenceInput(raw: unknown, ctx: { facts: RepoFacts }): EvidenceInput {
  const problems: string[] = [];
  const push = (message: string): void => {
    problems.push(message);
  };
  if (!isRecord(raw)) {
    throw new Error("evidence input: se esperaba un objeto JSON");
  }
  if (raw["schema"] !== EVIDENCE_SCHEMA) {
    push(`schema: se esperaba "${EVIDENCE_SCHEMA}" (obtenido: ${JSON.stringify(raw["schema"])})`);
  }
  const evidenceDate = raw["evidenceDate"];
  if (!isNonEmptyString(evidenceDate) || Number.isNaN(Date.parse(evidenceDate))) {
    push("evidenceDate: se requiere fecha/hora ISO 8601 parseable");
  }
  const operator = raw["operator"];
  if (!isNonEmptyString(operator)) push("operator: se requiere identidad del ejecutor (p. ej. \"coordinator\")");

  const environmentRaw = raw["environment"];
  if (!isRecord(environmentRaw)) {
    push("environment: objeto requerido");
  } else {
    if (!isNonEmptyString(environmentRaw["bun"])) push("environment.bun: requerido (versión observada)");
    if (!isNonEmptyString(environmentRaw["os"])) push("environment.os: requerido");
  }

  // ---------------------------------------------------------------- stage
  const stageRaw = raw["stage"];
  const stageValid = stageRaw === "pre-gate" || stageRaw === "final";
  if (!stageValid) {
    push(`stage: "pre-gate" | "final" (obtenido: ${JSON.stringify(stageRaw)})`);
  }
  const stage: EvidenceStage = stageValid ? (stageRaw as EvidenceStage) : "pre-gate";

  // ------------------------------------------------------------- comandos
  const commandsRaw = raw["commands"];
  const commands: EvidenceCommand[] = [];
  if (!Array.isArray(commandsRaw)) {
    push("commands: array requerido");
  } else {
    const byId = new Map<string, EvidenceCommand>();
    for (const entry of commandsRaw) {
      if (!isRecord(entry)) {
        push("commands[]: entrada no objetual");
        continue;
      }
      const id = entry["id"];
      const command = entry["command"];
      const cwd = entry["cwd"];
      const status = entry["status"];
      const exitCode = entry["exitCode"];
      const statusValid = status === "ok" || status === "pending";
      const exitValid =
        (status === "pending" && exitCode === null) || (status === "ok" && isIntegerInRange(exitCode, 0, 255));
      if (!isNonEmptyString(id)) push("commands[].id: requerido");
      if (!isNonEmptyString(command)) push("commands[].command: requerido");
      if (!isNonEmptyString(cwd)) push("commands[].cwd: requerido (usa \".\" o \"<repo>/...\")");
      if (!statusValid) push(`commands[${String(id)}].status: "ok" | "pending"`);
      if (!exitValid) {
        push(`commands[${String(id)}]: status "pending" exige exitCode null; status "ok" exige exit code observado 0..255`);
      }
      if (isNonEmptyString(id) && isNonEmptyString(command) && isNonEmptyString(cwd) && statusValid && exitValid) {
        const parsed: EvidenceCommand = {
          id,
          command,
          cwd,
          status: status as EvidenceEntryStatus,
          exitCode: exitCode as number | null,
          ...(isNonEmptyString(entry["notes"]) ? { notes: entry["notes"] } : {}),
        };
        if (byId.has(id)) push(`commands[${id}]: id duplicado`);
        byId.set(id, parsed);
        commands.push(parsed);
      }
    }
    for (const [id, expected] of Object.entries(EXPECTED_COMMANDS)) {
      const entry = byId.get(id);
      if (entry === undefined) {
        push(`commands: falta el comando requerido "${id}" (${expected})`);
        continue;
      }
      if (entry.command !== expected) {
        push(`commands[${id}].command: se esperaba exactamente "${expected}" (obtenido "${entry.command}")`);
      }
      const selfReferential = SELF_REFERENTIAL_COMMAND_IDS.includes(id);
      if (selfReferential && stage === "pre-gate") {
        if (entry.status !== "pending" || entry.exitCode !== null) {
          push(
            `commands[${id}]: en stage "pre-gate" los comandos autorreferenciales (${SELF_REFERENTIAL_COMMAND_IDS.join(", ")}) se registran status "pending" y exitCode null; no se inventa un 0 para poder arrancar`,
          );
        }
      } else if (entry.status !== "ok") {
        push(`commands[${id}]: status "pending" solo se permite en stage "pre-gate" y solo para ${SELF_REFERENTIAL_COMMAND_IDS.join(", ")}`);
      } else if (entry.exitCode !== 0) {
        push(`commands[${id}]: exit code observado ${entry.exitCode} ≠ 0; el handoff no materializa gates en rojo`);
      }
    }
  }

  // --------------------------------------------------------------- suites
  const suitesRaw = raw["suites"];
  const suites: EvidenceSuite[] = [];
  if (!Array.isArray(suitesRaw)) {
    push("suites: array requerido");
  } else {
    const seen = new Set<string>();
    for (const entry of suitesRaw) {
      if (!isRecord(entry)) {
        push("suites[]: entrada no objetual");
        continue;
      }
      const suite = entry["suite"];
      const validSuite = typeof suite === "string" && (SUITE_NAMES as readonly string[]).includes(suite);
      if (!validSuite) push(`suites[].suite: debe ser uno de ${SUITE_NAMES.join(", ")} (obtenido: ${JSON.stringify(suite)})`);
      const status = entry["status"];
      const statusValid = status === "ok" || status === "pending";
      if (!statusValid) push(`suites[${String(suite)}].status: "ok" | "pending"`);
      const tests = entry["tests"];
      const failures = entry["failures"];
      const skipped = entry["skipped"];
      const exitCode = entry["exitCode"];
      const pendingShape = tests === null && failures === null && skipped === null && exitCode === null;
      const observedShape =
        isIntegerInRange(tests, 0, Number.MAX_SAFE_INTEGER) &&
        isIntegerInRange(failures, 0, Number.MAX_SAFE_INTEGER) &&
        isIntegerInRange(skipped, 0, Number.MAX_SAFE_INTEGER) &&
        isIntegerInRange(exitCode, 0, 255);
      const numbersOk = (status === "pending" && pendingShape) || (status === "ok" && observedShape);
      if (!numbersOk) {
        push(`suites[${String(suite)}]: status "pending" exige tests/failures/skipped/exitCode null; status "ok" exige enteros observados (exit 0..255)`);
      }
      if (validSuite && statusValid && numbersOk) {
        if (seen.has(suite)) push(`suites[${String(suite)}]: duplicada`);
        seen.add(suite);
        if (status === "ok") {
          if (tests === 0) push(`suites[${String(suite)}]: tests=0 (suite vacía no cuenta como evidencia)`);
          if (failures !== 0 || skipped !== 0 || exitCode !== 0) {
            push(`suites[${String(suite)}]: resultados en rojo/vacíos (failures=${String(failures)}, skipped=${String(skipped)}, exit=${String(exitCode)}); no se maquillan`);
          }
        }
        suites.push({
          suite: suite as SuiteName,
          status: status as EvidenceEntryStatus,
          tests: tests as number | null,
          failures: failures as number | null,
          skipped: skipped as number | null,
          exitCode: exitCode as number | null,
          ...(isNonEmptyString(entry["notes"]) ? { notes: entry["notes"] } : {}),
        });
      }
    }
    for (const name of SUITE_NAMES) {
      const entry = suites.find((candidate) => candidate.suite === name);
      if (entry === undefined) {
        push(`suites: falta el resultado de la suite "${name}"`);
        continue;
      }
      const selfReferential = name === SELF_REFERENTIAL_SUITE;
      if (selfReferential && stage === "pre-gate") {
        if (entry.status !== "pending") {
          push(`suites[${name}]: en stage "pre-gate" la suite "${SELF_REFERENTIAL_SUITE}" se registra status "pending" (sus resultados se anexan al cierre del gate)`);
        }
      } else if (entry.status !== "ok") {
        push(`suites[${name}]: status "pending" solo se permite en stage "pre-gate" y solo para la suite "${SELF_REFERENTIAL_SUITE}"`);
      }
    }
  }

  if (!isNonEmptyString(raw["teardown"])) {
    push("teardown: se requiere la observación de teardown (TMP/HOME/fake model/red)");
  }

  // ------------------------------------------------------------- consumidor
  const consumerRaw = raw["consumer"];
  if (!isRecord(consumerRaw)) {
    push("consumer: objeto requerido");
  } else {
    const smokeExitCode = consumerRaw["smokeExitCode"];
    const relocationExitCode = consumerRaw["relocationExitCode"];
    if (!isIntegerInRange(smokeExitCode, 0, 255)) push("consumer.smokeExitCode: exit code observado requerido");
    if (!isIntegerInRange(relocationExitCode, 0, 255)) push("consumer.relocationExitCode: exit code observado requerido");
    if (isIntegerInRange(smokeExitCode, 0, 255) && smokeExitCode !== 0) {
      push(`consumer.smokeExitCode: ${smokeExitCode} ≠ 0; el smoke consumidor debe pasar`);
    }
    if (isIntegerInRange(relocationExitCode, 0, 255) && relocationExitCode !== 0) {
      push(`consumer.relocationExitCode: ${relocationExitCode} ≠ 0; la relocalización debe pasar`);
    }
    const artifactsRaw = consumerRaw["vendorArtifacts"];
    const expectedFiles = ctx.facts.packages.map((pkg) => canonicalVendorName(pkg.name, pkg.version));
    if (!Array.isArray(artifactsRaw)) {
      push("consumer.vendorArtifacts: array requerido (los cinco tarballs del snapshot)");
    } else {
      const seenFiles = new Set<string>();
      for (const entry of artifactsRaw) {
        if (!isRecord(entry)) {
          push("consumer.vendorArtifacts[]: entrada no objetual");
          continue;
        }
        const file = entry["file"];
        const sha256 = entry["sha256"];
        const bytes = entry["bytes"];
        if (!isNonEmptyString(file) || !expectedFiles.includes(file)) {
          push(`consumer.vendorArtifacts[].file: debe ser uno de ${expectedFiles.join(", ")} (obtenido: ${JSON.stringify(file)})`);
        }
        if (typeof sha256 !== "string" || !HEX_64.test(sha256)) {
          push(`consumer.vendorArtifacts[${String(file)}].sha256: se requiere sha256 hex de 64 chars`);
        }
        if (!isIntegerInRange(bytes, 1, Number.MAX_SAFE_INTEGER)) {
          push(`consumer.vendorArtifacts[${String(file)}].bytes: se requiere tamaño observado > 0`);
        }
        if (isNonEmptyString(file)) {
          if (seenFiles.has(file)) push(`consumer.vendorArtifacts: "${file}" duplicado`);
          seenFiles.add(file);
        }
      }
      for (const expected of expectedFiles) {
        if (!seenFiles.has(expected)) push(`consumer.vendorArtifacts: falta "${expected}"`);
      }
    }
  }

  // ---------------------------------------------------------- capabilities
  const capabilitiesRaw = raw["capabilities"];
  const capabilities: EvidenceCapability[] = [];
  const freezeCapabilities = ctx.facts.freeze.capabilities;
  if (!Array.isArray(capabilitiesRaw)) {
    push("capabilities: array requerido");
  } else {
    const seen = new Set<string>();
    for (const entry of capabilitiesRaw) {
      if (!isRecord(entry)) {
        push("capabilities[]: entrada no objetual");
        continue;
      }
      const name = entry["name"];
      const status = entry["status"];
      const evidence = entry["evidence"];
      const nameOk = isNonEmptyString(name) && freezeCapabilities.includes(name);
      if (!nameOk) push(`capabilities[].name: debe ser una capability de freeze.json (obtenido: ${JSON.stringify(name)})`);
      const statusOk = status === "supported" || status === "partial" || status === "unsupported";
      if (!statusOk) push(`capabilities[${String(name)}].status: supported | partial | unsupported`);
      if (!isNonEmptyString(evidence)) push(`capabilities[${String(name)}].evidence: referencia de evidencia requerida`);
      if (nameOk && statusOk && isNonEmptyString(evidence)) {
        if (seen.has(name)) push(`capabilities[${String(name)}]: duplicada`);
        seen.add(name);
        if (ctx.facts.freeze.coreCapabilities.includes(name) && status !== "supported") {
          push(`capabilities[${String(name)}]: es CORE y está "${String(status)}"; un core faltante bloquea, no se declara limitación`);
        }
        capabilities.push({ name, status: status as EvidenceCapability["status"], evidence });
      }
    }
    for (const name of freezeCapabilities) {
      if (!seen.has(name)) push(`capabilities: falta "${name}"`);
    }
  }

  // -------------------------------------------------------- limitaciones
  const limitationsRaw = raw["limitations"];
  const limitations: string[] = [];
  if (!Array.isArray(limitationsRaw) || limitationsRaw.length === 0) {
    push("limitations: se requiere al menos una limitación honesta");
  } else {
    for (const entry of limitationsRaw) {
      if (!isNonEmptyString(entry)) push("limitations[]: textos no vacíos");
      else limitations.push(entry);
    }
  }
  const notPerformedRaw = raw["notPerformed"];
  const notPerformed: string[] = [];
  if (!Array.isArray(notPerformedRaw) || notPerformedRaw.length === 0) {
    push("notPerformed: se requiere enumerar la evidencia NO realizada (G-LIVE/G-SERVICE, etc.)");
  } else {
    for (const entry of notPerformedRaw) {
      if (!isNonEmptyString(entry)) push("notPerformed[]: textos no vacíos");
      else notPerformed.push(entry);
    }
  }

  // ------------------------------------------------------- trazabilidad
  const requirementsRaw = raw["requirements"];
  const requirements: EvidenceRequirement[] = [];
  const requirementIds = Object.keys(REQUIREMENT_TITLES);
  if (!Array.isArray(requirementsRaw)) {
    push("requirements: array requerido");
  } else {
    const seen = new Set<string>();
    for (const entry of requirementsRaw) {
      if (!isRecord(entry)) {
        push("requirements[]: entrada no objetual");
        continue;
      }
      const id = entry["id"];
      const suitesEntry = entry["suites"];
      const result = entry["result"];
      const notes = entry["notes"];
      const idOk = isNonEmptyString(id) && requirementIds.includes(id);
      if (!idOk) push(`requirements[].id: debe ser uno de ${requirementIds.join(", ")} (obtenido: ${JSON.stringify(id)})`);
      const suitesOk =
        Array.isArray(suitesEntry) &&
        suitesEntry.length > 0 &&
        suitesEntry.every((name) => typeof name === "string" && (SUITE_NAMES as readonly string[]).includes(name));
      if (!suitesOk) push(`requirements[${String(id)}].suites: subconjunto no vacío de ${SUITE_NAMES.join(", ")}`);
      const resultOk = result === "pass" || result === "partial";
      if (!resultOk) push(`requirements[${String(id)}].result: "pass" | "partial"`);
      if (result === "partial" && !isNonEmptyString(notes)) {
        push(`requirements[${String(id)}]: "partial" exige notes que explique el hueco`);
      }
      if (idOk && suitesOk && resultOk && (result !== "partial" || isNonEmptyString(notes))) {
        if (seen.has(id)) push(`requirements[${String(id)}]: duplicado`);
        seen.add(id);
        requirements.push({
          id,
          suites: suitesEntry as SuiteName[],
          result: result as EvidenceRequirement["result"],
          ...(isNonEmptyString(notes) ? { notes } : {}),
        });
      }
    }
    for (const id of requirementIds) {
      if (!seen.has(id)) push(`requirements: falta la fila "${id}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`evidence input inválido (${problems.length} problema(s)):\n- ${problems.join("\n- ")}`);
  }

  const ompRaw = raw["omp"];
  const ompEntry = isRecord(ompRaw) && isNonEmptyString(ompRaw["version"])
    ? {
        version: ompRaw["version"] as string,
        ...(isNonEmptyString(ompRaw["notes"]) ? { notes: ompRaw["notes"] as string } : {}),
      }
    : undefined;

  return {
    schema: EVIDENCE_SCHEMA,
    stage,
    evidenceDate: evidenceDate as string,
    operator: operator as string,
    environment: {
      bun: (environmentRaw as Record<string, unknown>)["bun"] as string,
      os: (environmentRaw as Record<string, unknown>)["os"] as string,
      ...(isNonEmptyString((environmentRaw as Record<string, unknown>)["typescript"])
        ? { typescript: (environmentRaw as Record<string, unknown>)["typescript"] as string }
        : {}),
      ...(isNonEmptyString((environmentRaw as Record<string, unknown>)["notes"])
        ? { notes: (environmentRaw as Record<string, unknown>)["notes"] as string }
        : {}),
    },
    commands,
    suites,
    teardown: raw["teardown"] as string,
    consumer: {
      smokeExitCode: (consumerRaw as Record<string, unknown>)["smokeExitCode"] as number,
      relocationExitCode: (consumerRaw as Record<string, unknown>)["relocationExitCode"] as number,
      vendorArtifacts: (consumerRaw as Record<string, unknown>)["vendorArtifacts"] as EvidenceVendorArtifact[],
      ...(isNonEmptyString((consumerRaw as Record<string, unknown>)["notes"])
        ? { notes: (consumerRaw as Record<string, unknown>)["notes"] as string }
        : {}),
    },
    ...(ompEntry === undefined ? {} : { omp: ompEntry }),
    capabilities,
    limitations,
    notPerformed,
    requirements,
  };
}

// --------------------------------------------------------------- documento

export interface HandoffPackageInfo {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly publicSymbols: readonly string[];
}

export interface HandoffCommand {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  /** `pending` = aún no observado al materializar (solo stage `pre-gate`). */
  readonly status: EvidenceEntryStatus;
  /** Exit code observado; `null` SIEMPRE Y SOLO SI `status` es `pending`. */
  readonly exitCode: number | null;
  readonly notes?: string;
}

export interface HandoffVerification {
  /** Stage del evidence input con el que se materializó este handoff. */
  readonly stage: EvidenceStage;
  readonly environment: EvidenceEnvironment;
  readonly commands: readonly HandoffCommand[];
  readonly suites: readonly EvidenceSuite[];
  readonly teardown: string;
  readonly consumer: {
    readonly smokeExitCode: number;
    readonly relocationExitCode: number;
    readonly vendorArtifacts: readonly EvidenceVendorArtifact[];
  };
}

export interface HandoffCapability {
  readonly name: string;
  readonly status: "supported" | "partial" | "unsupported";
  readonly evidence: string;
}

export interface HandoffDoc {
  readonly schema: typeof HANDOFF_SCHEMA;
  readonly handoffId: typeof HANDOFF_ID;
  readonly generatedFrom: {
    readonly evidenceSchema: typeof EVIDENCE_SCHEMA;
    readonly stage: EvidenceStage;
    readonly evidenceDate: string;
    readonly operator: string;
  };
  readonly identification: {
    readonly title: string;
    readonly protocolVersion: string;
    readonly packages: readonly HandoffPackageInfo[];
    readonly evidenceDate: string;
    readonly origin: {
      readonly kind: "local-checkout";
      readonly npmPublished: false;
      readonly secrets: "none";
      readonly machinePaths: "none";
    };
  };
  readonly codeTraceability: {
    readonly revision: {
      readonly vcs: "git";
      readonly commits: number;
      readonly commit: null;
      readonly note: string;
    };
    readonly sourceHash: {
      readonly algorithm: string;
      readonly hash: string;
      readonly fileCount: number;
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    };
  };
  readonly verification: HandoffVerification;
  readonly capabilities: {
    readonly ompVersion: string;
    readonly matrix: readonly HandoffCapability[];
  };
  readonly consumption: {
    readonly recipe: readonly string[];
    readonly snapshotLayout: readonly string[];
    readonly adapterReuse: string;
    readonly prohibitions: readonly string[];
    readonly vendorArtifacts: readonly EvidenceVendorArtifact[];
  };
  readonly operation: {
    readonly configAndData: string;
    readonly backupRestore: string;
    readonly noLiveInference: true;
    readonly noServiceActivation: true;
    readonly gates: ReadonlyArray<{ id: "G-BROKER-LIVE" | "G-BROKER-SERVICE"; status: "opt-in-out-of-dod"; note: string }>;
    readonly notPerformed: readonly string[];
  };
  readonly limitations: readonly string[];
  readonly requirementsTraceability: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly suites: readonly string[];
    readonly result: "pass" | "partial";
    readonly notes?: string;
  }>;
}

export const CONSUMPTION_RECIPE: readonly string[] = [
  "1. Copiar las fuentes de los cinco workspaces al snapshot (src/ + package.json; sin node_modules, dist ni salidas generadas) bajo un TMP fuera del repo.",
  "2. Normalizar en el snapshot las specs internas `workspace:*` a la versión concreta publicada en cada manifest (0.1.0): el consumidor no depende de npm publicado.",
  "3. Empaquetar cada workspace con `bun pm pack` (corre en tiempo de test) y dejar los tarballs relativos en `snapshot/vendor/` con los nombres canónicos.",
  "4. `consumer-smoke/package.json` referencia los cinco tarballs con specs RELATIVAS `file:../vendor/<nombre>.tgz` (mismas specs en `overrides` para las dependencias transitivas).",
  "5. `bun install --offline` dentro de `consumer-smoke/` (HOME/XDG/BUN_INSTALL_CACHE_DIR efímeros): resuelve solo rutas relativas, sin registro npm.",
  "6. Ejecutar `bun test smoke.test.ts` en `consumer-smoke/`: importa SOLO exports públicos de los cinco paquetes y compone createBrokerServer + createClient + createOmpAdapter/issueRootProof con FakeOmpHost y fake model.",
  "7. Repetir el smoke tras copiar bundle+consumidor a un SEGUNDO TMP (relocalización): sin editar el monorepo y sin rutas absolutas de esta máquina en ningún manifest.",
];

export const CONSUMPTION_LAYOUT: readonly string[] = [
  "snapshot/package.json          # @session-broker/handoff-snapshot (private, workspaces packages/* + apps/*)",
  "snapshot/packages/{protocol,client,omp-adapter}/{package.json,src/**}",
  "snapshot/apps/{broker,cli}/{package.json,src/**}",
  "snapshot/vendor/session-broker-{protocol,client,server,cli,omp-adapter}-0.1.0.tgz",
  "snapshot/consumer-smoke/package.json   # deps file:../vendor/*.tgz (relativas)",
  "snapshot/consumer-smoke/smoke.test.ts  # consumidor externo: solo exports públicos",
];

export const CONSUMPTION_ADAPTER_REUSE =
  "El adaptador se reutiliza TAL CUAL (`@session-broker/omp-adapter` desde los tarballs): el consumidor no reimplementa el bridge OMP, no toca `packages/omp-adapter` y no pide al monorepo rehacer nada. El binding con el runtime real (shim de extensión sobre la API pública OMP) queda fuera de este handoff y es integración futura declarada.";

export const CONSUMPTION_PROHIBITIONS: readonly string[] = [
  "Sin imports privados: solo los export maps públicos (`.` y `./fixtures` del protocolo); prohibido `@session-broker/*/src/...`.",
  "Sin dependencias con rutas absolutas de esta máquina en manifests del consumidor: prohibido el esquema `file:` con ruta absoluta o con tres barras, y los symlinks absolutos.",
  "Sin `npm publish`, registro npm, red externa ni `bun add`/`bun install` con red: el consumo es offline con artefactos locales.",
  "Sin secretos (credenciales, MAC keys) en el snapshot, el consumidor ni el handoff.",
];

export const OPERATION_CONFIG_AND_DATA =
  "Config de usuario (`$XDG_CONFIG_HOME/session-broker/config.json`, permisos 600) y data del broker (`$XDG_DATA_HOME/session-broker`, fuera de worktrees; grants solo por `credentialHash` sha256). Journal de recibos del adaptador en user data. Nada de esto vive en el checkout ni se versiona.";

export const OPERATION_BACKUP_RESTORE =
  "Backup por `VACUUM INTO` (`createBackup`/`verifyBackup`/`restoreBackup` de `@session-broker/server`); el restore es conservador: sin `grants.json` (fail-closed, reautorización explícita), leases invalidados, `control_epoch` incrementado, writer lock NO heredado, ledger de root proofs íntegro y `outcome_unknown` conservado tal cual.";

export const OPERATION_GATES: ReadonlyArray<{ id: "G-BROKER-LIVE" | "G-BROKER-SERVICE"; status: "opt-in-out-of-dod"; note: string }> = [
  {
    id: "G-BROKER-LIVE",
    status: "opt-in-out-of-dod",
    note: "Inferencia/proveedores reales y gasto: opt-in del operador, FUERA del DoD. Ninguna suite ni el consumidor ejecutan inferencia real (fake model que lanza si se invoca).",
  },
  {
    id: "G-BROKER-SERVICE",
    status: "opt-in-out-of-dod",
    note: "Servicio systemd user persistente: opt-in del operador, FUERA del DoD. Solo artefactos de ejemplo en `ops/systemd/` y service manager fake en tests; nada instalado/habilitado/arrancado.",
  },
];

const REVISION_NOTE =
  "Repo Git inicializado SIN commits: no hay SHA que declarar y no se inventa. La trazabilidad se sostiene en el hash determinista del conjunto fuente (algoritmo y reglas incluidas abajo); un cambio de fuente tras generar el handoff invalida el hash y exige un nuevo gate.";

/**
 * Construye el documento del handoff a partir de evidencia REAL ya validada y
 * de los hechos del repo. Determinista: mismo evidence + misma fuente ⇒ bytes
 * idénticos (sin relojes, sin rutas absolutas, sin orden arbitrario).
 */
export function buildHandoffDoc(input: {
  evidence: EvidenceInput;
  facts: RepoFacts;
  sourceHash: SourceHashResult;
}): HandoffDoc {
  const { evidence, facts, sourceHash } = input;
  const packages: HandoffPackageInfo[] = facts.packages.map((pkg: PackageFact) => ({
    name: pkg.name,
    version: pkg.version,
    dir: pkg.dir,
    exports: pkg.exports,
    publicSymbols: PUBLIC_SYMBOLS[pkg.name] ?? [],
  }));
  return {
    schema: HANDOFF_SCHEMA,
    handoffId: HANDOFF_ID,
    generatedFrom: {
      evidenceSchema: EVIDENCE_SCHEMA,
      stage: evidence.stage,
      evidenceDate: evidence.evidenceDate,
      operator: evidence.operator,
    },
    identification: {
      title: "Handoff verificado del omp-session-broker (SDK + adaptador OMP consumibles sin publicación)",
      protocolVersion: facts.protocolVersion,
      packages,
      evidenceDate: evidence.evidenceDate,
      origin: {
        kind: "local-checkout",
        npmPublished: false,
        secrets: "none",
        machinePaths: "none",
      },
    },
    codeTraceability: {
      revision: {
        vcs: "git",
        commits: 0,
        commit: null,
        note: REVISION_NOTE,
      },
      sourceHash: {
        algorithm: sourceHash.algorithm,
        hash: sourceHash.hash,
        fileCount: sourceHash.fileCount,
        include: SOURCE_HASH_INCLUDE_RULES,
        exclude: SOURCE_HASH_EXCLUDE_RULES,
      },
    },
    verification: {
      stage: evidence.stage,
      environment: evidence.environment,
      commands: evidence.commands.map((entry) => ({
        id: entry.id,
        command: entry.command,
        cwd: entry.cwd,
        status: entry.status,
        exitCode: entry.exitCode,
        ...(entry.notes === undefined ? {} : { notes: entry.notes }),
      })),
      suites: evidence.suites,
      teardown: evidence.teardown,
      consumer: {
        smokeExitCode: evidence.consumer.smokeExitCode,
        relocationExitCode: evidence.consumer.relocationExitCode,
        vendorArtifacts: evidence.consumer.vendorArtifacts,
      },
    },
    capabilities: {
      ompVersion: evidence.omp?.version ?? "sin versión OMP declarada en la evidencia",
      matrix: evidence.capabilities,
    },
    consumption: {
      recipe: CONSUMPTION_RECIPE,
      snapshotLayout: CONSUMPTION_LAYOUT,
      adapterReuse: CONSUMPTION_ADAPTER_REUSE,
      prohibitions: CONSUMPTION_PROHIBITIONS,
      vendorArtifacts: evidence.consumer.vendorArtifacts,
    },
    operation: {
      configAndData: OPERATION_CONFIG_AND_DATA,
      backupRestore: OPERATION_BACKUP_RESTORE,
      noLiveInference: true,
      noServiceActivation: true,
      gates: OPERATION_GATES,
      notPerformed: evidence.notPerformed,
    },
    limitations: evidence.limitations,
    requirementsTraceability: evidence.requirements.map((row) => ({
      id: row.id,
      title: REQUIREMENT_TITLES[row.id] ?? row.id,
      suites: row.suites,
      result: row.result,
      ...(row.notes === undefined ? {} : { notes: row.notes }),
    })),
  };
}
