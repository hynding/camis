import type { Action, Service } from "@camis/permissions";
import { snake } from "../names";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export const permissionKey = (contentType: string, action: Action): string =>
  `${snake(contentType)}.${action}`;

/** A plugin service's permission: prefixed, so no content type's key can take its name. */
export const serviceKey = (service: Service): string => `service.${service}`;

export interface PolicyMethod {
  method: string;
  record: boolean;
}

export const POLICY_METHODS: Record<Action, PolicyMethod[]> = {
  read: [
    { method: "viewAny", record: false },
    { method: "view", record: true },
  ],
  create: [{ method: "create", record: false }],
  // updateAny is the role-level check a route makes before its policies run (CamisRouteHooks).
  update: [
    { method: "updateAny", record: false },
    { method: "update", record: true },
  ],
  // Bulk actions are offered on the record-less methods; Filament allows what a policy has no
  // method for, so each needs one.
  delete: [
    { method: "deleteAny", record: false },
    { method: "delete", record: true },
  ],
  publish: [
    { method: "publishAny", record: false },
    { method: "publish", record: true },
  ],
};
