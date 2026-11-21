import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";

// The users-permissions plugin serves the built-in user with no check of camis's, and its writes
// reach far past the entry written: the user API sets any user's role. (The upload plugin's
// writes are enforced by the generated upload extension: api-upload-enforcement.ts.)

/**
 * A non-admin role that creates or updates the built-in user: users-permissions takes the role
 * and password from the body for any user, so the caller could move itself (or an account it
 * made) into any role, and with it any endpoint or plugin service that role holds. No grant set
 * of the role's own makes that harmless, so none exempts it.
 */
const userGaps = (role: Role, user: ContentType): CapabilityGap[] =>
  (["create", "update"] as const)
    .filter((a) => role.grants.some((g) => g.contentType === user.name && g.actions.includes(a)))
    .map((action) => ({
      feature: "apiUserWrite",
      location: { contentType: user.name, rule: role.name },
      severity: "error",
      message: `role "${role.name}" may ${action} the built-in user, and Strapi's users-permissions ${action === "update" ? "update (PUT /api/users/:id)" : "create (POST /api/users)"} sets the role and password of any user from the body: the caller could take any other role, and every grant the rules guard`,
    }));

/** The errors for writes to the built-in user its plugin serves unchecked. */
export const builtinWriteGaps = (doc: IrDocument, roles: readonly Role[]): CapabilityGap[] => {
  // Every built-in user type of the IR is users-permissions' one user.
  const users = doc.contentTypes.filter((ct) => ct.builtin === "user");
  return roles
    .filter((r) => r.admin !== true)
    .flatMap((role) => users.flatMap((user) => userGaps(role, user)));
};
