import type { Action } from "@camis/permissions";
import { snake } from "../names";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export const permissionKey = (contentType: string, action: Action): string =>
  `${snake(contentType)}.${action}`;

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
  update: [{ method: "update", record: true }],
  delete: [{ method: "delete", record: true }],
  publish: [{ method: "publish", record: true }],
};
