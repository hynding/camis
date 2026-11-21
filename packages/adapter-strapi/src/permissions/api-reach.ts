import {
  fieldApiName,
  inverseApiName,
  type CapabilityGap,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { PUBLIC_ROLE, type Role } from "@camis/permissions";
import { componentUid, strapiNames } from "@camis/strapi-schema";
import type { ApiHolder, ApiHolderLink, ApiTypeRules } from "./api-enforcement";
import { PLUGIN_USER_UID } from "./actions";
import { codePointOrder } from "./code-point-order";

// Which content types and components reach a type some role reads under a condition, through
// relations (and their inverses), a localized type's localizations, components, dynamic zones and
// media (a file's `related` entries are every entry it is attached to): each serves the
// conditioned type's rows in a populate, a relation filter or a relation write, so the generated
// controllers narrow it there. A reach they cannot narrow is an error.

/**
 * A node of the reach graph: a content type or a component, which may share a name, or the upload
 * plugin's file, whose polymorphic `related` leads to every type and component with a media field.
 */
type NodeKey = `type:${string}` | `component:${string}` | "file" | "polymorphic" | "user";

const FILE: NodeKey = "file";
/**
 * users-permissions' user, which every built-in user type of the IR names: one node, whose edges
 * are the inverses onto any of them.
 */
const USER: NodeKey = "user";
/** Where every polymorphic relation or inverse leads: entries of any type. */
const POLYMORPHIC: NodeKey = "polymorphic";
/**
 * What a file's `related` entries, and any polymorphic relation or inverse, reach besides
 * conditioned types: a populate of one takes no per-type filter and returns entries of any type,
 * one the caller holds no grant on included (Strapi's sanitizer keeps such a list whole when it
 * can read none of its entries). Every node that leads to one reaches it, so its populate is
 * checked: refused for a role and the public role alike.
 */
const ANY_TYPE = "any type";
const FILE_UID = "plugin::upload.file";

export const typeKey = (ct: { name: string }): NodeKey => `type:${ct.name}`;
const componentKey = (name: string): NodeKey => `component:${name}`;

interface Edge {
  attribute: string;
  link: "relation" | "component" | "zone" | "media" | "polymorphic";
  targets: NodeKey[];
}

interface Node {
  uid: string;
  /** `Type.field` names, by attribute, for messages. */
  owner: string;
  populatable: string[];
  /** The relations Strapi adds to the type that are no edge: nothing is known beneath them. */
  unwalked: string[];
  edges: Edge[];
}

/** Strapi relates every content type to the admin users who created and last updated it. */
const ADMIN_RELATIONS = ["createdBy", "updatedBy"];

const BUILTIN_PLUGIN: Record<string, string> = { user: "users-permissions", file: "upload" };
const POPULATABLE = new Set<Field["type"]>([
  "relation",
  "media",
  "component",
  "dynamicZone",
  "polymorphicRelation",
  "polymorphicInverse",
]);

const gap = (ct: string, role: string, feature: string, message: string): CapabilityGap => ({
  feature,
  location: { contentType: ct, rule: role },
  severity: "error",
  message,
});

/** The reach graph over every non-built-in content type and every component. */
const graphOf = (doc: IrDocument): Map<NodeKey, Node> => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const nodes = new Map<NodeKey, Node>();
  const fieldEdges = (fields: readonly Field[]): Edge[] =>
    fields.flatMap((f): Edge[] => {
      const attribute = fieldApiName(f);
      if (f.type === "relation") {
        const target = byName.get(f.target);
        // The built-in user is a node (its inverses lead on); the media library's file is not.
        if (target?.builtin === "user") return [{ attribute, link: "relation", targets: [USER] }];
        return target === undefined || target.builtin !== undefined
          ? []
          : [{ attribute, link: "relation", targets: [typeKey(target)] }];
      }
      if (f.type === "component")
        return [{ attribute, link: "component", targets: [componentKey(f.component)] }];
      if (f.type === "dynamicZone")
        return [{ attribute, link: "zone", targets: f.components.map(componentKey) }];
      if (f.type === "media") return [{ attribute, link: "media", targets: [FILE] }];
      if (f.type === "polymorphicRelation" || f.type === "polymorphicInverse")
        return [{ attribute, link: "polymorphic", targets: [POLYMORPHIC] }];
      return [];
    });
  const populatable = (fields: readonly Field[]): string[] =>
    fields.filter((f) => POPULATABLE.has(f.type)).map(fieldApiName);
  // users-permissions serves the user and camis emits none of its own fields, but a relation to
  // it leads on through its inverses: a node with those alone.
  const user = doc.contentTypes.find((ct) => ct.builtin === "user");
  if (user !== undefined)
    nodes.set(USER, {
      uid: PLUGIN_USER_UID,
      owner: user.name,
      populatable: [],
      unwalked: [...ADMIN_RELATIONS, "role"].sort(),
      edges: [],
    });
  for (const ct of doc.contentTypes) {
    if (ct.builtin !== undefined) continue;
    nodes.set(typeKey(ct), {
      uid: strapiNames(ct).uid,
      owner: ct.name,
      populatable: [
        ...populatable(ct.fields),
        ...(ct.options?.localized === true ? ["localizations"] : []),
      ],
      unwalked: ADMIN_RELATIONS,
      edges: [
        ...fieldEdges(ct.fields),
        // i18n's relation from each locale of an entry to its other locales.
        ...(ct.options?.localized === true
          ? [{ attribute: "localizations", link: "relation" as const, targets: [typeKey(ct)] }]
          : []),
      ],
    });
  }
  for (const c of doc.components) {
    nodes.set(componentKey(c.name), {
      uid: componentUid(c),
      owner: c.name,
      populatable: populatable(c.fields),
      unwalked: [],
      edges: fieldEdges(c.fields),
    });
  }
  // A relation's inverse is an attribute of its target that leads back to the relation's owner.
  for (const ct of doc.contentTypes) {
    if (ct.builtin !== undefined) continue;
    for (const f of ct.fields) {
      const inverse = f.type === "relation" ? inverseApiName(f) : undefined;
      if (f.type !== "relation" || inverse === undefined) continue;
      const target = nodes.get(
        byName.get(f.target)?.builtin === "user" ? USER : (`type:${f.target}` as NodeKey),
      );
      if (target === undefined) continue;
      target.populatable.push(inverse);
      target.edges.push({ attribute: inverse, link: "relation", targets: [typeKey(ct)] });
    }
  }
  const attached = [...nodes]
    .filter(([, node]) => node.edges.some((e) => e.link === "media"))
    .map(([key]) => key);
  nodes.set(FILE, {
    uid: FILE_UID,
    owner: "File",
    populatable: ["related"],
    unwalked: ADMIN_RELATIONS,
    edges: [{ attribute: "related", link: "relation", targets: attached }],
  });
  nodes.set(POLYMORPHIC, { uid: "", owner: "", populatable: [], unwalked: [], edges: [] });
  for (const node of nodes.values()) node.populatable = [...new Set(node.populatable)].sort();
  return nodes;
};

/** For each node, the conditioned types (by name) a path of one edge or more leads to. */
const reachOf = (
  nodes: ReadonlyMap<NodeKey, Node>,
  conditioned: ReadonlySet<string>,
  restricted: boolean,
): Map<NodeKey, Set<string>> => {
  const reach = new Map<NodeKey, Set<string>>(
    [...nodes.keys()].map((k) => [
      k,
      new Set(restricted && (k === FILE || k === POLYMORPHIC) ? [ANY_TYPE] : []),
    ]),
  );
  const step = (target: NodeKey): Set<string> => {
    const out = new Set(reach.get(target) ?? []);
    if (target.startsWith("type:") && conditioned.has(target.slice(5))) out.add(target.slice(5));
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, node] of nodes) {
      const mine = reach.get(key)!;
      for (const edge of node.edges)
        for (const target of edge.targets)
          for (const name of step(target)) {
            if (mine.has(name)) continue;
            mine.add(name);
            changed = true;
          }
    }
  }
  return reach;
};

/**
 * The holder entries of the reaching nodes: each link that leads on towards a conditioned type.
 * The user is always one, and every relation to it a link: Strapi checks neither a populate's
 * filters nor its sorts against the caller's grants, so what lies beneath the user (its role) is
 * walked and refused where camis does not know it, whatever the user reaches.
 */
const holdersOf = (
  nodes: ReadonlyMap<NodeKey, Node>,
  reach: ReadonlyMap<NodeKey, Set<string>>,
  conditioned: ReadonlySet<string>,
): Record<string, ApiHolder> => {
  const leads = (target: NodeKey): boolean =>
    target === USER ||
    (reach.get(target)?.size ?? 0) > 0 ||
    (target.startsWith("type:") && conditioned.has(target.slice(5)));
  const uid = (key: NodeKey): string => nodes.get(key)!.uid;
  const holders: [string, ApiHolder][] = [];
  for (const [key, node] of nodes) {
    // The file has no controller of camis's (its reach is a build error instead), and the
    // polymorphic sentinel is no type.
    if (key === FILE || key === POLYMORPHIC) continue;
    if (key !== USER && (reach.get(key)?.size ?? 0) === 0) continue;
    const links: [string, ApiHolderLink][] = [];
    for (const edge of node.edges) {
      const targets = edge.targets.filter(leads);
      if (targets.length === 0) continue;
      if (edge.link === "media") links.push([edge.attribute, { media: true }]);
      else if (edge.link === "polymorphic") links.push([edge.attribute, { polymorphic: true }]);
      else if (edge.link === "zone") links.push([edge.attribute, { zone: targets.map(uid) }]);
      else if (edge.link === "component")
        links.push([edge.attribute, { component: uid(targets[0]!) }]);
      else links.push([edge.attribute, { relation: uid(targets[0]!) }]);
    }
    links.sort(([a], [b]) => codePointOrder(a, b));
    holders.push([
      node.uid,
      { populatable: node.populatable, unwalked: node.unwalked, links: Object.fromEntries(links) },
    ]);
  }
  holders.sort(([a], [b]) => codePointOrder(a, b));
  // The user's entry matters only beneath a holder that links to it.
  const userUid = nodes.get(USER)?.uid;
  const linked = holders.some(([, h]) =>
    Object.values(h.links).some((l) => "relation" in l && l.relation === userUid),
  );
  return Object.fromEntries(holders.filter(([uid]) => linked || uid !== userUid));
};

/** The components a type embeds, at any depth, through components and dynamic zones. */
export const embedded = (doc: IrDocument, fields: readonly Field[]): Component[] => {
  const byName = new Map(doc.components.map((c) => [c.name, c]));
  const seen = new Map<string, Component>();
  const visit = (list: readonly Field[]): void => {
    for (const f of list) {
      const names =
        f.type === "component" ? [f.component] : f.type === "dynamicZone" ? f.components : [];
      for (const name of names) {
        const c = byName.get(name);
        if (c === undefined || seen.has(name)) continue;
        seen.set(name, c);
        visit(c.fields);
      }
    }
  };
  visit(fields);
  return [...seen.values()];
};

const readsType = (role: Role, ct: string): boolean =>
  role.grants.some((g) => g.contentType === ct && g.actions.includes("read"));

/**
 * How a role reaches a type's links: by reading it, or by writing it (a write's response is
 * populated like a read, and a single type's or a polymorphic link is written unchecked). Null
 * when it does neither.
 */
const touches = (role: Role, ct: ContentType): "reads" | "writes" | null => {
  if (readsType(role, ct.name)) return "reads";
  return role.grants.some(
    (g) =>
      g.contentType === ct.name && (g.actions.includes("create") || g.actions.includes("update")),
  )
    ? "writes"
    : null;
};

/** Whether an `auth: false` route writes the type: it does so as the public role. */
const openlyWritten = (role: Role, ct: ContentType): boolean =>
  role.name === PUBLIC_ROLE &&
  (ct.options?.publicApiActions ?? []).some((a) => a === "create" || a === "update");

export interface ApiReach {
  holders: Record<string, ApiHolder>;
  /** The nodes that reach a conditioned type. */
  reaching: ReadonlySet<NodeKey>;
  gaps: CapabilityGap[];
}

/**
 * The reach of every type some non-admin role reads under a condition, and the errors for a
 * reach the generated controllers cannot narrow, from a type a role reads or writes: a polymorphic relation (which may point at any
 * type), a relation the users-permissions or upload plugin serves, and a single type (which camis
 * serves through Strapi's own controller).
 */
export const projectReach = (doc: IrDocument, roles: Role[], types: ApiTypeRules[]): ApiReach => {
  const nonAdmin = roles.filter((r) => r.admin !== true);
  /** Per role, the types it reads under a condition. */
  const conditionedFor = new Map(
    nonAdmin.map((r) => [
      r.name,
      new Set(types.filter((t) => Array.isArray(t.roles[r.name]?.read)).map((t) => t.contentType)),
    ]),
  );
  const conditioned = new Set([...conditionedFor.values()].flatMap((s) => [...s]));
  const nodes = graphOf(doc);
  // With no role the rules restrict and no open route, no request is narrowed at all.
  const restricted =
    nonAdmin.length > 0 ||
    doc.contentTypes.some((ct) => (ct.options?.publicApiActions ?? []).length > 0);
  const reach = reachOf(nodes, conditioned, restricted);
  const reachFrom = (key: NodeKey): Set<string> => {
    const out = new Set(reach.get(key) ?? []);
    if (key.startsWith("type:") && conditioned.has(key.slice(5))) out.add(key.slice(5));
    return out;
  };
  const gaps: CapabilityGap[] = [];
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));

  for (const role of nonAdmin) {
    const mine = [...conditionedFor.get(role.name)!].sort();
    for (const ct of doc.contentTypes) {
      if (ct.builtin !== undefined) continue;
      const how = touches(role, ct);
      if (how !== null) gaps.push(...polymorphicGaps(doc, role.name, how, ct));
      const single = how ?? (openlyWritten(role, ct) ? "writes" : null);
      if (ct.kind === "single" && single !== null)
        gaps.push(...singleGaps(role.name, single, ct, mine, nodes, reachFrom));
    }
    gaps.push(...builtinGaps(doc, byName, role, mine, reachFrom));
  }
  for (const ct of doc.contentTypes)
    if (ct.builtin === undefined) gaps.push(...openPolymorphicGaps(doc, ct));

  return {
    holders: holdersOf(nodes, reach, conditioned),
    reaching: new Set(
      [...reach]
        .filter(([key, s]) => key !== FILE && key !== POLYMORPHIC && s.size > 0)
        .map(([key]) => key),
    ),
    gaps,
  };
};

/**
 * A polymorphic relation or inverse of a type the role reads or writes (or of a component it
 * embeds, at any depth). Strapi's sanitizer leaves a polymorphic list as it is when it can read
 * none of its entries (seen on 5.48), so the role gets entries of types it holds no grant on, or
 * reads only under a condition, whatever conditions the IR names.
 */
const polymorphicGaps = (
  doc: IrDocument,
  role: string,
  how: "reads" | "writes",
  ct: ContentType,
): CapabilityGap[] =>
  [
    { owner: ct.name, fields: ct.fields },
    ...embedded(doc, ct.fields).map((c) => ({ owner: c.name, fields: c.fields })),
  ].flatMap(({ owner, fields }) =>
    fields
      .filter((f) => f.type === "polymorphicRelation" || f.type === "polymorphicInverse")
      .map((f) =>
        gap(
          ct.name,
          role,
          "apiPolymorphicReach",
          `role "${role}" ${how} "${ct.name}", whose polymorphic relation ${owner}.${f.name} can return entries of any type, ones the role holds no grant on or reads only under a condition included: Strapi leaves a polymorphic populate unchecked when it can read none of its entries, so the Strapi target cannot narrow it or a polymorphic write`,
        ),
      ),
  );

/**
 * A polymorphic relation (its own, or a component's at any depth) of a type an `auth: false`
 * route serves. Strapi sanitises such a request with no credentials, which strips an ordinary
 * relation from populate but not a polymorphic one: it returns entries of any type, one the public
 * role may not read or holds no grant on (seen on 5.48). Whatever roles the IR names.
 */
const openPolymorphicGaps = (doc: IrDocument, ct: ContentType): CapabilityGap[] => {
  const opened = (ct.options?.publicApiActions ?? []).filter((a) =>
    ["list", "read", "create", "update"].includes(a),
  );
  if (opened.length === 0) return [];
  return [
    { owner: ct.name, fields: ct.fields },
    ...embedded(doc, ct.fields).map((c) => ({ owner: c.name, fields: c.fields })),
  ].flatMap(({ owner, fields }) =>
    fields
      .filter((f) => f.type === "polymorphicRelation" || f.type === "polymorphicInverse")
      .map((f) =>
        gap(
          ct.name,
          PUBLIC_ROLE,
          "apiPolymorphicReach",
          `"${ct.name}" opens ${opened.join(", ")} to anyone (an auth: false route), and its polymorphic relation ${owner}.${f.name} can return entries of any type: Strapi does not narrow a polymorphic populate there, whatever the public role holds`,
        ),
      ),
  );
};

/** A single type's reach, which Strapi's own single-type controller serves unnarrowed. */
const singleGaps = (
  role: string,
  how: "reads" | "writes",
  ct: ContentType,
  mine: readonly string[],
  nodes: ReadonlyMap<NodeKey, Node>,
  reachFrom: (key: NodeKey) => Set<string>,
): CapabilityGap[] => {
  const gaps: CapabilityGap[] = [];
  for (const edge of nodes.get(typeKey(ct))?.edges ?? []) {
    const reached = new Set(edge.targets.flatMap((t) => [...reachFrom(t)]));
    for (const target of mine.filter((t) => reached.has(t)))
      gaps.push(
        gap(
          ct.name,
          role,
          "apiRelationReach",
          `role "${role}" ${how} single type "${ct.name}", which reaches "${target}" (read under a condition) through ${ct.name}.${edge.attribute}; the Strapi target does not narrow a single type's populate or relation writes`,
        ),
      );
  }
  return gaps;
};

/** A relation attribute on a built-in type (its own, or an inverse) that leads to a conditioned type. */
const builtinGaps = (
  doc: IrDocument,
  byName: ReadonlyMap<string, ContentType>,
  roleOf: Role,
  mine: readonly string[],
  reachFrom: (key: NodeKey) => Set<string>,
): CapabilityGap[] => {
  const role = roleOf.name;
  const gaps: CapabilityGap[] = [];
  const add = (builtin: ContentType, attribute: string, leadsTo: NodeKey): void => {
    const reached = reachFrom(leadsTo);
    const plugin = BUILTIN_PLUGIN[builtin.builtin!] ?? builtin.builtin!;
    for (const target of mine.filter((t) => reached.has(t)))
      gaps.push(
        gap(
          target,
          role,
          "apiRelationReach",
          `role "${role}" reads "${target}" under a condition, but ${builtin.name}.${attribute} reaches it from a type the ${plugin} plugin serves; the Strapi target cannot narrow that populate`,
        ),
      );
  };
  // The upload plugin serves a file's related entries to a role that reads the media library.
  // A grant on any built-in file type is one on the media library.
  const file = doc.contentTypes.find((ct) => ct.builtin === "file" && readsType(roleOf, ct.name));
  if (file !== undefined) add(file, "related", FILE);
  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "relation") continue;
      const target = byName.get(f.target);
      if (ct.builtin !== undefined && target !== undefined && target.builtin === undefined)
        add(ct, fieldApiName(f), typeKey(target));
      const inverse = inverseApiName(f);
      if (ct.builtin === undefined && target?.builtin !== undefined && inverse !== undefined)
        add(target, inverse, typeKey(ct));
    }
  }
  return gaps;
};
