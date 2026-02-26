import { useSockets } from '@/sockets/useSockets';
import { useAppSelector } from '@/store/hooks';
import { useEffect } from 'react';
import { Link } from 'react-router';

export function NotFound() {
  const name = useAppSelector((store) => store.user.name);

  // const { sockets, getSocket } = useSockets();
  // const {statuses} = useSocketStatuses()

  return (
    <div className="flex h-screen flex-col items-center justify-center">
      <h1>404 {name}</h1>
      <p>Page Not Found</p>
      <Link to="/">Go to Home</Link>
    </div>
  );
}
