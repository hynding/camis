import type { StorageLayout } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { snakeColumn } from "../names";
import { authLine, NESTED_STMT, STMT } from "./controller-shared";
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
}

const laravelParts = (spec: ControllerSpec): ControllerParts => {
  const { shape, secured, scoped } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  // syncChildren deletes the existing child rows before re-inserting them, so a failing insert
  // outside a transaction would leave the parent persisted with its children gone. Both halves
  // must commit or roll back together.
  const persist = (save: string, indent: string = STMT): string =>
    `${indent}DB::transaction(function () use ($m, $wire): void {
${indent}    ${save}
${indent}    ${S}::syncChildren($m, $wire['children']);
${indent}});`;
  const auth = authLine(secured);
  const assign = spec.assigns
    .map((name) => `${STMT}$m->${snakeColumn(name)}_id = $request->user()->id;`)
    .join("\n");
  const assignBlock = assign ? `${assign}\n` : "";
  const upsert = shape.keyColumn !== "id";

  const createBranch = upsert
    ? `
        if (${M}::query()->where(self::KEY, $key)->exists()) {
            abort(404); // claimed by another scope: never reach across owners
        }
${auth(`$this->authorize('create', ${M}::class);`)}        $m = new ${M}($wire['columns']);
        $m->{self::KEY} = $key;
${assignBlock}${persist("$m->save();")}

        return response()->json(['data' => ${S}::toWire($m->fresh())], 200);`
    : `
        abort(404);`;

  return {
    uses: [],
    query: scoped ? `${M}::query()->forUser($request->user())` : `${M}::query()`,
    indexBody: `${auth(`$this->authorize('viewAny', ${M}::class);`)}        $rows = $this->scoped($request)->get()${secured ? `->filter(fn (${M} $m) => $request->user()->can('view', $m))` : ""};

        return response()->json(['data' => $rows->map(fn (${M} $m) => ${S}::toWire($m))->values()->all()]);`,
    showBody: `        $m = $this->find($request, $key);

        return response()->json(['data' => ${S}::toWire($m)]);`,
    storeBody: `${auth(`$this->authorize('create', ${M}::class);`)}        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = new ${M}($wire['columns']);
${assignBlock}${persist("$m->save();")}

        return response()->json(['data' => ${S}::toWire($m->fresh())], 201);`,
    updateBody: `        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m !== null${secured ? ` && $request->user()->can('view', $m)` : ""}) {
${auth(`$this->authorize('update', $m);`, NESTED_STMT)}${persist("$m->fill($wire['columns'])->save();", NESTED_STMT)}

            return response()->json(['data' => ${S}::toWire($m->fresh())]);
        }
${createBranch}`,
    destroyBody: `        $m = $this->find($request, $key);
${auth(`$this->authorize('delete', $m);`)}        $m->delete();

        return response()->json(null, 204);`,
  };
};

export const emitGeneratedController = (spec: ControllerSpec): string => {
  const { shape, secured } = spec;
  const M = shape.model;
  const parts = spec.layout === "strapi" ? strapiControllerParts(spec) : laravelParts(spec);

  const uses = [
    "App\\Http\\Controllers\\Controller",
    `App\\Http\\Serializers\\${M}Serializer`,
    `App\\Models\\${M}`,
    ...parts.uses,
    ...(secured ? ["Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests"] : []),
    "Illuminate\\Database\\Eloquent\\Builder",
    "Illuminate\\Http\\JsonResponse",
    "Illuminate\\Http\\Request",
    "Illuminate\\Support\\Facades\\DB",
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
        if ($m === null${secured ? ` || ! $request->user()->can('view', $m)` : ""}) {
            abort(404);
        }

        return $m;
    }

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
}
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
