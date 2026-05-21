import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api-client-context';

export interface HealthzResponse {
  readonly status: string;
  readonly version: string;
  readonly zvecVersion: string;
}

export const healthzQueryKey = ['system', 'healthz'] as const;

export function useHealthz(): UseQueryResult<HealthzResponse, unknown> {
  const client = useApiClient();
  return useQuery({
    queryKey: healthzQueryKey,
    queryFn: ({ signal }) => client.request<HealthzResponse>('/healthz', { signal }),
    staleTime: Infinity,
  });
}
