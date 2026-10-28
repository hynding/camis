import type { StorageLayout } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { snakeColumn } from "../names";
import { authLine, createCheck, madeCheck, NESTED_STMT, STMT } from "./controller-shared";
import { strapiControllerParts } from "./storage/controller-storage";
import type { ControllerLink } from "./storage/names";
import type { WireShape } from "./wire-shape";

// The link shape is named by `storage/names.ts` (alongside `ownerLinks`, which builds it);
// re-exported here so a controller caller needs only one import.
export type { ControllerLink };

export interface ControllerSpec {
  shape: WireShape;
  ct: ContentType;
  assigns: string[];
  secured: boolean;
  scoped: boolean;
  /** Defaults to the Laravel layout, whose output this task leaves byte-identical. */
  layout?: StorageLayout;
  /** Strapi layout only: one entry per owning relation, in IR order. */
  links?: ControllerLink[];
}

/** The per-layout halves of the controller; everything else is the shared class scaffold. */
export interface ControllerParts {
  /** Fully-qualified imports this layout needs on top of the shared ones. */
  uses: string[];
  /** The expression `scoped()` returns. */
  query: string;
  indexBody: string;
  showBody: string;
  storeBody: string;
  updateBody: string;
  destroyBody: string;
  /** Extra protected helpers this layout's bodies call, rendered after `find()`. */
  helpers?: string;
}

/**
 * A single type's routes: its one entry is found by any of its rows, whatever their version or
 * locale, as Strapi's single-type service finds its document id, and served by the collection
 * methods with that key.
 */
const singleMethods = (spec: ControllerSpec): string => {
  const M = spec.shape.model;
  const emptyDelete = spec.secured ? `            $this->authorize('delete', new ${M}());\n\n` : "";
  return `
    protected function singleKey(): ?string
    {
        $key = ${M}::query()->orderBy('id')->value(self::KEY);

        return $key === null ? null : (string) $key;
    }

    public function single(Request $request): JsonResponse
    {
        return $this->show($request, $this->singleKey() ?? '');
    }

    /** Strapi's createOrUpdate: the first put makes the entry, a later one updates it. */
    public function putSingle(Request $request): JsonResponse
    {
        if (! is_array($request->input('data'))) {
            throw new StrapiError(400, 'ValidationError', 'Missing "data" payload in the request body');
        }
        $key = $this->singleKey();

        return $key === null ? $this->store($request)->setStatusCode(200) : $this->update($request, $key);
    }

    /** The entry's documentId, which GraphQL's delete answers with. */
    public function singleDocumentId(): ?string
    {
        $documentId = ${M}::query()->orderBy('id')->value('document_id');

        return $documentId === null ? null : (string) $documentId;
    }

    public function destroySingle(Request $request): JsonResponse
    {
        $key = $this->singleKey();
        if ($key === null) {
${emptyDelete}            return response()->json(null, 204);
        }

        return $this->destroy($request, $key);
    }
`;
};

/** The request's data as relation input, without the relations a grant assigns: those stay the caller's. */
const linkData = (assigns: string[]): string =>
  assigns.length === 0
    ? "(array) $request->input('data', [])"
    : `array_diff_key((array) $request->input('data', []), [${assigns.map((a) => `'${a}' => true`).join(", ")}])`;

const laravelParts = (spec: ControllerSpec): ControllerParts => {
  const { shape, secured, scoped } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  // The caller whose grants reach a relation's target; none in a project without roles.
  const viewer = secured ? "$request->user()" : "null";
  // syncChildren deletes the existing child rows before re-inserting them, so a failing insert
  // outside a transaction would leave the parent persisted with its children gone. The row, its
  // children and its relation links must commit or roll back together.
  const persist = (fill: string, indent: string = STMT): string =>
    `${indent}DB::transaction(function () use ($m, $wire, $links): void {
${indent}    ${fill}StrapiRelations::associate($m, $links);
${indent}    $m->save();
${indent}    ${S}::syncChildren($m, $wire['children']);
${indent}    StrapiRelations::link($m, $links);
${indent}});`;
  const readLinks = `${STMT}$links = StrapiRelations::read(${linkData(spec.assigns)}, ${S}::FIELDS, ${viewer});`;
  const auth = authLine(secured);
  const assign = spec.assigns
    .map((name) => `${STMT}$m->${snakeColumn(name)}_id = $request->user()?->id;`)
    .join("\n");
  const assignBlock = assign ? `${assign}\n` : "";
  const upsert = shape.upsert;

  const createBranch = upsert
    ? `
        if (${M}::query()->where(self::KEY, $key)->exists()) {
            abort(404); // claimed by another scope: never reach across owners
        }
${auth(`$this->authorize('create', ${M}::class);`)}        $m = new ${M}($wire['columns']);
        $m->{self::KEY} = $key;
${assignBlock}${persist("")}

        return response()->json(['data' => $this->wire($request, $m->fresh()), 'meta' => new \\stdClass()], 200);`
    : `
        abort(404);`;

  const base = {
    uses: [
      "App\\Support\\StrapiPopulate",
      "App\\Support\\StrapiQuery",
      "App\\Support\\StrapiRelations",
    ],
    query: scoped ? `${M}::query()->forUser($request->user())` : `${M}::query()`,
    indexBody: `${auth(`$this->authorize('viewAny', ${M}::class);`)}        $found = StrapiQuery::find($this->scoped($request), $request->query(), ${S}::FIELDS, ${viewer});
        $rows = $found['rows']${secured ? `->filter(fn (${M} $m) => Gate::allows('view', $m))` : ""};

        return response()->json([
            'data' => StrapiPopulate::many($rows, $request->query(), ${S}::class, ${viewer}),
            'meta' => ['pagination' => $found['pagination']],
        ]);`,
    // Strapi checks the route's read grant before it looks for the row.
    showBody: `${auth(`$this->authorize('viewAny', ${M}::class);`)}        $m = $this->find($request, $key);

        return response()->json(['data' => $this->wire($request, $m), 'meta' => new \\stdClass()]);`,
    storeBody: `${createCheck(spec)}        $wire = ${S}::fromWire((array) $request->input('data', []));
${readLinks}
        $m = new ${M}($wire['columns']);
${madeCheck(spec)}${assignBlock}${persist("")}

        return response()->json(['data' => $this->wire($request, $m->fresh()), 'meta' => new \\stdClass()], 201);`,
    updateBody: `        $wire = ${S}::fromWire((array) $request->input('data', []));
${readLinks}
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m !== null${secured ? ` && Gate::allows('view', $m)` : ""}) {
${auth(`$this->authorize('update', $m);`, NESTED_STMT)}${persist("$m->fill($wire['columns']);\n" + NESTED_STMT + "    ", NESTED_STMT)}

            return response()->json(['data' => $this->wire($request, $m->fresh()), 'meta' => new \\stdClass()]);
        }
${createBranch}`,
    destroyBody: `        $m = $this->find($request, $key);
${auth(`$this->authorize('delete', $m);`)}        $m->delete();

        return response()->json(null, 204);`,
    helpers: `
    /** One row on the wire, shaped by the request's \`fields\` and \`populate\` parameters. */
    protected function wire(Request $request, ${M} $m): array
    {
        return StrapiPopulate::one($m, $request->query(), ${S}::class, ${viewer});
    }
`,
  };
  return shape.draftPublish || shape.localized
    ? { ...base, ...documentParts(spec, base.query, readLinks) }
    : base;
};

/**
 * A type whose documents span several rows. A draft-and-publish type reads the version its status
 * parameter names and writes through the draft: create and update save the draft and then publish
 * it unless status=draft (behind the publish grant, inside the same transaction), and delete
 * removes every version. A localized type reads and writes the locale its locale parameter names
 * (the default one otherwise); an update in a locale the document lacks creates it, and delete
 * removes the requested locale's rows.
 */
const documentParts = (
  spec: ControllerSpec,
  query: string,
  plainReadLinks: string,
): Pick<
  ControllerParts,
  "uses" | "query" | "storeBody" | "updateBody" | "destroyBody" | "helpers"
> => {
  const { shape, secured } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  const versioned = shape.draftPublish;
  const localized = shape.localized;
  const viewer = secured ? "$request->user()" : "null";
  const auth = authLine(secured);
  const assign = spec.assigns
    .map((name) => `${STMT}$m->${snakeColumn(name)}_id = $request->user()?->id;`)
    .join("\n");
  const assignBlock = assign ? `${assign}\n` : "";
  const forWrite = "StrapiLocales::forWrite($request->query())";
  const readLinks = localized
    ? `${STMT}$links = StrapiRelations::read(${linkData(spec.assigns)}, ${S}::FIELDS, ${viewer}, ${forWrite});`
    : plainReadLinks;
  const publish = versioned
    ? `${STMT}    if (! StrapiDocuments::draftOnly($request->query())) {
${auth(`$this->authorize('publish', $m);`, `${STMT}        `)}${STMT}        $m = StrapiDocuments::publish($m, ${S}::class);
${STMT}    }

`
    : "";
  const persist = (
    fill: string,
  ): string => `${STMT}$m = DB::transaction(function () use (${versioned ? "$request, " : ""}$m, $wire, $links): ${M} {
${fill}${STMT}    StrapiRelations::associate($m, $links);
${STMT}    $m->save();
${STMT}    ${S}::syncChildren($m, $wire['children']);
${STMT}    StrapiRelations::link($m, $links);
${publish}${STMT}    return $m;
${STMT}});`;
  const lookup = versioned
    ? "StrapiDocuments::draft($this->documents($request), $key)"
    : "$this->documents($request)->where(self::KEY, $key)->first()";
  const visible = secured ? ` || ! Gate::allows('view', $m)` : "";
  const notFound = `        if ($m === null${visible}) {
            abort(404);
        }
`;
  // Strapi creates a locale the document lacks when an update is written in it.
  const missingLocale = localized
    ? `
            ?? StrapiLocales::localization(${query}->where(self::KEY, $key), ${forWrite})`
    : "";
  const destroyBody = localized
    ? `        $rows = $this->documents($request)->where(self::KEY, $key)->get()${secured ? `->filter(fn (${M} $m) => Gate::allows('view', $m))` : ""};
        if ($rows->isEmpty()) {
            abort(404);
        }
${secured ? `        foreach ($rows as $m) {\n            $this->authorize('delete', $m);\n        }\n` : ""}        DB::transaction(fn () => $rows->each->delete());

        return response()->json(null, 204);`
    : `        $m = ${lookup};
${notFound}${auth(`$this->authorize('delete', $m);`)}        StrapiDocuments::destroy($m);

        return response()->json(null, 204);`;
  const documents = localized ? `StrapiLocales::narrow(${query}, $request->query())` : query;
  return {
    uses: [
      ...(versioned ? ["App\\Support\\StrapiDocuments"] : []),
      ...(localized ? ["App\\Support\\StrapiLocales"] : []),
      "App\\Support\\StrapiPopulate",
      "App\\Support\\StrapiQuery",
      "App\\Support\\StrapiRelations",
    ],
    query: versioned
      ? "StrapiDocuments::version($this->documents($request), $request->query())"
      : "$this->documents($request)",
    storeBody: `${createCheck(spec)}        $wire = ${S}::fromWire((array) $request->input('data', []));
${readLinks}
        $m = new ${M}($wire['columns']);
${localized ? `${STMT}$m->locale = ${forWrite};\n` : ""}${madeCheck(spec)}${assignBlock}${persist("")}

        return response()->json(['data' => $this->wire($request, $m->fresh()), 'meta' => new \\stdClass()], 201);`,
    updateBody: `        $wire = ${S}::fromWire((array) $request->input('data', []));
${readLinks}
        $m = ${lookup}${missingLocale};
${notFound}${auth(`$this->authorize('update', $m);`)}${persist(`${STMT}    $m->fill($wire['columns']);\n`)}

        return response()->json(['data' => $this->wire($request, $m->fresh()), 'meta' => new \\stdClass()]);`,
    destroyBody,
    helpers: `
    /** ${
      localized
        ? `The requested locale's rows${versioned ? ", every version," : ""} of the documents the caller may see${versioned ? "; scoped() narrows them to one status" : ""}.`
        : "Every version of every document the caller may see; scoped() narrows it to one status."
    } */
    protected function documents(Request $request): Builder
    {
        return ${documents};
    }

    /** One row on the wire, shaped by the request's \`fields\` and \`populate\` parameters. */
    protected function wire(Request $request, ${M} $m): array
    {
        return StrapiPopulate::one($m, $request->query(), ${S}::class, ${viewer});
    }
`,
  };
};

export const emitGeneratedController = (spec: ControllerSpec): string => {
  const { shape, secured } = spec;
  const M = shape.model;
  const parts = spec.layout === "strapi" ? strapiControllerParts(spec) : laravelParts(spec);
  const single = spec.ct.kind === "single";

  const uses = [
    "App\\Http\\Controllers\\Controller",
    `App\\Http\\Serializers\\${M}Serializer`,
    `App\\Models\\${M}`,
    ...parts.uses,
    ...(single ? ["App\\Support\\StrapiError"] : []),
    ...(secured ? ["Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests"] : []),
    "Illuminate\\Database\\Eloquent\\Builder",
    "Illuminate\\Http\\JsonResponse",
    "Illuminate\\Http\\Request",
    "Illuminate\\Support\\Facades\\DB",
    // The gate answers for a caller without a session too, which the user object cannot.
    ...(secured ? ["Illuminate\\Support\\Facades\\Gate"] : []),
  ]
    .sort()
    .map((u) => `use ${u};`)
    .join("\n");

  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api\\Generated;

${uses}

class ${M}ApiController extends Controller
{
${secured ? "    use AuthorizesRequests;\n\n" : ""}    private const KEY = '${shape.keyColumn}';

    protected function scoped(Request $request): Builder
    {
        return ${parts.query};
    }

    /** Fail closed: a row outside the caller's view is indistinguishable from a missing one. */
    protected function find(Request $request, string $key): ${M}
    {
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m === null${secured ? ` || ! Gate::allows('view', $m)` : ""}) {
            abort(404);
        }

        return $m;
    }
${parts.helpers ?? ""}
    public function index(Request $request): JsonResponse
    {
${parts.indexBody}
    }

    public function show(Request $request, string $key): JsonResponse
    {
${parts.showBody}
    }

    public function store(Request $request): JsonResponse
    {
${parts.storeBody}
    }

    public function update(Request $request, string $key): JsonResponse
    {
${parts.updateBody}
    }

    public function destroy(Request $request, string $key): JsonResponse
    {
${parts.destroyBody}
    }
${single ? singleMethods(spec) : ""}}
`;
};

// Protected seam (mode: seed): hand-written overrides go here and survive regeneration.
export const emitProtectedController = (model: string): string => `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Api\\Generated\\${model}ApiController as Generated;

// Hand-written overrides for ${model}. camis seeds this file once and never overwrites it.
// Override store()/update()/index() here and call parent:: for the generated behavior.
class ${model}ApiController extends Generated
{
}
`;
