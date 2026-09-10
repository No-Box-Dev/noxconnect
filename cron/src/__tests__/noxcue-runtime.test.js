import { describe, expect, it } from "vitest";
import { isTenantConfigurationFailure } from "../noxcue-runtime.js";

describe("NoxCue runtime failure classification", () => {
  it("does not turn tenant GitHub access configuration into a platform incident", () => {
    expect(isTenantConfigurationFailure(new Error("GitHub API error: 404 Not Found"))).toBe(true);
    expect(isTenantConfigurationFailure(new Error("GitHub API error: 403 Forbidden"))).toBe(true);
  });

  it("reports code and infrastructure failures", () => {
    expect(isTenantConfigurationFailure(new ReferenceError("ghFetch is not defined"))).toBe(false);
    expect(isTenantConfigurationFailure(new Error("D1_ERROR: database unavailable"))).toBe(false);
  });
});
