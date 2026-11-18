import type { Service } from "@camis/permissions";

/**
 * The users-permissions actions each plugin service is in Strapi: a role holds the service when it
 * holds every one of them, and an export gives a role holding it all of them.
 */
export const SERVICE_ACTIONS: Record<Service, string[]> = {
  "email.send": ["plugin::email.email.send"],
  "locales.list": ["plugin::i18n.locales.listLocales"],
  "roles.read": [
    "plugin::users-permissions.role.find",
    "plugin::users-permissions.role.findOne",
    "plugin::users-permissions.permissions.getPermissions",
  ],
};
