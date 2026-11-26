/**
 * How a `maxLength` counts: in characters, which are Unicode code points, as PHP's mb_strlen counts
 * them (Laravel's max rule and the Strapi API style's validator) and as a VARCHAR's length counts
 * them; not in the UTF-16 code units a JavaScript string's length counts, nor in bytes.
 */
export interface CharacterCountVector {
  value: string;
  characters: number;
}

/**
 * The canonical vectors every target's check runs: ASCII, two, three and four bytes a character
 * in UTF-8, characters past the Basic Multilingual Plane (two UTF-16 code units each), and
 * combining marks and modifiers, which are characters of their own.
 */
export const characterCountVectors: readonly CharacterCountVector[] = [
  { value: "", characters: 0 },
  { value: "abc", characters: 3 },
  { value: "été", characters: 3 },
  { value: "é", characters: 2 },
  { value: "日本語", characters: 3 },
  { value: "\u{1F600}", characters: 1 },
  { value: "\u{1F600}\u{1F600}a", characters: 3 },
  { value: "\u{1F44D}\u{1F3FD}", characters: 2 },
  { value: "\u{1D4B3}\u{10FFFF}", characters: 2 },
];
