import { RouterProvider } from 'react-router';
import { router } from '@/router';
import '@/styles/index.css';

export function App() {
  return <RouterProvider router={router} />;
}
