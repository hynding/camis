import { MAX_CHUNK } from '../services/camis-client';

/**
 * config/plugins.(js|ts):
 *   camis: { config: { url: env('CAMIS_URL'), token: env('CAMIS_TRANSFER_TOKEN') } }
 * The token is a CAMIS transfer token (Settings › Transfer Tokens there): push to send, pull to receive.
 */
export default {
  default: { url: '', token: '', chunkSize: 4 * 1024 * 1024 },
  validator(config: { url?: unknown; token?: unknown; chunkSize?: unknown }) {
    if (typeof config.url !== 'string') throw new Error("camis.url must be a string, the CAMIS app's origin");
    if (config.url !== '' && !/^https?:\/\//.test(config.url))
      throw new Error('camis.url must start with http:// or https://');
    if (typeof config.token !== 'string') throw new Error('camis.token must be a string, a CAMIS transfer token');
    if (typeof config.chunkSize !== 'number' || config.chunkSize < 1024 || config.chunkSize > MAX_CHUNK) {
      throw new Error(`camis.chunkSize must be a number of bytes between 1024 and ${MAX_CHUNK}`);
    }
  },
};
