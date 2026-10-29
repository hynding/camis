import { readFile } from "node:fs/promises";
import type { IrDocument } from "@camis/ir-schema";
import { readStrapiArchive } from "./archive";
import { importStrapiRoles, type ImportedRoles } from "./roles";

/** The IR's roles from a `strapi export` archive on disk; `key` decrypts an `.enc` one. */
export const readStrapiRoles = async (
  archivePath: string,
  document: IrDocument,
  key?: string,
): Promise<ImportedRoles> =>
  importStrapiRoles(readStrapiArchive(await readFile(archivePath), key), document);
