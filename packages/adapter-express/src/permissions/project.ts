import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";
import { snakeColumn } from "../names";

export interface ExpressFieldRule {
  field: string;
  access: "read" | "write";
  when?: Expression;
}
/** An action's record condition; an action a role holds outright has none. */
export type ActionConditions = Partial<Record<Action, Expression>>;

export interface ExpressPermissions {
  roles: string[];
  grants: Record<string, Record<string, Action[]>>;
  conditions: Record<string, Record<string, ActionConditions>>;
  fieldRules: Record<string, Record<string, ExpressFieldRule[]>>;
  /** role → type → the owning FK columns a create fills from the signed-in user (`assign`). */
  assigns: Record<string, Record<string, string[]>>;
  gaps: CapabilityGap[];
}

const recordFieldNames = (ct: ContentType): Set<string> =>
  new Set([
    ...ct.fields.filter((f) => f.type !== "relation" && f.type !== "component").map((f) => f.name),
    // Owning relations expose their FK as <name>Id so conditions can express ownership.
    ...ct.fields
      .filter(
        (f) =>
          f.type === "relation" &&
          (f.relationKind === "manyToOne" || f.relationKind === "oneToOne"),
      )
      .map((f) => `${f.name}Id`),
  ]);

export const projectExpressPermissions = (doc: IrDocument, roles: Role[]): ExpressPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const grants: Record<string, Record<string, Action[]>> = {};
  // role → type → action → the conditions of the grants giving it; null: a grant gives it outright.
  const given: Record<string, Record<string, Map<Action, Expression[] | null>>> = {};
  const assigns: Record<string, Record<string, string[]>> = {};
  const fieldRules: Record<string, Record<string, ExpressFieldRule[]>> = {};
  const gaps: CapabilityGap[] = [];

  const flagEscaping = (
    expr: Expression,
    ctName: string,
    role: string,
    fieldOk: Set<string>,
  ): void => {
    const escaping = freeVars(expr).filter(
      (v) =>
        !(
          v.startsWith("user.") ||
          (v.startsWith("record.") && fieldOk.has(v.slice("record.".length)))
        ),
    );
    if (escaping.length > 0) {
      gaps.push({
        feature: "conditionContext",
        location: { contentType: ctName, rule: role },
        severity: "downgrade",
        message: `condition references ${escaping.join(", ")} outside user.* and record.<field>; it will deny`,
      });
    }
  };

  for (const role of [...roles].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const service of role.services ?? []) {
      gaps.push({
        feature: "service",
        location: { rule: role.name },
        severity: "downgrade",
        message: `role "${role.name}" may use ${service}, which the Express target does not serve`,
      });
    }
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (!ct) continue;
      const fieldOk = recordFieldNames(ct);

      (grants[role.name] ??= {})[grant.contentType] = [
        ...new Set([...(grants[role.name]?.[grant.contentType] ?? []), ...grant.actions]),
      ].sort() as Action[];

      if (grant.actions.includes("publish" as Action)) {
        gaps.push({
          feature: "publishAction",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `the "publish" action has no REST analog in the Express target; ignored`,
        });
      }

      if (grant.condition) flagEscaping(grant.condition, grant.contentType, role.name, fieldOk);
      // Grants on one type are alternatives: an action is let through outright when any grant
      // gives it without a condition, else when any of its grants' conditions holds.
      const byAction = ((given[role.name] ??= {})[grant.contentType] ??= new Map());
      for (const action of grant.actions as Action[]) {
        const held = byAction.get(action);
        if (held === null) continue;
        byAction.set(action, grant.condition ? [...(held ?? []), grant.condition] : null);
      }

      for (const [field] of Object.entries(grant.assign ?? {})) {
        const column = `${snakeColumn(field)}_id`;
        const list = ((assigns[role.name] ??= {})[grant.contentType] ??= []);
        if (!list.includes(column)) list.push(column);
      }

      for (const fr of grant.fieldRules ?? []) {
        if (!fieldOk.has(fr.field)) {
          gaps.push({
            feature: "unknownFieldRule",
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            severity: "downgrade",
            message: `field rule on "${grant.contentType}.${fr.field}" names a field absent or unsupported; ignored`,
          });
          continue;
        }
        if (fr.when) flagEscaping(fr.when, grant.contentType, role.name, fieldOk);
        const rule: ExpressFieldRule = fr.when
          ? { field: fr.field, access: fr.access, when: fr.when }
          : { field: fr.field, access: fr.access };
        ((fieldRules[role.name] ??= {})[grant.contentType] ??= []).push(rule);
      }
    }
  }

  const conditions: Record<string, Record<string, ActionConditions>> = {};
  for (const [role, byCt] of Object.entries(given))
    for (const [ct, byAction] of Object.entries(byCt))
      for (const [action, held] of [...byAction].sort(([a], [b]) => a.localeCompare(b))) {
        if (held === null) continue;
        ((conditions[role] ??= {})[ct] ??= {})[action] =
          held.length === 1 ? held[0]! : { kind: "or", args: held };
      }
  return {
    roles: roles.map((r) => r.name).sort(),
    grants,
    conditions,
    fieldRules,
    assigns,
    gaps,
  };
};
