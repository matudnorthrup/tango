import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BASE } from './api';

/**
 * Live refresh: subscribes to /api/events (SSE fed by Postgres NOTIFY) and
 * invalidates all queries when workout data changes anywhere (e.g. an agent
 * logging sets in the background). Also refetches on tab re-focus, since
 * mobile browsers drop EventSource connections in the background.
 */
export function useLiveRefresh() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let throttleTimer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let disposed = false;

    const invalidate = () => {
      if (throttleTimer) {
        pending = true;
        return;
      }
      void queryClient.invalidateQueries();
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined;
        if (pending) {
          pending = false;
          invalidate();
        }
      }, 400);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(`${BASE}/api/events`);
      source.addEventListener('change', invalidate);
      source.onerror = () => {
        source?.close();
        source = null;
        if (!disposed) reconnectTimer = setTimeout(connect, 3000);
      };
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (!source || source.readyState === EventSource.CLOSED) connect();
        void queryClient.invalidateQueries();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(reconnectTimer);
      clearTimeout(throttleTimer);
      source?.close();
    };
  }, [queryClient]);
}
