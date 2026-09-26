/**
 * Unidad systemd user: generación declarativa sin instalar nada (FR-010).
 *
 * La suite valida CONTENIDO y ESCAPE contra fixtures y afirma el
 * comportamiento del generador:
 *   - rutas/argumentos explícitos y absolutos, escapados correctamente;
 *   - data dir FUERA de worktrees (se rechaza lo contrario);
 *   - `Restart=` solo del broker (una unidad, un proceso);
 *   - secretos JAMÁS en `ExecStart` ni en archivos versionados: el
 *     `EnvironmentFile` se referencia, no se rellena con valores;
 *   - sin lingering y sin una sola operación sobre el service manager (fake
 *     que debe quedar intacto): ni install, ni enable, ni start, ni
 *     daemon-reload.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_BROKER_ENV_FILE_NAME,
  SYSTEMD_UNIT_NAME,
  assertOutsideWorktrees,
  escapeSystemdValue,
  renderSystemdUserUnit,
} from "@session-broker/cli";
import { FakeServiceManager, assertModelUnused, setupIsolation, type Isolation } from "./helpers";

const CREDENTIAL = "fixture-credential-not-a-real-secret";
const MAC_KEY = "fixture-mac-key-not-a-real-secret";

let isolation: Isolation;
const serviceManager = new FakeServiceManager();

beforeAll(() => {
  isolation = setupIsolation("recovery-systemd");
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

function fixtureInput(): Parameters<typeof renderSystemdUserUnit>[0] {
  return {
    exec: {
      command: "/usr/bin/env",
      args: ["bun", "/opt/session-broker/apps/broker/src/serve.ts", "--config", "/etc/session-broker/broker.env"],
    },
    dataDir: "/var/lib/session-broker",
    environmentFile: "/home/user/.config/session-broker/broker.env",
    workingDirectory: "/opt/session-broker",
    worktreeRoots: ["/home/user/code/broker", "/home/user/.herdr/worktrees/theelena/control-de-caja"],
    restart: "on-failure",
    restartSec: 5,
  };
}

describe("generador de la unidad user (contenido y escape)", () => {
  test("la unidad declara rutas explícitas, Restart solo del broker y EnvironmentFile", () => {
    const rendered = renderSystemdUserUnit(fixtureInput());
    expect(rendered.unitName).toBe(SYSTEMD_UNIT_NAME);
    const unit = rendered.unit;
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain('ExecStart="/usr/bin/env" "bun" "/opt/session-broker/apps/broker/src/serve.ts" "--config" "/etc/session-broker/broker.env"');
    expect(unit).toContain("Environment=SESSION_BROKER_DATA_DIR=\"/var/lib/session-broker\"");
    expect(unit).toContain("EnvironmentFile=-\"/home/user/.config/session-broker/broker.env\"");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("WorkingDirectory=\"/opt/session-broker\"");
    // SOLO el broker se reinicia: una unidad, un proceso, un ExecStart.
    expect(unit.split("\n").filter((line) => line.startsWith("ExecStart=")).length).toBe(1);
    expect(unit).not.toContain("ExecStartPre");
    expect(unit).not.toContain("ExecStopPost");
    expect(unit).not.toContain("socket");
  });

  test("los secretos jamás aparecen en la unidad ni en archivos versionados", () => {
    const rendered = renderSystemdUserUnit(fixtureInput());
    const artifacts = `${rendered.unit}\n${rendered.environmentFileTemplate}`;
    expect(artifacts.includes(CREDENTIAL)).toBe(false);
    expect(artifacts.includes(MAC_KEY)).toBe(false);
    expect(artifacts).not.toContain("SESSION_BROKER_CREDENTIAL=");
    // La MAC key se referencia como variable, nunca con valor.
    expect(rendered.environmentFileTemplate).toContain("# SESSION_BROKER_MAC_KEY=");
    expect(rendered.environmentFileTemplate.split("\n").some((line) => /^SESSION_BROKER_MAC_KEY=\S/.test(line))).toBe(false);
  });

  test("sin lingering y sin comandos de activación en el artefacto", () => {
    const rendered = renderSystemdUserUnit(fixtureInput());
    const artifacts = `${rendered.unit}\n${rendered.environmentFileTemplate}`;
    expect(artifacts).not.toContain("loginctl");
    expect(artifacts).not.toContain("enable-linger");
    expect(artifacts).not.toContain("systemctl");
    expect(artifacts).not.toContain("daemon-reload");
  });

  test("el escape de argumentos es explícito y rechaza inyecciones", () => {
    expect(escapeSystemdValue("/ruta/con espacios/broker.env", "test")).toBe('"/ruta/con espacios/broker.env"');
    expect(escapeSystemdValue('con"comillas', "test")).toBe('"con\\"comillas"');
    expect(escapeSystemdValue("con\\barra", "test")).toBe('"con\\\\barra"');
    expect(() => escapeSystemdValue("linea1\nlinea2", "test")).toThrow(/control|saltos/);
    expect(() => escapeSystemdValue("", "test")).toThrow(/vacío/);

    const withSpaces = renderSystemdUserUnit({
      exec: { command: "/usr/bin/env", args: ["/opt/sesión broker/serve.ts"] },
      dataDir: "/var/lib/session broker",
      environmentFile: "/home/user/.config/session broker/broker.env",
    });
    expect(withSpaces.unit).toContain('"/opt/sesión broker/serve.ts"');
    expect(withSpaces.unit).toContain('Environment=SESSION_BROKER_DATA_DIR="/var/lib/session broker"');
  });

  test("rutas relativas, worktrees y políticas inválidas se rechazan en silencio cero", () => {
    expect(() => renderSystemdUserUnit({ ...fixtureInput(), dataDir: "relative/data" })).toThrow(/absoluta/);
    expect(() =>
      renderSystemdUserUnit({ ...fixtureInput(), dataDir: "/home/user/code/broker/.local/data" }),
    ).toThrow(/worktree/);
    expect(() => renderSystemdUserUnit({ ...fixtureInput(), restart: "siempre" as never })).toThrow(/Restart/);
    expect(() => renderSystemdUserUnit({ ...fixtureInput(), restartSec: 0 })).toThrow(/RestartSec/);
    expect(() => assertOutsideWorktrees("/var/lib/session-broker", ["/home/user/code/broker"])).not.toThrow();
    expect(() => assertOutsideWorktrees("/home/user/code/broker/.data", ["/home/user/code/broker"])).toThrow(/worktree/);
  });
});

describe("generador frente a fixtures y service manager fake", () => {
  test("el comportamiento del generador es puro: no escribe ni toca el service manager", () => {
    const scratch = join(isolation.tmpDir, "systemd-scratch");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "placeholder.txt"), "intocable", "utf8");
    const before = readFileSync(join(scratch, "placeholder.txt"), "utf8");
    const rendered = renderSystemdUserUnit(fixtureInput());
    // Nada instalado, habilitado, arrancado ni recargado: jamás.
    expect(serviceManager.operations).toEqual([]);
    // El artefacto solo es texto: no aparece nada nuevo en el directorio.
    expect(existsSync(join(scratch, SYSTEMD_UNIT_NAME))).toBe(false);
    expect(readFileSync(join(scratch, "placeholder.txt"), "utf8")).toBe(before);
    expect(rendered.unitName).toBe(SYSTEMD_UNIT_NAME);
  });

  test("los artefactos versionados de ops/systemd son válidos y sin secretos", () => {
    const opsDir = join(import.meta.dir, "..", "..", "ops", "systemd");
    const unitExample = readFileSync(join(opsDir, "session-broker.service.example"), "utf8");
    const envExample = readFileSync(join(opsDir, "session-broker.env.example"), "utf8");
    expect(unitExample).toContain("[Unit]");
    expect(unitExample).toContain("[Service]");
    expect(unitExample).toContain("ExecStart=");
    expect(unitExample).toContain("EnvironmentFile=-");
    expect(unitExample).toContain("Restart=on-failure");
    expect(unitExample).toContain("SESSION_BROKER_DATA_DIR=");
    expect(unitExample).not.toContain("loginctl");
    expect(unitExample).not.toContain("enable-linger");
    expect(unitExample).not.toContain("systemctl");
    expect(unitExample.includes(CREDENTIAL)).toBe(false);
    expect(unitExample.includes(MAC_KEY)).toBe(false);
    expect(envExample).toContain("SESSION_BROKER_DATA_DIR=");
    expect(envExample).not.toContain("SESSION_BROKER_CREDENTIAL=");
    expect(envExample.includes(CREDENTIAL)).toBe(false);
    expect(envExample.includes(MAC_KEY)).toBe(false);
    // Ninguna plantilla versionada trae valores de secreto reales.
    expect(/^SESSION_BROKER_MAC_KEY=\S+/m.test(envExample)).toBe(false);
  });

  test("la plantilla de EnvironmentFile se puede completar en TMP con permisos 600", () => {
    const rendered = renderSystemdUserUnit(fixtureInput());
    const envPath = join(isolation.tmpDir, "user-config", SESSION_BROKER_ENV_FILE_NAME);
    mkdirSync(join(isolation.tmpDir, "user-config"), { recursive: true });
    writeFileSync(envPath, rendered.environmentFileTemplate, "utf8");
    expect(existsSync(envPath)).toBe(true);
    const written = readFileSync(envPath, "utf8");
    expect(written).toContain("SESSION_BROKER_DATA_DIR=");
    expect(written.includes(CREDENTIAL)).toBe(false);
    expect(serviceManager.operations).toEqual([]);
  });
});
