import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";

export interface MigrationOrderResult {
  order: ContentType[];
  gaps: CapabilityGap[];
}

type RelationField = Extract<ContentType["fields"][number], { type: "relation" }>;

/**
 * Orders a content type's create-table migrations so a table is never created before the
 * table its foreign key constrains. `manyToOne`/`oneToOne` put the FK on the owner, so the
 * owner depends on its target; `oneToMany` puts the FK on the target, so the target depends
 * on the owner; `manyToMany` needs no edge (its pivot table is emitted after every content
 * table, unconditionally). Self-references and relations to a type outside `emitted` (e.g.
 * the builtin user type, whose table the host app owns) add no edge.
 *
 * A stable topological sort (Kahn's algorithm) breaks ties by IR position, so a document
 * with no relations — or none that reorder anything — regenerates in its original order.
 * A genuine dependency cycle can't be ordered at all; it is reported as a capability gap and
 * the cyclic types are appended, in IR order, after everything that could be sorted.
 */
// `doc` is unused: every relation lives on the content types themselves, so ordering only
// needs to walk `emitted`. It stays in the signature because the caller (and every other
// gap-producing pass in this adapter) is handed the full IR document, not just its own slice.
export const migrationOrder = (_doc: IrDocument, emitted: ContentType[]): MigrationOrderResult => {
  const emittedNames = new Set(emitted.map((ct) => ct.name));

  // dependsOn[A] = the set of types A's migration must follow.
  const dependsOn = new Map<string, Set<string>>();
  // dependents[B] = the set of types that depend on B (the reverse edges), for decrementing
  // remaining-dependency counts as types are placed.
  const dependents = new Map<string, Set<string>>();
  const addEdge = (after: string, before: string): void => {
    if (after === before) return; // self-reference: no ordering constraint
    if (!emittedNames.has(after) || !emittedNames.has(before)) return; // outside `emitted`
    const deps = dependsOn.get(after) ?? new Set<string>();
    deps.add(before);
    dependsOn.set(after, deps);
    const revDeps = dependents.get(before) ?? new Set<string>();
    revDeps.add(after);
    dependents.set(before, revDeps);
  };

  for (const ct of emitted) {
    for (const field of ct.fields) {
      if (field.type !== "relation") continue;
      const f = field as RelationField;
      if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
        addEdge(ct.name, f.target); // owner's table holds the FK
      } else if (f.relationKind === "oneToMany") {
        addEdge(f.target, ct.name); // target's table holds the FK
      }
      // manyToMany: pivot tables are emitted after every content table; no edge needed.
    }
  }

  const remaining = new Map(emitted.map((ct) => [ct.name, dependsOn.get(ct.name)?.size ?? 0]));
  const placed = new Set<string>();
  const order: ContentType[] = [];

  for (;;) {
    const next = emitted.find((ct) => !placed.has(ct.name) && (remaining.get(ct.name) ?? 0) === 0);
    if (next === undefined) break;
    placed.add(next.name);
    order.push(next);
    for (const dependent of dependents.get(next.name) ?? []) {
      remaining.set(dependent, (remaining.get(dependent) ?? 1) - 1);
    }
  }

  const gaps: CapabilityGap[] = [];
  const unplaced = emitted.filter((ct) => !placed.has(ct.name));
  if (unplaced.length > 0) {
    gaps.push({
      feature: "relationCycle",
      severity: "error",
      location: { contentType: unplaced[0]!.name },
      message:
        `content types ${unplaced.map((ct) => ct.name).join(", ")} reference each other ` +
        "through owning relations; their migrations cannot be ordered — break the cycle or " +
        "make one side a oneToMany with an inverse",
    });
    order.push(...unplaced);
  }

  return { order, gaps };
};
