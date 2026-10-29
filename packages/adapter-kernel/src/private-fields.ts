import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

/**
 * One gap per private field, for a target whose API answers with every field it stores. `target`
 * names it in the message ("the Express target").
 */
export const privateFieldGaps = (doc: IrDocument, target: string): CapabilityGap[] => {
  const gap = (location: CapabilityGap["location"], field: string): CapabilityGap => ({
    feature: "privateField",
    location: { ...location, field },
    severity: "downgrade",
    message: `"${field}" is private; ${target} answers with it like any other field`,
  });
  return [
    ...doc.contentTypes.flatMap((ct) =>
      ct.fields.filter((f) => f.private === true).map((f) => gap({ contentType: ct.name }, f.name)),
    ),
    ...doc.components.flatMap((c) =>
      c.fields.filter((f) => f.private === true).map((f) => gap({ component: c.name }, f.name)),
    ),
  ];
};
