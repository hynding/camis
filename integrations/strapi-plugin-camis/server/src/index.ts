import type { Core } from '@strapi/strapi';
import config from './config';
import controllers from './controllers';
import routes from './routes';
import services from './services';

/** The admin's Settings › Roles grants: see the page, push to CAMIS, pull from CAMIS. */
const ACTIONS = [
  { uid: 'read', displayName: 'Read' },
  { uid: 'push', displayName: 'Push to CAMIS' },
  { uid: 'pull', displayName: 'Pull from CAMIS' },
];

export default {
  register() {},
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await strapi
      .service('admin::permission')
      .actionProvider.registerMany(ACTIONS.map((action) => ({ ...action, section: 'plugins', pluginName: 'camis' })));
  },
  config,
  controllers,
  routes,
  services,
};
