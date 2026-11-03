import type { ExpandedZone } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { childTableEmit, type ChildTableEmit, type RepeaterEmit } from "../components";
import { filamentNames } from "../names";
import { componentUid } from "./names";

/**
 * A dynamic zone in the admin: a Builder with one block per member component, read from and
 * written to the zone's rows through `StrapiZones`, as the REST API reads and writes them. With
 * a media library an item's media fields pick files by id, which `StrapiZones` links.
 */
export const zoneBuilder = (
  ct: ContentType,
  zone: ExpandedZone,
  linksMedia: boolean,
): RepeaterEmit => {
  const key = zone.apiName;
  const members = `${filamentNames(ct).model}Serializer::ZONES['${key}']`;
  const children = zone.members.map((m) => ({
    member: m,
    child: childTableEmit(ct, m.table, linksMedia),
  }));
  const blocks = children
    .map(({ member, child }) => {
      const schema = [...child.emits.map((e) => e.formComponent), ...child.media.map(mediaIds)]
        .map((c) => `                        ${c},`)
        .join("\n");
      return `                    Block::make('${componentUid(member.component)}')->label('${member.component.name}')->schema([\n${schema}\n                    ]),`;
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
      "App\\Support\\StrapiZones",
      "Filament\\Forms\\Components\\Builder",
      "Filament\\Forms\\Components\\Builder\\Block",
      "Illuminate\\Database\\Eloquent\\Model",
      ...children.flatMap(({ child }) => child.emits.map((e) => e.formImport)),
      ...(children.some(({ child }) => child.media.length > 0)
        ? ["App\\Filament\\Support\\MediaPicker"]
        : []),
    ],
  };
};

const mediaIds = (m: ChildTableEmit["media"][number]): string =>
  `MediaPicker::ids('${m.method}', multiple: ${m.multiple}${m.allowedTypes === undefined ? "" : `, allowedTypes: [${m.allowedTypes.map((t) => `'${t}'`).join(", ")}]`})`;
