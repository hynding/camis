import { describe, expect, it } from "vitest";
import { characterCountVectors } from "./character-count";

describe("characterCountVectors (issue #126)", () => {
  it("counts each value's Unicode code points, not its UTF-16 code units or its bytes", () => {
    for (const { value, characters } of characterCountVectors) {
      expect([...value].length, JSON.stringify(value)).toBe(characters);
    }
  });

  // The vectors must tell the counts apart, or a target counting code units or bytes would pass.
  it("holds values whose UTF-16 length and UTF-8 bytes differ from their characters", () => {
    expect(characterCountVectors.some((v) => v.value.length !== v.characters)).toBe(true);
    expect(
      characterCountVectors.some(
        (v) => Buffer.byteLength(v.value, "utf8") === 4 * v.characters && v.characters > 0,
      ),
    ).toBe(true);
  });
});
