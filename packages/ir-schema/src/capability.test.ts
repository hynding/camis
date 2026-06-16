import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor, CapabilityGapReport } from "./index";

describe("capability types", () => {
  it("a descriptor value is well-typed and usable", () => {
    const d: CapabilityDescriptor = {
      target: "strapi",
      fieldTypes: { string: true, dynamicZone: true },
      relationKinds: { manyToMany: true },
      features: { component: true },
    };
    const report: CapabilityGapReport = { target: "strapi", gaps: [] };
    expect(d.target).toBe("strapi");
    expect(report.gaps).toHaveLength(0);
  });
});
