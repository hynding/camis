import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

const gap = (
  feature: string,
  what: string,
  name: string,
  contentType?: string,
  detail = "",
): CapabilityGap => ({
  feature,
  location: contentType === undefined ? { rule: name } : { contentType, rule: name },
  severity: "downgrade",
  message: `the Express target runs no ${what}; "${name}"${detail} is not wired`,
});

/** The Express target has no Ring 2 seams yet, so each piece of hand-written code is a gap. */
export const customCodeGaps = (doc: IrDocument): CapabilityGap[] => [
  ...(doc.hooks ?? []).map((h) => gap("hook", "hooks", h.name, h.contentType, ` (${h.trigger})`)),
  ...(doc.policies ?? []).map((r) => gap("policy", "route policies", r.name, r.contentType)),
  ...(doc.middlewares ?? []).map((r) =>
    gap("middleware", "route middlewares", r.name, r.contentType),
  ),
  ...(doc.schedules ?? []).map((s) => gap("schedule", "schedules", s.name)),
];
