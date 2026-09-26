/**
 * Criterio binario: la exportación de fixtures de referencia es consumible
 * desde el export público del paquete y todo fixture negativo rechaza con el
 * code/reason exacto documentado.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  checkInvalidFixture,
  checkValidFixture,
  expectedErrorTable,
  idempotentReplayExample,
  referenceFixtures,
  referenceInvalidFixtures,
  FIXTURE_VALID_NAMES,
} from "@session-broker/protocol/fixtures";
import { PROTOCOL_VERSION, evaluateDedup } from "@session-broker/protocol";
import { assertModelUnused, expectAccepted, expectRejection, setupIsolation, type Isolation } from "./helpers";

let isolation: Isolation;

beforeAll(() => {
  isolation = setupIsolation();
});

afterAll(() => {
  assertModelUnused(isolation.fakeModel);
  isolation.teardown();
});

describe("fixtures de referencia", () => {
  test("todos los fixtures válidos se aceptan", () => {
    for (const name of FIXTURE_VALID_NAMES) {
      expectAccepted(checkValidFixture(name));
    }
  });

  test("todo fixture negativo rechaza con code+reason exactos", () => {
    const invalid = referenceInvalidFixtures();
    expect(invalid.length).toBeGreaterThanOrEqual(15);
    for (const fixture of invalid) {
      expectRejection(checkInvalidFixture(fixture), fixture.expected.code, fixture.expected.reason);
    }
  });

  test("la tabla de errores esperados coincide con los fixtures", () => {
    const table = expectedErrorTable();
    const invalid = referenceInvalidFixtures();
    expect(table.map((entry) => entry.name)).toEqual(invalid.map((fixture) => fixture.name));
    for (let i = 0; i < table.length; i++) {
      expect(table[i].code).toBe(invalid[i].expected.code);
      expect(table[i].reason).toBe(invalid[i].expected.reason);
    }
  });

  test("los fixtures son deterministas entre llamadas", () => {
    const first = referenceFixtures();
    const second = referenceFixtures();
    expect(first.rootProof.mac).toBe(second.rootProof.mac);
    expect(first.rootProof.proofId).toBe(second.rootProof.proofId);
  });

  test("el par idempotente de dedup devuelve replay sin efectos", () => {
    const { existing, input } = idempotentReplayExample();
    const decision = expectAccepted(evaluateDedup(existing, input));
    expect(decision.kind).toBe("idempotent_replay");
  });

  test("la versión del paquete de referencia es la congelada", () => {
    expect(PROTOCOL_VERSION).toBe("1.0.0");
  });
});
