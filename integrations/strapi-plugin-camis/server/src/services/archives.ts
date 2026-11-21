import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '@strapi/strapi';
import { engine, file, strapi as strapiTransfer } from '@strapi/data-transfer';
import type { Selection } from './camis-client';
import { describeDiff, isBenign, type Diff } from './schema-diffs';
import type { Archives } from './sync';

const { createTransferEngine, DEFAULT_VERSION_STRATEGY, DEFAULT_SCHEMA_STRATEGY } = engine;

const transferred = (uid: string): boolean => !strapiTransfer.isIgnoredOfficialTransferType(uid);

/** What `strapi export` and `strapi import` leave out by default, as their CLI filters it. */
const transforms = {
  links: [
    {
      filter: (link: { left: { type: string }; right: { type: string } }) =>
        transferred(link.left.type) && transferred(link.right.type),
    },
  ],
  entities: [{ filter: (entity: { type: string }) => transferred(entity.type) }],
};

const skips = (selection: Selection, type: 'content' | 'files' | 'config'): boolean =>
  (selection.only !== undefined && !selection.only.includes(type)) || (selection.exclude?.includes(type) ?? false);

const counts = (progress: Record<string, { count?: number } | undefined> | undefined): Record<string, number> =>
  Object.fromEntries(Object.entries(progress ?? {}).map(([stage, data]) => [stage, data?.count ?? 0]));

/** Strapi's own data-transfer engine, as `strapi export --no-encrypt` and `strapi import` drive it. */
export const createArchives = (strapi: Core.Strapi): Archives => ({
  async export(path, selection) {
    const source = strapiTransfer.providers.createLocalStrapiSourceProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
    });
    const destination = file.providers.createLocalFileDestinationProvider({
      file: { path },
      encryption: { enabled: false },
      compression: { enabled: true },
    });
    const transfer = createTransferEngine(source, destination, {
      versionStrategy: 'ignore',
      schemaStrategy: 'ignore',
      ...(selection.only === undefined ? {} : { only: selection.only }),
      ...(selection.exclude === undefined ? {} : { exclude: selection.exclude }),
      transforms,
    } as Parameters<typeof createTransferEngine>[2]);
    const results = await transfer.transfer();
    const written = (results.destination as { file?: { path?: string } } | undefined)?.file?.path ?? `${path}.tar.gz`;
    return { path: written, counts: counts(results.engine) };
  },

  async import(path, selection, { force }) {
    const source = file.providers.createLocalFileSourceProvider({
      file: { path },
      compression: { enabled: true },
      encryption: { enabled: false },
    });
    const ignored = Object.keys(strapi.contentTypes).filter((uid) => !transferred(uid));
    const destination = strapiTransfer.providers.createLocalStrapiDestinationProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
      strategy: 'restore',
      restore: {
        entities: {
          exclude: [...ignored, ...strapiTransfer.getIgnoredOfficialTransferTypes()],
          // As `strapi import` scopes what it deletes first: nothing when no content comes, only the
          // project's own types when the core store does not come either.
          ...(skips(selection, 'content')
            ? { include: [] }
            : skips(selection, 'config')
              ? { include: Object.keys(strapi.contentTypes).filter(transferred) }
              : {}),
        },
        assets: !skips(selection, 'files'),
        configuration: { webhook: !skips(selection, 'config'), coreStore: !skips(selection, 'config') },
      },
    });
    const transfer = createTransferEngine(source, destination, {
      versionStrategy: DEFAULT_VERSION_STRATEGY,
      schemaStrategy: DEFAULT_SCHEMA_STRATEGY,
      ...(selection.only === undefined ? {} : { only: selection.only }),
      ...(selection.exclude === undefined ? {} : { exclude: selection.exclude }),
      transforms,
    } as Parameters<typeof createTransferEngine>[2]);
    const diffs: string[] = [];
    transfer.onSchemaDiff(async (context, next) => {
      const ignored: Record<string, Diff[]> = { ...(context.ignoredDiffs as Record<string, Diff[]>) };
      for (const [uid, list] of Object.entries(context.diffs as Record<string, Diff[]>)) {
        // A type is let through whole or not at all: the engine compares each type's list as one.
        if (force || list.every((diff) => isBenign(uid, diff))) ignored[uid] = list;
        else diffs.push(...list.filter((diff) => !isBenign(uid, diff)).map((diff) => describeDiff(uid, diff)));
      }
      context.ignoredDiffs = ignored as typeof context.ignoredDiffs;
      return next(context);
    });
    try {
      const results = await transfer.transfer();
      return { counts: counts(results.engine), diffs: [] };
    } catch (error) {
      if (!force && diffs.length > 0) return { counts: {}, diffs };
      throw error;
    }
  },

  remove(path) {
    rmSync(path, { force: true });
  },

  temporary(name) {
    return join(tmpdir(), name);
  },
});
