import { CamisClient, CamisError, type Applied, type Selection } from './camis-client';

export type Direction = 'push' | 'pull';

export type Stage = 'exporting' | 'uploading' | 'checking' | 'applying' | 'downloading' | 'importing';

export interface PluginConfig {
  url: string;
  token: string;
  chunkSize: number;
}

/** One push or pull, as the admin page and the CLI show it, and as the history keeps it. */
export interface Transfer {
  direction: Direction;
  selection: Selection;
  state: 'running' | 'done' | 'failed';
  stage?: Stage;
  /** Bytes sent or received so far, and of how many, while uploading. */
  progress?: { done: number; total: number };
  counts?: Record<string, number>;
  skipped?: Record<string, string>;
  diffs?: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Archives {
  /** Writes this project's data as a gzipped, unencrypted Strapi export archive. */
  export(path: string, selection: Selection): Promise<{ path: string; counts: Record<string, number> }>;
  /** Restores an archive into this project, as `strapi import` does; diffs it refused on when not forced. */
  import(
    path: string,
    selection: Selection,
    options: { force: boolean },
  ): Promise<{ counts: Record<string, number>; diffs: string[] }>;
  remove(path: string): void;
  temporary(name: string): string;
}

export type Client = Pick<CamisClient, 'upload' | 'check' | 'apply' | 'abort' | 'download'>;

export interface SyncDependencies {
  config(): PluginConfig;
  store: { get(): Promise<Transfer[] | null | undefined>; set(value: Transfer[]): Promise<void> };
  archives: Archives;
  client(config: PluginConfig): Client;
  now(): Date;
}

const HISTORY = 20;

const SCHEMA_HINT =
  'Part of this project has nowhere to go in CAMIS. CAMIS builds its code from the content model, so update it there ' +
  'first (`camis import strapi <this project>`, then regenerate and deploy), and push again.';

const describe = (error: unknown): string => {
  if (error instanceof CamisError) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/**
 * Push and pull between this Strapi project and CAMIS, one transfer at a time: push writes a
 * Strapi export archive and hands it to CAMIS's archive import; pull fetches CAMIS's archive and
 * restores it here as `strapi import` does.
 */
export const createSync = (deps: SyncDependencies) => {
  let running: Transfer | undefined;
  let finished: Promise<Transfer> = Promise.resolve(undefined as unknown as Transfer);

  const missing = (): string[] => {
    const config = deps.config();
    return (['url', 'token'] as const).filter((key) => config[key] === '');
  };

  const record = async (transfer: Transfer): Promise<void> => {
    const history = (await deps.store.get()) ?? [];
    await deps.store.set([transfer, ...history].slice(0, HISTORY));
  };

  const push = async (transfer: Transfer, client: Client): Promise<void> => {
    transfer.stage = 'exporting';
    const archive = await deps.archives.export(deps.archives.temporary(`camis-push-${Date.now()}`), transfer.selection);
    try {
      transfer.stage = 'uploading';
      const id = await client.upload(archive.path, (done, total) => {
        transfer.progress = { done, total };
      });
      transfer.stage = 'checking';
      const diffs = await client.check(id);
      if (diffs.length > 0) {
        await client.abort(id);
        transfer.diffs = diffs;
        throw new Error(SCHEMA_HINT);
      }
      transfer.stage = 'applying';
      const applied: Applied = await client.apply(id, transfer.selection);
      transfer.counts = applied.counts;
      transfer.skipped = applied.skipped;
    } finally {
      deps.archives.remove(archive.path);
    }
  };

  const pull = async (transfer: Transfer, client: Client, force: boolean): Promise<void> => {
    const path = deps.archives.temporary(`camis-pull-${Date.now()}.tar.gz`);
    try {
      transfer.stage = 'downloading';
      await client.download(path, transfer.selection);
      transfer.stage = 'importing';
      const imported = await deps.archives.import(path, transfer.selection, { force });
      if (imported.diffs.length > 0) {
        transfer.diffs = imported.diffs;
        throw new Error(
          "CAMIS's content model differs from this project's, and the data listed would be lost: pull again with force to accept that.",
        );
      }
      transfer.counts = imported.counts;
    } finally {
      deps.archives.remove(path);
    }
  };

  const execute = async (transfer: Transfer, force: boolean): Promise<Transfer> => {
    try {
      const client = deps.client(deps.config());
      if (transfer.direction === 'push') await push(transfer, client);
      else await pull(transfer, client, force);
      transfer.state = 'done';
    } catch (error) {
      transfer.state = 'failed';
      transfer.error = describe(error);
    } finally {
      delete transfer.stage;
      transfer.finishedAt = deps.now().toISOString();
      running = undefined;
    }
    await record(transfer);
    return transfer;
  };

  const begin = (direction: Direction, selection: Selection): Transfer => {
    const absent = missing();
    if (absent.length > 0) throw new Error(`Set ${absent.join(' and ')} in config/plugins (camis.config) first`);
    if (running !== undefined) throw new Error(`A ${running.direction} is already running`);
    running = { direction, selection, state: 'running', startedAt: deps.now().toISOString() };
    return running;
  };

  return {
    status: () => {
      const absent = missing();
      return { configured: absent.length === 0, missing: absent, running };
    },
    current: (): Transfer | undefined => running,
    history: async (): Promise<Transfer[]> => (await deps.store.get()) ?? [],

    /** Starts a transfer and answers at once; current() follows it, history() keeps it once it ends. */
    start(direction: Direction, selection: Selection, options: { force?: boolean } = {}): Transfer {
      const transfer = begin(direction, selection);
      finished = execute(transfer, options.force ?? false);
      return transfer;
    },

    /** Runs a transfer to its end. */
    async run(direction: Direction, selection: Selection, options: { force?: boolean } = {}): Promise<Transfer> {
      return execute(begin(direction, selection), options.force ?? false);
    },

    settled: (): Promise<Transfer> => finished,

    /** The schema check alone: a config-only archive is sent, checked, and dropped. */
    async check(): Promise<{ diffs: string[] }> {
      const absent = missing();
      if (absent.length > 0) throw new Error(`Set ${absent.join(' and ')} in config/plugins (camis.config) first`);
      const client = deps.client(deps.config());
      const archive = await deps.archives.export(deps.archives.temporary(`camis-check-${Date.now()}`), {
        only: ['config'],
      });
      try {
        const id = await client.upload(archive.path);
        try {
          return { diffs: await client.check(id) };
        } finally {
          await client.abort(id);
        }
      } finally {
        deps.archives.remove(archive.path);
      }
    },
  };
};

export type Sync = ReturnType<typeof createSync>;
