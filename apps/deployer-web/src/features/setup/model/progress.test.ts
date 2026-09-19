import { describe, expect, it } from "vitest";
import {
  nextAction,
  phaseState,
  publicSiteUrl,
  interruptionCopy,
  updateUnavailableCopy,
} from "./progress";

describe("install progress mapping", () => {
  it("marks earlier phases done and the current phase active", () => {
    expect(
      phaseState("prepare", {
        status: "running",
        step: "create_access_app",
        errorCode: null,
      }),
    ).toBe("done");
    expect(
      phaseState("protect", {
        status: "running",
        step: "create_access_app",
        errorCode: null,
      }),
    ).toBe("active");
    expect(
      phaseState("verify", {
        status: "running",
        step: "create_access_app",
        errorCode: null,
      }),
    ).toBe("pending");
  });

  it("maps update maintenance as the second phase", () => {
    expect(
      phaseState(
        "protect",
        { status: "running", step: "enter_maintenance", errorCode: null },
        "update",
      ),
    ).toBe("active");
  });

  it("explains missing releases and expired tokens without claiming live deploy", () => {
    expect(nextAction("RELEASE_UNAVAILABLE")).toMatch(/版本包/);
    expect(nextAction("TOKEN_EXPIRED")).toMatch(/重新授權/);
    expect(nextAction("RELEASE_UNAVAILABLE")).not.toMatch(/一鍵部署已開放/);
    expect(nextAction("UP_TO_DATE")).toMatch(/這個版本/);
    expect(nextAction("UPGRADE_NOT_ALLOWED")).toMatch(/尚未開放/);
  });

  it("describes update interruption without claiming SQL rollback", () => {
    expect(
      interruptionCopy({
        pendingMigrations: ["0002_probe_note.sql"],
        interruption: { pauseSync: true, hasMigrations: true },
      }),
    ).toMatch(/不會倒跑 SQL/);
    expect(updateUnavailableCopy("UP_TO_DATE")).toMatch(/目前已是這個版本/);
  });

  it("builds the workers.dev URL from the recorded subdomain", () => {
    expect(
      publicSiteUrl("taiwan-fin-hub", { workersSubdomain: "example" }),
    ).toBe("https://taiwan-fin-hub.example.workers.dev/");
  });
});
