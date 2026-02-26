import { useCallback, useContext } from 'react';
import { SocketsContext } from '@/sockets/socketContext';
import type { SocketsContextValue } from '@/sockets/types';
import type { Socket } from 'socket.io-client';

export function useSockets() {
  const sockets = useContext<SocketsContextValue | null>(SocketsContext);
  if (!sockets) throw new Error('useSockets must be used within <SocketProvider />');

  const getSocket = useCallback((url: string): Socket | undefined => sockets[url], [sockets]);

  return { sockets, getSocket };
}
