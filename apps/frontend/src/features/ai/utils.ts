import type { EmbeddingFunctionRecord } from './api';

type EmbeddingConfig = EmbeddingFunctionRecord['config'];

const DENSE_TYPES = new Set(['default_local_dense', 'qwen_dense', 'openai_dense']);
const SPARSE_TYPES = new Set(['default_local_sparse', 'bm25', 'qwen_sparse']);

export function isDenseEmbedding(config: EmbeddingConfig): boolean {
  return DENSE_TYPES.has(config.type);
}

export function isSparseEmbedding(config: EmbeddingConfig): boolean {
  return SPARSE_TYPES.has(config.type);
}

export function getEmbeddingDimension(config: EmbeddingConfig): number | null {
  if ('dimension' in config && typeof config.dimension === 'number') {
    return config.dimension;
  }
  return null;
}

export function getEmbeddingTag(record: EmbeddingFunctionRecord): string {
  const cfg = record.config;
  if (isSparseEmbedding(cfg)) return 'sparse';
  const dim = getEmbeddingDimension(cfg);
  return dim ? `${dim}d` : 'dense';
}
