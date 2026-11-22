import { apiActionGaps, customCodeGaps, publicApiActionGaps } from "./custom-code";
import {
  buildManifest,
  expandComponents,
  privateFieldGaps,
  type ExpandedContentType,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { decimalsBeyondDouble, normalize } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import { adminResourceFiles } from "./admin-resources";
import { adminStaticFiles } from "./admin-app";
import { aiColumnsOf, aiFiles, hasAiField } from "./ai";
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
import { emitMorphsFile, morphLinks } from "./morphs";
import { resolveRelations } from "./relations";
import { emitRoutes } from "./routes";
import { emitSchemaFile } from "./schema";
import { skeletonFiles } from "./skeleton";
import { expressReservedNameGaps } from "./reserved-names";

// "  author_id: integer('author_id').references(...)," → "author_id"
const fkNames = (lines: string[]): string[] => lines.map((l) => l.trim().split(":")[0]!.trim());

const namedConditions = (perms: ExpressPermissions): NamedCondition[] => {
  const out: NamedCondition[] = [];
  for (const [role, byCt] of Object.entries(perms.conditions)) {
    for (const [ct, byAction] of Object.entries(byCt)) {
      for (const [action, expr] of Object.entries(byAction)) {
        out.push({ key: conditionKey(role, ct, action), expr });
      }
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

/**
 * Drizzle answers a decimal as a string on MySQL and PostgreSQL, and one beyond a double on SQLite
 * too (its column is text there), and the generated list sorts rows in JavaScript, comparing such
 * strings as text. Express's JSON body parser reads a JSON number as a double.
 */
const expressDecimalGaps = (doc: IrDocument): CapabilityGap[] =>
  decimalsBeyondDouble(doc).map(({ location, digits }) => ({
    feature: "decimalPrecision",
    location,
    severity: "downgrade",
    message: `"${location.field}" keeps its ${digits.precision} digits as a string, which the generated API's list sorts as text, not as a number, on every database; a JSON number sent for it is read as a double first, so an exact value is sent as a string`,
  }));

export const expressAdapterFor = (dialect: Dialect): GenerateAdapter => ({
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc, dialect);
    const links = morphLinks(doc);
    const secured = ir.roles.length > 0;
    const gaps: CapabilityGap[] = [
      ...expressReservedNameGaps(doc),
      ...privateFieldGaps(doc, "the Express target"),
      ...customCodeGaps(doc),
      ...apiActionGaps(doc),
      ...publicApiActionGaps(doc),
      ...expressDecimalGaps(doc),
    ];
    const files: GeneratedFile[] = [
      ...skeletonFiles(doc, options.projectName, dialect, { secured }),
    ];

    const expansions = new Map<string, ExpandedContentType>();
    doc.contentTypes.forEach((ct) => {
      if (ct.builtin === "file") {
        gaps.push({
          feature: "builtinFile",
          location: { contentType: ct.name },
          severity: "downgrade",
          message: `"${ct.name}" is the media library's files; the Express target has no media library, so it is a plain table and media fields stay text columns`,
        });
      }
      if (ct.options?.localized === true) {
        gaps.push({
          feature: "localized",
          location: { contentType: ct.name },
          severity: "downgrade",
          message: `"${ct.name}" is localized; the Express target keeps one row per record, in no locale`,
        });
      }
      for (const f of ct.fields) {
        if (["relation", "component", "polymorphicRelation", "polymorphicInverse"].includes(f.type))
          continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Express target`,
          });
        }
      }
      const expansion = expandComponents(doc, ct);
      expansions.set(ct.name, expansion);
      gaps.push(...expansion.gaps);
      const fk = rel.fkColumns.get(ct.name) ?? [];
      files.push({
        path: `src/routes/${expressNames(ct).table}.ts`,
        content: emitRoutes(ct, fkNames(fk), {
          secured,
          aiColumns: aiColumnsOf(ct),
          links: links.own.has(ct.name) ? "own" : links.inverses.has(ct.name) ? "inverse" : "none",
        }),
      });
    });

    files.push({
      path: "src/db/schema.ts",
      content: emitSchemaFile(doc.contentTypes, dialect, rel, expansions, links),
    });
    if (links.own.size > 0)
      files.push({ path: "src/morphs.ts", content: emitMorphsFile(doc, links) });
    files.push(camisSchemaFile(doc));

    if (hasAiField(doc)) files.push(...aiFiles(doc));

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
