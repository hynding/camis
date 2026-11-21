const route = (method: 'GET' | 'POST', path: string, handler: string, action: 'read' | 'push' | 'pull') => ({
  method,
  path,
  handler: `sync.${handler}`,
  config: {
    policies: [{ name: 'admin::hasPermissions', config: { actions: [`plugin::camis.${action}`] } }],
  },
});

export default {
  admin: {
    type: 'admin',
    routes: [
      route('GET', '/status', 'status', 'read'),
      route('GET', '/history', 'history', 'read'),
      route('POST', '/check', 'check', 'read'),
      route('POST', '/push', 'push', 'push'),
      route('POST', '/pull', 'pull', 'pull'),
    ],
  },
};
