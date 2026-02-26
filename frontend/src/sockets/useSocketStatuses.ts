import { useCallback, useContext } from 'react';
import type { SocketStatus, SocketStatusesContextValue } from '@/sockets/types';
import { SocketStatusesContext } from '@/sockets/socketContext';

export function useSocketStatuses() {
  const statuses = useContext<SocketStatusesContextValue | null>(SocketStatusesContext);
  if (!statuses) throw new Error('useSocketStatuses must be used within <SocketProvider />');

  const getStatus = useCallback(
    (url: string): SocketStatus | undefined => statuses[url],
    [statuses]
  );

  return { statuses, getStatus };
}
