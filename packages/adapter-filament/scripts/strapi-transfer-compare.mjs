#!/usr/bin/env node
// Compares two Strapi export archives (.tar.gz) for what an import restores from them: every
// entity of the expected archive is in the actual one with the same data, and every link joins
// the same entries in the same positions. Ids differ between databases, so entries are named by
// type, documentId, locale and version; timestamps are compared to the second, which is what a
// Laravel timestamp column keeps. What camis does not keep is left out: users-permissions
// permissions (the IR's grants), upload folders, a role's documentId and timestamps, and a plain
// type's publishedAt.
// usage: strapi-transfer-compare.mjs <expected.tar.gz> <actual.tar.gz>
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  console.error("usage: strapi-transfer-compare.mjs <expected.tar.gz> <actual.tar.gz>");
  process.exit(2);
}

const untar = (path) => {
  const archive = gunzipSync(readFileSync(path));
  const files = new Map();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, ""), 8);
    files.set(
      prefix === "" ? name : `${prefix}/${name}`,
      archive.subarray(offset + 512, offset + 512 + size),
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

const SKIPPED = new Set(["plugin::users-permissions.permission", "plugin::upload.folder"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const read = (path) => {
  const files = untar(path);
  const stage = (name) =>
    [...files]
      .filter(([p]) => p.startsWith(`${name}/`) && p.endsWith(".jsonl"))
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, data]) => data.toString("utf8").split("\n"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  const versioned = new Set(
    stage("schemas")
      .filter((s) => s.options?.draftAndPublish === true)
      .map((s) => s.uid),
  );
  const names = new Map(); // "type|id" → entry name
  const entities = new Map();
  for (const { type, id, data } of stage("entities")) {
    if (SKIPPED.has(type)) continue;
    const version = versioned.has(type) ? (data.publishedAt === null ? "draft" : "published") : "";
    const name =
      type === "plugin::users-permissions.role"
        ? `${type}|${data.type}`
        : `${type}|${data.documentId}|${data.locale ?? ""}|${version}`;
    names.set(`${type}|${id}`, name);
    // A role is the IR's, made anew by every build: its name and type are what carry over.
    const kept =
      type === "plugin::users-permissions.role"
        ? { name: data.name, description: data.description, type: data.type }
        : data;
    entities.set(name, normalize(kept, versioned.has(type)));
  }
  const links = [];
  for (const link of stage("links")) {
    if (link.kind === "relation.circular") continue;
    const left = names.get(`${link.left.type}|${link.left.ref}`);
    const right = names.get(`${link.right.type}|${link.right.ref}`);
    if (left === undefined || right === undefined) continue;
    links.push(
      JSON.stringify([
        link.kind,
        left,
        link.left.field ?? null,
        link.left.pos ?? null,
        right,
        link.right.field ?? null,
        link.right.pos ?? null,
      ]),
    );
  }
  const assets = new Map(
    [...files]
      .filter(([p]) => p.startsWith("assets/uploads/"))
      .map(([p, bytes]) => [p, bytes.toString("base64")]),
  );
  const configuration = new Map(
    stage("configuration").map((c) => [
      c.type === "core-store" ? c.value.key : `webhook|${c.value.name}`,
      c.value.value ?? c.value,
    ]),
  );
  return { entities, links: links.sort(), assets, configuration };
};

/** An entry's data as an import restores it: no ids, timestamps to the second. */
function normalize(value, versioned, top = true) {
  if (Array.isArray(value)) return value.map((v) => normalize(v, versioned, false));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (!top && key === "id") continue;
      if (top && key === "publishedAt" && !versioned) continue;
      out[key] = normalize(v, versioned, false);
    }
    return out;
  }
  return typeof value === "string" && ISO.test(value) ? value.replace(/\.\d+Z$/, "Z") : value;
}

const expected = read(expectedPath);
const actual = read(actualPath);
const failures = [];
for (const [name, data] of expected.entities) {
  const ours = actual.entities.get(name);
  if (ours === undefined) failures.push(`missing entity ${name}`);
  else if (JSON.stringify(ours) !== JSON.stringify(data))
    failures.push(
      `entity ${name}\n    want ${JSON.stringify(data)}\n    got  ${JSON.stringify(ours)}`,
    );
}
for (const name of actual.entities.keys())
  if (!expected.entities.has(name)) failures.push(`unexpected entity ${name}`);
const ourLinks = new Set(actual.links);
for (const link of expected.links) if (!ourLinks.has(link)) failures.push(`missing link ${link}`);
const theirLinks = new Set(expected.links);
for (const link of actual.links)
  if (!theirLinks.has(link)) failures.push(`unexpected link ${link}`);
for (const [path, bytes] of expected.assets)
  if (actual.assets.get(path) !== bytes) failures.push(`asset ${path} differs or is missing`);
for (const [key, value] of actual.configuration) {
  const theirs = expected.configuration.get(key);
  if (JSON.stringify(theirs) !== JSON.stringify(value))
    failures.push(
      `configuration ${key}\n    want ${JSON.stringify(theirs)}\n    got  ${JSON.stringify(value)}`,
    );
}
if (failures.length > 0) {
  console.error(`✗ the archives differ:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `✓ same ${expected.entities.size} entities, ${expected.links.length} links, ${expected.assets.size} files` +
    ` and ${actual.configuration.size} settings`,
);
