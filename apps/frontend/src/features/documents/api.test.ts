import { describe, expect, it } from 'vitest';

import { buildExportUrl } from './api';

describe('buildExportUrl', () => {
  const base = '/api/v1';

  it('defaults to jsonl with vectors included', () => {
    expect(buildExportUrl(base, 'demo', { includeVector: true })).toBe(
      '/api/v1/collections/demo/documents:export?includeVector=true&format=jsonl',
    );
  });

  it('omits vectors when disabled', () => {
    expect(buildExportUrl(base, 'demo', { includeVector: false })).toContain('includeVector=false');
  });

  it('joins output fields with commas', () => {
    const url = buildExportUrl(base, 'demo', {
      includeVector: false,
      outputFields: ['title', 'score'],
    });
    expect(url).toContain('outputFields=title%2Cscore');
  });

  it('skips an empty output field list', () => {
    const url = buildExportUrl(base, 'demo', { includeVector: true, outputFields: [] });
    expect(url).not.toContain('outputFields');
  });

  it('encodes the collection name', () => {
    const url = buildExportUrl(base, 'my collection', { includeVector: true });
    expect(url).toContain('/collections/my%20collection/documents:export');
  });

  it('honours an absolute base url (Tauri sidecar)', () => {
    const url = buildExportUrl('http://127.0.0.1:7861/api/v1', 'demo', {
      includeVector: true,
    });
    expect(url.startsWith('http://127.0.0.1:7861/api/v1/collections/demo')).toBe(true);
  });

  it('adds mode=snapshot for snapshot exports', () => {
    const url = buildExportUrl(base, 'demo', { includeVector: true, mode: 'snapshot' });
    expect(url).toContain('mode=snapshot');
  });

  it('omits the mode param for data exports', () => {
    const url = buildExportUrl(base, 'demo', { includeVector: true, mode: 'data' });
    expect(url).not.toContain('mode=');
  });
});
