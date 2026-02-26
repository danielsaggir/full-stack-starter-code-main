import type { Socket } from 'socket.io-client';

export type ServerToClientEvents = {
  helloFromServer: () => void;
};
export type ClientToServerEvents = {
  helloFromClient: () => void;
};
export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SocketsByUrl = Record<string, Socket>;
export type SocketStatusByUrl = Record<string, SocketStatus>;

export type SocketsContextValue = SocketsByUrl;
export type SocketStatusesContextValue = SocketStatusByUrl;
