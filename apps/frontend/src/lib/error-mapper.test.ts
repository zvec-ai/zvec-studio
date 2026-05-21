import { describe, expect, it } from 'vitest';

import {
  errorTitleKey,
  mapProblem,
  mapUnknownError,
  type ProblemDetails,
} from './error-mapper';

describe('mapProblem', () => {
  it('maps a known code to its i18n key with status-derived severity', () => {
    const problem: ProblemDetails = {
      code: 'COLLECTION_NOT_FOUND',
      detail: 'Collection x missing',
      traceId: '01H-abc',
    };
    const err = mapProblem(problem, 404);
    expect(err.code).toBe('COLLECTION_NOT_FOUND');
    expect(err.messageKey).toBe('errors.code.COLLECTION_NOT_FOUND');
    expect(err.traceId).toBe('01H-abc');
    expect(err.severity).toBe('warning'); // 4xx
  });

  it('falls back to INTERNAL_ERROR on unknown codes', () => {
    const err = mapProblem({ code: 'UNKNOWN_BUG', detail: 'oops' }, 500);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.severity).toBe('error'); // 5xx
  });

  it('prefers detail over title when building the message', () => {
    const err = mapProblem({ title: 'Title', detail: 'Detail', code: 'INVALID_SCHEMA' }, 400);
    expect(err.message).toBe('Detail');
  });

  it('keeps the traceId null when the payload does not provide one', () => {
    const err = mapProblem({ code: 'INVALID_SCHEMA', detail: 'nope' }, 400);
    expect(err.traceId).toBeNull();
  });
});

describe('mapUnknownError', () => {
  it('classifies TypeError as network failure', async () => {
    const err = await mapUnknownError(new TypeError('Failed to fetch'));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
    expect(err.severity).toBe('error');
  });

  it('parses a Response with Problem Details body and echoes the x-trace-id', async () => {
    const body = JSON.stringify({ code: 'DIMENSION_MISMATCH', detail: 'dim 2 != 4' });
    const response = new Response(body, {
      status: 400,
      headers: {
        'Content-Type': 'application/problem+json',
        'x-trace-id': '01H-trace',
      },
    });
    const err = await mapUnknownError(response);
    expect(err.code).toBe('DIMENSION_MISMATCH');
    expect(err.status).toBe(400);
    expect(err.traceId).toBe('01H-trace');
  });

  it('falls back when the response body is not JSON', async () => {
    const response = new Response('not json', { status: 502, statusText: 'Bad Gateway' });
    const err = await mapUnknownError(response);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.status).toBe(502);
    expect(err.message).toContain('not json');
  });

  it('treats bare Errors as INTERNAL_ERROR', async () => {
    const err = await mapUnknownError(new Error('boom'));
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.status).toBe(500);
  });

  it('handles non-Error throwables', async () => {
    const err = await mapUnknownError('something weird');
    expect(err.code).toBe('INTERNAL_ERROR');
  });
});

describe('errorTitleKey', () => {
  it('uses errors.network for NETWORK_ERROR', () => {
    expect(
      errorTitleKey({
        code: 'NETWORK_ERROR',
        messageKey: 'errors.code.INTERNAL_ERROR',
        message: '',
        status: 0,
        traceId: null,
        severity: 'error',
      }),
    ).toBe('errors.network');
  });

  it('uses the messageKey for regular errors', () => {
    expect(
      errorTitleKey({
        code: 'INVALID_SCHEMA',
        messageKey: 'errors.code.INVALID_SCHEMA',
        message: '',
        status: 400,
        traceId: null,
        severity: 'warning',
      }),
    ).toBe('errors.code.INVALID_SCHEMA');
  });
});
