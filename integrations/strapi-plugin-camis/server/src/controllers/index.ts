import type { Core } from '@strapi/strapi';
import { CamisError, DATA_TYPES, type DataType, type Selection } from '../services/camis-client';
import type { Sync } from '../services/sync';

type Context = {
  request: { body?: unknown };
  body: unknown;
  status: number;
  badRequest(message: string, details?: object): void;
};

const sync = (strapi: Core.Strapi): Sync => strapi.plugin('camis').service('sync') as Sync;

const types = (value: unknown, key: string): DataType[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((type) => !DATA_TYPES.includes(type as DataType))) {
    throw new Error(`${key} must be a list of ${DATA_TYPES.join(', ')}`);
  }
  return value as DataType[];
};

const selection = (body: unknown): Selection => {
  const { only, exclude } = (body ?? {}) as { only?: unknown; exclude?: unknown };
  const picked = { only: types(only, 'only'), exclude: types(exclude, 'exclude') };
  return Object.fromEntries(Object.entries(picked).filter(([, value]) => value !== undefined));
};

const settings = (strapi: Core.Strapi) => {
  const { url, chunkSize } = strapi.config.get('plugin::camis') as { url: string; chunkSize: number };
  return { url, chunkSize };
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default {
  sync: ({ strapi }: { strapi: Core.Strapi }) => {
    const start = (ctx: Context, direction: 'push' | 'pull'): void => {
      try {
        const force = (ctx.request.body as { force?: unknown } | undefined)?.force === true;
        ctx.status = 202;
        ctx.body = { data: sync(strapi).start(direction, selection(ctx.request.body), { force }) };
      } catch (error) {
        ctx.badRequest(message(error));
      }
    };

    return {
      async status(ctx: Context) {
        ctx.body = { data: { ...sync(strapi).status(), ...settings(strapi) } };
      },

      async history(ctx: Context) {
        ctx.body = { data: await sync(strapi).history() };
      },

      async check(ctx: Context) {
        try {
          ctx.body = { data: await sync(strapi).check() };
        } catch (error) {
          ctx.badRequest(error instanceof CamisError ? `${error.name}: ${error.message}` : message(error));
        }
      },

      async push(ctx: Context) {
        return start(ctx, 'push');
      },

      async pull(ctx: Context) {
        return start(ctx, 'pull');
      },
    };
  },
};
