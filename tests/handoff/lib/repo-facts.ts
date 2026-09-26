/**
 * Hechos verificables del repo (manifests reales + `docs/contracts/freeze.json`).
 * Los consume tanto el generator (`build-handoff.ts`) como la validación de la
 * suite (`validate-handoff.ts`): una única lectura para ambas caras evita que
 * el handoff y su validación diverjan.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FreezePackage {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly exports: readonly string[];
}

export interface FreezeDoc {
  readonly protocolVersion: string;
  readonly packages: readonly FreezePackage[];
  readonly errorCodes: ReadonlyArray<{ code: string; terminal: boolean; retrySafe: boolean; exitCode: number }>;
  readonly exitCodes: Readonly<Record<string, number>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly capabilities: readonly string[];
  readonly coreCapabilities: readonly string[];
  readonly optionalCapabilities: readonly string[];
}

export interface PackageFact {
  readonly name: string;
  readonly version: string;
  /** Ruta relativa POSIX del workspace (p. ej. `packages/protocol`). */
  readonly dir: string;
  /** Export map literal del `package.json` real (clave → ruta). */
  readonly exports: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface RepoFacts {
  readonly repoRoot: string;
  readonly protocolVersion: string;
  readonly packages: readonly PackageFact[];
  readonly freeze: FreezeDoc;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageExportsOf(manifest: Record<string, unknown>): Record<string, string> {
  const raw = manifest["exports"];
  const out: Record<string, string> = {};
  if (typeof raw === "string") {
    out["."] = raw;
    return out;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

function packageDependenciesOf(manifest: Record<string, unknown>): Record<string, string> {
  const raw = manifest["dependencies"];
  const out: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/** Lee freeze.json y los cinco manifests reales; no valida (eso lo hace el validador). */
export function readRepoFacts(repoRoot: string): RepoFacts {
  const freeze = readJson(join(repoRoot, "docs", "contracts", "freeze.json")) as FreezeDoc;
  const packages: PackageFact[] = [];
  for (const entry of freeze.packages) {
    const manifest = readJson(join(repoRoot, entry.dir, "package.json")) as Record<string, unknown>;
    packages.push({
      name: typeof manifest["name"] === "string" ? manifest["name"] : entry.name,
      version: typeof manifest["version"] === "string" ? manifest["version"] : entry.version,
      dir: entry.dir.split("\\").join("/"),
      exports: packageExportsOf(manifest),
      dependencies: packageDependenciesOf(manifest),
    });
  }
  return {
    repoRoot,
    protocolVersion: freeze.protocolVersion,
    packages,
    freeze,
  };
}
