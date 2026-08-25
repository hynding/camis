#!/usr/bin/env node
// camis bin wrapper: the workspace ships TypeScript sources with no build step, so this
// registers tsx's ESM loader at runtime and then loads the real entry point.
import { register } from "tsx/esm/api";

register();
await import("../src/bin.ts");
