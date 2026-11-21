import { own, recordQuery, type Tables } from "./api-conditions";
import {
  FILE_UID,
  UPLOADER,
  attachField,
  changeVerdict,
  entryHeadQuery,
  entryVerdict,
  fileQuery,
  relatedEntries,
  uploadCaller,
  uploaderOf,
  uploadRequest,
  type StoredFile,
} from "./api-uploads";

// The upload plugin's content API controller with the upload API's checks before it, copied into
// each generated Strapi project as src/permissions/api-upload-controller.ts. The generated
// src/extensions/upload/strapi-server.ts puts it in place of the plugin's own, which it wraps:
// every refusal comes before the plugin stores, replaces or deletes a file.

interface UploadContext {
  params?: { id?: unknown };
  query?: Record<string, unknown>;
  state?: unknown;
  request?: { body?: unknown };
  body?: unknown;
  forbidden: () => unknown;
  badRequest: (message?: string) => unknown;
}

/** The parts of the plugin's content API controller wrapped here. */
interface UploadController {
  upload(ctx: UploadContext): Promise<unknown>;
  destroy(ctx: UploadContext): Promise<unknown>;
}

interface Query {
  findMany(params: object): Promise<unknown[]>;
}

/** The parts of Strapi the checks load from: the query engine. */
export interface QueryEngine {
  db: { query(uid: string): Query };
}

const field = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;

/** Every row of the entry `id` is a row of (as a type with rules decides on them); none if absent. */
const loadEntry = async (
  strapi: QueryEngine,
  tables: Tables,
  uid: string,
  id: number,
): Promise<unknown[]> => {
  const head = await strapi.db.query(uid).findMany(entryHeadQuery(id));
  const documentId = field(head[0], "documentId");
  const rules = own(tables.rules, uid);
  if (rules?.own !== true || typeof documentId !== "string") return head;
  return strapi.db.query(uid).findMany(recordQuery(rules, documentId));
};

/**
 * A stored file with the rows of each content type entry it is attached to; null when there is no
 * such file. A component's row, or a type no check knows, is left with no rows: no verdict allows it.
 */
export const loadFile = async (
  strapi: QueryEngine,
  tables: Tables,
  id: number,
): Promise<StoredFile | null> => {
  const [file] = await strapi.db.query(FILE_UID).findMany(fileQuery(id));
  if (file === undefined) return null;
  const known = (uid: string): boolean =>
    tables.uploads !== undefined && own(tables.uploads.grants, uid) !== undefined;
  const related = await Promise.all(
    relatedEntries(file).map(async (r) => ({
      uid: r.uid,
      rows: known(r.uid) ? await loadEntry(strapi, tables, r.uid, r.id) : [],
    })),
  );
  return { uploader: field(file, UPLOADER), related };
};

/** The ids of the files an upload answered with. */
const createdIds = (body: unknown): number[] =>
  (Array.isArray(body) ? body : [body])
    .map((file) => field(file, "id"))
    .filter((id): id is number => typeof id === "number");

/**
 * The plugin's content API controller factory, with upload and destroy decided first for a caller
 * the rules restrict: an upload attaches only to a content type's own media field on an entry the
 * caller may update; a replace, an info update or a delete needs update on every entry the file is
 * attached to, or, for an unattached file, that the caller uploaded it. Every upload with a session
 * records its uploader. An API token and an admin role pass to the plugin as they are.
 */
export const enforcedUpload =
  (factory: unknown, tables: Tables) =>
  ({ strapi: strapiInstance }: { strapi: unknown }) => {
    const core = (factory as (p: { strapi: unknown }) => UploadController)({
      strapi: strapiInstance,
    });
    const strapi = strapiInstance as {
      db: { query(uid: string): Query & { updateMany(params: object): Promise<unknown> } };
    };
    const uploads = tables.uploads!;

    const recordUploader = async (ctx: UploadContext): Promise<void> => {
      const uploader = uploaderOf(ctx.state);
      const ids = createdIds(ctx.body);
      if (uploader === null || ids.length === 0) return;
      await strapi.db
        .query(FILE_UID)
        .updateMany({ where: { id: { $in: ids } }, data: { [UPLOADER]: uploader } });
    };

    return {
      ...core,

      async upload(ctx: UploadContext) {
        const caller = uploadCaller(uploads, ctx.state);
        if (caller.kind === "refused") return ctx.forbidden();
        const request = uploadRequest(ctx.query, ctx.request?.body);
        if (caller.kind === "role") {
          if (!request.ok) return ctx.badRequest(request.message);
          const value = request.value;
          if (value.kind === "change") {
            const file = await loadFile(strapi, tables, value.id);
            if (!changeVerdict(tables, ctx.state, file)) return ctx.forbidden();
            return core.upload.call(core, ctx);
          }
          const attach = value.attach;
          if (
            attach !== null &&
            !(
              attachField(uploads, attach) &&
              entryVerdict(
                tables,
                attach.uid,
                ctx.state,
                "update",
                await loadEntry(strapi, tables, attach.uid, attach.id),
              )
            )
          )
            return ctx.forbidden();
        }
        await core.upload.call(core, ctx);
        // Strapi's own dispatch: with an id it replaces, which keeps the file and its uploader.
        if (!ctx.query?.id) await recordUploader(ctx);
        return undefined;
      },

      async destroy(ctx: UploadContext) {
        if (uploadCaller(uploads, ctx.state).kind === "refused") return ctx.forbidden();
        if (uploadCaller(uploads, ctx.state).kind === "role") {
          const id = ctx.params?.id;
          if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id))
            return ctx.badRequest("Invalid id");
          const file = await loadFile(strapi, tables, Number(id));
          if (!changeVerdict(tables, ctx.state, file)) return ctx.forbidden();
        }
        return core.destroy.call(core, ctx);
      },
    };
  };
