import { connectorConfigSchemas } from "@taiwan-fin-hub/connectors";
import { connectorCatalog, supportedConnectorIds } from "@taiwan-fin-hub/core";
import { describe, expect, it } from "vitest";
import { connectorRuntimeRegistry } from "../../../src/features/sync/registry";

describe("connector registry completeness", () => {
  it("keeps catalog, config schemas, and Worker runtimes in lockstep", () => {
    const expected = [...supportedConnectorIds].sort();

    expect(Object.keys(connectorCatalog).sort()).toEqual(expected);
    expect(Object.keys(connectorConfigSchemas).sort()).toEqual(expected);
    expect(Object.keys(connectorRuntimeRegistry).sort()).toEqual(expected);
  });

  it("declares all connectors with an all scope", () => {
    for (const connectorId of supportedConnectorIds) {
      expect(connectorCatalog[connectorId].scopes).toContain("all");
    }
  });

  it("keeps catalog-managed fields in each connector config schema", () => {
    for (const connectorId of supportedConnectorIds) {
      const schema = connectorConfigSchemas[connectorId] as unknown as {
        shape: Record<string, unknown>;
      };
      const schemaFields = Object.keys(schema.shape);
      const definition = connectorCatalog[connectorId];

      expect(schemaFields).toEqual(
        expect.arrayContaining([
          ...definition.credentialFields,
          ...definition.publicFields,
          ...definition.secretStateFields,
        ]),
      );
    }
  });
});
