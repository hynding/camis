import type { ContentType } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { snakeColumn } from "../names";
import type { WireShape } from "./wire-shape";

export interface ControllerSpec {
  shape: WireShape;
  ct: ContentType;
  assigns: string[];
  secured: boolean;
  scoped: boolean;
}

// PSR-12 indent levels inside a method body.
const STMT = "        "; // 8 spaces: a top-level statement in a method body
const NESTED_STMT = "            "; // 12 spaces: a statement inside a method-body if-block

export const emitGeneratedController = (spec: ControllerSpec): string => {
  const { shape, secured, scoped } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  // `indent` lets a single call site emit at whatever nesting depth it sits in
  // (the update() create branch and the update() if-block sit one level apart).
  const auth = (line: string, indent: string = STMT): string =>
    secured ? `${indent}${line}\n` : "";
  const query = scoped ? `${M}::query()->forUser($request->user())` : `${M}::query()`;
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
${assignBlock}        $m->save();
        ${S}::syncChildren($m, $wire['children']);

        return response()->json(['data' => ${S}::toWire($m->fresh())], 200);`
    : `
        abort(404);`;

  const uses = [
    "App\\Http\\Controllers\\Controller",
    `App\\Http\\Serializers\\${S}`,
    `App\\Models\\${M}`,
    ...(secured ? ["Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests"] : []),
    "Illuminate\\Database\\Eloquent\\Builder",
    "Illuminate\\Http\\JsonResponse",
    "Illuminate\\Http\\Request",
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
        return ${query};
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
${auth(`$this->authorize('viewAny', ${M}::class);`)}        $rows = $this->scoped($request)->get()${secured ? `->filter(fn (${M} $m) => $request->user()->can('view', $m))` : ""};

        return response()->json(['data' => $rows->map(fn (${M} $m) => ${S}::toWire($m))->values()->all()]);
    }

    public function show(Request $request, string $key): JsonResponse
    {
        $m = $this->find($request, $key);

        return response()->json(['data' => ${S}::toWire($m)]);
    }

    public function store(Request $request): JsonResponse
    {
${auth(`$this->authorize('create', ${M}::class);`)}        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = new ${M}($wire['columns']);
${assignBlock}        $m->save();
        ${S}::syncChildren($m, $wire['children']);

        return response()->json(['data' => ${S}::toWire($m->fresh())], 201);
    }

    public function update(Request $request, string $key): JsonResponse
    {
        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m !== null${secured ? ` && $request->user()->can('view', $m)` : ""}) {
${auth(`$this->authorize('update', $m);`, NESTED_STMT)}            $m->fill($wire['columns'])->save();
            ${S}::syncChildren($m, $wire['children']);

            return response()->json(['data' => ${S}::toWire($m->fresh())]);
        }
${createBranch}
    }

    public function destroy(Request $request, string $key): JsonResponse
    {
        $m = $this->find($request, $key);
${auth(`$this->authorize('delete', $m);`)}        $m->delete();

        return response()->json(null, 204);
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
