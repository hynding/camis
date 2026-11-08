import { fieldApiName, type ContentType, type Field } from "@camis/ir-schema";
import { strapiNames } from "@camis/strapi-schema";
import type { FieldEmit } from "../fields";
import { filamentNames, snakeColumn } from "../names";
import { permissionKey } from "../permissions/keys";
import { phpSingleQuoted } from "../php-literal";
import type { AdminRelation } from "../relations";
import {
  CONTENT_MANAGER_IMPORTS,
  contentManagerAttributes,
  contentManagerConstant,
  keyedByAttribute,
  type ContentManagerAttribute,
  type FieldAdmin,
} from "./content-manager";
import { listedColumn } from "./content-manager-list";

/** What the generator knows of a content type that its Content Manager views need. */
export interface ContentManagerInput {
  /** The type's fields in schema order, media and dynamic zones included. */
  fields: readonly Field[];
  /** Each relation form field's attribute, in the order of the resource's relation fields. */
  relations: readonly AdminRelation[];
  /** The attribute each embedded component column belongs to, in the order of its emits. */
  extraAttributes: readonly string[];
  /** The attribute each picker for a relation inside an embedded component belongs to, in the
   * order of the relation fields that follow the type's own. */
  componentRelationAttributes: readonly string[];
  /** The attribute each repeater or zone builder edits, in the order of the repeaters. */
  repeaterAttributes: readonly string[];
  /** The fields that keep an entry from being duplicated directly. */
  prohibited: readonly string[];
}

type Names = ReturnType<typeof filamentNames>;

/** A form component as the Content Manager's form lists it under its attribute. */
interface Placed {
  attribute: string;
  component: string;
}

const UID_IMPORTS = [
  "App\\Support\\StrapiUid",
  "Filament\\Actions\\Action",
  "Filament\\Schemas\\Components\\Utilities\\Get",
  "Filament\\Schemas\\Components\\Utilities\\Set",
  "Illuminate\\Database\\Eloquent\\Model",
];

/**
 * A uid field as Strapi's Content Manager edits it: made from its target field while an entry is
 * created, regenerated on demand, marked available or taken, and refused when another document's
 * draft in the locale has it.
 */
const uidComponent = (
  base: string,
  column: string,
  model: string,
  fallback: string,
  target: string | undefined,
  localized: boolean,
): string => {
  const locale = localized ? "$get('locale')" : "null";
  const generate = `StrapiUid::generate(${model}::class, '${column}', ${target === undefined ? "null" : `$get('${target}')`}, ${locale}, '${fallback}')`;
  return `${base}
                ->default(fn (Get $get): string => ${generate})
                ->live(onBlur: true)
                ->hint(fn (?string $state, Get $get, ?Model $record): string => StrapiUid::available(${model}::class, '${column}', $state, ${locale}, $record) ? 'Available' : 'Unavailable')
                ->rule(fn (Get $get, ?Model $record): \\Closure => StrapiUid::rule(${model}::class, '${column}', ${locale}, $record))
                ->suffixAction(Action::make('regenerate')->label('Regenerate')->icon('heroicon-m-arrow-path')->action(fn (Get $get, Set $set) => $set('${column}', ${generate})))`;
};

/** A uid's target field regenerates the uid while the entry is created, as Strapi's does. */
const targetsUid = (uids: { column: string; generate: string }[]): string =>
  `
                ->live(onBlur: true)
                ->afterStateUpdated(function (Get $get, Set $set, string $operation): void {
                    if ($operation === 'create') {
${uids.map((u) => `                        $set('${u.column}', ${u.generate});`).join("\n")}
                    }
                })`;

export interface ContentManagerForm {
  attributes: ContentManagerAttribute[];
  /** Each attribute's components, in schema order. */
  placed: Placed[];
  imports: string[];
}

/** The type's attributes with the components that edit them, uid fields wired as Strapi's. */
export const contentManagerForm = (
  ct: ContentType,
  input: ContentManagerInput,
  own: { fields: readonly Field[]; emits: readonly FieldEmit[] },
  extraEmits: readonly FieldEmit[],
  relationFields: readonly string[],
  media: readonly { component: string; attribute: string }[],
  repeaters: readonly string[],
  options: { localized: boolean; formComponent: (e: FieldEmit) => string },
): ContentManagerForm => {
  const n = filamentNames(ct);
  const placed: Placed[] = [];
  const uids = own.fields.flatMap((f, i) =>
    f.type === "uid" ? [{ field: f, column: own.emits[i]!.column }] : [],
  );
  const fallback = strapiNames(ct).singularName;
  const generateFor = (u: { field: Field; column: string }): string => {
    const target = (u.field as { targetField?: string }).targetField;
    const locale = options.localized ? "$get('locale')" : "null";
    return `StrapiUid::generate(${n.model}::class, '${u.column}', ${target === undefined ? "null" : `$get('${snakeColumn(target)}')`}, ${locale}, '${fallback}')`;
  };
  own.fields.forEach((f, i) => {
    const emit = own.emits[i]!;
    let component = options.formComponent(emit);
    if (f.type === "uid") {
      const target = (f as { targetField?: string }).targetField;
      component = uidComponent(
        component,
        emit.column,
        n.model,
        fallback,
        target === undefined ? undefined : snakeColumn(target),
        options.localized,
      );
    }
    const targeting = uids.filter(
      (u) => (u.field as { targetField?: string }).targetField === f.name,
    );
    if (targeting.length > 0) {
      component += targetsUid(
        targeting.map((u) => ({ column: u.column, generate: generateFor(u) })),
      );
    }
    placed.push({ attribute: f.name, component });
  });
  extraEmits.forEach((e, i) =>
    placed.push({ attribute: input.extraAttributes[i]!, component: options.formComponent(e) }),
  );
  const relationAttributes = [
    ...input.relations.map((r) => r.attribute),
    ...input.componentRelationAttributes,
  ];
  relationFields.forEach((s, i) =>
    placed.push({ attribute: relationAttributes[i]!, component: s }),
  );
  media.forEach((m) => placed.push(m));
  repeaters.forEach((r, i) =>
    placed.push({ attribute: input.repeaterAttributes[i]!, component: r }),
  );

  const componentsOf = (name: string): string[] =>
    placed.filter((p) => p.attribute === name).map((p) => p.component);
  const fieldAdmins: FieldAdmin[] = input.fields.map((field) => {
    const i = own.fields.findIndex((f) => f.name === field.name);
    const emit = i < 0 ? undefined : own.emits[i];
    return {
      field,
      components: componentsOf(field.name),
      ...(emit === undefined
        ? {}
        : { column: emit.column, tableColumn: listedColumn(field, emit.column, emit.tableColumn) }),
    };
  });
  const inverses = input.relations.filter((r) => !input.fields.some((f) => f.name === r.attribute));
  const attributes = contentManagerAttributes(fieldAdmins, inverses, input.relations);
  // The form keys components by the attribute's API name, as the configuration names it.
  const apiName = new Map<string, string>([
    ...input.fields.map((f) => [f.name, fieldApiName(f)] as [string, string]),
  ]);
  return {
    attributes,
    placed: placed.map((p) => ({ ...p, attribute: apiName.get(p.attribute) ?? p.attribute })),
    imports: uids.length > 0 ? [...UID_IMPORTS, `App\\Models\\${n.model}`] : [],
  };
};

/** The form's body: each attribute's components, keyed by attribute in schema order. */
export const contentManagerFormBody = (
  form: ContentManagerForm,
  resourceClass: string,
  before: readonly string[],
): string => {
  const components = form.attributes
    .filter((a) => form.placed.some((p) => p.attribute === a.name))
    .map((a) => {
      const list = form.placed
        .filter((p) => p.attribute === a.name)
        .map((p) => `                ${p.component.replace(/\n/g, "\n    ")},`)
        .join("\n");
      return `            '${a.name}' => [\n${list}\n            ],`;
    })
    .join("\n");
  const beforeArg =
    before.length === 0
      ? ""
      : `, before: [\n${before.map((b) => `            ${b},`).join("\n")}\n        ]`;
  return `        return StrapiContentManager::form($schema, ${resourceClass}::CONTENT_MANAGER, [
${components}
        ]${beforeArg});`;
};

/** The list's columns and filters, keyed by attribute, laid out as the view configures them. */
export const contentManagerTableBody = (
  attributes: readonly ContentManagerAttribute[],
  resourceClass: string,
  after: readonly string[],
  filters: readonly string[],
): string => {
  const columns = keyedByAttribute(attributes, (a) => a.column, "            ");
  const constraints = keyedByAttribute(attributes, (a) => a.constraint, "            ");
  const list = (name: string, items: readonly string[]): string =>
    items.length === 0
      ? ""
      : `, ${name}: [\n${items.map((i) => `            ${i},`).join("\n")}\n        ]`;
  return `StrapiContentManager::table($table, ${resourceClass}::CONTENT_MANAGER, columns: [
${columns}
        ], constraints: [
${constraints}
        ]${list("after", after)}${list("filters", filters)})`;
};

export const CONTENT_MANAGER_TABLE_IMPORTS = [
  ...CONTENT_MANAGER_IMPORTS.constraints,
  "App\\Support\\StrapiContentManager",
  "Filament\\Actions\\Action",
  "Filament\\Tables\\Columns\\TextColumn",
];

/** The resource's Content Manager members: its view, who may configure it, and duplicating. */
export const contentManagerResourceMembers = (
  ct: ContentType,
  attributes: readonly ContentManagerAttribute[],
  n: Names,
  options: { secured: boolean; collection: boolean; prohibited: readonly string[] },
): string => {
  const update = permissionKey(ct.name, "update");
  const configure = `

    /** Configuring the view takes the update grant: IR roles have no configure-view action. */
    public static function canConfigureView(): bool
    {
        return ${options.secured ? `auth()->user()?->can('${update}') ?? false` : "auth()->check()"};
    }`;
  const duplicating = options.collection
    ? `

    /** Strapi's fields that keep an entry from being duplicated directly. */
    public const PROHIBITED_CLONING_FIELDS = [${options.prohibited.map(phpSingleQuoted).join(", ")}];

    public static function duplicate(${n.model} $record): ${n.model}
    {
        return StrapiDocuments::duplicate($record, ${n.model}Serializer::class);
    }`
    : "";
  return `${contentManagerConstant(ct, attributes)}${configure}${duplicating}`;
};

/** Strapi's Duplicate, from a list row or the edit page: copied directly, or to a create form. */
export const duplicateAction = (
  n: Names,
  prohibited: readonly string[],
  record: string,
): string => {
  const visible = `->visible(fn (): bool => ${n.resourceClass}::canCreate())`;
  return prohibited.length === 0
    ? `Action::make('duplicate')
                    ->label('Duplicate')
                    ->icon('heroicon-o-document-duplicate')
                    ${visible}
                    ->action(function (${n.model} $record, $livewire): void {
                        $copy = ${n.resourceClass}::duplicate(${record});
                        Notification::make()->success()->title('Duplicated')->send();
                        $livewire->redirect(${n.resourceClass}::getUrl('edit', ['record' => $copy]));
                    })`
    : `Action::make('duplicate')
                    ->label('Duplicate')
                    ->icon('heroicon-o-document-duplicate')
                    ${visible}
                    ->requiresConfirmation()
                    ->modalHeading('This entry can\\'t be duplicated directly')
                    ->modalDescription('A new entry will be created with the same content, but you will have to change the following fields to save it: ' . implode(', ', ${n.resourceClass}::PROHIBITED_CLONING_FIELDS))
                    ->modalSubmitActionLabel('Create')
                    ->action(fn (${n.model} $record, $livewire) => $livewire->redirect(${n.resourceClass}::getUrl('create', ['duplicate' => ${record}->getKey()])))`;
};

export const DUPLICATE_IMPORTS = [
  "Filament\\Actions\\Action",
  "Filament\\Notifications\\Notification",
];

/** The list page's Configure the view, beside Create new entry. */
export const configureViewAction = (n: Names): string =>
  `Action::make('configure')->label('Configure the view')->icon('heroicon-o-cog-6-tooth')->url(${n.resourceClass}::getUrl('configure'))->visible(${n.resourceClass}::canConfigureView())`;

/**
 * The create page fills its form with an entry to duplicate (`?duplicate=<id>`), as Strapi's
 * clone form does when an entry has fields to change first.
 */
export const duplicateCreateBody = (n: Names): string => `

    #[Url]
    public ?string $duplicate = null;

    protected function fillForm(): void
    {
        $source = $this->duplicate === null ? null : ${n.resourceClass}::getEloquentQuery()->find($this->duplicate);
        if ($source === null || ! ${n.resourceClass}::canView($source)) {
            parent::fillForm();

            return;
        }
        StrapiContentManager::fillWith($this->form, $source, ${n.resourceClass}::getModel());
        Notification::make()
            ->warning()
            ->title('Change the following fields to save the duplicate: ' . implode(', ', ${n.resourceClass}::PROHIBITED_CLONING_FIELDS))
            ->send();
    }`;

export const DUPLICATE_CREATE_IMPORTS = [
  "App\\Support\\StrapiContentManager",
  "Filament\\Notifications\\Notification",
  "Livewire\\Attributes\\Url",
];

/** The type's "Configure the view" page. */
export const configureViewPage = (ns: string, n: Names): { cls: string; content: string } => {
  const cls = `Configure${n.resourceDir}View`;
  return {
    cls,
    content: `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

use ${ns}\\${n.resourceClass};
use App\\Filament\\Support\\ConfigureView;

class ${cls} extends ConfigureView
{
    protected static string $resource = ${n.resourceClass}::class;
}
`,
  };
};
