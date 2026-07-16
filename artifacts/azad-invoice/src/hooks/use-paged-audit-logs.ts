import { useInfiniteQuery } from "@tanstack/react-query";
import {
  listAuditLogs,
  getListAuditLogsQueryKey,
  useCountAuditLogs,
  getCountAuditLogsQueryKey,
} from "@workspace/api-client-react";
import type { ListAuditLogsParams } from "@workspace/api-client-react";

export const AUDIT_LOG_PAGE_SIZE = 200;

export function usePagedAuditLogs(
  filters?: Pick<ListAuditLogsParams, "entityType" | "entityId">,
  options?: { enabled?: boolean },
) {
  const query = useInfiniteQuery({
    queryKey: [...getListAuditLogsQueryKey(filters), "paged"],
    queryFn: ({ pageParam, signal }) =>
      listAuditLogs(
        { ...filters, limit: AUDIT_LOG_PAGE_SIZE, offset: pageParam },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < AUDIT_LOG_PAGE_SIZE
        ? undefined
        : allPages.reduce((sum, page) => sum + page.length, 0),
    enabled: options?.enabled,
  });

  const countQuery = useCountAuditLogs(filters, {
    query: {
      queryKey: getCountAuditLogsQueryKey(filters),
      enabled: options?.enabled,
    },
  });

  return {
    ...query,
    logs: query.data?.pages.flat(),
    totalCount: countQuery.data?.count,
  };
}
