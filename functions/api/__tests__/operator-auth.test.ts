import { describe, expect, it } from "vitest";
import { isPersonalWorkspaceRequest, isPlatformOperator } from "../../_middleware";

describe("platform operator authorization", () => {
  it("matches verified numeric GitHub ids from a comma-separated allowlist", () => {
    const env = { PLATFORM_ADMIN_GITHUB_IDS: "123, 196446605,456" };
    expect(isPlatformOperator(env, 196446605)).toBe(true);
    expect(isPlatformOperator(env, 999)).toBe(false);
  });

  it("fails closed for absent or invalid identity data", () => {
    expect(isPlatformOperator({}, 196446605)).toBe(false);
    expect(isPlatformOperator({ PLATFORM_ADMIN_GITHUB_IDS: "196446605" }, Number.NaN)).toBe(false);
    expect(isPlatformOperator({ PLATFORM_ADMIN_GITHUB_IDS: "JasperNoBoxDev" }, 196446605)).toBe(false);
  });
});

describe("personal workspace authorization", () => {
  it("accepts only the verified user's own login, case-insensitively", () => {
    expect(isPersonalWorkspaceRequest("Jasper", "jasper")).toBe(true);
    expect(isPersonalWorkspaceRequest("another-user", "jasper")).toBe(false);
  });

  it("fails closed for missing identity data", () => {
    expect(isPersonalWorkspaceRequest("jasper", undefined)).toBe(false);
    expect(isPersonalWorkspaceRequest(undefined, "jasper")).toBe(false);
  });
});
