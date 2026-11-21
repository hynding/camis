# strapi-plugin-camis

A Strapi 5 plugin that moves a project's data to [CAMIS](https://github.com/hynding/camis) and back:

- **Push** replaces CAMIS's content, media and settings with this project's.
- **Pull** replaces this project's content, media and settings with CAMIS's.
- **Check** says what of this project's content model CAMIS has nowhere to put, before anything moves.

It is the `strapi transfer --to/--from` that a PHP host cannot serve. Strapi's own transfer needs a
WebSocket that PHP under FPM cannot keep open. This plugin writes the same archive `strapi export`
writes, using Strapi's own data-transfer engine, and sends it over plain HTTPS in chunks. CAMIS loads
it with the same importer as `php artisan strapi:import`. A pull goes the other way, and Strapi's
`strapi import` engine restores it.

The content model is not transferred. CAMIS builds its code from the model, so a model change goes
through `camis import strapi <project>`, then a regenerate and a deploy. Check tells you when that
is needed.

## Install

```sh
npm install strapi-plugin-camis
```

```js
// config/plugins.js
module.exports = ({ env }) => ({
  camis: {
    config: {
      url: env('CAMIS_URL'), // the CAMIS app's origin, e.g. https://cms.example.com
      token: env('CAMIS_TRANSFER_TOKEN'), // a CAMIS transfer token
      // chunkSize: 4 * 1024 * 1024, // bytes per uploaded chunk, at most 6 MiB
    },
  },
});
```

Make the token in CAMIS under **Settings › Transfer Tokens**. Give it **push** to send, **pull** to
receive, or both. Then rebuild the admin (`npm run build`).

## Use

In the admin, the **CAMIS** page in the main menu shows the connection, lets you pick the data
(content, files, settings), checks the content model, pushes, pulls and lists the last 20 transfers.
Roles need the plugin's **Read**, **Push to CAMIS** and **Pull from CAMIS** permissions
(Settings › Roles › Plugins › CAMIS).

From a shell or CI, in the project directory:

```sh
npx strapi-plugin-camis check
npx strapi-plugin-camis push [--only content,files,config | --exclude files]
npx strapi-plugin-camis pull [--only … | --exclude …] [--force]
```

`check` exits 1 when CAMIS lacks part of the model. A pull stops when CAMIS's model differs from
this project's in a way that would lose data, and `--force` accepts that loss, as `strapi import`
asks. Two differences never stop a pull, because nothing is lost: an empty `options` or
`pluginOptions` that only one side writes, and the Enterprise content-releases and review-workflows
types that CAMIS does not build.

## What moves

Exactly what `strapi export` and `strapi import` move: entries (drafts and published versions),
relations, components, dynamic zones, media library records and files, locales, users and their
roles, the core store and webhooks. Admin users, admin roles, API tokens and transfer tokens stay
where they are, as with `strapi transfer`.

Both directions **replace** the receiving side's data of the chosen kinds. A transfer is one archive
in one request to apply. CAMIS reads the archive into memory, so a very large media library is
better moved with `--exclude files` plus a copy of the uploads folder.

## The CAMIS endpoints

Every request carries `Authorization: Bearer <transfer token>`, and every error comes back in
Strapi's error envelope.

| Request | Token | What it does |
| --- | --- | --- |
| `POST /admin/transfer/push` | push | Starts a push, answering `{ data: { id, size: 0 } }`. |
| `PUT /admin/transfer/push/:id?offset=N` | push | Appends the body (at most 6 MiB). `N` must be the bytes received so far, or a 400 names the right size in `details.size`. |
| `POST /admin/transfer/push/:id/check` | push | `{ data: { diffs: [...] } }`, the check `strapi:import` makes. |
| `POST /admin/transfer/push/:id/apply` | push | Body `{ only?, exclude? }`. Imports and answers `{ data: { counts, skipped } }`. |
| `DELETE /admin/transfer/push/:id` | push | Drops an upload. Uploads nobody applies are dropped after a day. |
| `GET /admin/transfer/pull?only=&exclude=` | pull | The gzipped, unencrypted export archive. `X-Camis-Counts` holds what it counted. |

## Develop

```sh
npm install
npm test          # vitest: the CAMIS client, the sync service, schema diffs, CLI arguments
npm run typecheck
npm run build     # @strapi/sdk-plugin, into dist/
npm run verify
```

The package lives in the camis repository under `integrations/` and is not a pnpm workspace member:
it depends on Strapi itself, which the CAMIS build does not need.
