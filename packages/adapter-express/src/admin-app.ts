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
