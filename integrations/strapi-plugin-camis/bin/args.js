'use strict';

const DATA_TYPES = ['content', 'files', 'config'];

const USAGE = `Usage: strapi-plugin-camis <push|pull|check> [--only <types>] [--exclude <types>] [--force]

  push    Replace CAMIS's data with this project's
  pull    Replace this project's data with CAMIS's (--force accepts a differing content model)
  check   Show what of this project's content model CAMIS has nowhere to put

  <types> is a comma-separated list of content, files, config.
  Run it in the Strapi project, with camis.config's url and token set in config/plugins.`;

const list = (value, flag) => {
  const types = String(value ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (types.length === 0) throw new Error(`${flag} needs a comma-separated list of ${DATA_TYPES.join(', ')}`);
  for (const type of types) {
    if (!DATA_TYPES.includes(type))
      throw new Error(`Invalid data type "${type}": the available types are ${DATA_TYPES.join(', ')}`);
  }
  return types;
};

/** @param {string[]} argv @returns {{command: 'push'|'pull'|'check', selection: {only?: string[], exclude?: string[]}, force: boolean}} */
const parse = (argv) => {
  const [command, ...rest] = argv;
  if (command !== 'push' && command !== 'pull' && command !== 'check') throw new Error(USAGE);
  const selection = {};
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s);
    if (flag === '--force') force = true;
    else if (flag === '--only' || flag === '--exclude') {
      selection[flag.slice(2)] = list(inline ?? rest[++i], flag);
    } else throw new Error(`Unknown option ${flag}\n\n${USAGE}`);
  }
  if (selection.only !== undefined && selection.exclude !== undefined)
    throw new Error('--only and --exclude cannot both be used');
  return { command, selection, force };
};

module.exports = { parse, USAGE };
