import express, { type NextFunction, type Request, type Response } from 'express';
import 'dotenv/config';
import { connectToMongoDB, startServer } from './utils.js';
import { usersRouter } from './routes/users.routes.js';
import { postsRouter } from './routes/posts.routes.js';
import cors from 'cors';
import helmet from 'helmet';
import { runMarginAgent } from './ai/marign.api.js';
import { startSlackApp } from './slack/slackApp.js';
import { startRealtimeSyncCron } from './cron/realtimeSync.js';
// create a new express application
const app = express();

// helmet is a middleware that helps to secure the express application by setting various HTTP headers
app.use(helmet());

// cors is a middleware that allows the express application to accept requests from the frontend specifically
// the origin is the URL of the frontend
// credentials: true means that the browser will send the credentials (cookies, authentication tokens, etc.) to the backend
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  }),
);

// express.json() is a middleware that parses the request body and makes it available in req.body
app.use(express.json());

// express.urlencoded() is a middleware that parses the request body and makes it available in req.body
// extended: true means that the parser will support nested objects and arrays
app.use(express.urlencoded({ extended: true }));

// create a new route that returns a JSON object with a key of ok and a value of true
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// initialize routers
app.use('/users', usersRouter);
app.use('/posts', postsRouter);

// if the route is not found, return a 404 error
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// error handler (must be last)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// get the port and uri from the environment variables
const port = Number(process.env.PORT) || 3000;
const uri = process.env.MONGODB_URI;

// main function to start the server
async function main() {
  if (!uri) throw new Error('MONGODB_URI is not set');

  await connectToMongoDB(uri);

  await startSlackApp();

  startRealtimeSyncCron();

  await startServer(app, port);
  console.log(`✅ Server is running on port ${port}! 🚀`);
}

// catch any errors and exit the process
main()
  .then(async () => {
    await runMarginAgent('default', 'main');
  })
  .catch((error) => {
    console.error(`❌ Failed to start: ${error}`);
    process.exit(1);
  });
