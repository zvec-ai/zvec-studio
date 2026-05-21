/**
 * Maps backend RFC 7807 Problem Details into user-facing Toast content.
 *
 * The backend always returns ``application/problem+json`` for business errors
 * with a stable ``code`` field. We expose a small adapter that:
 *  1. Accepts the raw fetch ``Response`` (or a thrown ``Error``);
 *  2. Returns a typed :class:`UserFacingError` the UI can localize and render.
 *
 * The mapping intentionally degrades gracefully: malformed payloads, network
 * errors or opaque 5xx responses all resolve to a safe ``INTERNAL_ERROR``
 * default so the UI never crashes.
 */

export interface ProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly status?: number;
  readonly code?: string;
  readonly traceId?: string;
  readonly [key: string]: unknown;
}

export type ErrorSeverity = 'info' | 'warning' | 'error';

export interface UserFacingError {
  /** Stable machine code (e.g. ``COLLECTION_NOT_FOUND``). */
  readonly code: string;
  /** Localization key under ``errors.code.<code>``; always set. */
  readonly messageKey: string;
  /** Original backend detail, surfaced as a fallback. */
  readonly message: string;
  /** HTTP status; ``0`` for pure network failures. */
  readonly status: number;
  /** ``X-Trace-Id`` echoed by the server; used for support. */
  readonly traceId: string | null;
  /** Severity for Toast styling. */
  readonly severity: ErrorSeverity;
}

const KNOWN_CODES = new Set<string>([
  'COLLECTION_NOT_FOUND',
  'COLLECTION_ALREADY_EXISTS',
  'INVALID_SCHEMA',
  'INVALID_FILTER_EXPRESSION',
  'DOCUMENT_NOT_FOUND',
  'DIMENSION_MISMATCH',
  'CURSOR_EXPIRED',
  'INTERNAL_ERROR',
]);

function severityFor(status: number): ErrorSeverity {
  if (status === 0) return 'error';
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'info';
}

function fallback(status: number, message: string, traceId: string | null): UserFacingError {
  return {
    code: 'INTERNAL_ERROR',
    messageKey: 'errors.code.INTERNAL_ERROR',
    message,
    status,
    traceId,
    severity: severityFor(status),
  };
}

/** Parse a Problem Details document into a ``UserFacingError``. */
export function mapProblem(problem: ProblemDetails, status?: number): UserFacingError {
  const resolvedStatus = status ?? problem.status ?? 500;
  const rawCode = typeof problem.code === 'string' ? problem.code : undefined;
  const code = rawCode && KNOWN_CODES.has(rawCode) ? rawCode : 'INTERNAL_ERROR';
  const traceId = typeof problem.traceId === 'string' ? problem.traceId : null;
  const message = problem.detail ?? problem.title ?? 'Unknown error';
  return {
    code,
    messageKey: `errors.code.${code}`,
    message,
    status: resolvedStatus,
    traceId,
    severity: severityFor(resolvedStatus),
  };
}

/** Parse any thrown value / fetch failure into a ``UserFacingError``. */
export async function mapUnknownError(value: unknown): Promise<UserFacingError> {
  // Network / abort errors surface as TypeError under fetch.
  if (value instanceof TypeError) {
    return {
      code: 'NETWORK_ERROR',
      messageKey: 'errors.network',
      message: value.message,
      status: 0,
      traceId: null,
      severity: 'error',
    };
  }

  if (value instanceof Response) {
    const traceId = value.headers.get('x-trace-id');
    try {
      const body = (await value.clone().json()) as ProblemDetails;
      return mapProblem({ ...body, traceId: body.traceId ?? traceId ?? undefined }, value.status);
    } catch {
      const text = await value.clone().text().catch(() => '');
      return fallback(value.status, text || value.statusText || 'Request failed', traceId);
    }
  }

  if (value instanceof Error) {
    return fallback(500, value.message, null);
  }

  return fallback(500, 'Unknown error', null);
}

/** Convenience helper that yields an ``i18next`` key for the given error. */
export function errorTitleKey(err: UserFacingError): string {
  if (err.code === 'NETWORK_ERROR') return 'errors.network';
  return err.messageKey;
}
