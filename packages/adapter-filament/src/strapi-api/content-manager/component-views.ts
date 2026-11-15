import { fieldApiName, type Component, type Field, type IrDocument } from "@camis/ir-schema";
import { relationMainFields } from "../../relations";
import { componentUid } from "../core/names";
import { runtimePhp } from "../../runtime-php";
import { PHP_MARKER } from "../../hooks/names";
import { sortsBy, strapiType, viewAttributeRow, type ViewAttribute } from "./content-manager";

export const STRAPI_COMPONENT_VIEWS_PATH = "app/Support/StrapiComponentViews.php";
export const CONFIGURE_COMPONENT_VIEW_PATH = "app/Filament/Pages/ConfigureComponentView.php";

/** A component's attribute as its view (Strapi's `components::<uid>` configuration) lists it. */
const componentAttribute = (
  doc: IrDocument,
  components: readonly Component[],
  field: Field,
): ViewAttribute => {
  const type = strapiType(field);
  const name = fieldApiName(field);
  if (field.type === "relation") {
    const multiple = field.relationKind === "manyToMany" || field.relationKind === "oneToMany";
    const titled = doc.contentTypes.some((c) => c.name === field.target)
      ? relationMainFields(doc, field.target)
      : {};
    return {
      name,
      type,
      relation: field.relationKind,
      list: true,
      sort: !multiple,
      edit: true,
      ...titled,
    };
  }
  const component =
    field.type === "component" ? components.find((c) => c.name === field.component) : undefined;
  return {
    name,
    type,
    list: sortsBy(type),
    sort: sortsBy(type),
    edit: true,
    ...(component === undefined ? {} : { component: componentUid(component) }),
  };
};

const ID: ViewAttribute = { name: "id", type: "integer", list: true, sort: true, edit: false };

/**
 * Each component's view as the admin configures it (Strapi's "Configure the view" for a
 * component): its uid, and its attributes in schema order as a type's `CONTENT_MANAGER` has them,
 * which `StrapiContentManager::component` lays every use of the component out by. Configuring
 * one takes the Settings grant, as Strapi gives components.configure-layout to its admins.
 */
export const emitStrapiComponentViews = (doc: IrDocument, secured: boolean): string => {
  const views = doc.components.map((c) => {
    const rows = [ID, ...c.fields.map((f) => componentAttribute(doc, doc.components, f))].map(
      (a) => `                ${viewAttributeRow(a)}`,
    );
    const uid = componentUid(c);
    return `        '${uid}' => [
            'uid' => 'components::${uid}',
            'attributes' => [
${rows.join("\n")}
            ],
        ],`;
  });
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

/** Strapi's Content Manager view of each component: its uid and each attribute, in schema order. */
final class StrapiComponentViews
{
    public const VIEWS = [
${views.join("\n")}
    ];

    /** Who may configure a component's view. */
    public static function canConfigure(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "true"};
    }
}
`;
};

/**
 * Strapi's "Configure the view" for a component: its entry title, and its edit view's fields,
 * each with its label, description, placeholder, size, whether it may be edited and, for a
 * relation, its entry title. Opened from the view of a type that uses the component.
 */
export const emitConfigureComponentView = (): string =>
  runtimePhp(new URL("./php/app/Filament/Pages/ConfigureComponentView.php", import.meta.url));
