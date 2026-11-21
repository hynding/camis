import type { CapabilityGap, Field, IrDocument, IrErrorLocation } from "@camis/ir-schema";

/** One name a field takes on a target. */
export interface TargetName {
  /** As the target is told it: the field's name or API key, its key column, or its inverse. */
  spelled: string;
  /** As the target compares it with its own (its column, its snake_cased key). */
  mapped: string;
  /** The relation's inverse, which the target puts on the related type. */
  inverse?: true;
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
}

const describe = (field: Field, name: TargetName): string => {
  if (name.inverse === true) return `inverse "${name.spelled}" of relation "${field.name}"`;
  return name.spelled === field.name
    ? `field "${field.name}"`
    : `field "${field.name}", as "${name.spelled}",`;
};

/**
 * An `error` gap for every field whose name, as `target` maps it, is one the target keeps for its
 * own: such a field is overwritten or refused at run time, so generation stops before it is
 * written. `reserved` maps each kept name, as `namesOf` maps names, to what the target calls it.
 * A built-in content type is checked only with `builtins`.
 */
export const reservedNameGaps = (
  doc: IrDocument,
  target: string,
  reserved: ReadonlyMap<string, string>,
  namesOf: TargetNames,
  options: ReservedNameOptions = {},
): CapabilityGap[] => {
  const check = (fields: readonly Field[], holder: FieldHolder, location: IrErrorLocation) =>
    fields.flatMap((field) => {
      const reported = new Set<string>();
      return namesOf(field, holder).flatMap((name): CapabilityGap[] => {
        const own = reserved.get(name.mapped);
        if (own === undefined || reported.has(name.mapped)) return [];
        reported.add(name.mapped);
        return [
          {
            feature: "reservedFieldName",
            location: { ...location, field: field.name },
            severity: "error",
            message: `${describe(field, name)} collides with ${target}'s own "${own}"; rename it`,
          },
        ];
      });
    });
  return [
    ...doc.contentTypes
      .filter((ct) => options.builtins === true || ct.builtin === undefined)
      .flatMap((ct) => check(ct.fields, "contentType", { contentType: ct.name })),
    ...doc.components.flatMap((c) => check(c.fields, "component", { component: c.name })),
  ];
};
