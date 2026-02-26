import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketsContext, SocketStatusesContext } from '@/sockets/socketContext';
import type { SocketStatus } from '@/sockets/types';

type SocketProviderProps = {
  children: React.ReactNode;
  urls: string[];
};

export function SocketProvider({ urls, children }: SocketProviderProps) {
  const [sockets, setSockets] = useState<Record<string, Socket>>({});
  const [statuses, setStatuses] = useState<Record<string, SocketStatus>>({});
  const createdRef = useRef<Record<string, Socket>>({});

  const initSockets = useEffectEvent(() => {
    const created: Record<string, Socket> = {};
    const initialStatus: Record<string, SocketStatus> = {};

    for (const url of urls) {
      created[url] = io(url, {
        transports: ['websocket'],
        secure: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        autoConnect: false,
        timeout: 10_000,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
      });
      initialStatus[url] = 'disconnected';
    }

    createdRef.current = created;

    const updateStatus = (url: string, next: SocketStatus) => {
      setStatuses((prev) => (prev[url] === next ? prev : { ...prev, [url]: next }));
    };

    for (const [url, socket] of Object.entries(createdRef.current)) {
      socket.on('connect', () => {
        updateStatus(url, 'connected');
        console.log(`Connected to ${url}`);
      });

      socket.on('disconnect', () => {
        updateStatus(url, 'disconnected');
        console.log(`Disconnected from ${url}`);
      });

      socket.on('connect_error', (error) => {
        updateStatus(url, 'error');
        console.error(`Error connecting to ${url}: ${error}`);
      });
    }

    setStatuses(initialStatus);
    setSockets(created);
    Object.entries(created).forEach(([url, socket]) => {
      socket.connect();
      console.log(`Connecting to ${url}`);
      updateStatus(url, 'connecting');
    });
  });

  const cleanupSockets = useEffectEvent(() => {
    Object.values(createdRef.current).forEach((s) => {
      s.off('connect');
      s.off('disconnect');
      s.off('connect_error');
      s.disconnect();
    });
    createdRef.current = {};
  });

  useEffect(() => {
    if (!urls.length) return;
    initSockets();
    return () => cleanupSockets();
  }, [urls]);

  return (
    <SocketsContext.Provider value={sockets}>
      <SocketStatusesContext.Provider value={statuses}>{children}</SocketStatusesContext.Provider>
    </SocketsContext.Provider>
  );
}
