// Generates, materializes, installs, pushes the schema, boots the SECURED API, logs in, and proves
// permission enforcement on denied paths: anonymous mutate → 403, a role's record condition hides a
// row → 404, and a read field rule strips a field for one role but not another. Then it boots an
// unsecured project with an AI field (populate and change detection, over HTTP writes) and the
// polymorphic links project, secured and unsecured (morph-smoke.ts), on every dialect.
// Runs ONLY in the gated CI job (needs npm + a running server + the target DB). The dialect is the
// first CLI arg (default sqlite); the DB connection comes from the environment (DATABASE_URL for
// mysql/pgsql, each project getting a database of its own next to it; see smoke-project.ts).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Dialect } from "../src/dialect";
import { aiFixture } from "../src/__fixtures__/ai";
import { secured } from "../src/__fixtures__/secured";
import { morphSmoke, unsecuredMorphSmoke } from "./morph-smoke";
import { fail, smokeProject, waitForServer } from "./smoke-project";

const dialect = (process.argv[2] ?? "sqlite") as Dialect;
const headers = { "content-type": "application/json" };

const securedSmoke = async (port = 3210): Promise<void> => {
  const project = await smokeProject(secured, dialect, "boot", port);
  const root = `http://127.0.0.1:${port}/api`;
  const bearer = (token: string) => ({ ...headers, authorization: `Bearer ${token}` });
  const login = async (email: string): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "dev" }),
    });
    if (res.status !== 200) fail(`login ${email} → ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  try {
    project.start();
    await waitForServer(`${root}/articles`);

    const editor = await login("editor@example.com");

    // allowed: Editor creates a published Article carrying a secret
    const created = await fetch(`${root}/articles`, {
      method: "POST",
      headers: bearer(editor),
      body: JSON.stringify({ title: "hello", status: "published", secret_notes: "classified" }),
    });
    if (created.status !== 201) fail(`editor create → ${created.status}`);
    const publishedId = ((await created.json()) as { id: number }).id;

    // denied: anonymous (no token) create → 403
    const anon = await fetch(`${root}/articles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "nope" }),
    });
    if (anon.status !== 403) fail(`anonymous create expected 403, got ${anon.status}`);

    // denied: a token that does not verify is refused, not served as a guest → 401
    const forged = await fetch(`${root}/articles`, { headers: bearer("not-a-token") });
    if (forged.status !== 401) fail(`forged token expected 401, got ${forged.status}`);

    // record condition: a draft Article is invisible (404) to the Viewer (condition status==published)
    const draft = await fetch(`${root}/articles`, {
      method: "POST",
      headers: bearer(editor),
      body: JSON.stringify({ title: "secret", status: "draft" }),
    });
    const draftId = ((await draft.json()) as { id: number }).id;

    const viewer = await login("viewer@example.com");
    const viewerDraft = await fetch(`${root}/articles/${draftId}`, { headers: bearer(viewer) });
    if (viewerDraft.status !== 404) fail(`viewer should not see draft, got ${viewerDraft.status}`);

    // field rule: the Viewer sees the published Article but NOT its secret_notes (read rule denies);
    // the Editor (no read rule) sees it.
    const viewerPub = await fetch(`${root}/articles/${publishedId}`, { headers: bearer(viewer) });
    const viewerBody = (await viewerPub.json()) as { title?: string; secret_notes?: string };
    if (viewerPub.status !== 200 || viewerBody.title !== "hello")
      fail(`viewer published read failed: ${JSON.stringify(viewerBody)}`);
    if (viewerBody.secret_notes !== undefined)
      fail(`viewer should NOT see secret_notes, got ${viewerBody.secret_notes}`);

    const editorPub = await fetch(`${root}/articles/${publishedId}`, { headers: bearer(editor) });
    const editorBody = (await editorPub.json()) as { secret_notes?: string };
    if (editorBody.secret_notes !== "classified")
      fail(`editor should see secret_notes, got ${JSON.stringify(editorBody)}`);

    // The list: the Viewer's holds the published Article only, counted in Content-Range.
    const list = await fetch(`${root}/articles`, { headers: bearer(viewer) });
    const listed = (await list.json()) as { id: number }[];
    if (JSON.stringify(listed.map((a) => a.id)) !== JSON.stringify([publishedId]))
      fail(`viewer list → ${JSON.stringify(listed)}`);
    if (list.headers.get("content-range") !== "articles 0-0/1")
      fail(`viewer list Content-Range → ${list.headers.get("content-range")}`);

    // update, an update with nothing the caller may write, and delete
    const renamed = await fetch(`${root}/articles/${publishedId}`, {
      method: "PATCH",
      headers: bearer(editor),
      body: JSON.stringify({ title: "renamed" }),
    });
    const renamedBody = (await renamed.json()) as { title?: string };
    if (renamed.status !== 200 || renamedBody.title !== "renamed")
      fail(`editor update → ${renamed.status} ${JSON.stringify(renamedBody)}`);
    const unchanged = await fetch(`${root}/articles/${publishedId}`, {
      method: "PATCH",
      headers: bearer(editor),
      body: JSON.stringify({ unknown: 1 }),
    });
    if (
      unchanged.status !== 200 ||
      ((await unchanged.json()) as { title?: string }).title !== "renamed"
    )
      fail(`editor update with nothing to write → ${unchanged.status}`);
    const deleted = await fetch(`${root}/articles/${draftId}`, {
      method: "DELETE",
      headers: bearer(editor),
    });
    if (deleted.status !== 200) fail(`editor delete → ${deleted.status}`);
    const gone = await fetch(`${root}/articles/${draftId}`, { headers: bearer(editor) });
    if (gone.status !== 404) fail(`a deleted article → ${gone.status}`);
    // An id no row can have is the JSON 404 on every database, PostgreSQL refusing to compare one
    // past its integer column's range; a body that does not parse is a JSON 400.
    for (const id of ["not-a-number", "2147483648", "99999999999", "0001", `${"0".repeat(40)}1`]) {
      const missing = await fetch(`${root}/articles/${id}`, { headers: bearer(editor) });
      const body = await missing.text();
      if (missing.status !== 404 || body !== '{"error":"not found"}')
        fail(`the id ${id} → ${missing.status} ${body}`);
    }
    const unparsed = await fetch(`${root}/articles`, {
      method: "POST",
      headers: bearer(editor),
      body: "{ not json",
    });
    const unparsedBody = (await unparsed.json()) as { error?: unknown };
    if (unparsed.status !== 400 || typeof unparsedBody.error !== "string")
      fail(`a body that does not parse → ${unparsed.status} ${JSON.stringify(unparsedBody)}`);

    // The admin SPA is dialect-agnostic — build it once (sqlite leg) to prove the generated
    // react-admin TSX type-checks (tsc) and bundles (vite build).
    if (dialect === "sqlite") {
      const adminDir = join(project.dir, "admin");
      const adminInstall = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: adminDir,
        stdio: "inherit",
      });
      if (adminInstall.status !== 0) fail("admin npm install failed");
      const adminBuild = spawnSync("npm", ["run", "build"], { cwd: adminDir, stdio: "inherit" });
      if (adminBuild.status !== 0) fail("admin build failed");
      console.log("ADMIN BUILD OK");
    }
  } finally {
    await project.stop();
  }
};

// An unsecured project with an AI field: offline populate and change detection (deterministic stub
// provider — no network, no ANTHROPIC_API_KEY), and an update with nothing to write.
const aiSmoke = async (port = 3211): Promise<void> => {
  const project = await smokeProject(aiFixture, dialect, "ai", port);
  const aiRoot = `http://127.0.0.1:${port}/api/articles`;
  const patch = (id: number, body: Record<string, unknown>) =>
    fetch(`${aiRoot}/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  try {
    project.start();
    await waitForServer(aiRoot);

    // create → summary populated by the stub
    const created = await fetch(aiRoot, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "t", body: "the original body" }),
    });
    const createdBody = (await created.json()) as { id: number; summary?: string };
    if (created.status !== 201 || !createdBody.summary?.startsWith("[ai:"))
      fail(`ai create did not populate summary: ${JSON.stringify(createdBody)}`);
    const id = createdBody.id;
    const firstSummary = createdBody.summary;

    // update title only → summary unchanged (no source field changed)
    await patch(id, { title: "t2" });
    const afterTitle = (await (await fetch(`${aiRoot}/${id}`)).json()) as { summary?: string };
    if (afterTitle.summary !== firstSummary) fail("summary regenerated on a non-source update");

    // update body → summary regenerates from the new source value
    await patch(id, { body: "a different body entirely" });
    const afterBody = (await (await fetch(`${aiRoot}/${id}`)).json()) as { summary?: string };
    if (!afterBody.summary?.includes("a different body"))
      fail(`summary did not regenerate on a source update: ${JSON.stringify(afterBody)}`);

    // an update with no writable key answers the row unchanged, as the secured router does
    const noop = await patch(id, { unknown: 1 });
    const noopBody = (await noop.json()) as { title?: string };
    if (noop.status !== 200 || noopBody.title !== "t2")
      fail(`an update with nothing to write → ${noop.status} ${JSON.stringify(noopBody)}`);
    if ((await patch(999_999, { title: "x" })).status !== 404)
      fail("an update of no row → not 404");

    const list = (await (await fetch(aiRoot)).json()) as { id: number }[];
    if (JSON.stringify(list.map((a) => a.id)) !== JSON.stringify([id]))
      fail(`ai list → ${JSON.stringify(list)}`);
    if ((await fetch(`${aiRoot}/${id}`, { method: "DELETE" })).status !== 204)
      fail("ai delete → not 204");
    if ((await fetch(`${aiRoot}/${id}`)).status !== 404) fail("a deleted row → not 404");
    console.log("AI POPULATE OK");
  } finally {
    await project.stop();
  }
};

await securedSmoke();
await aiSmoke();
await morphSmoke(dialect);
await unsecuredMorphSmoke(dialect);
console.log(`EXPRESS SECURED BOOT SMOKE PASS (${dialect})`);
