import { defineWorkspace } from "vitest/config";

// Each package owns its tests; this root workspace makes a single `vitest` run
// discover them all while `pnpm -r test` still works per-package.
export default defineWorkspace(["packages/*"]);
