#!/usr/bin/env node
'use strict';

const { parse } = require('./args.js');

/** Boots the Strapi project in the working directory, runs one transfer or check, and stops it. */
const main = async () => {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const { compileStrapi, createStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';
  try {
    const sync = app.plugin('camis').service('sync');
    if (options.command === 'check') {
      const { diffs } = await sync.check();
      if (diffs.length === 0) {
        console.log("CAMIS has somewhere to put everything this project's content model holds.");
        return 0;
      }
      console.log('CAMIS has nowhere to put:');
      for (const diff of diffs) console.log(`  - ${diff}`);
      return 1;
    }
    const transfer = await sync.run(options.command, options.selection, { force: options.force });
    if (transfer.state === 'done') {
      console.table(transfer.counts);
      for (const [type, reason] of Object.entries(transfer.skipped ?? {}))
        console.log(`Not imported: ${type} (${reason})`);
      console.log(`${options.command === 'push' ? 'Push' : 'Pull'} completed successfully.`);
      return 0;
    }
    console.error(transfer.error);
    for (const diff of transfer.diffs ?? []) console.error(`  - ${diff}`);
    return 1;
  } finally {
    await app.destroy();
  }
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
