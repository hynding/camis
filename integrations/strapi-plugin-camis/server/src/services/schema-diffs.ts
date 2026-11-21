/** A difference between the schemas of a pulled archive (source) and this project (destination), as Strapi's engine reports it. */
export type Diff =
  | { kind: 'added' | 'deleted'; path: string[]; type: string; value: unknown }
  | { kind: 'modified'; path: string[]; types: [string, string]; values: [unknown, unknown] };

/** Enterprise plugins CAMIS does not build; Strapi's own `strapi import` already lets review workflows' absence pass. */
const NOT_BUILT = ['plugin::content-releases.', 'plugin::review-workflows.'];

const isEmptyObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;

/** A difference that loses no data: nothing a pull restores depends on it. */
export const isBenign = (uid: string, diff: Diff): boolean => {
  if (diff.kind === 'modified') return false;
  if (diff.path.length === 0) return NOT_BUILT.some((prefix) => uid.startsWith(prefix));
  return (
    diff.path.length === 1 && ['options', 'pluginOptions'].includes(diff.path[0] ?? '') && isEmptyObject(diff.value)
  );
};

/** As `strapi import` words a schema difference. */
export const describeDiff = (uid: string, diff: Diff): string => {
  const path = [uid, ...diff.path].join('.');
  if (diff.kind === 'added') return `${path} does not exist on source`;
  if (diff.kind === 'deleted') return `${path} does not exist on destination`;
  return `${path} has a different data type`;
};
