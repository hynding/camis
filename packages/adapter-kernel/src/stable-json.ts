// Deterministic JSON: 2-space indent, trailing newline, INSERTION order preserved
// (JSON.stringify preserves key insertion order; we deliberately do not sort).
export const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
