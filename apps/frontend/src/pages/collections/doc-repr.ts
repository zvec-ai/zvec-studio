/**
 * Document row representation rules shared with the backend
 * (`zvec_studio/storage/doc_repr.py`) — keep the two in sync.
 *
 * Zvec keeps the primary key (`Doc.id`) beside the columns, and a column may
 * be named `id`, which a naive flat mapping would let shadow the key. When
 * such a column exists the primary key travels under the reserved `$id` key.
 * `$id` cannot collide with a user column: the zvec engine rejects `$` in
 * column names at create time (Studio enforces the same regex).
 */

/** Row key carrying the primary key for an ordinary schema. */
export const PK_KEY = 'id';
/** First reserved fallback when a column occupies `id`. */
export const RESERVED_PK_KEY = '$id';

export interface SchemaLike {
  fields?: ReadonlyArray<{ name: string }> | null;
  vectors?: ReadonlyArray<{ name: string }> | null;
}

/** The row key that carries the primary key for *schema*. */
export function primaryKeyFor(schema: SchemaLike): string {
  const columns = [...(schema.fields ?? []), ...(schema.vectors ?? [])];
  return columns.some((c) => c.name === PK_KEY) ? RESERVED_PK_KEY : PK_KEY;
}

/** Read the primary key out of a document row; null when absent. */
export function primaryKeyOf(row: Record<string, unknown>, pkKey: string): string | null {
  const value = row[pkKey];
  return value === null || value === undefined ? null : String(value);
}
