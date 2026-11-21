import { describe, expect, it } from 'vitest';
import { CamisError, type Applied, type Selection } from './camis-client';
import { createSync, type SyncDependencies, type Transfer } from './sync';

/** A sync over fakes: an in-memory store, archives that write nothing, and a scripted CAMIS. */
const fakes = (overrides: Partial<SyncDependencies> = {}) => {
  const calls: string[] = [];
  let history: Transfer[] = [];
  const deps: SyncDependencies = {
    config: () => ({ url: 'https://cms.example.test', token: 'key', chunkSize: 4 }),
    store: {
      get: async () => history,
      set: async (value) => {
        history = value;
      },
    },
    archives: {
      export: async (_path, selection: Selection) => {
        calls.push(`export ${JSON.stringify(selection)}`);
        return { path: '/tmp/out.tar.gz', counts: { entities: 5 } };
      },
      import: async (path, selection: Selection, options) => {
        calls.push(`import ${path} ${JSON.stringify(selection)} force=${options.force}`);
        return { counts: { entities: 4 }, diffs: [] };
      },
      remove: (path) => calls.push(`remove ${path}`),
      temporary: (name) => `/tmp/${name}`,
    },
    client: () => ({
      upload: async (_path, onProgress) => {
        calls.push('upload');
        onProgress?.(10, 10);
        return 'abc';
      },
      check: async () => {
        calls.push('check');
        return [];
      },
      apply: async (_id: string, selection?: Selection): Promise<Applied> => {
        calls.push(`apply ${JSON.stringify(selection)}`);
        return { counts: { entities: 5 }, skipped: {} };
      },
      abort: async () => {
        calls.push('abort');
      },
      download: async (path: string, selection?: Selection) => {
        calls.push(`download ${path} ${JSON.stringify(selection)}`);
        return { entities: 4 };
      },
    }),
    now: () => new Date('2026-11-21T00:00:00Z'),
    ...overrides,
  };
  return { deps, calls, history: () => history };
};

describe('sync', () => {
  it('pushes: exports, uploads, checks, applies, cleans up and records the transfer', async () => {
    const { deps, calls, history } = fakes();
    const transfer = await createSync(deps).run('push', { exclude: ['files'] });
    expect(calls).toEqual([
      'export {"exclude":["files"]}',
      'upload',
      'check',
      'apply {"exclude":["files"]}',
      'remove /tmp/out.tar.gz',
    ]);
    expect(transfer).toMatchObject({
      direction: 'push',
      state: 'done',
      selection: { exclude: ['files'] },
      counts: { entities: 5 },
      startedAt: '2026-11-21T00:00:00.000Z',
    });
    expect(history()).toEqual([transfer]);
  });

  it('stops before applying when CAMIS has nowhere to put part of the archive, and says what', async () => {
    const { deps, calls } = fakes();
    const client = deps.client(deps.config());
    deps.client = () => ({ ...client, check: async () => ['api::article.article: no such content type here'] });
    const transfer = await createSync(deps).run('push', {});
    expect(transfer.state).toBe('failed');
    expect(transfer.diffs).toEqual(['api::article.article: no such content type here']);
    expect(transfer.error).toContain('camis import strapi');
    expect(calls).toContain('abort');
    expect(calls.some((c) => c.startsWith('apply'))).toBe(false);
    expect(calls).toContain('remove /tmp/out.tar.gz');
  });

  it("records CAMIS's refusal as the transfer's error", async () => {
    const { deps } = fakes();
    deps.client = () => ({
      ...fakes().deps.client(deps.config()),
      upload: async () => {
        throw new CamisError(403, 'ForbiddenError', 'Forbidden');
      },
    });
    const transfer = await createSync(deps).run('push', {});
    expect(transfer).toMatchObject({ state: 'failed', error: 'ForbiddenError: Forbidden' });
  });

  it('pulls: downloads, imports, cleans up', async () => {
    const { deps, calls } = fakes();
    const transfer = await createSync(deps).run('pull', { only: ['content'] }, { force: true });
    expect(calls).toEqual([
      expect.stringMatching(/^download \/tmp\/camis-pull-\d+\.tar\.gz \{"only":\["content"\]\}$/),
      expect.stringMatching(/^import \/tmp\/camis-pull-\d+\.tar\.gz \{"only":\["content"\]\} force=true$/),
      expect.stringMatching(/^remove \/tmp\/camis-pull-\d+\.tar\.gz$/),
    ]);
    expect(transfer).toMatchObject({ direction: 'pull', state: 'done', counts: { entities: 4 } });
  });

  it("refuses a pull whose schema differs from this project's unless forced", async () => {
    const { deps } = fakes();
    deps.archives = {
      ...deps.archives,
      import: async () => ({ counts: {}, diffs: ['api::page.page does not exist on destination'] }),
    };
    const transfer = await createSync(deps).run('pull', {});
    expect(transfer).toMatchObject({ state: 'failed', diffs: ['api::page.page does not exist on destination'] });
  });

  it('checks the schema with a config-only archive and never applies it', async () => {
    const { deps, calls, history } = fakes();
    expect(await createSync(deps).check()).toEqual({ diffs: [] });
    expect(calls).toEqual(['export {"only":["config"]}', 'upload', 'check', 'abort', 'remove /tmp/out.tar.gz']);
    expect(history()).toEqual([]);
  });

  it('runs one transfer at a time, and start() answers at once with the running transfer', async () => {
    let release: () => void = () => undefined;
    const { deps } = fakes();
    deps.archives = {
      ...deps.archives,
      export: () =>
        new Promise((resolve) => {
          release = () => resolve({ path: '/tmp/out.tar.gz', counts: {} });
        }),
    };
    const sync = createSync(deps);
    const started = sync.start('push', {});
    expect(started.state).toBe('running');
    expect(sync.current()?.stage).toBe('exporting');
    expect(() => sync.start('pull', {})).toThrow('A push is already running');
    release();
    await sync.settled();
    expect(sync.current()).toBeUndefined();
    expect((await sync.history())[0]?.state).toBe('done');
  });

  it('keeps the last 20 transfers, newest first', async () => {
    const { deps, history } = fakes();
    const sync = createSync(deps);
    for (let i = 0; i < 22; i++) await sync.run('push', {});
    expect(history()).toHaveLength(20);
  });

  it('says what is missing before trying a transfer that is not configured', async () => {
    const { deps } = fakes({ config: () => ({ url: '', token: '', chunkSize: 4 }) });
    const sync = createSync(deps);
    expect(sync.status()).toEqual({ configured: false, missing: ['url', 'token'], running: undefined });
    expect(() => sync.start('push', {})).toThrow('Set url and token in config/plugins');
  });
});
