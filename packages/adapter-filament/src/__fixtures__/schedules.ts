import type { IrBundle } from "@camis/permissions";

export const schedulesBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
    components: [],
    schedules: [
      { name: "SendDigest", cron: "0 7 * * 1-5" },
      { name: "PruneDrafts", cron: "*/30 * * * *" },
    ],
  },
  roles: [],
};
