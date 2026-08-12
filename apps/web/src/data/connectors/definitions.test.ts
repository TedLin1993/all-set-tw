import { connectorCatalog, supportedConnectorIds } from "@taiwan-fin-hub/core";
import { describe, expect, it } from "vitest";
import { connectorDefinitions, connectorFields } from "./definitions";

describe("connector definitions", () => {
  it("keeps every catalog connector visible in the settings UI", () => {
    expect(connectorDefinitions.map(({ id }) => id)).toEqual([
      ...supportedConnectorIds,
    ]);
  });

  it("provides a form field for every credential and public preference", () => {
    for (const connectorId of supportedConnectorIds) {
      const fieldKeys = connectorFields[connectorId].map(({ key }) => key);
      const definition = connectorCatalog[connectorId];

      expect(fieldKeys).toEqual(
        expect.arrayContaining([
          ...definition.credentialFields,
          ...definition.publicFields,
        ]),
      );
    }
  });

  it("does not expose fixed sync-window settings", () => {
    for (const connectorId of supportedConnectorIds) {
      const fieldKeys = connectorFields[connectorId].map(({ key }) => key);

      expect(fieldKeys).not.toContain("periodsBack");
      expect(fieldKeys).not.toContain("lookbackMonths");
    }
  });

  it("does not expose retired sync preferences", () => {
    for (const connectorId of supportedConnectorIds) {
      expect(connectorCatalog[connectorId].publicFields).toEqual([]);
    }

    expect(connectorFields.einvoice.map(({ key }) => key)).not.toContain(
      "fetchDetails",
    );
  });
});
