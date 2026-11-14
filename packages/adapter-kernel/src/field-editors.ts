import type { CapabilityGap, Field, IrDocument } from "@camis/ir-schema";

/**
 * One gap per field the source project edited with its own input (a Strapi plugin's custom
 * field): the value is kept, but `target` names who shows its default input instead, unless the
 * project registers that input where `registeredIn` says.
 */
export const fieldEditorGaps = (
  doc: IrDocument,
  target: string,
  registeredIn?: string,
): CapabilityGap[] => {
  const gaps = (location: CapabilityGap["location"], fields: readonly Field[]): CapabilityGap[] =>
    fields.flatMap((f) =>
      f.editor === undefined
        ? []
        : [
            {
              feature: "fieldEditor",
              location: { ...location, field: f.name },
              severity: "downgrade" as const,
              message: `"${f.name}" was edited with ${f.editor.name}; ${target} shows its own ${f.type} input${registeredIn === undefined ? "" : ` unless ${registeredIn} registers it`}`,
            },
          ],
    );
  return [
    ...doc.contentTypes.flatMap((ct) => gaps({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => gaps({ component: c.name }, c.fields)),
  ];
};
