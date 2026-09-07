import { describe, expect, it } from "vitest";
import { getActivityDataStatus } from "./load-status";

describe("activity data status", () => {
  it("names a failed source", () => {
    expect(
      getActivityDataStatus([
        {
          label: "銀行與信用卡",
          isError: true,
        },
        {
          label: "發票",
          isError: false,
        },
      ]),
    ).toMatchObject({
      failedLabels: ["銀行與信用卡"],
      hasFailure: true,
    });
  });

  it("reports complete data when all sources succeeded", () => {
    expect(
      getActivityDataStatus([
        {
          label: "銀行與信用卡",
          isError: false,
        },
        {
          label: "發票",
          isError: false,
        },
      ]),
    ).toEqual({
      failedLabels: [],
      hasFailure: false,
    });
  });
});
