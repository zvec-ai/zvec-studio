/**
 * Document row representation rules shared with the backend
 * (`zvec_studio/storage/doc_repr.py`) — keep the two in sync.
 *
 * Zvec keeps the primary key (`Doc.id`) beside the columns, and a column may
 * be named `id`, which a naive flat mapping would let shadow the key. The
 * row key carrying the primary key is therefore picked from the reserved
 * chain `id` -> `$id` -> `$$id` -> ... . The zvec engine rejects `$` in
 * column names at create time (Studio enforces the same regex), so in
 * practice the chain stops at `$id`; deeper links are defense in depth.
 */

/** Row key carrying the primary key for an ordinary schema. */
export const PK_KEY = 'id';
/** First reserved fallback when a column occupies `id`. */
export const RESERVED_PK_KEY = '$id';

export interface SchemaLike {
  fields?: ReadonlyArray<{ name: string }> | null;
  vectors?: ReadonlyArray<{ name: string }> | null;
}

/**
 * The row key that carries the primary key for *schema*: the first key of the
 * reserved chain (`id`, `$id`, `$$id`, ...) that no column occupies.
 */
export function primaryKeyFor(schema: SchemaLike): string {
  const names = new Set(
    [...(schema.fields ?? []), ...(schema.vectors ?? [])].map((c) => c.name),
  );
  let key = PK_KEY;
  while (names.has(key)) {
    key = `$${key}`;
  }
  return key;
}

/** Read the primary key out of a document row; null when absent. */
export function primaryKeyOf(row: Record<string, unknown>, pkKey: string): string | null {
  const value = row[pkKey];
  return value === null || value === undefined ? null : String(value);
}
