import { createCipheriv, scryptSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readStrapiArchive } from "./archive";

/** A ustar archive of the given files, as `strapi export` writes one (names under 100 bytes). */
const tar = (files: Record<string, string>): Buffer => {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
};

const encrypt = (bytes: Buffer, key: string): Buffer => {
  const cipher = createCipheriv("aes-128-ecb", scryptSync(key, "", 16), null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};

const archive = tar({
  "metadata.json": '{"strapi":{"version":"5.56.0"}}',
  "entities/entities_00001.jsonl":
    '{"type":"plugin::users-permissions.role","id":1,"data":{"type":"public"}}\n' +
    '{"type":"plugin::users-permissions.permission","id":7,"data":{"action":"api::book.book.find"}}\n',
  "links/links_00001.jsonl":
    '{"kind":"relation.basic","relation":"manyToOne","left":{"type":"plugin::users-permissions.permission","field":"role","ref":7},"right":{"type":"plugin::users-permissions.role","field":"permissions","ref":1,"pos":1}}\n',
  "configuration/configuration_00001.jsonl":
    '{"type":"core-store","value":{"key":"plugin_i18n_default_locale","value":"en"}}\n',
});

describe("readStrapiArchive", () => {
  const expected = {
    entities: [
      { type: "plugin::users-permissions.role", id: 1, data: { type: "public" } },
      {
        type: "plugin::users-permissions.permission",
        id: 7,
        data: { action: "api::book.book.find" },
      },
    ],
    links: [
      {
        kind: "relation.basic",
        relation: "manyToOne",
        left: { type: "plugin::users-permissions.permission", field: "role", ref: 7 },
        right: { type: "plugin::users-permissions.role", field: "permissions", ref: 1, pos: 1 },
      },
    ],
    configuration: [
      { type: "core-store", value: { key: "plugin_i18n_default_locale", value: "en" } },
    ],
  };

  it("reads a plain, a compressed and an encrypted archive alike", () => {
    expect(readStrapiArchive(archive)).toEqual(expected);
    expect(readStrapiArchive(gzipSync(archive))).toEqual(expected);
    expect(readStrapiArchive(encrypt(gzipSync(archive), "secret"), "secret")).toEqual(expected);
  });

  it("refuses an encrypted archive without its key, and with another", () => {
    const encrypted = encrypt(gzipSync(archive), "secret");
    expect(() => readStrapiArchive(encrypted)).toThrow(/give its key/);
    expect(() => readStrapiArchive(encrypted, "other")).toThrow(/cannot be decrypted/);
  });

  it("refuses a tar without Strapi's metadata.json", () => {
    expect(() => readStrapiArchive(gzipSync(tar({ "notes.txt": "hi" })))).toThrow(
      /not a Strapi export archive/,
    );
  });
});
