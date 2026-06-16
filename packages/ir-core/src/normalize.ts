import type { ContentType, IrDocument } from "@camis/ir-schema";
import { humanize, pluralize, snakeCase } from "./inflect";

const DEFAULT_OPTIONS = { draftPublish: false, timestamps: true, softDelete: false };

const normalizeContentType = (ct: ContentType): ContentType => ({
  ...ct,
  names: {
    display: ct.names?.display ?? humanize(ct.name),
    plural: ct.names?.plural ?? pluralize(ct.name),
    collection: ct.names?.collection ?? snakeCase(pluralize(ct.name)),
  },
  options: { ...DEFAULT_OPTIONS, ...ct.options },
});

export const normalize = (doc: IrDocument): IrDocument => ({
  ...doc,
  contentTypes: doc.contentTypes.map(normalizeContentType),
});
