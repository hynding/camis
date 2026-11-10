import { PHP_MARKER } from "../hooks/names";
import type { LinkOrder, WireShape } from "./wire-shape";
import { runtimePhp } from "../runtime-php";

export const LINK_ORDER_MIGRATION_PATH =
  "database/migrations/0001_01_03_000000_add_link_order_columns.php";

/** Every order column the shapes' to-many sides read, once each, by table then column. */
export const linkOrderColumns = (shapes: Iterable<WireShape>): LinkOrder[] => {
  const seen = new Map<string, LinkOrder>();
  for (const shape of shapes) {
    for (const r of shape.relations) {
      for (const order of [r.order, r.inverseOrder]) {
        if (order !== null) seen.set(`${order.table}.${order.column}`, order);
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  );
};

/**
 * Strapi's link order: the place of each linked row in a to-many list, kept beside the link (on the
 * pivot, or beside the foreign key), as Strapi's `*_ord` columns are. Fractional while a connect
 * places a row between two others, renumbered from 1 after it.
 */
export const emitLinkOrderMigration = (columns: LinkOrder[]): string => {
  const byTable = new Map<string, string[]>();
  for (const { table, column } of columns)
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  const tables = (body: (columns: string[]) => string): string =>
    [...byTable.entries()]
      .map(
        ([table, cols]) => `        Schema::table('${table}', function (Blueprint $table): void {
${body(cols)}
        });`,
      )
      .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
${tables((cols) => cols.map((c) => `            $table->double('${c}')->nullable();`).join("\n"))}
    }

    public function down(): void
    {
${tables((cols) => `            $table->dropColumn([${cols.map((c) => `'${c}'`).join(", ")}]);`)}
    }
};
`;
};

/**
 * A model's to-one foreign keys whose target lists it, each with the column keeping its place in
 * that list (on this model's table): what `HasLinkOrder` fills when a link is made outside the API.
 */
export const toOneLinkOrders = (shape: WireShape): Record<string, string> => {
  const orders: Record<string, string> = {};
  for (const r of shape.relations) {
    if (r.kind === "belongsTo" && r.foreignKey !== null && r.inverseOrder !== null)
      orders[r.foreignKey] = r.inverseOrder.column;
  }
  return orders;
};

/** The model member `HasLinkOrder` reads: foreign key → order column. */
export const linkOrdersConstant = (orders: Record<string, string>): string =>
  `    public const LINK_ORDERS = [${Object.entries(orders)
    .map(([foreignKey, column]) => `'${foreignKey}' => '${column}'`)
    .join(", ")}];`;

/**
 * A row linked to-one outside the API (the admin's select, a hook's save) takes the end of its
 * target's list, as Strapi places a link made without a position. A save that sets the order
 * itself (the API's writes, publishing) keeps it.
 */
export const emitHasLinkOrder = (): string =>
  runtimePhp(new URL("./php/app/Models/Concerns/HasLinkOrder.php", import.meta.url));

/**
 * A pivot link made outside the API (the admin's multi-select syncs, a hook attaches) takes the
 * end of both sides' lists unless it is given a place, as a Strapi connect without a position
 * does. An order column is named for the side whose place it keeps (`genre_ord` is a genre's
 * place in its book's list), beside that side's key (`genre_id`).
 */
export const emitStrapiLinkPivot = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiLinkPivot.php", import.meta.url));

/**
 * Strapi's link order over Eloquent: a to-many relation's links, on its pivot or beside the target's
 * foreign key, written as strapi-php's entity manager writes its link tables. A set is kept in the
 * order given; a connect goes where its position says (the end without one), placed by Strapi's
 * relations orderer among the adjacent links only, then the list is renumbered from 1. A new link
 * takes the end of the target's own list. `link-order-vectors.json` is the check.
 */
export const emitStrapiLinkOrder = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiLinkOrder.php", import.meta.url));

/**
 * Strapi's relations orderer (`entity-manager/relations-orderer.ts`, as strapi-php ports it): where
 * each connected link goes among the adjacent links read from the database. A link placed next to
 * one connected in the same request is placed after it; one placed next to a link that is not
 * there is refused, as Strapi's strict mode does.
 */
export const emitStrapiRelationsOrderer = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiRelationsOrderer.php", import.meta.url));
