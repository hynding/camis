import { describe, expect, it } from "vitest";
import { OPAQUE, readCallArguments } from "./literal";

describe("readCallArguments", () => {
  it("reads a JavaScript call's literal arguments", () => {
    const source = `import { factories } from '@strapi/strapi';
// the router
export default factories.createCoreRouter('api::address.address', {
  prefix: "",
  only: ['find', "findOne"], // listed
  config: {
    find: { auth: false, policies: ['global::is-owner', { name: 'api::address.limit', config: { max: 3 } }] },
  },
  /* a block comment */
  count: 2,
  "quoted-key": null,
  done: true,
});
`;
    expect(readCallArguments(source, "createCoreRouter")).toEqual([
      "api::address.address",
      {
        prefix: "",
        only: ["find", "findOne"],
        config: {
          find: {
            auth: false,
            policies: ["global::is-owner", { name: "api::address.limit", config: { max: 3 } }],
          },
        },
        count: 2,
        "quoted-key": null,
        done: true,
      },
    ]);
  });

  it("reads a PHP call's literal arguments", () => {
    const source = `<?php

declare(strict_types=1);

use Strapi\\Core\\Factories;

return Factories::createCoreRouter('api::address.address', [
    'config' => [
        'find' => [
            // 'auth' => false,
            'policies' => ['global::is-owner'],
        ],
    ],
    'only' => ['find', 'findOne'],
    'empty' => [],
]);
`;
    expect(readCallArguments(source, "createCoreRouter")).toEqual([
      "api::address.address",
      {
        config: { find: { policies: ["global::is-owner"] } },
        only: ["find", "findOne"],
        empty: [],
      },
    ]);
  });

  it("stands OPAQUE in for what is not a literal, and reads on past it", () => {
    const source = `module.exports = createCoreRouter("api::a.a", {
  config: {
    find: { policies: [async (ctx, cfg, { strapi }) => { return ctx.state.user?.id === 1 && "}"; }, 'global::x'] },
    update: { middlewares: [someMiddleware], prefix: \`/v\${version}\` },
  },
  only: ROUTES,
});`;
    expect(readCallArguments(source, "createCoreRouter")).toEqual([
      "api::a.a",
      {
        config: {
          find: { policies: [OPAQUE, "global::x"] },
          update: { middlewares: [OPAQUE], prefix: OPAQUE },
        },
        only: OPAQUE,
      },
    ]);
  });

  it("is undefined when the source makes no such call", () => {
    expect(readCallArguments("export default { routes: [] };", "createCoreRouter")).toBeUndefined();
  });
});
