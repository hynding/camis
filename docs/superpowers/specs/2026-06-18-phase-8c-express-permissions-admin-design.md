# Phase 8C — Express Permissions Enforcement + JWT Auth Seam + React Admin Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 8, sub-phase C (final slice — closes Phase 8)
**Scope:** extend `@camis/adapter-express` (8A booting API, 8B breadth/relations/multi-dialect/round-trip)
with: (1) a **JWT auth seam** — generated verify/login wiring over a protected, hand-written user
store; (2) **permissions down-projected from the IR and enforced** in the API at three levels (action,
record-condition, field-level), all **Ring-1-aware** via the conformance-tested `expr-ts` runtime; and
(3) a generated **react-admin** SPA. This satisfies the remaining Phase 8 exit criteria.

---

## 1. Context & goal

8A/8B proved camis generates a booting, full-taxonomy, multi-dialect, round-trippable Express+Drizzle
API. 8C makes it **secured and operable**: the IR's permission model (`Role → Grant{contentType,
actions, fieldRules, condition}`) is projected to the Express target and *enforced* (denied paths must
actually 403/404, not merely be described), with Ring-1 conditions evaluated at request time by the
same conformance-tested runtime the other targets share. A generated react-admin SPA gives a working
UI over the secured API. Identity is not IR-derived, so it enters through a **protected seam**, keeping
the generator IR-focused while still producing a loginnable product.

All auth/JWT/react-admin/SQL specifics live **only** inside `adapter-express`. The IR and shared
packages stay neutral; the sole sanctioned shared touch is exporting two types from `expr-ts`'s
embeddable runtime (§5).

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **All three threads (auth seam, permissions enforcement, react-admin) in one 8C spec.** | Closes Phase 8 in one pass; the threads share the permission context and HTTP contract. |
| D2 | **Thin JWT auth seam, not a fully generated auth stack.** Generator owns verify-middleware, `/auth/login` wiring, and the permission-context builder (overwrite). The **user store, password policy, and JWT secret live in a protected `src/auth/store.ts`** (seed, write-once) — a dev stub seeding one user per IR role, hand-replaced for real auth. **No `users` table in the IR-derived schema.** | Identity isn't in the IR; the generator must not own security-sensitive credential policy. Keeps generation IR-focused; the seam is still loginnable and enforceable. |
| D3 | **Permissions projected by a pure `projectExpressPermissions(doc, roles)`** mirroring `projectFilamentPermissions`; enforcement is a separate concern. | Same projection-vs-emission split that earns the other adapters their unit + golden coverage. |
| D4 | **Three enforcement levels, all fail-closed:** action gate, record condition, field-level read/write — **field rules enforced, not gapped** (the Express differentiator). | Express is from-scratch and capable; reusing the Ring-1 evaluator per field is natural. The only gap is `conditionContext`. |
| D5 | **Ring-1 via `emitTs` + vendored `tsRuntimeSource`.** Each grant `condition` / field-rule `when` is emitted as a TS function over the vendored, conformance-tested `r` runtime. No AST ships at runtime. | Reuses two already-tested `expr-ts` exports; conditions are inspectable, golden-locked TS; structurally matches Filament's emit path. |
| D6 | **Enforcement runs inside the route handlers via generated guard helpers**, not a re-fetching `:id` middleware. | A standalone middleware would fetch the record only to evaluate the condition, then the handler fetches again. Guard helpers on the single query path = one DB round-trip. |
| D7 | **react-admin (ra-core) + a thin generated dataProvider**, in an `admin/` sub-app (own `package.json`, Vite). Dev proxy `/api`+`/auth` → Express (no CORS). | Mature CRUD admin for little generated code; the thin provider speaks exactly our API shape. The admin is dumb about permissions — the server enforces. |
| D8 | **Fail-closed evaluation is the single allow chokepoint:** only `{ok:true, value:true}` allows; any other `EvalResult` (incl. `TYPE_MISMATCH`/`UNKNOWN_VAR`/`value:false`) denies. | A malformed condition can never accidentally grant. |

## 3. Auth seam (`auth.ts`)

- **Generated (overwrite):**
  - `src/auth/verify.ts` — JWT-verify middleware. Verifies the bearer token with the store's secret,
    reads `{sub, role}`, then **hydrates the full user via `store.getUser(sub)`** (token stays small;
    attributes stay authoritative) → `req.camisUser = { id, role, ...attrs }`. Augments the Express
    `Request` type via a generated `.d.ts`.
  - `src/auth/login.ts` — `POST /auth/login` → `store.verifyCredentials(email, pw)` → signs a JWT
    `{ sub, role }` with `store.jwtSecret`.
  - The permission-context builder that flattens `{ user.*, record.* }` into the Ring-1 eval `data` map.
- **Protected (seed):** `src/auth/store.ts` — exports `verifyCredentials`, `getUser`, `jwtSecret`.
  Default stub: an in-memory map of **deterministic dev users, one per IR role**, with known dev
  credentials (so the gated boot can log in). Marked "replace for production".
- **Anonymous handling:** no/invalid token → if the IR defines a role named `public`, the caller gets
  that role's grants; otherwise `401`. Lets the model express public access without a magic flag.

## 4. Permissions projection & enforcement

### 4.1 `permissions/project.ts` (pure)
`projectExpressPermissions(doc, roles): ExpressPermissions` →
- `grants`: by `role × contentType` → set of actions.
- `conditions`: by `role × contentType` → grant `Expression` (record-level).
- `fieldRules`: by `role × contentType` → `[{ field, access: "read"|"write", when?: Expression }]`.
- `gaps`: a `conditionContext` downgrade when a `condition`/`when` references free vars outside
  `user.*` / `record.<field>` (mirrors Filament; such a rule denies).

Action vocabulary is the IR's `create | read | update | delete | publish` (no `list`). HTTP mapping:
`GET /` and `GET /:id` → `read`; `POST /` → `create`; `PATCH /:id` → `update`; `DELETE /:id` →
`delete`. **`publish` has no REST analog in the generated CRUD API** (its semantics — which field
flips — are not defined by the permission model); a grant including `publish` is reported as a
`publishAction` capability gap (downgrade) and otherwise ignored, rather than inventing a route.

### 4.2 `permissions/enforce.ts` + permission-aware routes
The route emitter (extended from 8B) calls generated guard helpers on the single query path (D6):
- `authorizeAction(role, ct, action)` → `403` if the role has no grant.
- `applyRecordCondition(role, ct, row)` → evaluate the grant condition with `{user, record}`; deny ⇒
  `404` on `:id` routes. On list, **filter rows app-side** (fetch → drop denied rows), then sort, then
  paginate; the count header reflects the *filtered* set. (SQL pushdown deferred — known limitation.)
- `filterRead(role, ct, row)` → strip fields whose read-rule denies, per-record, Ring-1-aware.
- `stripWrites(role, ct, body)` → **silently drop** fields whose write-rule denies (so react-admin's
  whole-record PATCH still works), before insert/update.

**`record.*` binding:** for **read** rules and record conditions, `record.*` is the stored row; for
**write** rules, `record.*` binds to the *proposed* record (create: the request body; update: the
existing row merged with the body). All four helpers route through the fail-closed chokepoint (D8).

### 4.3 react-admin REST contract (routes addendum)
The list route gains `_start/_end/_sort/_order` handling and a `Content-Range` total-count header;
`DELETE` returns `{ id }`. These let a thin generated dataProvider drive react-admin's list/delete.

## 5. Ring-1 mechanism (`permissions/ring1.ts`)

- Vendor `tsRuntimeSource()` verbatim → generated `src/ring1/runtime.ts` (overwrite, marked).
  **`expr-ts` is extended once** so the embeddable runtime **exports `Value` and `EvalResult`** (its
  legitimate public surface) — `conditions.ts` imports `{ r }` plus those types from `./runtime`.
- Each grant `condition` and field-rule `when` is emitted via `emitTs(expr)` into generated
  `src/permissions/conditions.ts`, with deterministic, collision-free keys:
  `c__<role>__<Type>__<action>` (conditions), `f__<role>__<Type>__<field>__<access>` (field rules).
  Example:
  ```ts
  export const c__editor__Article__update = (data: Record<string, Value>): EvalResult =>
    r.eq(() => r.var(data, "user.id"), () => r.var(data, "record.author_id"));
  ```
- Guard helpers build `data` by flattening `{ user.*, record.* }`, call the keyed fn, and apply D8.

## 6. React admin (`admin/` sub-app)

Generated files: `admin/package.json`, `admin/vite.config.ts` (dev proxy `/api`+`/auth` → Express; no
CORS), `admin/src/App.tsx` (`<Admin>` + one `<Resource>` per content type), `admin/src/dataProvider.ts`
(thin REST provider matching our routes + `Authorization: Bearer`), `admin/src/authProvider.ts` (login
→ `/auth/login`, store token, `getPermissions` decodes role from the JWT).

Per-resource views generated from IR fields: `<Datagrid>`/list + `<Edit>`/`<Create>` forms. Field →
input: `string/text/email/uid→TextInput`, `richText→` (TextInput multiline), `boolean→BooleanInput`,
`enumeration→SelectInput`, `integer/float/decimal→NumberInput`, `date/dateTime→DateTimeInput`,
relation `manyToOne/oneToOne→ReferenceInput`. `component`/`dynamicZone` → capability gap, omitted from
the UI. (A `ReferenceInput`'s related list is itself permission-gated — correct behavior.)

The admin gates nothing client-side beyond optionally hiding create buttons via `getPermissions`;
enforcement is server-side only (YAGNI on client gating).

## 7. Generation orchestration

`expressAdapterFor(dialect).generate(ir, options)` (the dialect already bound) additionally:
1. `projectExpressPermissions(doc, ir.roles)` → grants/conditions/fieldRules/gaps (merged into the
   result `gaps`).
2. Emit auth files (`auth/verify.ts`, `auth/login.ts` overwrite; `auth/store.ts` seed).
3. Emit `ring1/runtime.ts` (vendored) + `permissions/conditions.ts` (emitTs) + `permissions/enforce.ts`.
4. Emit permission-aware routes (action/condition/field guards + list range/sort/count + `DELETE`
   returning `{ id }`); a granted `publish` action yields a `publishAction` gap (no route).
5. Emit the `admin/` sub-app.
6. Continue to emit `camis.schema.json` (document-level; roles are an enforced input, not part of the
   content-model round-trip).

## 8. Verification

- **Unit:** `projectExpressPermissions` (grants/conditions/fieldRules/`conditionContext` gap); HTTP→action
  mapping; fail-closed eval (a `TYPE_MISMATCH`/`UNKNOWN_VAR`/`false` all deny); field read-strip and
  write-strip; condition key scheme.
- **Golden (sqlite):** the 8B catalog fixture + a **roles fixture** → emitted `auth/*`, `permissions/*`,
  `conditions.ts`, permission-aware `routes/*`, `admin/*`, file-listing; idempotent (seed files via
  `materialize`).
- **Round-trip:** unchanged from 8B (document-level) — still green.
- **Gated boot (extends the 3-DB matrix):** generate → `drizzle-kit push` → boot API → **log in via the
  stub** → exercise an **allowed vs a denied path** (denied must `403`/`404` — proves enforcement) → a
  **field-stripped read** (a read-denied field absent from the response) → `npm run build` the `admin/`
  sub-app (proves it type-checks + bundles).

## 9. Exit criteria (8C — closes Phase 8)

- An `Article`+roles IR generates a **booting, permission-enforced** Express API + a **building**
  react-admin, on `sqlite | mysql | pgsql`.
- Denied action/record/field paths are **enforced** (verified on denied paths, not just described).
- Ring-1 conditions evaluate via the vendored conformance-tested runtime; fail-closed.
- Round-trip still green; `conditionContext`/`publishAction`/`component`/`dynamicZone` reported as gaps.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green; 8A/8B goldens unchanged except intended
  file-listing growth.

## 10. Cross-cutting

- IR is the single source of truth; all auth/JWT/react-admin/SQL specifics confined to `adapter-express`;
  the sole shared touch is exporting two types from `expr-ts`'s embeddable runtime.
- One-way authoritative generation; Ring-1 reuses `expr-ts` (no cross-language emission, no PHP).
- Generated regions overwrite; `auth/store.ts` is protected (seed). Enforcement enforces (denied-path
  tests), never merely describes.
- Determinism: stable condition keys, stable ordering, escaped literals, no timestamps — goldens and
  idempotent regen hold.
