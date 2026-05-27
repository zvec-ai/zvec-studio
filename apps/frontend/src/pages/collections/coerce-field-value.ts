const NUMERIC_TYPES = new Set([
  'INT32', 'INT64', 'UINT32', 'UINT64', 'FLOAT', 'DOUBLE',
]);
const ARRAY_TYPES = new Set([
  'ARRAY_INT32', 'ARRAY_INT64', 'ARRAY_UINT32', 'ARRAY_UINT64',
  'ARRAY_FLOAT', 'ARRAY_DOUBLE', 'ARRAY_BOOL', 'ARRAY_STRING',
]);

/**
 * Coerce a raw string input to the correct JS type based on the schema dataType.
 * - Numeric scalars → Number (throws if NaN)
 * - BOOL → boolean
 * - ARRAY_* → JSON.parse (must be a valid JSON array)
 * - STRING → string as-is
 *
 * Throws an Error with a human-readable message on invalid input.
 */
export function coerceFieldValue(
  raw: string,
  dataType: string,
  nullable: boolean,
  fieldName: string,
): unknown {
  // Nullable field with empty input → null
  if (nullable && raw === '') return null;
  if (NUMERIC_TYPES.has(dataType)) {
    if (raw === '') return 0;
    const n = Number(raw);
    if (Number.isNaN(n)) {
      throw new Error(`Field '${fieldName}': expected ${dataType}, got "${raw}"`);
    }
    return n;
  }
  if (dataType === 'BOOL') {
    return raw === 'true';
  }
  if (ARRAY_TYPES.has(dataType)) {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) {
        throw new Error(`Field '${fieldName}': expected a JSON array for ${dataType}`);
      }
      return arr;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Field '${fieldName}': invalid JSON for ${dataType}`);
      }
      throw err;
    }
  }
  // STRING or unknown
  return raw;
}
