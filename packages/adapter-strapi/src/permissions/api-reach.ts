import {
  fieldApiName,
  inverseApiName,
  type CapabilityGap,
  type Component,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { componentUid, strapiNames } from "@camis/strapi-schema";
import type { ApiHolder, ApiHolderLink, ApiTypeRules } from "./api-enforcement";
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
type NodeKey = `type:${string}` | `component:${string}` | "file";

const FILE: NodeKey = "file";
const FILE_UID = "plugin::upload.file";

export const typeKey = (ct: { name: string }): NodeKey => `type:${ct.name}`;
const componentKey = (name: string): NodeKey => `component:${name}`;

interface Edge {
  attribute: string;
  link: "relation" | "component" | "zone" | "media";
  targets: NodeKey[];
}

interface Node {
  uid: string;
  /** `Type.field` names, by attribute, for messages. */
  owner: string;
  populatable: string[];
  edges: Edge[];
}

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
        return target === undefined || target.builtin !== undefined
          ? []
          : [{ attribute, link: "relation", targets: [typeKey(target)] }];
      }
      if (f.type === "component")
        return [{ attribute, link: "component", targets: [componentKey(f.component)] }];
      if (f.type === "dynamicZone")
        return [{ attribute, link: "zone", targets: f.components.map(componentKey) }];
      if (f.type === "media") return [{ attribute, link: "media", targets: [FILE] }];
      return [];
    });
  const populatable = (fields: readonly Field[]): string[] =>
    fields.filter((f) => POPULATABLE.has(f.type)).map(fieldApiName);
  for (const ct of doc.contentTypes) {
    if (ct.builtin !== undefined) continue;
    nodes.set(typeKey(ct), {
      uid: strapiNames(ct).uid,
      owner: ct.name,
      populatable: [
        ...populatable(ct.fields),
        ...(ct.options?.localized === true ? ["localizations"] : []),
      ],
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
      edges: fieldEdges(c.fields),
    });
  }
  // A relation's inverse is an attribute of its target that leads back to the relation's owner.
  for (const ct of doc.contentTypes) {
    if (ct.builtin !== undefined) continue;
    for (const f of ct.fields) {
      const inverse = f.type === "relation" ? inverseApiName(f) : undefined;
      if (f.type !== "relation" || inverse === undefined) continue;
      const target = nodes.get(`type:${f.target}`);
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
    edges: [{ attribute: "related", link: "relation", targets: attached }],
  });
  for (const node of nodes.values()) node.populatable = [...new Set(node.populatable)].sort();
  return nodes;
};

/** For each node, the conditioned types (by name) a path of one edge or more leads to. */
const reachOf = (
  nodes: ReadonlyMap<NodeKey, Node>,
  conditioned: ReadonlySet<string>,
): Map<NodeKey, Set<string>> => {
  const reach = new Map<NodeKey, Set<string>>([...nodes.keys()].map((k) => [k, new Set()]));
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

/** The holder entries of the reaching nodes: each link that leads on towards a conditioned type. */
const holdersOf = (
  nodes: ReadonlyMap<NodeKey, Node>,
  reach: ReadonlyMap<NodeKey, Set<string>>,
  conditioned: ReadonlySet<string>,
): Record<string, ApiHolder> => {
  const leads = (target: NodeKey): boolean =>
    (reach.get(target)?.size ?? 0) > 0 ||
    (target.startsWith("type:") && conditioned.has(target.slice(5)));
  const uid = (key: NodeKey): string => nodes.get(key)!.uid;
  const holders: [string, ApiHolder][] = [];
  for (const [key, node] of nodes) {
    // The file has no controller of camis's: its reach is a build error instead.
    if (key === FILE || (reach.get(key)?.size ?? 0) === 0) continue;
    const links: [string, ApiHolderLink][] = [];
    for (const edge of node.edges) {
      const targets = edge.targets.filter(leads);
      if (targets.length === 0) continue;
      if (edge.link === "media") links.push([edge.attribute, { media: true }]);
      else if (edge.link === "zone") links.push([edge.attribute, { zone: targets.map(uid) }]);
      else if (edge.link === "component")
        links.push([edge.attribute, { component: uid(targets[0]!) }]);
      else links.push([edge.attribute, { relation: uid(targets[0]!) }]);
    }
    links.sort(([a], [b]) => codePointOrder(a, b));
    holders.push([node.uid, { populatable: node.populatable, links: Object.fromEntries(links) }]);
  }
  holders.sort(([a], [b]) => codePointOrder(a, b));
  return Object.fromEntries(holders);
};

/** The components a type embeds, at any depth, through components and dynamic zones. */
const embedded = (doc: IrDocument, fields: readonly Field[]): Component[] => {
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

export interface ApiReach {
  holders: Record<string, ApiHolder>;
  /** The nodes that reach a conditioned type. */
  reaching: ReadonlySet<NodeKey>;
  gaps: CapabilityGap[];
}

/**
 * The reach of every type some non-admin role reads under a condition, and the errors for a
 * reach the generated controllers cannot narrow: a polymorphic relation (which may point at any
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
  const reach = reachOf(nodes, conditioned);
  const reachFrom = (key: NodeKey): Set<string> => {
    const out = new Set(reach.get(key) ?? []);
    if (key.startsWith("type:") && conditioned.has(key.slice(5))) out.add(key.slice(5));
    return out;
  };
  const gaps: CapabilityGap[] = [];
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));

  for (const role of nonAdmin) {
    const mine = [...conditionedFor.get(role.name)!].sort();
    if (mine.length === 0) continue;
    for (const ct of doc.contentTypes) {
      if (ct.builtin !== undefined || !readsType(role, ct.name)) continue;
      gaps.push(...polymorphicGaps(doc, role.name, ct, mine, reachFrom));
      if (ct.kind === "single") gaps.push(...singleGaps(role.name, ct, mine, nodes, reachFrom));
    }
    gaps.push(...builtinGaps(doc, byName, role, mine, reachFrom));
  }

  return {
    holders: holdersOf(nodes, reach, conditioned),
    reaching: new Set(
      [...reach].filter(([key, s]) => key !== FILE && s.size > 0).map(([key]) => key),
    ),
    gaps,
  };
};

/** A polymorphic relation of a type the role reads (or of a component it embeds). */
const polymorphicGaps = (
  doc: IrDocument,
  role: string,
  ct: ContentType,
  mine: readonly string[],
  reachFrom: (key: NodeKey) => Set<string>,
): CapabilityGap[] => {
  const owners: { owner: string; fields: readonly Field[] }[] = [
    { owner: ct.name, fields: ct.fields },
    ...embedded(doc, ct.fields).map((c) => ({ owner: c.name, fields: c.fields })),
  ];
  const gaps: CapabilityGap[] = [];
  for (const { owner, fields } of owners) {
    for (const f of fields) {
      let targets: readonly string[] = [];
      if (f.type === "polymorphicRelation") targets = mine;
      else if (f.type === "polymorphicInverse") {
        const reached = reachFrom(`type:${f.target}`);
        targets = mine.filter((t) => reached.has(t));
      }
      for (const target of targets)
        gaps.push(
          gap(
            ct.name,
            role,
            "apiPolymorphicReach",
            `role "${role}" reads "${ct.name}", whose polymorphic relation ${owner}.${f.name} can reach "${target}", which it reads under a condition; the Strapi target cannot narrow a polymorphic populate or write`,
          ),
        );
    }
  }
  return gaps;
};

/** A single type's reach, which Strapi's own single-type controller serves unnarrowed. */
const singleGaps = (
  role: string,
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
          `role "${role}" reads single type "${ct.name}", which reaches "${target}" (read under a condition) through ${ct.name}.${edge.attribute}; the Strapi target does not narrow a single type's populate or relation writes`,
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
  const file = doc.contentTypes.find((ct) => ct.builtin === "file");
  if (file !== undefined && readsType(roleOf, file.name)) add(file, "related", FILE);
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
