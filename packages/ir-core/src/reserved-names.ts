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
  /** The prefix the target keeps that a name begins with, where it keeps any. */
  prefixOf?(mapped: string): string | undefined;
}

export type FieldHolder = "contentType" | "component";

/** The names a field takes on a target, as that target maps them. */
export type TargetNames = (field: Field, holder: FieldHolder) => TargetName[];

/**
 * A table whose rows are a component's items, as a target stores a repeatable component (or a
 * dynamic zone's member, where it keeps the zone as tables): one per place the target keeps one.
 */
export interface ItemTable {
  /** The component whose items its rows are. */
  component: string;
  /** Where the items are held, for the message (`Note.items`). */
  heldBy: string;
  /**
   * Every name a row of it keeps for itself (its timestamps, its key to the row holding it), as
   * `columns` maps names, to what the target calls each.
   */
  kept: KeptNames;
}

export interface ReservedNameOptions {
  /**
   * Check a built-in content type's own fields too: a target that emits a built-in type's columns
   * from the IR, as it does any type's, must. One that maps it onto its own model generates
   * nothing from them. Either way a built-in type's relations' inverses are checked: they land on
   * the related type, which the target generates.
   */
  builtins?: boolean;
  /**
   * The columns a field takes on a row, by its path of field names from that row: an embedded
   * (non-repeatable) component's field on the entry's row, the holding field first (`created`
   * holding `at`), and an item's field, its embedded components' included, on the item's row,
   * the path restarting there. A repeatable component or a dynamic zone is never embedded: its
   * items are rows of a table of their own, checked only where `items` names one. Without it, no
   * column but those `namesOf` gives a content type's own fields is checked.
   */
  columns?: (path: readonly string[], field: Field) => TargetName[];
  /** The item tables the target stores; none without it. */
  items?: readonly ItemTable[];
}

/** A field reached from a row through embedded components, with its path of field names. */
interface EmbeddedField {
  path: string[];
  field: Field;
  component: Component;
}

const describe = (holderName: string, field: Field, name: TargetName): string => {
  if (name.inverse === true)
    return `inverse "${name.spelled}" of relation "${holderName}.${field.name}"`;
  return name.spelled === field.name
    ? `field "${field.name}"`
    : `field "${field.name}", as "${name.spelled}",`;
};

const describeEmbedded = (holderName: string, embedded: EmbeddedField, name: TargetName) =>
  `field "${embedded.field.name}" of component "${embedded.component.name}", embedded in "${[holderName, ...embedded.path.slice(0, -1)].join(".")}" as "${name.spelled}",`;

const describeItem = (item: ItemTable, embedded: EmbeddedField, name: TargetName) =>
  embedded.path.length === 1
    ? `field "${embedded.field.name}" of component "${embedded.component.name}", in "${item.heldBy}" as "${name.spelled}",`
    : describeEmbedded(item.component, embedded, name);

const locationKey = (location: IrErrorLocation): string =>
  [location.contentType, location.component, location.field].join("\0");

/**
 * An `error` gap for every field whose name, as `target` maps it, is one the target keeps for its
 * own: such a field is overwritten or refused at run time, so generation stops before it is
 * written. `reserved` maps each kept name, as `namesOf` maps names, to what the target calls it.
 * A built-in content type is checked only with `builtins`; the columns of a row, an embedded
 * component's on the entry's and an item's on its own, only with `columns` (and `items`).
 */
export const reservedNameGaps = (
  doc: IrDocument,
  target: string,
  reserved: KeptNames,
  namesOf: TargetNames,
  options: ReservedNameOptions = {},
): CapabilityGap[] => {
  const components = new Map(doc.components.map((c) => [c.name, c]));

  // The fields of `component` that land on the row it is embedded in, through every embedded
  // component within it; `path` leads from that row to the component.
  const embeddedIn = (component: Component, path: readonly string[]): EmbeddedField[] =>
    component.fields.flatMap((field): EmbeddedField[] => {
      if (field.type !== "component") return [{ path: [...path, field.name], field, component }];
      const inner = components.get(field.component);
      if (field.repeatable || inner === undefined) return []; // undefined: unreachable on valid IR
      return embeddedIn(inner, [...path, field.name]);
    });

  // One gap per place and kept name, however many of a field's names, or rows, map onto it: a key
  // and its key column (created_by, created_by_id) may both be one name of the target's. An
  // inverse is a name of its own, where it lands, so it is reported beside its relation.
  const reported = new Set<string>();
  // How a name clashes with what the target keeps, as the message says it.
  const clashOf = (kept: KeptNames, mapped: string): string | undefined => {
    const own = kept.get(mapped);
    if (own !== undefined) return `collides with ${target}'s own "${own}"`;
    const prefix = kept.prefixOf?.(mapped);
    return prefix === undefined ? undefined : `uses ${target}'s reserved prefix "${prefix}"`;
  };
  const gaps = (
    names: readonly TargetName[],
    kept: KeptNames,
    locate: (name: TargetName) => IrErrorLocation,
    described: (name: TargetName) => string,
  ): CapabilityGap[] =>
    names.flatMap((name): CapabilityGap[] => {
      const clash = clashOf(kept, name.mapped);
      if (clash === undefined) return [];
      const location = locate(name);
      // An inverse is told apart by its relation, which its description names.
      const key = [locationKey(location), name.inverse === true ? described(name) : "", clash].join(
        "\0",
      );
      if (reported.has(key)) return [];
      reported.add(key);
      return [
        {
          feature: "reservedFieldName",
          location,
          severity: "error",
          message: `${described(name)} ${clash}; rename it`,
        },
      ];
    });

  const columns = options.columns;

  const entryColumnGaps = (contentType: string, field: Field): CapabilityGap[] => {
    if (columns === undefined || field.type !== "component" || field.repeatable) return [];
    const component = components.get(field.component);
    if (component === undefined) return []; // unreachable on validated IR
    return embeddedIn(component, [field.name]).flatMap((e) =>
      gaps(
        columns(e.path, e.field),
        reserved,
        () => ({ contentType, component: e.component.name, field: e.field.name }),
        (name) => describeEmbedded(contentType, e, name),
      ),
    );
  };

  const itemColumnGaps = (item: ItemTable): CapabilityGap[] => {
    const component = components.get(item.component);
    if (columns === undefined || component === undefined) return [];
    return embeddedIn(component, []).flatMap((e) =>
      gaps(
        columns(e.path, e.field),
        item.kept,
        () => ({ component: e.component.name, field: e.field.name }),
        (name) => describeItem(item, e, name),
      ),
    );
  };

  // A field is located where it is declared, its inverse on the type it lands on.
  const ownGaps = (
    holderName: string,
    field: Field,
    holder: FieldHolder,
    checked: (name: TargetName) => boolean = () => true,
  ): CapabilityGap[] => {
    const at: IrErrorLocation =
      holder === "contentType" ? { contentType: holderName } : { component: holderName };
    const locate = (name: TargetName): IrErrorLocation =>
      name.inverse === true && field.type === "relation"
        ? { contentType: field.target, field: field.inverse ?? name.spelled }
        : { ...at, field: field.name };
    return gaps(namesOf(field, holder).filter(checked), reserved, locate, (name) =>
      describe(holderName, field, name),
    );
  };

  // A built-in type's inverses only, unless the target generates its own fields too: they land on
  // the related type.
  const builtinGaps = (contentType: string, field: Field): CapabilityGap[] =>
    ownGaps(contentType, field, "contentType", (name) => name.inverse === true);

  return [
    ...doc.contentTypes.flatMap((ct) =>
      ct.fields.flatMap((field) =>
        options.builtins === true || ct.builtin === undefined
          ? [...ownGaps(ct.name, field, "contentType"), ...entryColumnGaps(ct.name, field)]
          : builtinGaps(ct.name, field),
      ),
    ),
    ...doc.components.flatMap((c) =>
      c.fields.flatMap((field) => ownGaps(c.name, field, "component")),
    ),
    ...(options.items ?? []).flatMap(itemColumnGaps),
  ];
};
