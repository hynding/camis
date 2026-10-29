import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// `strapi:import` refuses an archive whose data would have nowhere to go. A migrated project
// lacks what camis cannot represent yet (getstarted's password, customField and morph
// attributes), and its inverse relations hold no data of their own, so the check looks at the
// archive's data, not only at its schemas.
const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** An uncompressed ustar archive of the given files. */
const tar = (files: Record<string, string>): Buffer => {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((acc, byte) => acc + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
};

const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n");

const POST_SCHEMA = {
  uid: "api::post.post",
  attributes: {
    title: { type: "string" },
    views: { type: "integer" },
    secret: { type: "password" },
    color: { type: "customField", customField: "plugin::color-picker.color" },
    tags: { type: "relation", relation: "manyToMany", target: "api::tag.tag", mappedBy: "posts" },
    taggable: { type: "relation", relation: "morphToOne" },
    mentions: { type: "relation", relation: "morphMany", morphBy: "taggable" },
  },
};

describe.skipIf(!hasPhp())("strapi:import's schema check", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "camis-transfer-check-"));
    const result = filamentAdapter.generate(strapiApiBundle, {
      projectName: "oyl",
      apiStyle: "strapi",
    });
    for (const file of ["StrapiImport.php", "StrapiTransferMap.php"]) {
      const content = result.files.find((f) => f.path === `app/Support/${file}`)!.content;
      writeFileSync(join(dir, file), content);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const diffs = (
    entities: unknown[],
    links: unknown[] = [],
    schemas: unknown[] = [POST_SCHEMA],
  ) => {
    const archive = join(dir, "export.tar");
    writeFileSync(
      archive,
      tar({
        "metadata.json": "{}",
        "schemas/schemas_00001.jsonl": jsonl(schemas),
        "entities/entities_00001.jsonl": jsonl(entities),
        "links/links_00001.jsonl": jsonl(links),
      }),
    );
    const script = `require '${dir}/StrapiTransferMap.php'; require '${dir}/StrapiImport.php';
      echo json_encode(App\\Support\\StrapiImport::open('${archive}')->schemaDiffs());`;
    return JSON.parse(execFileSync("php", ["-r", script], { encoding: "utf8" })) as string[];
  };

  it("passes attributes this project lacks while the archive holds no value for them", () => {
    expect(diffs([{ type: "api::post.post", id: 1, data: { title: "a", secret: null } }])).toEqual(
      [],
    );
  });

  it("passes inverse relations, whose links Strapi exports from the owning side", () => {
    // The owning side's link names the inverse as its right field.
    const owning = {
      kind: "relation.basic",
      relation: "manyToMany",
      left: { type: "api::tag.tag", ref: 1, field: "posts" },
      right: { type: "api::post.post", ref: 1, field: "tags" },
    };
    const tag = { uid: "api::tag.tag", attributes: { label: { type: "string" } } };
    expect(diffs([], [owning], [POST_SCHEMA, tag])).toEqual([]);
  });

  it("refuses an attribute this project lacks once an entity holds a value for it", () => {
    expect(
      diffs([
        { type: "api::post.post", id: 1, data: { title: "a", secret: "$2a$10$hash" } },
        { type: "api::post.post", id: 2, data: { title: "b", color: "#ff0000" } },
      ]),
    ).toEqual([
      "api::post.post.secret is in the archive but not in this project",
      "api::post.post.color is in the archive but not in this project",
    ]);
  });

  it("refuses a relation this project lacks once a link uses it, from either side", () => {
    const morph = {
      kind: "relation.morph",
      relation: "morphToOne",
      left: { type: "api::post.post", ref: 1, field: "taggable" },
      right: { type: "api::post.post", ref: 2 },
    };
    expect(diffs([], [morph])).toEqual([
      "api::post.post.taggable is in the archive but not in this project",
    ]);
  });

  it("passes a content type this project lacks while the archive holds no entity of it", () => {
    expect(
      diffs([], [], [POST_SCHEMA, { uid: "api::kitchensink.kitchensink", attributes: {} }]),
    ).toEqual([]);
  });
});
