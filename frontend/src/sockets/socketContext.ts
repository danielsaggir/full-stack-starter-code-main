import { createContext } from 'react';
import type { SocketsContextValue, SocketStatusesContextValue } from '@/sockets/types';

export const SocketsContext = createContext<SocketsContextValue | null>(null);
export const SocketStatusesContext = createContext<SocketStatusesContextValue | null>(null);
