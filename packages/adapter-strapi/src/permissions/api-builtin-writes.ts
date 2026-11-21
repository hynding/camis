import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";
import { embedded } from "./api-reach";

// The users-permissions and upload plugins serve the built-in user and the media library with
// no check of camis's, and some of their writes reach far past the entry written: the upload API
// attaches, replaces or deletes a file on any entry, and the user API sets any user's role.

const holdsOutright = (role: Role, contentType: string, action: Action): boolean =>
  role.grants.some(
    (g) => g.contentType === contentType && g.actions.includes(action) && g.condition === undefined,
  );

/** The fields of a type with a media field, its own or an embedded component's, as `Type.field`. */
const mediaFields = (doc: IrDocument, ct: ContentType): string[] => [
  ...ct.fields.filter((f) => f.type === "media").map((f) => `${ct.name}.${f.name}`),
  ...embedded(doc, ct.fields).flatMap((c) =>
    c.fields.filter((f) => f.type === "media").map((f) => `${c.name}.${f.name}`),
  ),
];

/**
 * A non-admin role that writes the media library while a type with a media field is one it does
 * not update outright: `POST /api/upload` with `ref`, `refId` and `field` attaches the new file
 * to any entry, `?id=` replaces a file wherever it is attached, and `DELETE
 * /api/upload/files/:id` removes it from every entry, none checking the entry.
 */
const uploadGaps = (doc: IrDocument, role: Role, file: ContentType): CapabilityGap[] => {
  const writes = (["create", "update", "delete"] as const).filter((a) =>
    role.grants.some((g) => g.contentType === file.name && g.actions.includes(a)),
  );
  const [action] = writes;
  if (action === undefined) return [];
  return doc.contentTypes
    .filter((ct) => ct.builtin === undefined && !holdsOutright(role, ct.name, "update"))
    .flatMap((ct) => {
      const fields = mediaFields(doc, ct);
      if (fields.length === 0) return [];
      return [
        {
          feature: "apiRelationReach",
          location: { contentType: ct.name, rule: role.name },
          severity: "error",
          message: `role "${role.name}" may ${action} files, and Strapi's upload API attaches, replaces or deletes a file on any entry (ref, refId and field on POST /api/upload, ?id=, DELETE /api/upload/files/:id) with no check: that changes ${fields.join(", ")} on entries of "${ct.name}", which it does not update outright`,
        },
      ];
    });
};

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

/** The errors for writes to the built-in user and media library their plugins serve unchecked. */
export const builtinWriteGaps = (doc: IrDocument, roles: readonly Role[]): CapabilityGap[] => {
  const file = doc.contentTypes.find((ct) => ct.builtin === "file");
  const user = doc.contentTypes.find((ct) => ct.builtin === "user");
  return roles
    .filter((r) => r.admin !== true)
    .flatMap((role) => [
      ...(file === undefined ? [] : uploadGaps(doc, role, file)),
      ...(user === undefined ? [] : userGaps(role, user)),
    ]);
};
