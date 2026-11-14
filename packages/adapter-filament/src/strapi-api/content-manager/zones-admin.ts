import type { ExpandedZone } from "@camis/adapter-kernel";
import type { Component, ContentType } from "@camis/ir-schema";
import { componentLayout } from "../../component-layout";
import { componentRelationOptions } from "../../component-relations";
import {
  childFields,
  childTableEmit,
  NO_PICKERS,
  type ChildContext,
  type ChildTableEmit,
  type RelationPickers,
  type RepeaterEmit,
} from "../../components";
import { componentDisplayName } from "@camis/strapi-schema";
import { filamentNames } from "../../names";
import { phpSingleQuoted } from "../../php-literal";
import { componentUid } from "../core/names";

/**
 * A dynamic zone in the admin: a Builder with one block per member component, read from and
 * written to the zone's rows through `StrapiZones`, as the REST API reads and writes them. With
 * a media library an item's media fields pick files by id, which `StrapiZones` links; an
 * item's relations pick targets by id, and the repeatables inside it are plain repeaters, all
 * written with the item.
 */
export const zoneBuilder = (
  ct: ContentType,
  zone: ExpandedZone,
  linksMedia: boolean,
  context?: ChildContext,
  pickers: RelationPickers = NO_PICKERS,
): RepeaterEmit => {
  const key = zone.apiName;
  const members = `${filamentNames(ct).model}Serializer::ZONES['${key}']`;
  const children = zone.members.map((m) => ({
    member: m,
    child: childTableEmit(ct, m.table, linksMedia, context),
  }));
  const components = context?.doc.components ?? [];
  const blocks = children
    .map(({ member, child }) => {
      const schema = blockFields(child, pickers, components, "                    ");
      return `                    Block::make('${componentUid(member.component)}')->label(${phpSingleQuoted(componentDisplayName(member.component))})->schema(${schema}),`;
    })
    .join("\n");
  return {
    component: `Builder::make('${zone.name}')
                ->blocks([
${blocks}
                ])
                ->afterStateHydrated(fn (Builder $component, ?Model $record) => $component->state(StrapiZones::builder($record, ${members})))
                ->dehydrated(false)
                ->saveRelationshipsUsing(fn (Model $record, ?array $state) => StrapiZones::sync($record, '${key}', ${members}, StrapiZones::fromBuilder($state, ${members})))`,
    imports: [
      `App\\Http\\Serializers\\${filamentNames(ct).model}Serializer`,
      "App\\Support\\StrapiContentManager",
      "App\\Support\\StrapiZones",
      "Filament\\Forms\\Components\\Builder",
      "Filament\\Forms\\Components\\Builder\\Block",
      "Illuminate\\Database\\Eloquent\\Model",
      ...children.flatMap(({ child }) => blockImports(child)),
    ],
  };
};

/** A block's (or a repeater's in it) fields, laid out by its component's own view. */
const blockFields = (
  child: ChildTableEmit,
  pickers: RelationPickers,
  components: readonly Component[],
  pad: string,
): string =>
  componentLayout(
    child.component,
    childFields(child, {
      media: mediaIds,
      relation: (r) => componentRelationOptions(r, pickers.versioned, pickers.localized),
      child: (n) =>
        `Repeater::make('${n.relationName}')->schema(${blockFields(n, pickers, components, `${pad}    `)})`,
    }),
    components,
    pad,
  );

const blockImports = (child: ChildTableEmit): string[] => [
  ...child.emits.map((e) => e.formImport),
  ...(child.media.length > 0 ? ["App\\Filament\\Support\\MediaPicker"] : []),
  ...(child.relations.length > 0 ? ["Filament\\Forms\\Components\\Select"] : []),
  ...(child.children.length > 0 ? ["Filament\\Forms\\Components\\Repeater"] : []),
  ...child.children.flatMap(blockImports),
];

const mediaIds = (m: ChildTableEmit["media"][number]): string =>
  `MediaPicker::ids('${m.method}', multiple: ${m.multiple}${m.allowedTypes === undefined ? "" : `, allowedTypes: [${m.allowedTypes.map((t) => `'${t}'`).join(", ")}]`})`;
