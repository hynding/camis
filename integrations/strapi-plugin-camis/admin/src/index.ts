import { ArrowsCounterClockwise } from '@strapi/icons';

const PLUGIN_ID = 'camis';

export default {
  register(app: { addMenuLink(link: object): void; registerPlugin(plugin: object): void }) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: ArrowsCounterClockwise,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: 'CAMIS' },
      Component: async () => (await import('./pages/App')).App,
      permissions: [{ action: `plugin::${PLUGIN_ID}.read`, subject: null }],
    });
    app.registerPlugin({ id: PLUGIN_ID, name: 'CAMIS' });
  },
  async registerTrads({ locales }: { locales: string[] }) {
    return locales.map((locale) => ({ data: {}, locale }));
  },
};
