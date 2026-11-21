import {
  fieldApiName,
  inverseApiName,
  type CapabilityGap,
  type ContentType,
  type IrDocument,
  type RelationKind,
} from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { dual, strapiNames } from "@camis/strapi-schema";
import type { ApiRelationWrite, ApiTypeRules } from "./api-enforcement";

// What a write through a relation changes besides the entry written, as Strapi 5 stores links: a
// link both sides declare (`inversedBy`/`mappedBy`) shows on the entry at the other end too, so
// writing it changes that entry; a to-one side's write replaces its last link; and a link whose
// other side holds one entry at most (a bidirectional oneToOne or oneToMany) takes that entry from
// the entry that held it (Strapi's deletePreviousOneToAnyRelations). A link only one side
// declares changes nothing at the other end.

const TO_ONE: readonly RelationKind[] = ["oneToOne", "manyToOne"];
const ONE_TO_ANY: readonly RelationKind[] = ["oneToOne", "oneToMany"];

const BUILTIN_PLUGIN: Record<string, string> = { user: "users-permissions", file: "upload" };

/** A relation attribute of a type: its own field or the inverse another type's field declares. */
interface RelationAttribute {
  holder: ContentType;
  attribute: string;
  target: ContentType;
  kind: RelationKind;
  mirrored: boolean;
}

const attributesOf = (doc: IrDocument): RelationAttribute[] => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const out: RelationAttribute[] = [];
  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "relation") continue;
      const target = byName.get(f.target);
      if (target === undefined) continue;
      const inverse = inverseApiName(f);
      out.push({
        holder: ct,
        attribute: fieldApiName(f),
        target,
        kind: f.relationKind,
        mirrored: inverse !== undefined,
      });
      if (inverse !== undefined)
        out.push({
          holder: target,
          attribute: inverse,
          target: ct,
          kind: dual(f.relationKind),
          mirrored: true,
        });
    }
  }
  return out;
};

const writeOf = (a: RelationAttribute): ApiRelationWrite => ({
  target: strapiNames(a.target).uid,
  mirrored: a.mirrored,
  toOne: TO_ONE.includes(a.kind),
  exclusive: a.mirrored && ONE_TO_ANY.includes(a.kind),
});

/**
 * Per content type, the relation attributes whose writes change an entry the generated
 * controllers guard: one a type with rules shows (a mirrored link into it), or one taken from a
 * last holder that has rules itself (an exclusive link of a type with rules).
 */
export const projectRelationWrites = (
  doc: IrDocument,
  own: ReadonlySet<string>,
): Map<string, Record<string, ApiRelationWrite>> => {
  const out = new Map<string, Record<string, ApiRelationWrite>>();
  const sorted = [...attributesOf(doc)].sort((a, b) => a.attribute.localeCompare(b.attribute));
  for (const a of sorted) {
    if (a.holder.builtin !== undefined || a.target.builtin !== undefined) continue;
    const write = writeOf(a);
    const guarded =
      (own.has(a.target.name) && write.mirrored) || (own.has(a.holder.name) && write.exclusive);
    if (!guarded) continue;
    out.set(a.holder.name, { ...(out.get(a.holder.name) ?? {}), [a.attribute]: write });
  }
  return out;
};

/**
 * A role that writes a built-in or single type whose mirrored relation changes entries of a type
 * with rules, where the role does not update those outright: the plugin's or Strapi's own
 * controller serves that write, and checks nothing of camis's.
 */
export const relationWriteGaps = (
  doc: IrDocument,
  roles: readonly Role[],
  types: readonly ApiTypeRules[],
): CapabilityGap[] => {
  const gaps: CapabilityGap[] = [];
  const rulesOf = new Map(types.filter((t) => t.own).map((t) => [t.contentType, t]));
  for (const role of roles.filter((r) => r.admin !== true)) {
    for (const a of attributesOf(doc)) {
      const target = rulesOf.get(a.target.name);
      if (!a.mirrored || target === undefined) continue;
      if (a.holder.builtin === undefined && a.holder.kind !== "single") continue;
      const writes = role.grants.some(
        (g) =>
          g.contentType === a.holder.name &&
          (g.actions.includes("create") || g.actions.includes("update")),
      );
      if (!writes || target.roles[role.name]?.update === true) continue;
      const served =
        a.holder.builtin !== undefined
          ? `the ${BUILTIN_PLUGIN[a.holder.builtin] ?? a.holder.builtin} plugin serves that write unchecked`
          : "Strapi's own single-type controller serves that write unchecked";
      const which =
        a.holder.builtin === undefined ? `single type "${a.holder.name}"` : `"${a.holder.name}"`;
      gaps.push({
        feature: "apiRelationReach",
        location: { contentType: a.holder.name, rule: role.name },
        severity: "error",
        message: `role "${role.name}" writes ${which}, whose relation ${a.holder.name}.${a.attribute} changes entries of "${a.target.name}", which it does not update outright; ${served}`,
      });
    }
  }
  return gaps;
};
