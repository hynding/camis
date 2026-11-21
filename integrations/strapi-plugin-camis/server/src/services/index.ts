import type { Core } from '@strapi/strapi';
import { CamisClient } from './camis-client';
import { createArchives } from './archives';
import { createSync, type PluginConfig, type Transfer } from './sync';

export default {
  sync: ({ strapi }: { strapi: Core.Strapi }) => {
    const store = strapi.store({ type: 'plugin', name: 'camis', key: 'history' });
    return createSync({
      config: () => strapi.config.get('plugin::camis') as PluginConfig,
      store: {
        get: async () => (await store.get({})) as Transfer[] | null,
        set: async (value) => {
          await store.set({ value });
        },
      },
      archives: createArchives(strapi),
      client: (config) => new CamisClient(config),
      now: () => new Date(),
    });
  },
};
