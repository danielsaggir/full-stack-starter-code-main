import { App } from '@slack/bolt';
import { registerMessageListeners } from './listeners/messages.js';
import { logger } from '../ai/utils.js';

export async function startSlackApp() {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!token || !appToken || !signingSecret) {
    logger.log('system', 'Slack env vars missing (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET) — skipping Slack bot startup');
    return;
  }

  const app = new App({
    token,
    appToken,
    signingSecret,
    socketMode: true,
  });

  registerMessageListeners(app);

  await app.start();
  logger.log('system', 'Slack bot is running in Socket Mode');
}
