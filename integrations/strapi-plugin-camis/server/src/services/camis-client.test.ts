import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CamisClient, CamisError } from './camis-client';

/**
 * A stand-in for a CAMIS app's /admin/transfer/push and /admin/transfer/pull, answering as the
 * generated StrapiTransferPush and StrapiTransferPull controllers do.
 */
class FakeCamis {
  readonly uploads = new Map<string, Buffer>();
  readonly applied: Array<{ id: string; body: unknown }> = [];
  readonly requests: string[] = [];
  /** Fails the next n chunk PUTs after storing them, as a dropped response does. */
  dropAfterStore = 0;
  diffs: string[] = [];
  pullArchive = Buffer.from('pulled-archive');
  private server: Server | undefined;
  private next = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const error = (status: number, name: string, message: string, details: object = {}) =>
      json(status, { data: null, error: { status, name, message, details } });
    if (req.headers.authorization !== 'Bearer push-pull-key') {
      return error(401, 'UnauthorizedError', 'Missing or invalid credentials');
    }
    const match = url.pathname.match(/^\/admin\/transfer\/push(?:\/([0-9a-f]{32}))?(\/check|\/apply)?$/);
    if (req.method === 'GET' && url.pathname === '/admin/transfer/pull') {
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'x-camis-counts': JSON.stringify({ entities: 3 }),
      });
      return void res.end(this.pullArchive);
    }
    if (match === null) return error(404, 'NotFoundError', 'Not Found');
    const [, id, action] = match;
    if (id === undefined && req.method === 'POST') {
      const made = (this.next++).toString(16).padStart(32, '0');
      this.uploads.set(made, Buffer.alloc(0));
      return json(201, { data: { id: made, size: 0 } });
    }
    const upload = id === undefined ? undefined : this.uploads.get(id);
    if (id === undefined || upload === undefined) return error(404, 'NotFoundError', 'No such push');
    if (req.method === 'PUT' && action === undefined) {
      if (Number(url.searchParams.get('offset')) !== upload.length) {
        return error(400, 'ValidationError', 'offset must be the bytes received so far', {
          size: upload.length,
        });
      }
      this.uploads.set(id, Buffer.concat([upload, body]));
      if (this.dropAfterStore > 0) {
        this.dropAfterStore--;
        return void res.destroy();
      }
      return json(200, { data: { id, size: upload.length + body.length } });
    }
    if (req.method === 'POST' && action === '/check') return json(200, { data: { diffs: this.diffs } });
    if (req.method === 'POST' && action === '/apply') {
      if (this.diffs.length > 0) {
        return error(400, 'ValidationError', 'The source and destination provide incompatible schemas', {
          diffs: this.diffs,
        });
      }
      this.applied.push({ id, body: body.length > 0 ? JSON.parse(body.toString()) : {} });
      this.uploads.delete(id);
      return json(200, { data: { counts: { entities: 2, links: 1 }, skipped: {} } });
    }
    if (req.method === 'DELETE') {
      this.uploads.delete(id);
      res.writeHead(204);
      return void res.end();
    }
    return error(405, 'MethodNotAllowedError', 'Method Not Allowed');
  }
}

describe('CamisClient', () => {
  const camis = new FakeCamis();
  let url: string;
  let dir: string;

  beforeEach(async () => {
    url = await camis.start();
    dir = mkdtempSync(join(tmpdir(), 'camis-client-'));
  });
  afterEach(() => camis.stop());

  const client = (options: Partial<ConstructorParameters<typeof CamisClient>[0]> = {}) =>
    new CamisClient({ url: `${url}/`, token: 'push-pull-key', chunkSize: 4, retries: 2, retryDelayMs: 1, ...options });

  it('uploads an archive in chunks of the configured size and reports progress', async () => {
    const file = join(dir, 'export.tar.gz');
    writeFileSync(file, 'abcdefghij');
    const seen: number[] = [];
    const id = await client().upload(file, (sent) => seen.push(sent));
    expect(camis.uploads.get(id)?.toString()).toBe('abcdefghij');
    expect(seen).toEqual([4, 8, 10]);
    expect(camis.requests.filter((r) => r.startsWith('PUT'))).toEqual([
      `PUT /admin/transfer/push/${id}?offset=0`,
      `PUT /admin/transfer/push/${id}?offset=4`,
      `PUT /admin/transfer/push/${id}?offset=8`,
    ]);
  });

  it('resumes from the size CAMIS holds when a chunk was stored but its answer was lost', async () => {
    const file = join(dir, 'export.tar.gz');
    writeFileSync(file, 'abcdefghij');
    camis.dropAfterStore = 1;
    const id = await client().upload(file);
    expect(camis.uploads.get(id)?.toString()).toBe('abcdefghij');
  });

  it('checks and applies a push, sending only and exclude', async () => {
    const file = join(dir, 'export.tar.gz');
    writeFileSync(file, 'abc');
    const id = await client().upload(file);
    expect(await client().check(id)).toEqual([]);
    expect(await client().apply(id, { exclude: ['files'] })).toEqual({
      counts: { entities: 2, links: 1 },
      skipped: {},
    });
    expect(camis.applied).toEqual([{ id, body: { exclude: ['files'] } }]);
  });

  it("raises CAMIS's error envelope, with its name and details", async () => {
    camis.diffs = ['api::article.article: no such content type here'];
    const file = join(dir, 'export.tar.gz');
    writeFileSync(file, 'abc');
    const id = await client().upload(file);
    const failure = await client()
      .apply(id)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CamisError);
    expect(failure).toMatchObject({
      status: 400,
      name: 'ValidationError',
      message: 'The source and destination provide incompatible schemas',
      details: { diffs: camis.diffs },
    });
    camis.diffs = [];
  });

  it('refuses a wrong token as CAMIS does', async () => {
    await expect(client({ token: 'wrong' }).start()).rejects.toMatchObject({
      status: 401,
      name: 'UnauthorizedError',
    });
  });

  it('aborts a push', async () => {
    const id = await client().start();
    await client().abort(id);
    expect(camis.uploads.has(id)).toBe(false);
  });

  it('downloads a pull to a file, with what CAMIS counted', async () => {
    const file = join(dir, 'pulled.tar.gz');
    const counts = await client().download(file, { only: ['content', 'files'] });
    expect(readFileSync(file).toString()).toBe('pulled-archive');
    expect(counts).toEqual({ entities: 3 });
    expect(camis.requests.at(-1)).toBe('GET /admin/transfer/pull?only=content%2Cfiles');
  });
});
