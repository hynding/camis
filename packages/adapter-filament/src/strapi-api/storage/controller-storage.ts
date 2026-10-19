import { phpSingleQuoted } from "../../php-literal";
import { authLine, NESTED_STMT, STMT } from "../controller-shared";
import type { ControllerLink, ControllerParts, ControllerSpec } from "../controller";

/** A PHP single-quoted string literal, or `null` for an absent value. */
const nullableString = (value: string | undefined): string =>
  value === undefined ? "null" : phpSingleQuoted(value);

/**
 * The Strapi-storage half of `emitGeneratedController`. Nothing here touches a foreign-key
 * column or the serializer's child sync: on a Strapi database an owning relation lives in a
 * `_lnk` table and a component lives in its own table behind a `_cmps` link row, so every write
 * goes through `App\Support\StrapiRows` / `App\Support\StrapiComponents`.
 */
export const strapiControllerParts = (spec: ControllerSpec): ControllerParts => {
  const { shape, secured, scoped } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  const MAP = `${M}::COMPONENT_MAP`;
  const links = spec.links ?? [];
  const auth = authLine(secured);
  const upsert = shape.upsert;

  // The assign grants name relations; the link entry carries the physical table they write to.
  // A missing entry cannot be skipped: the row would be created with no ownership link at all,
  // invisible to the caller that just created it.
  const assignLinks = spec.assigns.map((relation) => {
    const link = links.find((l) => l.relation === relation);
    if (link === undefined) {
      throw new Error(
        `Unknown assign relation "${relation}" on "${spec.ct.name}" (no owning link)`,
      );
    }
    return link;
  });

  const linkLine = (indent: string, l: ControllerLink): string =>
    `${indent}StrapiRows::link($m, ${phpSingleQuoted(l.table)}, ${phpSingleQuoted(l.local)}, ${phpSingleQuoted(l.foreign)}, $request->user()->id, ${nullableString(l.ord)});`;

  /**
   * The row-creating transaction body, shared by store() and update()'s create branch. The key
   * is pinned after the fill because the wire payload carries it too, and the caller's URL key
   * is the authority.
   */
  const createTransaction = (indent: string, pinKey: boolean): string => {
    const inner = `${indent}    `;
    const lines = [`${inner}$m->fill(StrapiComponents::columnsOf($wire, ${MAP}));`];
    if (pinKey) lines.push(`${inner}$m->{self::KEY} = $key;`);
    lines.push(`${inner}StrapiRows::create($m);`);
    for (const l of assignLinks) lines.push(linkLine(inner, l));
    lines.push(`${inner}StrapiComponents::apply($m, ${MAP}, $wire);`);
    const captured = [
      "$m",
      "$wire",
      ...(pinKey ? ["$key"] : []),
      ...(assignLinks.length > 0 ? ["$request"] : []),
    ];
    return `${indent}DB::transaction(function () use (${captured.join(", ")}): void {
${lines.join("\n")}
${indent}});`;
  };

  // fresh() returns a new instance, so the components have to be loaded onto that one; the
  // trait's lazy accessors would otherwise fire one query per component table per attribute.
  const reload = (indent: string): string =>
    `${indent}$fresh = $m->fresh();\n${indent}StrapiComponents::loadOne($fresh, ${MAP});`;

  // Strapi's own validator answers a duplicate uid with a 400 ValidationError before the insert;
  // without this guard the driver's unique-constraint error would surface instead.
  const duplicateGuard = upsert
    ? `        if (${M}::query()->where(self::KEY, $wire['columns'][self::KEY] ?? null)->exists()) {
            throw ValidationException::withMessages([self::KEY => 'This attribute must be unique']);
        }
`
    : "";

  const createBranch = upsert
    ? `
        if (${M}::query()->where(self::KEY, $key)->exists()) {
            abort(404); // claimed by another scope: never reach across owners
        }
${auth(`$this->authorize('create', ${M}::class);`)}        $m = new ${M}();
${createTransaction(STMT, true)}

${reload(STMT)}

        return response()->json(['data' => ${S}::toWire($fresh)], 200);`
    : `
        abort(404);`;

  const unlinks = links
    .map(
      (l) =>
        `${NESTED_STMT}StrapiRows::unlinkAll($m, ${phpSingleQuoted(l.table)}, ${phpSingleQuoted(l.local)});`,
    )
    .join("\n");

  return {
    uses: [
      "App\\Support\\StrapiComponents",
      "App\\Support\\StrapiRows",
      ...(upsert ? ["Illuminate\\Validation\\ValidationException"] : []),
    ],
    // Every owning relation is eager-loaded: the policy conditions and the ownership accessors
    // read them per row, which is one query each on a lazy relation.
    query: `${scoped ? `${M}::query()->forUser($request->user())` : `${M}::query()`}${
      links.length > 0
        ? `->with([${links.map((l) => phpSingleQuoted(l.relation)).join(", ")}])`
        : ""
    }`,
    indexBody: `${auth(`$this->authorize('viewAny', ${M}::class);`)}        $rows = $this->scoped($request)->get();
        StrapiComponents::load($rows, ${MAP});
${secured ? `        $rows = $rows->filter(fn (${M} $m) => Gate::allows('view', $m));\n` : ""}
        return response()->json(['data' => $rows->map(fn (${M} $m) => ${S}::toWire($m))->values()->all()]);`,
    showBody: `        $m = $this->find($request, $key);
        StrapiComponents::loadOne($m, ${MAP});

        return response()->json(['data' => ${S}::toWire($m)]);`,
    storeBody: `        $wire = ${S}::fromWire((array) $request->input('data', []));
${duplicateGuard}${auth(`$this->authorize('create', ${M}::class);`)}        $m = new ${M}();
${createTransaction(STMT, false)}

${reload(STMT)}

        return response()->json(['data' => ${S}::toWire($fresh)], 201);`,
    updateBody: `        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m !== null${secured ? ` && Gate::allows('view', $m)` : ""}) {
${auth(`$this->authorize('update', $m);`, NESTED_STMT)}${NESTED_STMT}DB::transaction(function () use ($m, $wire): void {
${NESTED_STMT}    $m->fill(StrapiComponents::columnsOf($wire, ${MAP}))->save();
${NESTED_STMT}    StrapiComponents::apply($m, ${MAP}, $wire);
${NESTED_STMT}});

${reload(NESTED_STMT)}

            return response()->json(['data' => ${S}::toWire($fresh)]);
        }
${createBranch}`,
    destroyBody: `        $m = $this->find($request, $key);
${auth(`$this->authorize('delete', $m);`)}        DB::transaction(function () use ($m): void {
${NESTED_STMT}StrapiComponents::deleteAll($m, ${MAP});
${unlinks === "" ? "" : `${unlinks}\n`}${NESTED_STMT}$m->delete();
        });

        return response()->json(null, 204);`,
  };
};
