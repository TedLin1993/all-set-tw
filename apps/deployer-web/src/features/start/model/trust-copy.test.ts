import { describe, expect, it } from "vitest";
import { requestedPermissions, trustPoints } from "./trust-copy";

describe("deployer trust copy", () => {
  it("does not claim zero Dashboard steps or that the deployer cannot access D1", () => {
    const text = [...trustPoints, ...requestedPermissions]
      .map((item) =>
        typeof item === "string" ? item : `${item.title}${item.body}`,
      )
      .join("\n");
    expect(text).not.toMatch(/零人工|一鍵部署已開放/);
    expect(text).toMatch(/不能宣稱絕對無法存取/);
    expect(text).toMatch(/技術上可能接觸/);
  });
});
