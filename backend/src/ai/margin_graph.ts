import 'dotenv/config';
import {
  END,
  START,
  StateGraph,
  interrupt,
  MemorySaver,
  Command,
  isInterrupted,
  INTERRUPT,
} from '@langchain/langgraph';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getUserInput, logger } from './utils.js';
import { AIMessage, HumanMessage, initChatModel, SystemMessage } from 'langchain';
import { type Config } from '@langchain/langgraph-sdk';
import {
  greetingSchema,
  routerSchema,
  conversationHistorySchema,
  dataQuerySchema,
  MarginGraphStateDefinition,
  type MarginGraphState,
} from '../types/margin.types.js';

// ─── Configuration ─────────────────────────────────────────────────────────────

const MODEL_NAME = 'gpt-4.1-mini';

/**
 * Creates a LangGraph config with thread_id derived from channelId + threadId
 * for persistent memory across conversations.
 */
export function createConfig(channelId: string, threadId: string): Config {
  return {
    configurable: {
      thread_id: `${channelId}_${threadId}`,
    },
  };
}

// ─── Campaign Data: In-Memory JSON Store ────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Raw campaign records loaded once at module init. */
const rawData = JSON.parse(
  readFileSync(join(__dirname, '../assets/data.json'), 'utf-8'),
) as Record<string, unknown>[];

/** All field names available in the dataset, provided to the query-builder LLM. */
const AVAILABLE_FIELDS = Object.keys(rawData[0]).join(', ');

logger.log('system', `Loaded ${rawData.length} campaign records into memory.`);

// ─── In-Memory Query Engine ─────────────────────────────────────────────────────

interface QueryFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
  value: string;
}

interface QueryAggregation {
  field: string;
  function: 'sum' | 'avg' | 'min' | 'max' | 'count';
  alias: string;
}

interface HavingFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string;
}

interface DataQuery {
  select: string[];
  filters: QueryFilter[];
  groupBy: string | null;
  aggregations: QueryAggregation[];
  having: HavingFilter[];
  orderBy: { field: string; direction: 'asc' | 'desc' } | null;
  limit: number | null;
}

/**
 * Executes a structured query (SELECT / WHERE / GROUP BY / ORDER BY / LIMIT)
 * against the in-memory rawData array. Returns the result as a JSON string.
 */
function executeQuery(query: DataQuery, data: Record<string, unknown>[]): string {
  let result = [...data];

  // 1. WHERE -- apply filters
  for (const filter of query.filters) {
    result = result.filter((record) => {
      const fieldVal = record[filter.field];
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const cmpStr = String(fieldVal ?? '').toLowerCase();
      const valStr = String(filter.value).toLowerCase();
      const fieldNum = Number(fieldVal);
      const valNum = Number(filter.value);

      switch (filter.operator) {
        case 'eq':
          return cmpStr === valStr;
        case 'neq':
          return cmpStr !== valStr;
        case 'gt':
          return fieldNum > valNum;
        case 'gte':
          return fieldNum >= valNum;
        case 'lt':
          return fieldNum < valNum;
        case 'lte':
          return fieldNum <= valNum;
        case 'contains':
          return cmpStr.includes(valStr);
        default:
          return true;
      }
    });
  }

  // 2. GROUP BY + aggregations
  if (query.groupBy) {
    const groupField = query.groupBy;
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const record of result) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const key = String(record[groupField] ?? 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(record);
    }

    const aggregated: Record<string, unknown>[] = [];
    for (const [groupKey, records] of groups) {
      const row: Record<string, unknown> = { [groupField]: groupKey };

      for (const agg of query.aggregations) {
        const values = records.map((r) => Number(r[agg.field] ?? 0));
        switch (agg.function) {
          case 'sum':
            row[agg.alias] = values.reduce((a, b) => a + b, 0);
            break;
          case 'avg':
            row[agg.alias] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
            break;
          case 'min':
            row[agg.alias] = Math.min(...values);
            break;
          case 'max':
            row[agg.alias] = Math.max(...values);
            break;
          case 'count':
            row[agg.alias] = records.length;
            break;
        }
      }

      aggregated.push(row);
    }
    result = aggregated;

    // 2b. HAVING -- post-aggregation filters (applied to aggregated alias fields)
    if (query.having && query.having.length > 0) {
      for (const hf of query.having) {
        result = result.filter((record) => {
          const fieldVal = record[hf.field];
          const fieldNum = Number(fieldVal);
          const valNum = Number(hf.value);

          switch (hf.operator) {
            case 'eq':
              return fieldNum === valNum;
            case 'neq':
              return fieldNum !== valNum;
            case 'gt':
              return fieldNum > valNum;
            case 'gte':
              return fieldNum >= valNum;
            case 'lt':
              return fieldNum < valNum;
            case 'lte':
              return fieldNum <= valNum;
            default:
              return true;
          }
        });
      }
    }
  } else {
    // 3. SELECT -- project only the requested fields (when not grouping)
    if (query.select.length > 0) {
      result = result.map((record) => {
        const projected: Record<string, unknown> = {};
        for (const field of query.select) {
          projected[field] = record[field];
        }
        return projected;
      });
    }
  }

  // 4. ORDER BY
  if (query.orderBy) {
    const { field, direction } = query.orderBy;
    result.sort((a, b) => {
      const aVal = Number(a[field] ?? 0);
      const bVal = Number(b[field] ?? 0);
      if (isNaN(aVal) || isNaN(bVal)) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const aStr = String(a[field] ?? '');
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const bStr = String(b[field] ?? '');
        return direction === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
      }
      return direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }

  // 5. LIMIT
  if (query.limit != null && query.limit > 0) {
    result = result.slice(0, query.limit);
  }

  return JSON.stringify(result, null, 2);
}

// ─── Models ────────────────────────────────────────────────────────────────────

const ANALYSIS_MODEL_NAME = 'gpt-5.2';

const model = await initChatModel(MODEL_NAME, { modelProvider: 'openai' });
const analysisModel = await initChatModel(ANALYSIS_MODEL_NAME, { modelProvider: 'openai' });

const greetingModel = model.withStructuredOutput(greetingSchema);
const routerModel = model.withStructuredOutput(routerSchema);
const conversationHistoryModel = model.withStructuredOutput(conversationHistorySchema);
const queryModel = model.withStructuredOutput(dataQuerySchema as never) as unknown as {
  invoke: (messages: (SystemMessage | HumanMessage)[]) => Promise<DataQuery>;
};

// ─── Checkpointer (Memory) ────────────────────────────────────────────────────

const checkpointer = new MemorySaver();

// ─── System Prompt ─────────────────────────────────────────────────────────────

const MARGIN_SYSTEM_PROMPT = `You are Margin, a campaign analysis AI agent. You receive JSON campaign performance data and a prompt from the user. You analyze campaigns and provide data-driven insights on budget allocation, ROI optimization, creative performance, and campaign strategy. You help users understand which campaigns to scale, pause, or optimize.`;

// ─── Graph Nodes ───────────────────────────────────────────────────────────────

async function greet(state: MarginGraphState) {
  let systemPrompt: string;
  let response;

  logger.log('system', 'Generating greeting...');

  if (state.messages.length === 0) {
    systemPrompt = `${MARGIN_SYSTEM_PROMPT}

Greet the user warmly. Explain that you are Margin, a campaign data analysis agent. You have access to their campaign performance data and can:
- Analyze campaign performance and ROI
- Provide budget allocation recommendations
- Identify top and underperforming campaigns
- Show conversation history

Ask what they would like to explore.`;
    response = await greetingModel.invoke([new SystemMessage(systemPrompt)]);
  } else {
    systemPrompt = `${MARGIN_SYSTEM_PROMPT}

Give a greeting to the user based on the conversation history. If there was a previous analysis, briefly reference it. Ask what they would like to explore next.`;
    const history = 'Conversation History:\n' + JSON.stringify(state.messages, null, 2);
    response = await greetingModel.invoke([
      new SystemMessage(systemPrompt),
      new SystemMessage(history),
    ]);
  }

  logger.log('ai', response.greeting);
  logger.log('system', 'Reading input from user...');

  return {
    ...state,
    messages: [...state.messages, new AIMessage(response.greeting)],
  };
}

function readInputHITL(state: MarginGraphState) {
  const userInput: string = interrupt({ reason: 'getUserInput' });

  if (userInput === 'timeout') {
    return {
      ...state,
      timeout: true,
    };
  }

  const input = userInput.trim();

  return {
    ...state,
    input,
    messages: [...state.messages, new HumanMessage(input)],
  };
}

async function router(state: MarginGraphState) {
  if (state.timeout) {
    logger.log('system', 'Timeout reached, ending conversation...');
    return 'end';
  }

  if (!state.input || state.input.toLowerCase() === 'q') {
    logger.log('system', 'Ending conversation...');
    return 'end';
  }

  logger.log('system', 'Routing...');

  const systemPrompt = `${MARGIN_SYSTEM_PROMPT}

IMPORTANT: You already have full access to the user's campaign performance data. The data is pre-loaded and ready for analysis. The user does NOT need to provide or upload any data.

Route the user to the appropriate next step based on their input. Available decisions:
- analyze: The user wants to analyze campaign data, get insights, check performance, get budget recommendations, find best/worst campaigns, compare metrics, or any recognizable question about their campaigns. The input must contain real words that relate to campaigns, data, or analysis.
- conversation_history: The user wants to see a summary of the conversation so far.
- end: The user wants to quit, exit, or end the conversation (e.g. "quit", "exit", "bye", "q").
- other: The user's request is completely unrelated to campaign analysis (e.g. asking about the weather, telling a joke), OR the input is gibberish/random characters that don't form a meaningful request.
- clarify: The user's message contains real words but their intent is too vague to determine. Do NOT use clarify for vague campaign questions -- route those to analyze. Do NOT use clarify for gibberish -- route that to other.

Also provide your confidence (0 to 1) in the routing decision.`;

  const response = await routerModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);

  logger.log('system', 'Routing decision:', response.decision);
  logger.log('system', 'Confidence:', JSON.stringify(response.confidence));

  return response.decision;
}

async function prepareQuery(state: MarginGraphState) {
  logger.log('system', 'Generating data query from user input...');

  const systemPrompt = `You are a data-query planner. The user will ask a question about campaign performance data.
Your job is to produce a structured query (like SQL) that retrieves exactly the data needed to answer the question.

The dataset contains ${rawData.length} records with these fields:
${AVAILABLE_FIELDS}

Rules:
- Use SELECT (the "select" array) to pick only the fields relevant to the user's question.
- Use filters (WHERE) to narrow down records when the question specifies conditions (e.g., "campaigns with ROI > 100").
- Use groupBy + aggregations when the user asks for aggregated data (e.g., "total spend by country").
- Use orderBy to sort results logically (e.g., descending ROI for "best" questions, ascending for "worst").
- Use limit to cap results when the user asks for "top N" or "worst N". If they don't specify, use a reasonable default (10-20 for ranking questions, null for aggregations).
- For questions about "best", "highest", "top": order DESC and limit.
- For questions about "worst", "lowest", "bottom": order ASC and limit.
- For general overview questions, include the most relevant fields and a reasonable limit.
- Always include identifying fields like campaignName or article along with the metric fields.
- Numbers are stored as numbers in the dataset (not strings).`;

  const response = await queryModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);

  const query: DataQuery = response;

  logger.log('system', `Query: SELECT [${query.select.join(', ')}]` +
    (query.filters.length > 0 ? ` WHERE ${query.filters.map((f: QueryFilter) => `${f.field} ${f.operator} ${f.value}`).join(' AND ')}` : '') +
    (query.groupBy ? ` GROUP BY ${query.groupBy}` : '') +
    (query.orderBy ? ` ORDER BY ${query.orderBy.field} ${query.orderBy.direction}` : '') +
    (query.limit != null ? ` LIMIT ${String(query.limit)}` : ''));

  const queryResultJson = executeQuery(query, rawData);
  const parsedResult = JSON.parse(queryResultJson) as unknown[];
  logger.log('system', `Query returned ${parsedResult.length} records.`);

  return {
    ...state,
    queryResult: queryResultJson,
  };
}

async function analyze(state: MarginGraphState) {
  logger.log('system', 'Analyzing query results...');

  const systemPrompt = `${MARGIN_SYSTEM_PROMPT}

Below is the query result data relevant to the user's question. This data was extracted from the full dataset of ${rawData.length} campaigns based on the user's request.

${state.queryResult}

Instructions:
- Answer the user's question thoroughly and in detail. Be verbose -- the user wants rich, insightful analysis.
- Reference specific campaigns by name, cite exact numbers (spend, revenue, ROI, etc.), and list out every relevant record when the user asks for rankings or lists.
- If the user asks for "top 10" or "worst 5", list ALL of them individually with their data.
- For aggregate or grouped data, break down each group with its computed metrics.
- Provide actionable recommendations grounded in the data (e.g., scale, pause, increase/decrease budget).
- Explain WHY certain campaigns perform well or poorly based on the fields available (bid strategy, creative type, device, country, source, etc.).
- Use clear formatting: numbered lists, line breaks, and sections to make the output easy to read in a terminal.
- Do NOT be brief. The user expects a comprehensive, data-driven report -- not a short summary.
- If the query result seems incomplete for the user's question, note that and suggest a follow-up question.`;

  const response = await analysisModel.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  const analysisText = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);

  logger.log('ai', analysisText);

  return {
    ...state,
    messages: [...state.messages, new AIMessage(analysisText)],
  };
}

async function conversationHistory(state: MarginGraphState) {
  logger.log('system', 'Generating conversation history...');

  const systemPrompt = `Generate a clear and concise summary of the conversation history you will receive. Highlight key analyses performed and insights shared.`;

  const response = await conversationHistoryModel.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  const historyMessage = new AIMessage(response.conversationHistory);
  logger.log('ai', historyMessage.content);

  return {
    ...state,
    messages: [...state.messages, historyMessage],
  };
}

async function other(state: MarginGraphState) {
  logger.log('system', 'Handling off-topic request...');

  const systemPrompt = `${MARGIN_SYSTEM_PROMPT}

The user arrived here because their request is unrelated to campaign data analysis. Politely explain that you are a campaign analysis agent and can only help with campaign data analysis, insights, and recommendations. Ask them to rephrase their request or choose one of the available options. Keep your response short and concise.`;

  const history = 'Conversation History:\n' + JSON.stringify(state.messages, null, 2);

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new SystemMessage(history),
  ]);

  logger.log('ai', response.content);

  return {
    ...state,
    messages: [...state.messages, new AIMessage(response.content)],
  };
}

async function clarify(state: MarginGraphState) {
  logger.log('system', 'Requesting clarification...');

  const systemPrompt = `${MARGIN_SYSTEM_PROMPT}

You already have the user's campaign data loaded -- do NOT ask them to upload or share data.
The user's message was unclear and you need clarification on what they want. Ask them to rephrase their question more specifically. Suggest examples like:
- "Show me top performing campaigns by ROI"
- "Which campaigns should I increase budget on?"
- "Analyze ROI by country"
- "What are my worst performing campaigns?"

Keep your response short and helpful.`;

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  logger.log('ai', response.content);

  return {
    ...state,
    messages: [...state.messages, new AIMessage(response.content)],
  };
}

// ─── Graph Definition ──────────────────────────────────────────────────────────

export const graph = new StateGraph(MarginGraphStateDefinition)
  .addNode('greet', greet)
  .addNode('read_input_hitl', readInputHITL)
  .addNode('prepareQuery', prepareQuery)
  .addNode('analyze', analyze)
  .addNode('conversation_history', conversationHistory)
  .addNode('other', other)
  .addNode('clarify', clarify)
  .addEdge(START, 'greet')
  .addEdge('greet', 'read_input_hitl')
  .addConditionalEdges('read_input_hitl', router, {
    analyze: 'prepareQuery',
    conversation_history: 'conversation_history',
    other: 'other',
    clarify: 'clarify',
    end: END,
  })
  .addEdge('prepareQuery', 'analyze')
  .addEdge('analyze', 'greet')
  .addEdge('conversation_history', 'greet')
  .addEdge('other', 'greet')
  .addEdge('clarify', 'greet')
  .compile({ checkpointer });

// ─── Initial State ─────────────────────────────────────────────────────────────

/**
 * Creates the initial state for a Margin agent session.
 */
export function createInitialState(channelId: string, threadId: string): MarginGraphState {
  return {
    input: '',
    route: undefined,
    messages: [],
    channelId,
    threadId,
    timeout: false,
    queryResult: '',
  };
}

/** Default initial state for terminal-based usage */
export const initialState: MarginGraphState = createInitialState('default', 'main');

// ─── Interrupt Handlers ────────────────────────────────────────────────────────

async function handleGetUserInputInterrupt(): Promise<string> {
  const controller = new AbortController();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<string>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, 60_000);
  });

  try {
    const userInput = getUserInput('Please enter your input:', controller);
    const result = await Promise.race<string>([timeoutPromise, userInput]);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Abort') return 'timeout';
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ─── Graph Runner ──────────────────────────────────────────────────────────────

type InterruptValue = { reason: string; [k: string]: unknown };

/**
 * Runs the Margin agent graph, handling HITL interrupts in a loop until
 * the graph completes or an unrecognised interrupt is encountered.
 */
export async function runGraph(state: MarginGraphState = initialState, config: Config) {
  let run = await graph.invoke(state, config);

  while (isInterrupted<InterruptValue>(run)) {
    const interruptData = run[INTERRUPT][0];

    switch (interruptData.value?.reason) {
      case 'getUserInput': {
        const userInput = await handleGetUserInputInterrupt();
        run = await graph.invoke(new Command({ resume: userInput }), config);
        break;
      }

      default:
        return run;
    }
  }

  return run;
}
