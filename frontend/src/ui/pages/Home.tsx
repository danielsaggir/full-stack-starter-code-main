import { Button } from '@/shadcn/components/ui/button';
import { SlidingNumber } from '@/shadcn/registeries/animate-ui/primitives/texts/sliding-number';
import { useSockets } from '@/sockets/useSockets';
import { useSocketStatuses } from '@/sockets/useSocketStatuses';
import { useLazyGetPokemonByNameQuery } from '@/store/apis/pokemon.api';
import { useAppSelector } from '@/store/hooks';
import { useState } from 'react';
import { Link } from 'react-router';

export function Home() {
  const name = useAppSelector((store) => store.user.name);

  const [search, setSearch] = useState('');

  const [getPokemon, { data, isLoading, error }] = useLazyGetPokemonByNameQuery();

  const { sockets, getSocket } = useSockets();
  // const { statuses, getStatus } = useSocketStatuses();

  function onFindPokemon() {
    void getPokemon(search);
  }

  return (
    <div>
      Hello from Home {name}
      <input
        className="rounded-md border-2 border-gray-300 p-2"
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <SlidingNumber number={99999} />
      <Button variant="outline" disabled={isLoading} onClick={onFindPokemon}>
        Find Pokemon
      </Button>
      {isLoading && <div>Loading...</div>}
      {error && <div>Error: {JSON.stringify(error, null, 2)}</div>}
      <div>{JSON.stringify(data, null, 2)}</div>
      <Link to="/not-found">Not Found</Link>
    </div>
  );
}
