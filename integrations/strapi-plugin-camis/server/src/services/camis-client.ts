import { createWriteStream, openSync, closeSync, readSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Strapi's three transfer data types, as `strapi export --only/--exclude` names them. */
export type DataType = 'content' | 'files' | 'config';

export const DATA_TYPES: readonly DataType[] = ['content', 'files', 'config'];

export interface Selection {
  only?: DataType[];
  exclude?: DataType[];
}

export interface Applied {
  counts: Record<string, number>;
  skipped: Record<string, string>;
}

export interface CamisClientOptions {
  /** The CAMIS app's origin, e.g. https://cms.example.com */
  url: string;
  /** A CAMIS transfer token: push to send, pull to receive. */
  token: string;
  /** Bytes per uploaded chunk; CAMIS takes at most 6 MiB. */
  chunkSize?: number;
  /** How often a failed request is tried again before the transfer gives up. */
  retries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** CAMIS's error envelope `{ data: null, error: { status, name, message, details } }`, as Strapi answers. */
export class CamisError extends Error {
  constructor(
    readonly status: number,
    override readonly name: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_CHUNK = 6 * 1024 * 1024;

/**
 * The HTTP side of a transfer with CAMIS: /admin/transfer/push takes a Strapi export archive in
 * chunks, checks it and applies it; /admin/transfer/pull hands back CAMIS's own archive.
 */
export class CamisClient {
  private readonly base: string;
  private readonly chunkSize: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: CamisClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.chunkSize = Math.min(options.chunkSize ?? 4 * 1024 * 1024, MAX_CHUNK);
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.fetch = options.fetch ?? fetch;
  }

  async start(): Promise<string> {
    const { id } = await this.json<{ id: string }>('POST', '/admin/transfer/push');
    return id;
  }

  /** Sends the file to a new push and answers its id; a chunk whose answer is lost resumes where CAMIS stands. */
  async upload(path: string, onProgress?: (sent: number, total: number) => void): Promise<string> {
    const id = await this.start();
    const total = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      let offset = 0;
      while (offset < total) {
        const length = Math.min(this.chunkSize, total - offset);
        const chunk = Buffer.alloc(length);
        readSync(fd, chunk, 0, length, offset);
        offset = await this.appendChunk(id, offset, chunk);
        onProgress?.(offset, total);
      }
    } catch (error) {
      await this.abort(id).catch(() => undefined);
      throw error;
    } finally {
      closeSync(fd);
    }
    return id;
  }

  /** The schema check `strapi import` makes: what of the archive has nowhere to go in CAMIS. */
  async check(id: string): Promise<string[]> {
    const { diffs } = await this.json<{ diffs: string[] }>('POST', `/admin/transfer/push/${id}/check`);
    return diffs;
  }

  /** Replaces CAMIS's data with the pushed archive's. */
  async apply(id: string, selection: Selection = {}): Promise<Applied> {
    return this.json<Applied>('POST', `/admin/transfer/push/${id}/apply`, selection);
  }

  async abort(id: string): Promise<void> {
    await this.request('DELETE', `/admin/transfer/push/${id}`);
  }

  /** Writes CAMIS's export archive (gzipped, unencrypted) to the path, answering what it counted. */
  async download(path: string, selection: Selection = {}): Promise<Record<string, number>> {
    const query = new URLSearchParams();
    if (selection.only !== undefined) query.set('only', selection.only.join(','));
    if (selection.exclude !== undefined) query.set('exclude', selection.exclude.join(','));
    const search = query.size > 0 ? `?${query.toString()}` : '';
    const response = await this.request('GET', `/admin/transfer/pull${search}`);
    if (response.body === null) throw new CamisError(502, 'ApplicationError', 'CAMIS sent no archive');
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      createWriteStream(path),
    );
    const counts = response.headers.get('x-camis-counts');
    return counts === null ? {} : (JSON.parse(counts) as Record<string, number>);
  }

  private async appendChunk(id: string, offset: number, chunk: Buffer): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { size } = await this.json<{ size: number }>('PUT', `/admin/transfer/push/${id}?offset=${offset}`, chunk);
        return size;
      } catch (error) {
        // A lost answer to a stored chunk: CAMIS says how much it holds, and the next chunk starts there.
        if (error instanceof CamisError && error.name === 'ValidationError' && typeof error.details.size === 'number') {
          if (error.details.size === offset + chunk.length) return error.details.size;
          throw error;
        }
        if (!(error instanceof CamisError) || error.status >= 500) {
          if (attempt >= this.retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  }

  private async json<T>(method: string, path: string, body?: Buffer | object): Promise<T> {
    const response = await this.request(method, path, body);
    const parsed = (await response.json()) as { data: T };
    return parsed.data;
  }

  private async request(method: string, path: string, body?: Buffer | object): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      Accept: 'application/json',
    };
    let payload: string | Uint8Array | undefined;
    if (Buffer.isBuffer(body)) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
    if (!response.ok) throw await CamisClient.failure(response);
    return response;
  }

  private static async failure(response: Response): Promise<CamisError> {
    const text = await response.text();
    try {
      const { error } = JSON.parse(text) as {
        error?: { name?: string; message?: string; details?: Record<string, unknown> };
      };
      if (error !== undefined) {
        return new CamisError(
          response.status,
          error.name ?? 'ApplicationError',
          error.message ?? text,
          error.details ?? {},
        );
      }
    } catch {
      // Not CAMIS's envelope: a proxy's or a host's page, reported as it came.
    }
    return new CamisError(
      response.status,
      'ApplicationError',
      `CAMIS answered ${response.status}: ${text.slice(0, 200)}`,
    );
  }
}
