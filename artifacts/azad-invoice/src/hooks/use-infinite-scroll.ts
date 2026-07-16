import { useEffect, useRef } from "react";

export function useInfiniteScroll(options: {
  hasMore: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
}) {
  const { hasMore, isFetching, onLoadMore } = options;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onLoadMore);
  callbackRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isFetching) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          callbackRef.current();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isFetching]);

  return sentinelRef;
}
