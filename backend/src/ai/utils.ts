import * as readline from 'readline';

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export type LogKind = 'human' | 'ai' | 'system';

export const logger = {
  info(message: string, ...args: unknown[]) {
    console.log(message, ...args);
  },

  log(kind: LogKind, message: unknown, ...args: unknown[]) {
    const content = contentToString(message);

    if (kind === 'system') {
      // Yellow for system messages
      console.log(`\x1b[33m[SYSTEM]: ${content}\x1b[0m`, ...args);
      return;
    }

    if (kind === 'human') {
      console.log(`[HUMAN]: ${content}`, ...args);
      return;
    }

    if (kind === 'ai') {
      console.log(`[AI]: ${content}`, ...args);
      return;
    }
  },
};

// Common utility functions for LangGraph Essentials

/**
 * Simple utility to create a delay/sleep function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a simple UUID-like string for demo purposes
 */
export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Format state for logging/debugging
 */
export function formatState(state: any): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Console logging with timestamps for debugging
 */
export function logWithTimestamp(message: string, data?: any): void {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${message}:`, data);
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

// Utility function for getting user input
export function getUserInput(prompt: string = '', controller: AbortController): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      controller.signal.removeEventListener('abort', onAbort);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      rl.close();
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Abort'));
    }

    controller.signal.addEventListener('abort', onAbort, { once: true });

    rl.question(prompt, (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer.trim());
    });
  });
}
