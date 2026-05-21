import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  it('invokes the error sink when a query throws', async () => {
    const onError = vi.fn();
    const client = createQueryClient({ onError });
    await expect(
      client.fetchQuery({
        queryKey: ['boom'],
        queryFn: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not retry 4xx Response failures', async () => {
    const onError = vi.fn();
    const client = createQueryClient({ onError });
    let calls = 0;
    await expect(
      client.fetchQuery({
        queryKey: ['client-error'],
        queryFn: () => {
          calls += 1;
          throw new Response('bad', { status: 400 });
        },
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(calls).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx Response failures then surfaces the error', async () => {
    const client = createQueryClient();
    let calls = 0;
    await expect(
      client.fetchQuery({
        queryKey: ['server-error'],
        queryFn: () => {
          calls += 1;
          throw new Response('err', { status: 503 });
        },
      }),
    ).rejects.toBeInstanceOf(Response);
    // retry: (failureCount, err) => failureCount < 1 for 5xx -> total 2 attempts
    expect(calls).toBe(2);
  });

  it('mutations do not retry by default', async () => {
    const client = createQueryClient();
    let calls = 0;
    await expect(
      client.getMutationCache().build(client, {
        mutationFn: () => {
          calls += 1;
          throw new Error('nope');
        },
      }).execute(undefined),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });
});
