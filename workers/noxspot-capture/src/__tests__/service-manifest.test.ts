import { describe, expect, it } from "vitest";
import { NOXSPOT_SERVICE_MANIFEST } from "../service-manifest";

describe("NoxSpot service manifest", () => {
  it("advertises the versioned private service contract", () => {
    expect(NOXSPOT_SERVICE_MANIFEST.contract).toBe("nox.service-manifest");
    expect(NOXSPOT_SERVICE_MANIFEST.version).toBe(1);
    expect(NOXSPOT_SERVICE_MANIFEST.service.id).toBe("noxspot");
    expect(NOXSPOT_SERVICE_MANIFEST.service.capabilities.map(({ id }) => id)).toEqual([
      "sites", "widget", "reports", "spot_sharing", "spot_delivery",
    ]);
  });
});
