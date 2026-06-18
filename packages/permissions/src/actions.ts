import { z } from "zod";

export const ACTIONS = ["create", "read", "update", "delete", "publish"] as const;
export type Action = (typeof ACTIONS)[number];
export const action = z.enum(ACTIONS);
