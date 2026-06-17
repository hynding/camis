import { describe, expect, it } from "vitest";
import { buildManifest, MANIFEST_PATH, materialize, stableJson, withMarker } from "./index";

describe("kernel public surface", () => {
  it("exports the codegen toolkit", () => {
    expect(typeof materialize).toBe("function");
    expect(typeof buildManifest).toBe("function");
    expect(typeof stableJson).toBe("function");
    expect(typeof withMarker).toBe("function");
    expect(MANIFEST_PATH).toBe(".camis/manifest.json");
  });
});
