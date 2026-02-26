# Full-Stack Starter (React + Express + MongoDB)

A full-stack boilerplate with a **React/Vite** frontend and a **Node/Express + MongoDB (Mongoose)** backend.

This README focuses on **what technologies are used** and **how the frontend/backend are structured** (architecture), based on the actual code in this repo.

---

## Tech stack (at a glance)

### Frontend (`frontend/`)

- **Runtime / bundler**: Vite + TypeScript (ESM)
- **UI**: React 19
- **Routing**: React Router v7 (`RouterProvider` + `createBrowserRouter`)
- **State**: Redux Toolkit slices + **RTK Query** for data fetching
- **Styling**: Tailwind CSS v4 + `@tailwindcss/vite`
- **Component library**: shadcn/ui (New York style) + Radix primitives + Lucide icons
- **Forms & validation**: React Hook Form + Zod (+ resolvers)
- **Charts / tables / animation**: Recharts, TanStack Table, Motion
- **Realtime (client)**: `socket.io-client` with a provider + hooks pattern
- **Tooling**: ESLint (type-aware) + Prettier

### Backend (`backend/`)

- **Runtime**: Node.js (ESM) + TypeScript
- **HTTP server**: Express 5
- **Database**: MongoDB via Mongoose
- **Security headers**: `helmet`
- **CORS**: `cors` middleware (origin controlled by env var)
- **Env loading**: `dotenv/config`
- **Dev runner**: `tsx` (including watch mode)
- **Tooling**: ESLint (type-aware) + Prettier

---

## Project structure

```
full-stack-starter-code/
  backend/
    src/
      index.ts           # Express app bootstrap (middleware + routes + start)
      utils.ts           # Mongo connection + startServer helper
      controllers/       # Route handlers (business logic)
      models/            # Mongoose schemas/models
      routes/            # Express routers
      types/             # Backend TypeScript types (params/bodies/shared shapes)
      validators/        # Express request validation middleware
  frontend/
    src/
      main.tsx           # React entry + Redux Provider
      App.tsx            # RouterProvider
      router/            # route definitions
      ui/                # layout + pages
      store/             # Redux store + slices + RTK Query APIs
      sockets/           # socket.io client provider + hooks
      shadcn/            # shadcn/ui components, utils, registries
      styles/            # Tailwind v4 CSS entry
      types/             # shared frontend types
      consts/            # constants + env accessors
```

---

## Setup / installation

This repo is **two separate Node projects** (`backend/` and `frontend/`). Install dependencies in each.

### Backend

```bash
cd backend
npm i
```

### Frontend

```bash
cd frontend
npm i
```

---

## Environment variables

### Backend (`backend/.env`)

Used in `backend/src/index.ts`:

- **`MONGODB_URI`** (required): Mongo connection string
- **`FRONTEND_URL`**: allowed CORS origin (example: `http://localhost:5173`)
- **`PORT`**: server port (defaults to `3000`)

### Frontend (`frontend/.env.development`, `frontend/.env.production`)

Used in `frontend/src/consts/consts.ts`:

- **`VITE_API_URL`**: backend base URL (example: `http://localhost:3000`)

---

## Running locally

Run the backend and frontend in **two terminals**.

### Terminal 1: backend

```bash
cd backend
npm run dev
```

### Terminal 2: frontend

```bash
cd frontend
npm run dev
```

---

## Frontend architecture

### App entry + routing

- `frontend/src/main.tsx` mounts the app and wraps it with the Redux `<Provider store={store} />`.
- `frontend/src/App.tsx` renders React Router’s `<RouterProvider />`.
- `frontend/src/router/index.ts` defines routes using `createBrowserRouter`:
  - `/` → `Root` layout → `Home` page
  - `*` → `NotFound`
- `frontend/src/ui/Root.tsx` is the **layout wrapper**. It currently wraps the app in `SocketProvider` and renders an `<Outlet />` for nested routes.

### State management (Redux Toolkit + RTK Query)

- `frontend/src/store/index.ts` configures the Redux store:
  - classic slices (example: `user`, `counter`)
  - RTK Query API slice(s) (example: `pokemonApi`)
- `frontend/src/store/hooks/index.ts` exports typed hooks:
  - `useAppDispatch`
  - `useAppSelector`
- `frontend/src/store/apis/pokemon.api.ts` is a working RTK Query example hitting the public PokeAPI.

How to think about it:

- **Slices** hold local UI/app state.
- **RTK Query** holds server/cache state and generates hooks (e.g. `useLazyGetPokemonByNameQuery`).

### Styling + UI components

- Tailwind CSS v4 is enabled via `@tailwindcss/vite` (see `frontend/vite.config.ts`).
- The Tailwind entry file is `frontend/src/styles/index.css`.
- shadcn/ui is configured in `frontend/components.json` and components live under `frontend/src/shadcn/components/ui/`.

### Path aliases

- `@/` resolves to `frontend/src` (configured in `frontend/vite.config.ts` and `frontend/tsconfig*.json`).

### Sockets (client-only)

The repo includes a reusable **Socket.IO client** wrapper:

- Provider: `frontend/src/sockets/SocketProvider.tsx`
  - accepts an array of URLs
  - creates and manages one socket connection per URL
  - exposes connection status per URL
- Hooks:
  - `frontend/src/sockets/useSockets.ts`
  - `frontend/src/sockets/useSocketStatuses.ts`

To enable sockets, add URLs in `frontend/src/ui/Root.tsx` (currently it’s an empty array).

Note: there is **no Socket.IO server** implemented in the backend in this repo.

---

## Backend architecture

### Bootstrap and middleware

`backend/src/index.ts`:

- Creates an Express app
- Adds middleware:
  - `helmet()`
  - `express.json()`
  - `express.urlencoded({ extended: true })`
  - `cors({ origin: process.env.FRONTEND_URL, credentials: true })`
- Registers routers:
  - `/users` → `usersRouter`
  - `/posts` → `postsRouter`
- Adds fallback handlers:
  - 404 handler for unknown routes
  - last-resort error handler (500)
- Reads config from env:
  - `PORT` (default 3000)
  - `MONGODB_URI` (required)
- Connects to MongoDB and starts the server

`backend/src/utils.ts`:

- `connectToMongoDB(uri)` uses `mongoose.connect(...)`
- `startServer(app, port)` starts the HTTP server and returns the `Server` instance

### Request / DTO types

The backend keeps shared TypeScript shapes under `backend/src/types/` (examples: `ObjectIdParams`, `CreateUserBody`, `CreatePostBody`). These are used in:

- **Controllers**: casting `req.params` / `req.body` to known shapes
- **Validators**: casting `req.params` / `req.body` for field checks

Note: these types are **compile-time only** (they don’t change runtime validation/behavior).

### Data models

- `backend/src/models/User.model.ts`
  - `email` (unique), `name`, `posts: ObjectId[]` referencing Post
- `backend/src/models/Post.model.ts`
  - `createdBy: ObjectId` referencing User, `title`, `content`

Relationship:

- A `User` owns many `Post`s (via `User.posts[]`)
- A `Post` belongs to a `User` (via `Post.createdBy`)

---

## Backend routes (concise)

### `GET /health`

- Returns `{ ok: true }`

### Users: `/users` (`backend/src/routes/users.routes.ts`)

- **GET `/users`**
  - 200: list all users
  - 500: server error
- **GET `/users/:id`**
  - 200: user
  - 400: invalid ObjectId (`{ message: "invalid user id" }`)
  - 404: not found
  - 500: server error
- **POST `/users`**
  - Body: `{ email: string, name: string }`
  - 201: created user
  - 400: missing/invalid fields
    - `email` and `name` are required
    - `email` and `name` must be strings
    - `email` and `name` cannot be empty (whitespace-only is rejected)
  - 409: duplicate email
  - 500: server error

### Posts: `/posts` (`backend/src/routes/posts.routes.ts`)

- **GET `/posts`**
  - 200: list posts (sorted newest first), `createdBy` populated with user `email` + `name`
  - 500: server error
- **GET `/posts/:id`**
  - 200: post (with populated `createdBy`)
  - 400: invalid ObjectId (`{ message: "invalid id" }`)
  - 404: not found
  - 500: server error
- **POST `/posts`**
  - Body: `{ createdBy: string, title: string, content: string }`
  - 201: created post
  - 400: missing fields / invalid `createdBy`
    - `createdBy`, `title`, `content` are required
    - `createdBy` must be a valid ObjectId (`{ message: "createdBy is not a valid ObjectId" }`)
  - 404: user not found
  - 500: server error
  - Side effect: pushes the post id into the owning user’s `posts[]`
- **PATCH `/posts/:id`**
  - Body: `{ title?: string, content?: string }` (at least one required)
  - 200: updated post
  - 400: invalid ObjectId / no fields provided (`{ message: "provide title and/or content" }`)
  - 404: not found
  - 500: server error
- **DELETE `/posts/:id`**
  - 204: deleted
  - 400: invalid ObjectId (`{ message: "invalid id" }`)
  - 404: not found
  - 500: server error
  - Side effect: pulls the post id from the owning user’s `posts[]`

---

## Scripts

### Backend (`backend/package.json`)

- `npm run dev`: run with watch (`tsx watch src/index.ts`)
- `npm run start`: run once (`tsx src/index.ts`)
- `npm run build`: compile TS (`tsc`)
- `npm run typecheck`: typecheck only (`tsc --noEmit`)
- `npm run lint`: run ESLint
- `npm run lint:fix`: run ESLint with auto-fix

### Frontend (`frontend/package.json`)

- `npm run dev`: start Vite dev server
- `npm run build`: typecheck/build
- `npm run preview`: preview the production build
- `npm run check`: typecheck + lint + format check
# full-stack-starter-code-main
