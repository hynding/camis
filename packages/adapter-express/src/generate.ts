import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { adminResourceFiles } from "./admin-resources";
import { adminStaticFiles } from "./admin-app";
import { authFiles } from "./auth";
import { type Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { camisSchemaFile } from "./import";
import { expressNames } from "./names";
import { emitEnforce } from "./permissions/enforce";
import { projectExpressPermissions, type ExpressPermissions } from "./permissions/project";
import {
  conditionKey,
  emitConditionsFile,
  fieldRuleKey,
  ring1RuntimeFile,
  type NamedCondition,
} from "./permissions/ring1";
import { resolveRelations } from "./relations";
import { emitRoutes } from "./routes";
import { emitSchemaFile } from "./schema";
import { skeletonFiles } from "./skeleton";

// "  author_id: integer('author_id').references(...)," → "author_id"
const fkNames = (lines: string[]): string[] => lines.map((l) => l.trim().split(":")[0]!.trim());

const namedConditions = (perms: ExpressPermissions): NamedCondition[] => {
  const out: NamedCondition[] = [];
  for (const [role, byCt] of Object.entries(perms.conditions)) {
    for (const [ct, expr] of Object.entries(byCt)) {
      out.push({ key: conditionKey(role, ct, "record"), expr });
    }
  }
  for (const [role, byCt] of Object.entries(perms.fieldRules)) {
    for (const [ct, rules] of Object.entries(byCt)) {
      for (const rule of rules) {
        if (rule.when) {
          out.push({ key: fieldRuleKey(role, ct, rule.field, rule.access), expr: rule.when });
        }
      }
    }
  }
  return out;
};

export const expressAdapterFor = (dialect: Dialect): GenerateAdapter => ({
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc, dialect);
    const secured = ir.roles.length > 0;
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [
      ...skeletonFiles(doc, options.projectName, dialect, { secured }),
    ];

    doc.contentTypes.forEach((ct) => {
      for (const f of ct.fields) {
        if (f.type === "relation") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Express target`,
          });
        }
      }
      const fk = rel.fkColumns.get(ct.name) ?? [];
      files.push({
        path: `src/routes/${expressNames(ct).table}.ts`,
        content: emitRoutes(ct, fkNames(fk), { secured }),
      });
    });

    files.push({
      path: "src/db/schema.ts",
      content: emitSchemaFile(doc.contentTypes, dialect, rel),
    });
    files.push(camisSchemaFile(doc));

    if (secured) {
      const perms = projectExpressPermissions(doc, ir.roles);
      gaps.push(...perms.gaps);
      files.push(...authFiles(perms.roles));
      files.push({ path: "src/ring1/runtime.ts", content: ring1RuntimeFile() });
      files.push({
        path: "src/permissions/conditions.ts",
        content: emitConditionsFile(namedConditions(perms)),
      });
      files.push({ path: "src/permissions/enforce.ts", content: emitEnforce(perms, doc) });
      files.push(...adminStaticFiles());
      files.push(...adminResourceFiles(doc));
    }

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
});

export const expressAdapter = expressAdapterFor("sqlite");
