import type { EmbeddingFunctionRecord } from '@/features/ai/api';
import { isDenseEmbedding, isSparseEmbedding } from '@/features/ai/utils';

export interface VectorLike {
  name: string;
  dataType: string;
  dimension?: number | null;
  indexParam?: { indexType?: string | null; metric?: string | null } | null;
}

export type RawVectorValue = number[] | Record<string, number>;

export function isSparseVectorType(dataType: string): boolean {
  return dataType.startsWith('SPARSE_VECTOR');
}

export function isDenseVectorType(dataType: string): boolean {
  return dataType.startsWith('VECTOR') && !isSparseVectorType(dataType);
}

export function vectorDimensionLabel(vector: VectorLike): string {
  return isSparseVectorType(vector.dataType) ? '—' : `${vector.dimension ?? '?'}d`;
}

export function vectorTagLabel(vector: VectorLike): string {
  const idx = vector.indexParam?.indexType ?? 'FLAT';
  return isSparseVectorType(vector.dataType)
    ? `${idx} sparse`
    : `${idx} ${vector.dimension ?? '?'}d`;
}

export function vectorRawTemplate(vector: VectorLike): RawVectorValue {
  if (isSparseVectorType(vector.dataType)) return { '42': 1.0 };
  return Array.from({ length: vector.dimension ?? 3 }, () => 0);
}

export function vectorRawTextTemplate(vector: VectorLike): string {
  return isSparseVectorType(vector.dataType)
    ? '{42: 1.0}'
    : JSON.stringify(vectorRawTemplate(vector), null, 0);
}

export function vectorPlaceholder(vector?: VectorLike | null): string {
  if (!vector) return '[0.1, 0.2, ...]';
  return isSparseVectorType(vector.dataType)
    ? '{42: 1.0, 314: 0.5}'
    : `[0.1, 0.2, ...] (${vector.dimension ?? '?'}d)`;
}

export function randomVectorText(vector: VectorLike): string {
  if (isSparseVectorType(vector.dataType)) {
    return randomSparseVectorText();
  }
  return JSON.stringify(randomDenseVector(vector));
}

function randomDenseVector(vector: VectorLike): number[] {
  const dimension = Math.max(1, Math.floor(vector.dimension ?? 3));
  const values = Array.from({ length: dimension }, () => Math.random() * 2 - 1);
  if ((vector.indexParam?.metric ?? '').toUpperCase() === 'COSINE') {
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
    return values.map((value) => formatDenseNumber(value / norm));
  }
  return values.map(formatDenseNumber);
}

function randomSparseVectorText(): string {
  const entryCount = 6;
  const used = new Set<number>();
  const entries: string[] = [];
  while (entries.length < entryCount) {
    const key = Math.floor(Math.random() * 100_000) + 1;
    if (used.has(key)) continue;
    used.add(key);
    const weight = formatDenseNumber(Math.random() * 0.9 + 0.1);
    entries.push(`${key}: ${weight}`);
  }
  return `{${entries.join(', ')}}`;
}

function formatDenseNumber(value: number): number {
  return Number(value.toFixed(6));
}

export function parseRawVector(text: string, vector?: VectorLike | null): RawVectorValue | null {
  try {
    if (vector && isSparseVectorType(vector.dataType)) {
      return parseSparseVector(text);
    }
    const parsed = JSON.parse(text.trim()) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 0) return null;
    if (!parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

export function formatSparseVectorValue(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  if (!entries.every(([key, weight]) => isSparseKey(key) && typeof weight === 'number' && Number.isFinite(weight))) {
    return null;
  }
  return `{${entries.map(([key, weight]) => `${key}: ${formatSparseWeight(weight as number)}`).join(', ')}}`;
}

function isSparseKey(key: string): boolean {
  if (!/^\d+$/.test(key)) return false;
  const keyNumber = Number(key);
  return Number.isSafeInteger(keyNumber) && keyNumber >= 0 && keyNumber <= 0xFFFFFFFF;
}

function formatSparseWeight(weight: number): string {
  return Number.isInteger(weight) ? weight.toFixed(1) : String(weight);
}

function parseSparseVector(text: string): Record<string, number> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeSparseEntries(Object.entries(parsed));
  } catch {
    // Sparse fields also accept the SDK-shaped shorthand: {42: 1.0, 314: 0.5}.
  }

  const match = /^\{\s*(.*)\s*\}$/.exec(trimmed);
  if (!match) return null;
  const body = match[1].trim();
  if (!body) return null;

  const entries: Array<[string, number]> = [];
  for (const part of body.split(',')) {
    const item = part.trim();
    if (!item) return null;
    const itemMatch = /^(\d+)\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(item);
    if (!itemMatch) return null;
    const value = Number(itemMatch[2]);
    entries.push([itemMatch[1], value]);
  }
  return normalizeSparseEntries(entries);
}

function normalizeSparseEntries(entries: Array<[string, unknown]>): Record<string, number> | null {
  if (entries.length === 0) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (!isSparseKey(key)) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  return out;
}

export function embeddingMatchesVector(
  embedding: EmbeddingFunctionRecord,
  vector: VectorLike | null | undefined,
): boolean {
  if (!vector) return false;
  return isSparseVectorType(vector.dataType)
    ? isSparseEmbedding(embedding.config)
    : isDenseEmbedding(embedding.config);
}
