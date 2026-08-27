import { describe, expect, it } from 'vitest';

import { PK_KEY, RESERVED_PK_KEY, primaryKeyFor, primaryKeyOf } from './doc-repr';

describe('primaryKeyFor', () => {
  it('uses the plain key when no column is named id', () => {
    expect(primaryKeyFor({ fields: [{ name: 'title' }], vectors: [{ name: 'embedding' }] })).toBe(
      PK_KEY,
    );
  });

  it('uses the reserved key when a scalar field is named id', () => {
    expect(primaryKeyFor({ fields: [{ name: 'id' }, { name: 'title' }], vectors: [] })).toBe(
      RESERVED_PK_KEY,
    );
  });

  it('uses the reserved key when a vector is named id', () => {
    expect(primaryKeyFor({ fields: [{ name: 'title' }], vectors: [{ name: 'id' }] })).toBe(
      RESERVED_PK_KEY,
    );
  });

  it('walks the chain when both id and $id are occupied', () => {
    // zvec allows a vector named `$id`; the pk then moves one level deeper.
    expect(
      primaryKeyFor({
        fields: [{ name: 'id' }, { name: 'title' }],
        vectors: [{ name: '$id' }],
      }),
    ).toBe('$$id');
  });

  it('keeps the plain key when only $id is occupied', () => {
    // A `$id` vector does not occupy `id` — no reason to move.
    expect(primaryKeyFor({ fields: [{ name: 'title' }], vectors: [{ name: '$id' }] })).toBe(
      PK_KEY,
    );
  });

  it('falls back to the plain key for an empty schema', () => {
    expect(primaryKeyFor({ fields: [], vectors: [] })).toBe(PK_KEY);
    expect(primaryKeyFor({})).toBe(PK_KEY);
  });
});

describe('primaryKeyOf', () => {
  it('reads the primary key under the resolved key', () => {
    expect(primaryKeyOf({ id: 'doc-1', title: 't' }, PK_KEY)).toBe('doc-1');
    expect(primaryKeyOf({ $id: 'PK-1', id: 'USER-1' }, RESERVED_PK_KEY)).toBe('PK-1');
  });

  it('coerces non-string primary keys to string', () => {
    expect(primaryKeyOf({ id: 42 }, PK_KEY)).toBe('42');
  });

  it('returns null when the primary key is absent or null', () => {
    expect(primaryKeyOf({ title: 't' }, PK_KEY)).toBeNull();
    expect(primaryKeyOf({ id: null }, PK_KEY)).toBeNull();
    expect(primaryKeyOf({ id: undefined }, PK_KEY)).toBeNull();
  });
});
