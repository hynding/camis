import { describe, expect, it } from "vitest";
import { TS_MARKER, withMarker } from "./marker";

describe("marker", () => {
  it("prefixes content with the generated marker on its own line", () => {
    expect(withMarker("export default 1;")).toBe(`${TS_MARKER}\nexport default 1;`);
  });

  it("marker identifies generated files", () => {
    expect(TS_MARKER).toContain("@camis:generated");
  });
});
