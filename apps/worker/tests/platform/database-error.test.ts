import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { apiErrorResponse } from "../../src/platform/http";

describe("API database error logging", () => {
  afterEach(() => vi.restoreAllMocks());
  it("omits Drizzle SQL, bound values and causes from logs and responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiErrorResponse(
      new DrizzleQueryError(
        "SELECT private_query",
        ["private-value"],
        new Error("private-cause"),
      ),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    const logged = log.mock.calls[0][1] as Error;
    expect(logged.message).toBe("Database query failed.");
    expect(logged.cause).toBeUndefined();
    expect(logged.stack).not.toContain("private");
  });
});
