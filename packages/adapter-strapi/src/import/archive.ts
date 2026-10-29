import { createDecipheriv, scryptSync } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** One record of an archive's `entities/*.jsonl`: an entry of a content type, by its archived id. */
export interface ArchivedEntity {
  type: string;
  id: number | string;
  data: Record<string, unknown>;
}

/** One end of an archived link: the entry and the attribute it is listed under. */
export interface ArchivedLinkEnd {
  type: string;
  ref: number | string;
  field?: string;
  pos?: number;
}

/** One record of an archive's `links/*.jsonl`; `relation.basic` lists the declaring side left. */
export interface ArchivedLink {
  kind: string;
  relation?: string;
  left: ArchivedLinkEnd;
  right: ArchivedLinkEnd;
}

/** The records of a `strapi export` archive this importer reads. */
export interface StrapiArchive {
  entities: ArchivedEntity[];
  links: ArchivedLink[];
  configuration: Record<string, unknown>[];
}

const GZIP = [0x1f, 0x8b];

const isGzip = (bytes: Uint8Array): boolean => bytes[0] === GZIP[0] && bytes[1] === GZIP[1];

/** Strapi's `-k`: AES-128-ECB under scrypt(key, '', 16) with its default cost. */
const decrypt = (bytes: Uint8Array, key: string): Buffer => {
  const decipher = createDecipheriv("aes-128-ecb", scryptSync(key, "", 16), null);
  try {
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  } catch {
    throw new Error("the archive cannot be decrypted with this key");
  }
};

const text = (header: Buffer, start: number, length: number): string =>
  header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");

/** The files of a tar stream by path: ustar headers, with GNU and pax long names. */
const untar = (tar: Buffer): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
    } else if (type === "x") {
      longName = /^\d+ path=(.*)$/m.exec(data.toString("utf8"))?.[1] ?? longName;
    } else if (type === "0" || type === "\0") {
      const prefix = text(header, 345, 155);
      const name = text(header, 0, 100);
      const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
      files.set(path.replace(/^\.\//, ""), data);
      longName = undefined;
    }
  }
  return files;
};

/**
 * Reads an archive `strapi export` wrote (`.tar`, `.tar.gz`, `.tar.gz.enc`): its entities, links
 * and configuration, each stage's jsonl files in order.
 */
export const readStrapiArchive = (bytes: Uint8Array, key?: string): StrapiArchive => {
  let plain: Buffer = Buffer.from(bytes);
  if (!isGzip(plain) && key !== undefined) plain = decrypt(plain, key);
  if (isGzip(plain)) plain = gunzipSync(plain);
  const files = untar(plain);
  if (!files.has("metadata.json")) {
    throw new Error(
      key === undefined
        ? "not a Strapi export archive (if it is encrypted, give its key)"
        : "not a Strapi export archive",
    );
  }
  const stage = <T>(name: string): T[] =>
    [...files]
      .filter(([path]) => path.startsWith(`${name}/`) && path.endsWith(".jsonl"))
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, data]) => data.toString("utf8").split(/\r?\n/))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  return {
    entities: stage<ArchivedEntity>("entities"),
    links: stage<ArchivedLink>("links"),
    configuration: stage<Record<string, unknown>>("configuration"),
  };
};
