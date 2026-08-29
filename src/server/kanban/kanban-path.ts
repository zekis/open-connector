interface PathKeyToken {
  kind: "key";
  key: string;
}

interface PathIndexToken {
  kind: "index";
  index: number;
}

interface PathWildcardToken {
  kind: "wildcard";
}

type PathToken = PathKeyToken | PathIndexToken | PathWildcardToken;

/** Select values using a bounded JSONPath subset: keys, quoted keys, array indexes, and wildcards. */
export function selectKanbanPath(value: unknown, path: string): unknown[] {
  let values = [value];
  for (const token of parseKanbanPath(path)) {
    const next: unknown[] = [];
    for (const candidate of values) {
      if (token.kind === "key") {
        if (isRecord(candidate) && Object.hasOwn(candidate, token.key)) next.push(candidate[token.key]);
        continue;
      }
      if (token.kind === "index") {
        if (Array.isArray(candidate) && token.index < candidate.length) next.push(candidate[token.index]);
        continue;
      }
      if (Array.isArray(candidate)) next.push(...candidate);
      else if (isRecord(candidate)) next.push(...Object.values(candidate));
    }
    values = next;
  }
  return values;
}

export function selectKanbanItems(value: unknown, path: string): unknown[] {
  return selectKanbanPath(value, path).flatMap((item) => (Array.isArray(item) ? item : [item]));
}

function parseKanbanPath(path: string): PathToken[] {
  const source = path.trim();
  if (!source) throw new KanbanPathError("A JSON path cannot be empty.");
  const tokens: PathToken[] = [];
  let index = source.startsWith("$") ? 1 : 0;
  while (index < source.length) {
    if (source[index] === ".") {
      index += 1;
      if (source[index] === ".") throw new KanbanPathError("Recursive JSON paths are not supported.");
    }
    if (source[index] === "[") {
      const bracket = readBracketToken(source, index);
      tokens.push(bracket.token);
      index = bracket.next;
      continue;
    }
    const start = index;
    while (index < source.length && source[index] !== "." && source[index] !== "[") index += 1;
    const key = source.slice(start, index).trim();
    if (!key) throw new KanbanPathError(`Invalid JSON path: ${path}.`);
    tokens.push(key === "*" ? { kind: "wildcard" } : { kind: "key", key });
  }
  return tokens;
}

function readBracketToken(source: string, start: number): { token: PathToken; next: number } {
  const end = findBracketEnd(source, start);
  const content = source.slice(start + 1, end).trim();
  if (content === "*") return { token: { kind: "wildcard" }, next: end + 1 };
  if (/^\d+$/.test(content)) return { token: { kind: "index", index: Number(content) }, next: end + 1 };
  if (
    content.length >= 2 &&
    ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'")))
  ) {
    const key =
      content[0] === '"'
        ? (JSON.parse(content) as string)
        : content.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\");
    return { token: { kind: "key", key }, next: end + 1 };
  }
  throw new KanbanPathError(`Unsupported JSON path bracket: [${content}].`);
}

function findBracketEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "]") return index;
  }
  throw new KanbanPathError(`Unclosed JSON path bracket: ${source}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class KanbanPathError extends Error {}
