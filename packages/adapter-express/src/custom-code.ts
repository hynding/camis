import { ROUTE_ACTIONS, type CapabilityGap, type IrDocument } from "@camis/ir-schema";

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

const listed = (actions: readonly string[]): string =>
  actions.length < 2
    ? actions.join("")
    : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]!}`;

/** The Express target routes every action of a type, so a type serving only some is a gap. */
export const apiActionGaps = (doc: IrDocument): CapabilityGap[] =>
  doc.contentTypes.flatMap((ct): CapabilityGap[] => {
    const served = ct.options?.apiActions;
    if (served === undefined) return [];
    const open = ROUTE_ACTIONS.filter(
      (a) => !served.includes(a) && (ct.kind === "collection" || (a !== "list" && a !== "create")),
    );
    if (open.length === 0) return [];
    return [
      {
        feature: "apiActions",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `the Express target routes every action; ${ct.name} serves only ${served.join(", ")}, so its ${listed(open)} routes are open to whoever its roles let in`,
      },
    ];
  });
