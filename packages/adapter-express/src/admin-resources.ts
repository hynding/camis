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
      return ref
        ? { jsx: `<ReferenceField source="${c}_id" reference="${ref}" />`, comp: "ReferenceField" }
        : null;
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
      const values = (f as Field & { values?: string[] }).values ?? [];
      const choices = values
        .map((v) => `{ id: ${JSON.stringify(v)}, name: ${JSON.stringify(v)} }`)
        .join(", ");
      return { jsx: `<SelectInput source="${c}" choices={[${choices}]} />`, comp: "SelectInput" };
    }
    case "relation": {
      const fr = f as Field & { relationKind: string; target: string };
      if (fr.relationKind !== "manyToOne" && fr.relationKind !== "oneToOne") return null;
      const ref = refTable(doc, fr.target);
      return ref
        ? { jsx: `<ReferenceInput source="${c}_id" reference="${ref}" />`, comp: "ReferenceInput" }
        : null;
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
