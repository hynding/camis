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

// users-permissions REST Content API action suffixes per camis grant action, appended to a
// content type's `api::x.x` uid. `publish` has no separate API action: Strapi 5 publishes
// through `update` with a `status` parameter, so it maps to nothing here.
export const API_ACTION_SUFFIXES: Partial<Record<Action, string[]>> = {
  read: ["find", "findOne"],
  create: ["create"],
  update: ["update"],
  delete: ["delete"],
};

// Fixed users-permissions actions every generated project needs for headless registration
// and login, independent of any IR role/grant.
export const PUBLIC_API_ACTIONS = [
  "plugin::users-permissions.auth.register",
  "plugin::users-permissions.auth.callback",
] as const;
