/**
 * What a call's literal arguments say, read without running the code that makes the call: a
 * JavaScript object or array, or a PHP array, of strings, numbers, booleans and null. A value that
 * is anything else (a function, a variable, a template string) reads as OPAQUE, and reading
 * goes on past it, so a file is still read for what it does declare.
 */
export const OPAQUE: unique symbol = Symbol("opaque");
export type Literal =
  | string
  | number
  | boolean
  | null
  | typeof OPAQUE
  | Literal[]
  | { [key: string]: Literal };

type Token =
  | { kind: "string"; value: string }
  | { kind: "template" }
  | { kind: "number"; value: number }
  | { kind: "word"; value: string }
  | { kind: "punct"; value: string };

const PUNCT = ["=>", "::", "?.", "...", "{", "}", "[", "]", "(", ")", ",", ":", ";", "=", "."];
const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) i++;
    else if (source.startsWith("//", i) || c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      let value = "";
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\" && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += ESCAPES[next] ?? next;
          i += 2;
        } else value += source[i++];
      }
      i++;
      tokens.push(c === "`" ? { kind: "template" } : { kind: "string", value });
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^-?[0-9][0-9_]*(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?/i.exec(source.slice(i))!;
      tokens.push({ kind: "number", value: Number(m[0].replace(/_/g, "")) });
      i += m[0].length;
    } else if (/[A-Za-z_$\\]/.test(c)) {
      const m = /^[A-Za-z_$\\][\w$\\]*/.exec(source.slice(i))!;
      tokens.push({ kind: "word", value: m[0] });
      i += m[0].length;
    } else {
      const p = PUNCT.find((x) => source.startsWith(x, i)) ?? c;
      tokens.push({ kind: "punct", value: p });
      i += p.length;
    }
  }
  return tokens;
};

const isPunct = (t: Token | undefined, value: string): boolean =>
  t?.kind === "punct" && t.value === value;

class Reader {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  /** Steps over one value it cannot read: up to the `,` or closing bracket that ends it. */
  private skip(): typeof OPAQUE {
    const stack: string[] = [];
    for (; this.at < this.tokens.length; this.at++) {
      const t = this.tokens[this.at]!;
      if (t.kind !== "punct") continue;
      if (OPEN[t.value] !== undefined) stack.push(OPEN[t.value]!);
      else if (["}", "]", ")"].includes(t.value)) {
        if (stack.length === 0) break;
        stack.pop();
      } else if (t.value === "," && stack.length === 0) break;
    }
    return OPAQUE;
  }

  /** Whether the value starting here ends where a value ends (so it is whole, not an expression). */
  private endsHere(): boolean {
    const t = this.peek();
    return t === undefined || [",", "}", "]", ")", ";"].some((p) => isPunct(t, p));
  }

  value(): Literal {
    const start = this.at;
    const t = this.peek();
    let read: Literal = OPAQUE;
    if (t?.kind === "string" || t?.kind === "number") {
      this.at++;
      read = t.value;
    } else if (t?.kind === "word" && ["true", "false", "null"].includes(t.value.toLowerCase())) {
      this.at++;
      read = t.value.toLowerCase() === "null" ? null : t.value.toLowerCase() === "true";
    } else if (isPunct(t, "{")) read = this.object();
    else if (isPunct(t, "[")) read = this.array();
    else if (
      t?.kind === "word" &&
      t.value.toLowerCase() === "array" &&
      isPunct(this.peek(1), "(")
    ) {
      this.at++;
      read = this.array();
    }
    if (read !== OPAQUE && this.endsHere()) return read;
    this.at = start;
    return this.skip();
  }

  // A JavaScript object: `{ key: value, "key": value }`.
  private object(): Literal {
    this.at++;
    const out: Record<string, Literal> = {};
    while (this.peek() !== undefined && !isPunct(this.peek(), "}")) {
      const key = this.peek();
      if ((key?.kind === "word" || key?.kind === "string") && isPunct(this.peek(1), ":")) {
        this.at += 2;
        out[String(key.value)] = this.value();
      } else this.skip();
      if (isPunct(this.peek(), ",")) this.at++;
      else if (!isPunct(this.peek(), "}")) return OPAQUE;
    }
    this.at++;
    return out;
  }

  // A JavaScript array, or a PHP array: a list, or a map once its first entry has `=>`.
  private array(): Literal {
    const close = isPunct(this.peek(), "(") ? ")" : "]";
    this.at++;
    const list: Literal[] = [];
    const map: Record<string, Literal> = {};
    let keyed = false;
    while (this.peek() !== undefined && !isPunct(this.peek(), close)) {
      const key = this.peek();
      if ((key?.kind === "string" || key?.kind === "number") && isPunct(this.peek(1), "=>")) {
        keyed = true;
        this.at += 2;
        map[String(key.value)] = this.value();
      } else list.push(this.value());
      if (isPunct(this.peek(), ",")) this.at++;
      else if (!isPunct(this.peek(), close)) return OPAQUE;
    }
    this.at++;
    if (keyed && list.length > 0) return OPAQUE;
    return keyed ? map : list;
  }

  /** The module's value: `export default`, `module.exports =` or a PHP file's `return`. */
  exported(): Literal | undefined {
    const word = (i: number, value: string): boolean =>
      this.tokens[i]?.kind === "word" && (this.tokens[i] as { value: string }).value === value;
    for (let i = 0; i < this.tokens.length; i++) {
      const skip =
        word(i, "export") && word(i + 1, "default")
          ? 2
          : word(i, "module") && isPunct(this.tokens[i + 1], ".") && word(i + 2, "exports")
            ? 4
            : word(i, "return")
              ? 1
              : 0;
      if (skip === 0) continue;
      this.at = i + skip;
      return this.value();
    }
    return undefined;
  }

  /** The arguments of the first call to `name`, or undefined when there is none. */
  callArguments(name: string): Literal[] | undefined {
    const at = this.tokens.findIndex(
      (t, i) => t.kind === "word" && t.value === name && isPunct(this.tokens[i + 1], "("),
    );
    if (at === -1) return undefined;
    this.at = at + 2;
    const args: Literal[] = [];
    while (this.peek() !== undefined && !isPunct(this.peek(), ")")) {
      args.push(this.value());
      if (isPunct(this.peek(), ",")) this.at++;
      else if (!isPunct(this.peek(), ")")) return undefined;
    }
    return args;
  }
}

/** The literal arguments of the source's first call to `name` (JavaScript, TypeScript or PHP). */
export const readCallArguments = (source: string, name: string): Literal[] | undefined =>
  new Reader(tokenize(source)).callArguments(name);

/** The literal a module exports (JavaScript or TypeScript) or a PHP file returns. */
export const readExportedValue = (source: string): Literal | undefined =>
  new Reader(tokenize(source)).exported();
