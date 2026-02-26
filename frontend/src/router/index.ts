import { Home } from '@/ui/pages/Home';
import { NotFound } from '@/ui/pages/NotFound';
import { Root } from '@/ui/Root';
import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Root,
    children: [{ index: true, Component: Home }]
  },
  {
    path: '*',
    Component: NotFound
  }
]);
