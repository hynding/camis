import type { ContentType, IrDocument } from "@camis/ir-schema";

/** A foreign key whose constraint waits until every table exists: `table`'s key to `references`. */
export interface DeferredForeignKey {
  table: string;
  references: string;
}

export interface MigrationOrderResult {
  order: ContentType[];
  /** The keys cut to break cycles; the caller constrains them in a migration after the tables. */
  deferred: DeferredForeignKey[];
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
 * A cycle (types whose owning relations point at each other, ordinary in a Strapi project, which
 * keeps every relation in a link table) is broken where the sort gets stuck: the first stuck type
 * in IR order is created without the constraints of its keys to the other stuck types, which are
 * returned as `deferred`, and the sort carries on.
 */
// `doc` is unused: every relation lives on the content types themselves, so ordering only
// needs to walk `emitted`. It stays in the signature because the caller (and every other
// pass in this adapter) is handed the full IR document, not just its own slice.
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
  const deferred: DeferredForeignKey[] = [];

  const place = (ct: ContentType): void => {
    placed.add(ct.name);
    order.push(ct);
    for (const dependent of dependents.get(ct.name) ?? []) {
      remaining.set(dependent, (remaining.get(dependent) ?? 1) - 1);
    }
  };

  while (placed.size < emitted.length) {
    const next = emitted.find((ct) => !placed.has(ct.name) && (remaining.get(ct.name) ?? 0) === 0);
    if (next !== undefined) {
      place(next);
      continue;
    }
    const stuck = emitted.find((ct) => !placed.has(ct.name))!;
    for (const before of dependsOn.get(stuck.name) ?? []) {
      if (placed.has(before)) continue;
      deferred.push({ table: stuck.name, references: before });
      dependents.get(before)?.delete(stuck.name);
    }
    place(stuck);
  }

  return { order, deferred };
};
