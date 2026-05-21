/**
 * Entry point for the auto-generated OpenAPI client.
 *
 * ``schema.ts`` is regenerated via ``pnpm --filter frontend gen:api`` and must
 * never be edited by hand. This barrel re-exports the three named types that
 * ``openapi-typescript`` emits so app code can depend on ``components`` /
 * ``paths`` without reaching into the generated file directly.
 */

export type { paths, components, operations } from './schema';
