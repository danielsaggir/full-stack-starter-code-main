import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { agent, getVisualizationCount, getVisualizationsSince } from '../../ai/margin.js';
import { logger } from '../../ai/utils.js';

/**
 * Extract the last AI message text from the agent result.
 */
function getLastAIResponse(result: { messages: { content: unknown }[] }): string {
  const lastMsg = result.messages[result.messages.length - 1];
  if (!lastMsg) return '';
  return typeof lastMsg.content === 'string'
    ? lastMsg.content
    : JSON.stringify(lastMsg.content);
}

/**
 * Upload any visualizations created during an agent invocation to the Slack thread.
 */
async function uploadNewVisualizations(
  client: WebClient,
  channelId: string,
  threadTs: string,
  vizCountBefore: number,
) {
  const newVizs = getVisualizationsSince(vizCountBefore);
  for (const viz of newVizs) {
    try {
      await client.files.uploadV2({
        channel_id: channelId,
        file: readFileSync(viz.filePath),
        filename: basename(viz.filePath),
        thread_ts: threadTs,
        title: viz.title,
      });
      logger.log('system', `Uploaded visualization to Slack: ${viz.title}`);
    } catch (uploadErr) {
      logger.log('system', `Failed to upload visualization "${viz.title}" to Slack:`, uploadErr);
    }
  }
}

export function registerMessageListeners(app: App) {
  // New conversation: user @mentions the bot
  app.event('app_mention', async ({ event, say, context, client }) => {
    const threadTs = event.thread_ts ?? event.ts;

    // Skip bot's own messages
    if (event.user === context.botUserId) return;

    logger.log('system', `Slack app_mention from ${event.user} in thread ${threadTs}`);

    try {
      const vizCountBefore = getVisualizationCount();

      const result = await agent.invoke(
        { messages: [{ role: 'user', content: 'Hello, please introduce yourself and greet me.' }] },
        { configurable: { thread_id: threadTs } },
      );

      const response = getLastAIResponse(result);
      if (response) {
        await say({ text: response, thread_ts: threadTs });
      }

      await uploadNewVisualizations(client, event.channel, threadTs, vizCountBefore);
    } catch (error) {
      logger.log('system', 'Error handling app_mention:', error);
      await say({ text: 'Sorry, something went wrong. Please try again.', thread_ts: threadTs });
    }
  });

  // Thread reply: user responds in an existing thread
  app.event('message', async ({ event, say, context, client }) => {
    // Only process thread replies
    if (!('thread_ts' in event) || !event.thread_ts) return;

    // Skip bot messages and message subtypes (edits, joins, etc.)
    if ('bot_id' in event && event.bot_id) return;
    if ('user' in event && event.user === context.botUserId) return;
    if ('subtype' in event && event.subtype) return;

    // Skip app_mention events that also fire as message events
    if ('text' in event && typeof event.text === 'string' && event.text.includes(`<@${context.botUserId}>`)) return;

    const threadTs = event.thread_ts;
    const userText = 'text' in event && typeof event.text === 'string' ? event.text.trim() : '';

    if (!userText) return;

    logger.log('system', `Slack thread reply in ${threadTs}: "${userText}"`);

    try {
      const vizCountBefore = getVisualizationCount();

      const result = await agent.invoke(
        { messages: [{ role: 'user', content: userText }] },
        { configurable: { thread_id: threadTs } },
      );

      const response = getLastAIResponse(result);
      if (response) {
        await say({ text: response, thread_ts: threadTs });
      }

      await uploadNewVisualizations(client, event.channel, threadTs, vizCountBefore);
    } catch (error) {
      logger.log('system', 'Error handling thread reply:', error);
      await say({ text: 'Sorry, something went wrong. Please try again.', thread_ts: threadTs });
    }
  });
}
