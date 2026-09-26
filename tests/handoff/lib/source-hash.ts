/**
 * Hash determinista del conjunto fuente (trazabilidad de código del handoff,
 * P-006 / contenido mínimo §2).
 *
 * ALGORITMO `sha256-canonical-file-manifest-v1`:
 *   1. Se recorre el árbol desde `root` y se seleccionan los archivos que
 *      cumplen las reglas de INCLUSIÓN y no caen en ninguna EXCLUSIÓN.
 *   2. Las rutas relativas (separador `/`, sin prefijo `./`) se ordenan de
 *      forma determinista (`Array.prototype.sort()` por defecto: orden de
 *      puntos de código UTF-16).
 *   3. El manifiesto canónico es la concatenación de líneas
 *      `<sha256-hex del contenido>  <ruta relativa>\n`.
 *   4. `hash = "sha256:" + sha256-hex(manifiesto UTF-8)`.
 *
 * El hash depende SOLO de contenidos y rutas relativas: sin mtimes, sin
 * rutas absolutas, sin estado del entorno. Cualquier cambio de fuente en el
 * conjunto incluido cambia el hash (y por tanto invalida el handoff generado).
 *
 * Inclusiones: contratos, manifests, lockfile, source, tests/harness, scripts
 * de verificación y artefactos operativos que determinan el comportamiento
 * entregado. Exclusiones explícitas: el propio handoff y su evidencia
 * (`docs/handoff/**`), la planificación (`.plans/**`), dependencias
 * (`node_modules`), VCS (`.git`), salidas generadas (dist/coverage), prompts
 * de agentes y temporales. Así se evita la autorreferencia y un hash vacío o
 * solo-documentación.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const SOURCE_HASH_ALGORITHM = "sha256-canonical-file-manifest-v1";

export const SOURCE_HASH_INCLUDE_RULES: readonly string[] = [
  "package.json, tsconfig.json, bun.lock (si existe) y README.md en la raíz",
  "packages/<workspace>/{package.json,src/**}",
  "apps/<workspace>/{package.json,src/**}",
  "tests/** (suites y harness, incluido tests/handoff)",
  "scripts/** (verify.ts y utilidades de verificación)",
  "docs/contracts/**, docs/compatibility/**, docs/operations/**",
  "ops/** (artefactos operativos de ejemplo)",
];

export const SOURCE_HASH_EXCLUDE_RULES: readonly string[] = [
  "docs/handoff/** (handoff y evidencia generada: evita autorreferencia)",
  ".plans/** (planificación, no producto)",
  ".git/**, node_modules/**, **/dist/**, **/coverage/**",
  "prompts/** (material de agentes, no determina comportamiento del producto)",
  "*.tgz y otros empaquetados generados",
];

/** Directorios jamás descendidos durante el recorrido. */
const SKIP_DIR_NAMES: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  coverage: true,
  ".plans": true,
  prompts: true,
};

/** Nombres exactos incluidos en la raíz del repo. */
const ROOT_FILES: Record<string, true> = {
  "package.json": true,
  "tsconfig.json": true,
  "bun.lock": true,
  "README.md": true,
};

/** Subárboles de `docs/` que sí forman parte del conjunto fuente. */
const DOCS_INCLUDED: Record<string, true> = {
  contracts: true,
  compatibility: true,
  operations: true,
};

function isIncludedRelativePath(rel: string): boolean {
  const parts = rel.split("/");
  const top = parts[0] ?? "";
  if (parts.some((part) => SKIP_DIR_NAMES[part] === true)) return false;
  if (parts.some((part) => part.endsWith(".tgz"))) return false;
  if (parts.length === 1) return ROOT_FILES[rel] === true;
  if (top === "docs") {
    return parts.length >= 3 && parts[1] !== undefined && DOCS_INCLUDED[parts[1]] === true;
  }
  if (top === "packages" || top === "apps") {
    if (parts.length === 3) return parts[2] === "package.json";
    return parts.length >= 4 && parts[2] === "src";
  }
  return top === "tests" || top === "scripts" || top === "ops";
}

/**
 * Únicos subárboles descendidos: fuera de ellos no hay fuente que importe.
 * Profundidad explícita por rama (el bug de off-by-one en los contenedores
 * `docs`/`packages`/`apps` dejaba esos subárboles ENTEROS fuera del manifiesto):
 *  - `tests/**`, `scripts/**`, `ops/**`: cualquier profundidad.
 *  - `docs/` → solo `docs/{contracts,compatibility,operations}/**`, cualquier
 *    profundidad; `docs/handoff/**` (incluido `docs/handoff/evidence/**`) jamás
 *    se desciende ni se incluye (evita autorreferencia).
 *  - `packages/<ws>/**` y `apps/<ws>/**`: el contenedor, el workspace y
 *    `<ws>/src/**` (cualquier profundidad); jamás otros subdirectorios.
 */
function shouldDescend(rel: string): boolean {
  const parts = rel.split("/");
  const top = parts[0] ?? "";
  if (top === "tests" || top === "scripts" || top === "ops") return true;
  if (top === "docs") {
    const child = parts.length >= 2 ? (parts[1] ?? "") : "";
    return child === "" || DOCS_INCLUDED[child] === true;
  }
  if (top === "packages" || top === "apps") {
    return parts.length <= 2 || parts[2] === "src";
  }
  return false;
}

/** Recorre `root` y devuelve las rutas relativas incluidas (sin ordenar). */
export function collectSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES[entry.name] === true) continue;
        if (!shouldDescend(rel)) continue;
        walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIncludedRelativePath(rel)) found.push(rel);
    }
  };
  walk(root, "");
  return found;
}

export interface SourceHashResult {
  readonly algorithm: string;
  readonly hash: string;
  readonly fileCount: number;
  /** Rutas relativas incluidas, en orden determinista (para depuración/evidencia). */
  readonly files: readonly string[];
}

/** Calcula el hash determinista del conjunto fuente bajo `root`. */
export function computeSourceHash(root: string): SourceHashResult {
  const files = collectSourceFiles(root).sort();
  let manifest = "";
  for (const rel of files) {
    const digest = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    manifest += `${digest}  ${rel}\n`;
  }
  return {
    algorithm: SOURCE_HASH_ALGORITHM,
    hash: `sha256:${createHash("sha256").update(manifest, "utf8").digest("hex")}`,
    fileCount: files.length,
    files,
  };
}

/** Copia el conjunto fuente (mismas reglas) a `dest` para casos tampered. */
export function copySourceTree(root: string, dest: string): string[] {
  const files = collectSourceFiles(root).sort();
  for (const rel of files) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, rel), target);
  }
  return files;
}

/** Inventario de solo lectura: ruta → tamaño+sha256 (guardas de no-escritura). */
export function inventorySourceTree(root: string): Map<string, string> {
  const inventory = new Map<string, string>();
  for (const rel of collectSourceFiles(root)) {
    const full = join(root, rel);
    try {
      const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
      inventory.set(rel, `${statSync(full).size}:${digest}`);
    } catch {
      // Archivo desaparecido entre el listado y la lectura: se ignora.
    }
  }
  return inventory;
}

// ---- guarda global de no-escritura en el repo (captura al cargar el módulo) ----

/** Raíz del repo según la ubicación de esta librería (`tests/handoff/lib`). */
export const SUITE_REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function listHandoffDir(root: string): string[] {
  try {
    // `evidence/` queda fuera: es la única escritura documentada de la suite
    // (fragmento real del consumidor, excluido del source hash).
    return readdirSync(join(root, "docs", "handoff"))
      .filter((name) => name !== "evidence")
      .sort();
  } catch {
    return [];
  }
}

const initialInventory = inventorySourceTree(SUITE_REPO_ROOT);
const initialHandoffListing = listHandoffDir(SUITE_REPO_ROOT);

/**
 * Cambios observados en el repo desde que se cargó la suite. Debería ser
 * siempre `[]`: el harness escribe SOLO bajo TMP con el prefijo reservado y,
 * como única excepción documentada, el fragmento de evidencia del consumidor
 * en `docs/handoff/evidence/**` (excluido del source hash y de esta guarda).
 */
export function repoChangesSinceSuiteStart(): string[] {
  const changes: string[] = [];
  const current = inventorySourceTree(SUITE_REPO_ROOT);
  for (const [rel, stamp] of current) {
    if (initialInventory.get(rel) !== stamp) changes.push(`modificado: ${rel}`);
  }
  for (const rel of initialInventory.keys()) {
    if (!current.has(rel)) changes.push(`eliminado: ${rel}`);
  }
  const handoffNow = listHandoffDir(SUITE_REPO_ROOT);
  if (handoffNow.join("\n") !== initialHandoffListing.join("\n")) {
    changes.push(`docs/handoff cambió durante la suite: ${handoffNow.join(", ")}`);
  }
  return changes;
}
