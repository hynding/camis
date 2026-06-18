import type { Action } from "@camis/permissions";

// The one place Strapi content-manager action UIDs live; the fact most likely to drift
// across Strapi versions, so it is isolated and golden-locked.
export const STRAPI_ACTION_UID: Record<Action, string> = {
  create: "plugin::content-manager.explorer.create",
  read: "plugin::content-manager.explorer.read",
  update: "plugin::content-manager.explorer.update",
  delete: "plugin::content-manager.explorer.delete",
  publish: "plugin::content-manager.explorer.publish",
};

// Field access maps to the content-manager actions it gates.
export const FIELD_ACCESS_ACTIONS: Record<"read" | "write", Action[]> = {
  read: ["read"],
  write: ["create", "update"],
};
