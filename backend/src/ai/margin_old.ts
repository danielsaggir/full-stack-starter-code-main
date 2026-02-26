import 'dotenv/config';
import {
  END,
  START,
  StateGraph,
  MessagesZodMeta,
  interrupt,
  MemorySaver,
  Command,
  isInterrupted,
  INTERRUPT,
} from '@langchain/langgraph';
import { registry } from '@langchain/langgraph/zod';
import { z } from 'zod/v4';
import { getUserInput } from './utils.js';
import { logger } from './utils.js';
import { AIMessage, BaseMessage, HumanMessage, initChatModel, SystemMessage } from 'langchain';
// import { time } from 'node:console';
import { type Config } from '@langchain/langgraph-sdk';
import { greetingSchema, routerSchema, conversationHistorySchema } from '../types/margin.types.js';

export const config: Config = {
  configurable: {
    thread_id: '1',
  },
};

const MODEL_NAME = 'gpt-4.1-mini';

const model1 = await initChatModel(MODEL_NAME, {
  modelProvider: 'openai',
});
const model2 = await initChatModel(MODEL_NAME);

const model3 = await initChatModel(MODEL_NAME, {
  modelProvider: 'openai',
});

const artistModel = await initChatModel(MODEL_NAME, {
  modelProvider: 'openai',
});

const checkpointer = new MemorySaver();


const greetingModel = model1.withStructuredOutput(greetingSchema);
const routerModel = model2.withStructuredOutput(routerSchema);
const conversationHistoryModel = model3.withStructuredOutput(conversationHistorySchema);

const ArtistGraphStateDefinition = z
  .object({
    route: routerSchema.optional(),
    input: z.string().describe('The user input'),
    messages: z.array(z.instanceof(BaseMessage)).register(registry, MessagesZodMeta),
    timeout: z.boolean().describe('Whether the conversation has timed out').default(false),
  })
  .describe('The state of the artist graph');

type ArtistGraphState = z.infer<typeof ArtistGraphStateDefinition>;

export const graph = new StateGraph(ArtistGraphStateDefinition)
  .addNode('read_input', greet)
  .addNode('read_input_hitl', readInputHITL)
  .addNode('poem', poem)
  .addNode('conversation_history', conversationHistory)
  .addNode('story', story)
  .addNode('joke', joke)
  .addNode('song', song)
  .addNode('other', other)
  .addNode('clarify', clarify)
  .addEdge(START, 'read_input')
  .addEdge('read_input', 'read_input_hitl')
  .addConditionalEdges('read_input_hitl', router, {
    poem: 'poem',
    story: 'story',
    joke: 'joke',
    song: 'song',
    conversation_history: 'conversation_history',
    other: 'other',
    clarify: 'clarify',
    end: END,
  })
  .addEdge('poem', 'read_input')
  .addEdge('story', 'read_input')
  .addEdge('joke', 'read_input')
  .addEdge('song', 'read_input')
  .addEdge('conversation_history', 'read_input')
  .addEdge('other', 'read_input')
  .addEdge('clarify', 'read_input')
  .compile({ checkpointer });

async function poem(state: ArtistGraphState) {
  logger.log('system', 'Generating poem...');
  const systemPrompt = `You are an expert poet that creates poems based on the user input.`;
  const poemSchema = z.object({
    poem: z.string().describe('The poem'),
  });
  const poemModel = artistModel.withStructuredOutput(poemSchema);

  const response = await poemModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);

  // state.messages.push(new AIMessage(response.poem));
  logger.log('ai', response.poem);

  return {
    ...state,
    messages: [...state.messages, new AIMessage(response.poem)],
  };
}

async function story(state: ArtistGraphState) {
  logger.log('system', 'Generating story...');
  const systemPrompt = `You are an expert storyteller that creates stories based on the user input.`;
  const storySchema = z.object({
    story: z.string().describe('The story'),
  });
  const storyModel = artistModel.withStructuredOutput(storySchema);

  const response = await storyModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);
  logger.log('ai', response.story);

  const story = new AIMessage(response.story);

  return {
    ...state,
    messages: [...state.messages, story],
  };
}

async function joke(state: ArtistGraphState) {
  logger.log('system', 'Generating joke...');
  const systemPrompt = `You are an expert joke teller that creates jokes based on the user input.`;
  const jokeSchema = z.object({
    joke: z.string().describe('The joke'),
  });
  const jokeModel = artistModel.withStructuredOutput(jokeSchema);

  const response = await jokeModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);
  logger.log('ai', response.joke);

  const joke = new AIMessage(response.joke);

  return {
    ...state,
    messages: [...state.messages, joke],
  };
}

async function song(state: ArtistGraphState) {
  logger.log('system', 'Generating song...');
  const systemPrompt = `You are an expert songwriter that creates songs based on the user input.`;
  const songSchema = z.object({
    song: z.string().describe('The song'),
  });
  const songModel = artistModel.withStructuredOutput(songSchema);

  const response = await songModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);
  logger.log('ai', response.song);

  const song = new AIMessage(response.song);

  return {
    ...state,
    messages: [...state.messages, song],
  };
}

async function greet(state: ArtistGraphState) {
  let systemPrompt = `Give a greeting to the user based on the conversation history (mention their last creation if exists) and ask them what they would like to do.`;
  let response = null;

  logger.log('system', 'Generating greeting...');
  if (state.messages.length === 0) {
    systemPrompt = `Greet the user and explain they can choose to create a poem, story, joke or a song.`;
    response = await greetingModel.invoke([new SystemMessage(systemPrompt)]);
  } else {
    const history = 'Conversation History:\n' + JSON.stringify(state.messages, null, 2);

    // console.log(history);

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

async function conversationHistory(state: ArtistGraphState) {
  logger.log('system', 'Generating conversation history...');

  const systemPrompt = `Generate a conversation history based on the conversation you will receive.`;

  const response = await conversationHistoryModel.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  const conversationHistory = new AIMessage(response.conversationHistory);
  logger.log('ai', conversationHistory.content);

  return {
    ...state,
    messages: [...state.messages, conversationHistory],
  };
}

async function other(state: ArtistGraphState) {
  logger.log('system', 'Generating other...');
  const systemPrompt = `You are an assistant that the user arrived to because he selected an invalid option. Explain to the user that the option is invalid and ask him to select a valid option. If user spoke about other things mention that you can't help with that.
  Make answer short and concise and to the point.`;

  const history = 'Conversation History:\n' + JSON.stringify(state.messages, null, 2);

  const response = await model1.invoke([
    new SystemMessage(systemPrompt),
    new SystemMessage(history),
  ]);

  logger.log('ai', response.content);
  const other = new AIMessage(response.content);

  return {
    ...state,
    messages: [...state.messages, other],
  };
}

async function clarify(state: ArtistGraphState) {
  logger.log('system', 'Generating clarify...');
  const systemPrompt = `You are an assistant that the user arrived to because you were unsure of the next step and you need clarification. Explain to the user that you were unsure of the next step and ask him to select a valid option and be more clear and specific. Generate a very short and concise answer`;

  const response = await model1.invoke([
    new SystemMessage(systemPrompt),
    // ...state.messages,
  ]);

  logger.log('ai', response.content);
  const clarify = new AIMessage(response.content);

  return {
    ...state,
    messages: [...state.messages, clarify],
  };
}

async function router(state: ArtistGraphState) {
  if (state.timeout) {
    logger.log('system', 'Timeout reached, ending conversation...');
    return 'end';
  }

  if (!state.input || state.input.toLowerCase() === 'q') {
    logger.log('system', 'Ending conversation...');
    return 'end';
  }

  logger.log('system', 'Routing...');
  let systemPrompt = `Route the user to the next step in the conversation based on the user input. Also provide the confidence in the decision.`;

  const response = await routerModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.input),
  ]);

  logger.log('system', 'Routing decision:', response.decision);
  logger.log('system', 'Confidence in the decision:', JSON.stringify(response.confidence, null, 2));

  return response.decision;
}

async function readInputHITL(state: ArtistGraphState) {
  const userInput: string = interrupt({ reason: 'getUserInput' });

  if (userInput === 'timeout')
    return {
      ...state,
      timeout: true,
    };

  let input = userInput.trim();

  return {
    ...state,
    input,
    messages: [...state.messages, new HumanMessage(input)],
  };
}

export const initialState: ArtistGraphState = {
  input: '',
  route: undefined,
  messages: [],
  timeout: false,
};

// const run = await graph.invoke(initialState, config);
// console.log(run);

async function handleGetUserInputInterrupt(): Promise<'timeout' | string> {
  const controller = new AbortController();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, 60_000);
  });

  try {
    // gets user input using readline interface, returns Promise<string>
    const userInput = getUserInput('Please enter your input:', controller);

    const result = await Promise.race<'timeout' | string>([timeoutPromise, userInput]);

    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Abort') return 'timeout';

    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type InterruptValue = { reason: string; [k: string]: unknown };
export async function runGraph(state: ArtistGraphState = initialState, config: Config) {
  // Keep invoking until the graph finishes (i.e., no interrupt is returned).
  // NOTE: `graph.invoke(new Command({ resume }))` continues from the checkpoint
  // for the given `thread_id` (so we must reuse the same config).
  let run = await graph.invoke(state, config);

  while (isInterrupted<InterruptValue>(run)) {
    const interrupt = run[INTERRUPT][0];

    // handle interrupts here
    switch (interrupt.value?.reason) {
      case 'getUserInput': {
        const userInput: 'timeout' | string = await handleGetUserInputInterrupt();

        // If userInput==timeout then invoke with a timeout command and handle it in node..
        run = await graph.invoke(new Command({ resume: userInput }), config);
        break;
      }

      // Add more cases here for other interrupts
      case 'placeholderInterruptName': {
        // perform logic
        // ...
        // ...
        run = await graph.invoke(new Command({ resume: 'ValueToResumeWith' }), config);
        break;
      }

      default:
        return run;
    }
  }

  return run;
}
