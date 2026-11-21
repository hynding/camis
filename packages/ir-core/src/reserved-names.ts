import type {
  CapabilityGap,
  Component,
  Field,
  IrDocument,
  IrErrorLocation,
} from "@camis/ir-schema";

// Here rather than beside adapter-kernel's privateFieldGaps: strapi-schema reports Strapi's names
// with it and depends on ir-core, not on the adapters' kernel.

/** One name a field takes on a target. */
export interface TargetName {
  /** As the target is told it: the field's name or API key, its key column, or its inverse. */
  spelled: string;
  /** As the target compares it with its own (its column, its snake_cased key). */
  mapped: string;
  /** The relation's inverse, which the target puts on the related type. */
  inverse?: true;
}

/** What a target calls each name it keeps, by that name as the target maps names; a Map is one. */
export interface KeptNames {
  get(mapped: string): string | undefined;
}

export type FieldHolder = "contentType" | "component";

/** The names a field takes on a target, as that target maps them. */
export type TargetNames = (field: Field, holder: FieldHolder) => TargetName[];

export interface ReservedNameOptions {
  /**
   * Check a built-in content type's fields too: a target that emits a built-in type's columns
   * from the IR, as it does any type's, must. One that maps it onto its own model does not.
   */
  builtins?: boolean;
  /**
   * The names a field of an embedded (non-repeatable) component takes on the row holding it, by
   * its path of field names from that row, the holding field first: a target that flattens an
   * embedded component into prefixed columns says what it calls them. A repeatable component or
   * a dynamic zone is rows of a table of its own, so nothing under it is embedded. Without it, a
   * target embeds nothing.
   */
  embedded?: (path: readonly string[], field: Field, holder: FieldHolder) => TargetName[];
  columns?: (path: readonly string[], field: Field) => TargetName[];
  items?: readonly ItemTable[];
}

export interface ItemTable {
  component: string;
  heldBy: string;
  kept: KeptNames;
}

/** A field of a component embedded in a row, with its path of field names from that row. */
interface EmbeddedField {
  path: string[];
  field: Field;
  component: Component;
}

const describe = (field: Field, name: TargetName): string => {
  if (name.inverse === true) return `inverse "${name.spelled}" of relation "${field.name}"`;
  return name.spelled === field.name
    ? `field "${field.name}"`
    : `field "${field.name}", as "${name.spelled}",`;
};

const describeEmbedded = (holderName: string, embedded: EmbeddedField, name: TargetName) =>
  `field "${embedded.field.name}" of component "${embedded.component.name}", embedded in "${[holderName, ...embedded.path.slice(0, -1)].join(".")}" as "${name.spelled}",`;

/**
 * An `error` gap for every field whose name, as `target` maps it, is one the target keeps for its
 * own: such a field is overwritten or refused at run time, so generation stops before it is
 * written. `reserved` maps each kept name, as `namesOf` maps names, to what the target calls it.
 * A built-in content type is checked only with `builtins`, and an embedded component's fields,
 * where they land on the row holding it, only with `embedded`.
 */
export const reservedNameGaps = (
  doc: IrDocument,
  target: string,
  reserved: KeptNames,
  namesOf: TargetNames,
  options: ReservedNameOptions = {},
): CapabilityGap[] => {
  const components = new Map(doc.components.map((c) => [c.name, c]));

  const embeddedIn = (field: Field, path: string[]): EmbeddedField[] => {
    if (field.type !== "component" || field.repeatable) return [];
    const component = components.get(field.component);
    if (component === undefined) return []; // unreachable on validated IR
    return component.fields.flatMap((inner): EmbeddedField[] => {
      if (inner.type === "component") return embeddedIn(inner, [...path, inner.name]);
      return [{ path: [...path, inner.name], field: inner, component }];
    });
  };

  // One gap per name the target keeps, however many of the field's names map onto it: a key and
  // its key column (created_by, created_by_id) may both be one name of the target's.
  const gaps = (
    names: readonly TargetName[],
    location: IrErrorLocation,
    described: (name: TargetName) => string,
  ): CapabilityGap[] => {
    const reported = new Set<string>();
    return names.flatMap((name): CapabilityGap[] => {
      const own = reserved.get(name.mapped);
      if (own === undefined || reported.has(own)) return [];
      reported.add(own);
      return [
        {
          feature: "reservedFieldName",
          location,
          severity: "error",
          message: `${described(name)} collides with ${target}'s own "${own}"; rename it`,
        },
      ];
    });
  };

  const embeddedGaps = (
    holderName: string,
    field: Field,
    holder: FieldHolder,
    at: IrErrorLocation,
  ): CapabilityGap[] => {
    const embedded = options.embedded;
    if (embedded === undefined) return [];
    return embeddedIn(field, [field.name]).flatMap((e) =>
      gaps(
        embedded(e.path, e.field, holder),
        { ...at, component: e.component.name, field: e.field.name },
        (name) => describeEmbedded(holderName, e, name),
      ),
    );
  };

  const check = (holderName: string, fields: readonly Field[], holder: FieldHolder) => {
    const at: IrErrorLocation =
      holder === "contentType" ? { contentType: holderName } : { component: holderName };
    return fields.flatMap((field) => [
      ...gaps(namesOf(field, holder), { ...at, field: field.name }, (name) =>
        describe(field, name),
      ),
      ...embeddedGaps(holderName, field, holder, at),
    ]);
  };

  return [
    ...doc.contentTypes
      .filter((ct) => options.builtins === true || ct.builtin === undefined)
      .flatMap((ct) => check(ct.name, ct.fields, "contentType")),
    ...doc.components.flatMap((c) => check(c.name, c.fields, "component")),
  ];
};
