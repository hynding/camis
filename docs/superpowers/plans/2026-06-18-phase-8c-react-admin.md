# Phase 8C (Plan 2 of 2) — React-Admin Sub-App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a react-admin SPA (`admin/` sub-app) over the secured Express API, completing Phase 8.

**Architecture:** When the IR bundle carries roles (secured), the adapter emits an `admin/` Vite + react-admin app: IR-independent static files (package.json, vite config, entry, a thin custom `dataProvider` speaking our exact REST shape, and an `authProvider` driving `/auth/login`), plus IR-derived `App.tsx` (one `<Resource>` per content type) and per-resource list/edit/create views mapped from IR fields. The admin is dumb about permissions — the server enforces. The gated boot `vite build`s it once (dialect-agnostic) to prove it type-checks + bundles.

**Tech Stack:** react-admin v5, React 18, Vite 6, TypeScript. The admin talks to the Plan-1 secured API (`Content-Range` + `_start/_end/_sort/_order`, `Authorization: Bearer`, `DELETE {id}`).

**Spec:** `docs/superpowers/specs/2026-06-18-phase-8c-express-permissions-admin-design.md` (§6, D7).

---

## Conventions (read once)

- Package root for all relative paths below: `packages/adapter-express/`.
- Single test file: `pnpm --filter @camis/adapter-express exec vitest run src/<file>.test.ts`. Whole package: `… test`; typecheck: `… typecheck`; lint: `… lint`.
- **Golden guard:** the admin only appears when the bundle has roles, so the 8A/8B goldens (roles-less) and the existing 8C `secured/*` goldens for non-admin files must not change except where a task explicitly regenerates them. After any generation task, `git status --short src/__golden__/` shows only the intended goldens.
- Emitted code (the strings these emitters return, incl. `.tsx`) is data — `any`/loose typing inside them is fine; **our** `.ts` emitter sources stay `any`-free and lint-clean.
- Every commit message ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- React-admin is verified only by the gated `vite build`. If a v5 API name in an emitted template differs from the installed types, the gated build is the oracle; prefer the documented v5 names used here (`List`, `Datagrid`, `Edit`, `Create`, `SimpleForm`, `TextField`/`TextInput`, `BooleanField`/`BooleanInput`, `NumberField`/`NumberInput`, `DateField`/`DateTimeInput`, `SelectInput`, `ReferenceField`/`ReferenceInput`, `Admin`, `Resource`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/admin-app.ts` (create) | Emit the IR-independent admin files: `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/dataProvider.ts`, `src/authProvider.ts`. |
| `src/admin-resources.ts` (create) | IR field → react-admin field/input mapping; emit `src/App.tsx` + per-content-type `src/resources/<table>.tsx`. |
| `src/generate.ts` (modify) | When secured, emit all `admin/**` files. |
| `src/secured-golden.test.ts` (modify) | Snapshot the admin App + one resource view + file-listing. |
| `scripts/boot-smoke.ts` (modify) | After the API checks, `npm install` + `npm run build` the `admin/` once (sqlite leg only). |

All emitted admin files are written under the `admin/` path prefix (e.g. `admin/package.json`, `admin/src/App.tsx`).

---

## Task 1: IR-independent admin files (`admin-app.ts`)

**Files:** Create `src/admin-app.ts`, `src/admin-app.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/admin-app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adminStaticFiles } from "./admin-app";

describe("adminStaticFiles", () => {
  const files = adminStaticFiles();
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits a vite + react-admin package.json", () => {
    const pkg = JSON.parse(c("admin/package.json"));
    expect(pkg.dependencies["react-admin"]).toBeDefined();
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.scripts.build).toBe("tsc && vite build");
  });
  it("emits a dataProvider that reads Content-Range and attaches a Bearer token", () => {
    const dp = c("admin/src/dataProvider.ts");
    expect(dp).toContain("Content-Range");
    expect(dp).toContain("Authorization");
    expect(dp).toContain("_start");
    expect(dp).toContain("getManyReference");
  });
  it("emits an authProvider that logs in via /auth/login and decodes the role", () => {
    const ap = c("admin/src/authProvider.ts");
    expect(ap).toContain("/auth/login");
    expect(ap).toContain("getPermissions");
    expect(ap).toContain("localStorage");
  });
  it("emits the vite entry and index.html", () => {
    expect(c("admin/index.html")).toContain('<div id="root">');
    expect(c("admin/src/main.tsx")).toContain("createRoot");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/admin-app.test.ts`.

- [ ] **Step 3: Implement** — `src/admin-app.ts`:

```ts
import type { GeneratedFile } from "@camis/adapter-kernel";

const PACKAGE_JSON =
  JSON.stringify(
    {
      name: "admin",
      private: true,
      type: "module",
      scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "react-admin": "^5.4.0",
      },
      devDependencies: {
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.0",
        typescript: "^5.7.0",
        vite: "^6.0.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        useDefineForClassFields: true,
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n";

const VITE_CONFIG = `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin is a separate dev server; it proxies the API + auth to the Express server (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>camis admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const MAIN_TSX = `import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`;

const DATA_PROVIDER = `import { fetchUtils, type DataProvider } from "react-admin";

const apiUrl = "/api";

const httpClient = (url: string, options: fetchUtils.Options = {}) => {
  const headers = (options.headers ||
    new Headers({ Accept: "application/json" })) as Headers;
  const token = localStorage.getItem("token");
  if (token) headers.set("Authorization", \`Bearer \${token}\`);
  return fetchUtils.fetchJson(url, { ...options, headers });
};

export const dataProvider: DataProvider = {
  getList: async (resource, params) => {
    const { page = 1, perPage = 25 } = params.pagination ?? {};
    const { field = "id", order = "ASC" } = params.sort ?? {};
    const start = (page - 1) * perPage;
    const end = page * perPage;
    const query = new URLSearchParams({
      _sort: field,
      _order: order,
      _start: String(start),
      _end: String(end),
    });
    const { headers, json } = await httpClient(\`\${apiUrl}/\${resource}?\${query}\`);
    const range = headers.get("Content-Range") ?? "";
    const total = Number(range.split("/").pop() ?? json.length);
    return { data: json, total };
  },
  getOne: async (resource, params) => {
    const { json } = await httpClient(\`\${apiUrl}/\${resource}/\${params.id}\`);
    return { data: json };
  },
  getMany: async (resource, params) => {
    const data = await Promise.all(
      params.ids.map((id) => httpClient(\`\${apiUrl}/\${resource}/\${id}\`).then(({ json }) => json)),
    );
    return { data };
  },
  getManyReference: async (resource, params) => {
    const { json } = await httpClient(\`\${apiUrl}/\${resource}?_start=0&_end=1000\`);
    const data = json.filter((r: Record<string, unknown>) => r[params.target] === params.id);
    return { data, total: data.length };
  },
  create: async (resource, params) => {
    const { json } = await httpClient(\`\${apiUrl}/\${resource}\`, {
      method: "POST",
      body: JSON.stringify(params.data),
    });
    return { data: json };
  },
  update: async (resource, params) => {
    const { json } = await httpClient(\`\${apiUrl}/\${resource}/\${params.id}\`, {
      method: "PATCH",
      body: JSON.stringify(params.data),
    });
    return { data: json };
  },
  updateMany: async (resource, params) => {
    await Promise.all(
      params.ids.map((id) =>
        httpClient(\`\${apiUrl}/\${resource}/\${id}\`, {
          method: "PATCH",
          body: JSON.stringify(params.data),
        }),
      ),
    );
    return { data: params.ids };
  },
  delete: async (resource, params) => {
    const { json } = await httpClient(\`\${apiUrl}/\${resource}/\${params.id}\`, { method: "DELETE" });
    return { data: json };
  },
  deleteMany: async (resource, params) => {
    await Promise.all(
      params.ids.map((id) =>
        httpClient(\`\${apiUrl}/\${resource}/\${id}\`, { method: "DELETE" }),
      ),
    );
    return { data: params.ids };
  },
};
`;

const AUTH_PROVIDER = `import type { AuthProvider } from "react-admin";

export const authProvider: AuthProvider = {
  login: async ({ username, password }) => {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: username, password }),
    });
    if (!res.ok) throw new Error("Invalid login");
    const { token } = await res.json();
    localStorage.setItem("token", token);
  },
  logout: () => {
    localStorage.removeItem("token");
    return Promise.resolve();
  },
  checkAuth: () =>
    localStorage.getItem("token") ? Promise.resolve() : Promise.reject(),
  checkError: (error) => {
    if (error?.status === 401 || error?.status === 403) {
      localStorage.removeItem("token");
      return Promise.reject();
    }
    return Promise.resolve();
  },
  getIdentity: () => {
    const token = localStorage.getItem("token");
    if (!token) return Promise.reject();
    const payload = JSON.parse(atob(token.split(".")[1]));
    return Promise.resolve({ id: payload.sub, fullName: payload.role });
  },
  getPermissions: () => {
    const token = localStorage.getItem("token");
    if (!token) return Promise.resolve("public");
    const payload = JSON.parse(atob(token.split(".")[1]));
    return Promise.resolve(payload.role);
  },
};
`;

export const adminStaticFiles = (): GeneratedFile[] => [
  { path: "admin/package.json", content: PACKAGE_JSON },
  { path: "admin/tsconfig.json", content: TSCONFIG },
  { path: "admin/vite.config.ts", content: VITE_CONFIG },
  { path: "admin/index.html", content: INDEX_HTML },
  { path: "admin/src/main.tsx", content: MAIN_TSX },
  { path: "admin/src/dataProvider.ts", content: DATA_PROVIDER },
  { path: "admin/src/authProvider.ts", content: AUTH_PROVIDER },
];
```

(These files carry NO `// @camis:generated` marker because the marker is a TS line comment that would be wrong in `index.html`/JSON, and react-admin files are regenerated wholesale anyway; they are plain overwrite files. The build is `tsc && vite build` — plain `tsc` (with `noEmit: true`) type-checks `src/**` without needing a composite/referenced config; `vite.config.ts` lives outside `include: ["src"]`, so it is not type-checked. If the gated build ever needs a `tsconfig.node.json`, add a minimal one then, but keep it out unless required.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/admin-app.test.ts`; `… typecheck`; `… lint`. `git status --short src/__golden__/` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/admin-app.ts packages/adapter-express/src/admin-app.test.ts
git commit -m "feat(adapter-express): emit react-admin static files (vite, dataProvider, authProvider)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: IR-derived resource views + App (`admin-resources.ts`)

**Files:** Create `src/admin-resources.ts`, `src/admin-resources.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/admin-resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { adminResourceFiles } from "./admin-resources";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "boolean", name: "published" },
        { type: "enumeration", name: "status", values: ["draft", "published"] },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
        { type: "component", name: "seo", component: "Seo", repeatable: false },
      ],
    },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
  ],
  components: [],
};

describe("adminResourceFiles", () => {
  const files = adminResourceFiles(doc);
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits App.tsx wiring one Resource per content type", () => {
    const app = c("admin/src/App.tsx");
    expect(app).toContain('<Resource name="articles"');
    expect(app).toContain('<Resource name="authors"');
    expect(app).toContain("dataProvider={dataProvider}");
  });
  it("maps IR fields to react-admin inputs/fields and omits components", () => {
    const articles = c("admin/src/resources/articles.tsx");
    expect(articles).toContain('<TextInput source="title" />');
    expect(articles).toContain('<BooleanInput source="published" />');
    expect(articles).toContain('<SelectInput source="status" choices={[{ id: "draft", name: "draft" }, { id: "published", name: "published" }]} />');
    expect(articles).toContain('<ReferenceInput source="author_id" reference="authors" />');
    expect(articles).not.toContain("seo"); // component omitted
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/admin-resources.test.ts`.

- [ ] **Step 3: Implement** — `src/admin-resources.ts`:

```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, Field, IrDocument } from "@camis/ir-schema";
import { expressNames, snakeColumn } from "./names";

interface Emit {
  jsx: string;
  comp: string; // react-admin component name to import
}

const refTable = (doc: IrDocument, target: string): string | null => {
  const ct = doc.contentTypes.find((c) => c.name === target);
  return ct ? expressNames(ct).table : null;
};

const listField = (f: Field, doc: IrDocument): Emit | null => {
  const c = snakeColumn(f.name);
  switch (f.type) {
    case "string":
    case "text":
    case "richText":
    case "email":
    case "uid":
    case "enumeration":
    case "media":
    case "json":
      return { jsx: `<TextField source="${c}" />`, comp: "TextField" };
    case "boolean":
      return { jsx: `<BooleanField source="${c}" />`, comp: "BooleanField" };
    case "integer":
    case "bigInteger":
    case "float":
    case "decimal":
      return { jsx: `<NumberField source="${c}" />`, comp: "NumberField" };
    case "date":
    case "time":
    case "dateTime":
    case "timestamp":
      return { jsx: `<DateField source="${c}" showTime />`, comp: "DateField" };
    case "relation": {
      const fr = f as Field & { relationKind: string; target: string };
      if (fr.relationKind !== "manyToOne" && fr.relationKind !== "oneToOne") return null;
      const ref = refTable(doc, fr.target);
      return ref ? { jsx: `<ReferenceField source="${c}_id" reference="${ref}" />`, comp: "ReferenceField" } : null;
    }
    default:
      return null; // component / dynamicZone
  }
};

const input = (f: Field, doc: IrDocument): Emit | null => {
  const c = snakeColumn(f.name);
  switch (f.type) {
    case "string":
    case "text":
    case "email":
    case "uid":
    case "media":
    case "json":
      return { jsx: `<TextInput source="${c}" />`, comp: "TextInput" };
    case "richText":
      return { jsx: `<TextInput source="${c}" multiline />`, comp: "TextInput" };
    case "boolean":
      return { jsx: `<BooleanInput source="${c}" />`, comp: "BooleanInput" };
    case "integer":
    case "bigInteger":
    case "float":
    case "decimal":
      return { jsx: `<NumberInput source="${c}" />`, comp: "NumberInput" };
    case "date":
    case "time":
    case "dateTime":
    case "timestamp":
      return { jsx: `<DateTimeInput source="${c}" />`, comp: "DateTimeInput" };
    case "enumeration": {
      const values = ((f as Field & { values?: string[] }).values ?? []);
      const choices = values
        .map((v) => `{ id: ${JSON.stringify(v)}, name: ${JSON.stringify(v)} }`)
        .join(", ");
      return { jsx: `<SelectInput source="${c}" choices={[${choices}]} />`, comp: "SelectInput" };
    }
    case "relation": {
      const fr = f as Field & { relationKind: string; target: string };
      if (fr.relationKind !== "manyToOne" && fr.relationKind !== "oneToOne") return null;
      const ref = refTable(doc, fr.target);
      return ref ? { jsx: `<ReferenceInput source="${c}_id" reference="${ref}" />`, comp: "ReferenceInput" } : null;
    }
    default:
      return null;
  }
};

const resourceView = (ct: ContentType, doc: IrDocument): string => {
  const name = ct.name; // PascalCase export prefix
  const listEmits = ct.fields.map((f) => listField(f, doc)).filter((e): e is Emit => e !== null);
  const inputEmits = ct.fields.map((f) => input(f, doc)).filter((e): e is Emit => e !== null);
  const imports = [
    ...new Set([
      "List",
      "Datagrid",
      "Edit",
      "Create",
      "SimpleForm",
      "TextField",
      ...listEmits.map((e) => e.comp),
      ...inputEmits.map((e) => e.comp),
    ]),
  ]
    .sort()
    .join(", ");
  const cols = ['<TextField source="id" />', ...listEmits.map((e) => e.jsx)]
    .map((j) => `      ${j}`)
    .join("\n");
  const inputs = inputEmits.map((e) => `      ${e.jsx}`).join("\n");
  return `import { ${imports} } from "react-admin";

export const ${name}List = () => (
  <List>
    <Datagrid rowClick="edit">
${cols}
    </Datagrid>
  </List>
);

export const ${name}Edit = () => (
  <Edit>
    <SimpleForm>
${inputs}
    </SimpleForm>
  </Edit>
);

export const ${name}Create = () => (
  <Create>
    <SimpleForm>
${inputs}
    </SimpleForm>
  </Create>
);
`;
};

const appFile = (doc: IrDocument): string => {
  const imports = doc.contentTypes
    .map(
      (ct) =>
        `import { ${ct.name}Create, ${ct.name}Edit, ${ct.name}List } from "./resources/${expressNames(ct).table}";`,
    )
    .join("\n");
  const resources = doc.contentTypes
    .map(
      (ct) =>
        `    <Resource name="${expressNames(ct).table}" list={${ct.name}List} edit={${ct.name}Edit} create={${ct.name}Create} />`,
    )
    .join("\n");
  return `import { Admin, Resource } from "react-admin";
import { authProvider } from "./authProvider";
import { dataProvider } from "./dataProvider";
${imports}

export const App = () => (
  <Admin dataProvider={dataProvider} authProvider={authProvider}>
${resources}
  </Admin>
);
`;
};

export const adminResourceFiles = (doc: IrDocument): GeneratedFile[] => [
  { path: "admin/src/App.tsx", content: appFile(doc) },
  ...doc.contentTypes.map((ct) => ({
    path: `admin/src/resources/${expressNames(ct).table}.tsx`,
    content: resourceView(ct, doc),
  })),
];
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/admin-resources.test.ts`; `… typecheck`; `… lint`. `git status --short src/__golden__/` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/admin-resources.ts packages/adapter-express/src/admin-resources.test.ts
git commit -m "feat(adapter-express): emit react-admin App + per-resource views from IR fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Emit the admin when secured (`generate.ts`)

**Files:** Modify `src/generate.ts`, `src/generate.test.ts`.

- [ ] **Step 1: Write the failing test** — extend `src/generate.test.ts`:

```ts
it("emits the admin sub-app only when the bundle carries roles", () => {
  const bare = expressAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }], components: [] }, roles: [] } as never, { projectName: "blog" });
  expect(bare.files.some((f) => f.path.startsWith("admin/"))).toBe(false);

  const secured = expressAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }], components: [] }, roles: [{ name: "Editor", grants: [{ contentType: "Article", actions: ["read"] }] }] } as never, { projectName: "blog" });
  const paths = secured.files.map((f) => f.path);
  expect(paths).toContain("admin/package.json");
  expect(paths).toContain("admin/src/App.tsx");
  expect(paths).toContain("admin/src/dataProvider.ts");
  expect(paths).toContain("admin/src/resources/articles.tsx");
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — in `src/generate.ts`:
  1. Add imports near the other relative imports:

```ts
import { adminStaticFiles } from "./admin-app";
import { adminResourceFiles } from "./admin-resources";
```

  2. Inside the existing `if (secured) { ... }` block (after the auth/ring1/enforce pushes), append:

```ts
      files.push(...adminStaticFiles());
      files.push(...adminResourceFiles(doc));
```

  Nothing else changes — the admin emits exactly when the other secured artifacts do.

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`; then `pnpm --filter @camis/adapter-express test`. The no-roles path is unchanged, so the 8A/8B goldens stay byte-identical; the `secured/` non-admin goldens are unaffected **except the secured file-listing**, which now gains the `admin/**` paths → that one golden fails here and is regenerated in Task 4. For now confirm ONLY `src/__golden__/secured/file-listing.txt` fails (no other golden). `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/generate.ts packages/adapter-express/src/generate.test.ts
git commit -m "feat(adapter-express): emit the react-admin sub-app when the bundle carries roles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Admin goldens + file-listing

**Files:** Modify `src/secured-golden.test.ts`; regenerate `src/__golden__/secured/*`.

- [ ] **Step 1: Add golden assertions** — in `src/secured-golden.test.ts`, add inside the `describe("secured golden", ...)` block:

```ts
  it("admin App golden", async () => {
    await expect(c("admin/src/App.tsx")).toMatchFileSnapshot("./__golden__/secured/admin.App.tsx.txt");
  });
  it("admin articles resource golden", async () => {
    await expect(c("admin/src/resources/articles.tsx")).toMatchFileSnapshot("./__golden__/secured/admin.articles.tsx.txt");
  });
  it("admin dataProvider golden", async () => {
    await expect(c("admin/src/dataProvider.ts")).toMatchFileSnapshot("./__golden__/secured/admin.dataProvider.ts.txt");
  });
```

(The existing `file-listing` golden test already snapshots all paths, so it will capture the new `admin/**` entries.)

- [ ] **Step 2: Generate + INSPECT** — `pnpm --filter @camis/adapter-express exec vitest run src/secured-golden.test.ts -u`. READ and confirm:
  - `admin.App.tsx.txt`: `<Resource name="articles" …>` and `<Resource name="authors" …>`; imports from `./resources/articles` + `./resources/authors`.
  - `admin.articles.tsx.txt`: `<TextInput source="title" />`, `<SelectInput source="status" choices={[…]} />`, `<ReferenceInput source="author_id" reference="authors" />`; the `secretNotes` field maps to `<TextInput source="secret_notes" />`; no `seo`/component.
  - `admin.dataProvider.ts.txt`: the 9 methods; reads `Content-Range`; `Authorization: Bearer`.
  - `file-listing.txt` now includes the `admin/**` paths (all `overwrite`).
  - If anything is wrong, STOP — fix the emitter, do not hand-edit a golden.

- [ ] **Step 3: Regression** — `pnpm --filter @camis/adapter-express test` (ALL green). `git status --short src/__golden__/` shows only: the new `admin.*.txt` goldens + the modified `secured/file-listing.txt`. The 8A/8B goldens and the other `secured/*` goldens are unchanged. `… typecheck`; `… lint`.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-express/src/secured-golden.test.ts packages/adapter-express/src/__golden__/secured
git commit -m "test(adapter-express): admin App/resource/dataProvider goldens + file-listing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Gated boot builds the admin once

**Files:** Modify `packages/adapter-express/scripts/boot-smoke.ts`.

The admin is dialect-agnostic, so build it ONLY on the sqlite leg (after the existing enforcement
assertions, before the `finally`). The build (`npm install` + `npm run build`) proves the generated
react-admin TSX type-checks (`tsc -b`) and bundles (`vite build`).

- [ ] **Step 1: Implement** — in `scripts/boot-smoke.ts`, just before the final `console.log(...PASS...)` line, add:

```ts
  // The admin SPA is dialect-agnostic — build it once (sqlite leg) to prove it type-checks + bundles.
  if (dialect === "sqlite") {
    const adminDir = join(dir, "admin");
    const adminInstall = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: adminDir,
      stdio: "inherit",
    });
    if (adminInstall.status !== 0) fail("admin npm install failed");
    const adminBuild = spawnSync("npm", ["run", "build"], { cwd: adminDir, stdio: "inherit" });
    if (adminBuild.status !== 0) fail("admin build failed");
    console.log("ADMIN BUILD OK");
  }
```

(The secured project now materializes an `admin/` directory; `materialize` already writes nested
paths. No workflow change is needed — the existing `[sqlite, mysql, pgsql]` matrix runs this, and the
`if (dialect === "sqlite")` guard limits the heavy React build to one leg.)

- [ ] **Step 2: Typecheck the script** — `pnpm --filter @camis/adapter-express exec tsc --noEmit --module ESNext --moduleResolution Bundler --target ESNext --strict --skipLibCheck scripts/boot-smoke.ts` (expect no output).

- [ ] **Step 3: Full sweep** — `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` (report counts; all green). Confirm the only golden changes across the repo are the Task-4 admin goldens + secured file-listing. Do NOT run the gated workflow locally.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-express/scripts/boot-smoke.ts
git commit -m "ci(adapter-express): gated boot builds the generated react-admin once (sqlite leg)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** §6 react-admin sub-app — `admin/` Vite app (Task 1), App + `<Resource>` per type + per-resource views from IR fields with the documented field→input mapping (Task 2), thin dataProvider matching our REST shape + authProvider decoding the role (Task 1), component/dynamicZone omitted (Task 2 `listField`/`input` default → null). D7 admin built once in the gated boot (Task 5). §8 admin golden + admin build (Tasks 4, 5). The admin is server-enforced only (no client gating beyond `getPermissions`) — YAGNI honored.

**Placeholder scan:** No "TBD/TODO". Task 1 notes a conditional `tsconfig.node.json` only "if the gated build requires it" — that is a build-determined contingency, not a placeholder; the base config builds without it. All emitter code blocks are complete literals.

**Type consistency:** `adminStaticFiles()` (Task 1) and `adminResourceFiles(doc)` (Task 2) are both consumed in Task 3's `if (secured)` block. `expressNames(ct).table` is the single source for resource `name`, the API path, and the resource file path (Tasks 2). The field→`source` uses `snakeColumn(f.name)` consistently with the routes/schema (Plan 1). The dataProvider's `_sort/_order/_start/_end` + `Content-Range` exactly match the Plan-1 secured route contract.

**Risk note:** react-admin v5 templates are verified only by the gated `vite build`; the documented v5 component/provider names used here are stable, and the build is the oracle if any differ.
