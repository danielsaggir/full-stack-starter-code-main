import { BaseMessage } from 'langchain';
import { z } from 'zod/v4';
import { registry } from '@langchain/langgraph/zod';
import { MessagesZodMeta } from '@langchain/langgraph';

export const greetingSchema = z.object({
  greeting: z.string().describe('The greeting to the user'),
});

export const routerSchema = z
  .object({
    decision: z.enum([
      'analyze',
      'conversation_history',
      'end',
      'other',
      'clarify',
    ]),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('The confidence in which you chose the decision'),
  })
  .describe('The next step in the routing process');

export const conversationHistorySchema = z.object({
  conversationHistory: z.string().describe('The conversation history'),
});

export const analyzeResponseSchema = z.object({
  summary: z.string().describe('A brief summary of the analysis'),
  insights: z
    .array(z.string())
    .describe('Key insights derived from the data'),
  recommendations: z
    .array(z.string())
    .describe(
      'Actionable recommendations (e.g., increase/decrease budget, scale or pause campaigns)',
    ),
  metrics: z
    .object({
      totalSpend: z.number().nullable().describe('Total spend across analyzed campaigns, or null if not applicable'),
      totalRevenue: z.number().nullable().describe('Total revenue across analyzed campaigns, or null if not applicable'),
      averageROI: z.number().nullable().describe('Average ROI across analyzed campaigns, or null if not applicable'),
    })
    .describe('Relevant aggregate metrics referenced in the analysis'),
});

export const dataQuerySchema = z
  .object({
    select: z
      .array(z.string())
      .describe('Field names to include in the output objects'),
    filters: z
      .array(
        z.object({
          field: z.string().describe('Field name to filter on'),
          operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
          value: z.string().describe('Value to compare against (use strings for numbers too)'),
        }),
      )
      .describe('WHERE conditions (applied BEFORE grouping). Empty array for no filters'),
    groupBy: z
      .string()
      .nullable()
      .describe('Field name to GROUP BY, or null for no grouping'),
    aggregations: z
      .array(
        z.object({
          field: z.string().describe('Field to aggregate on'),
          function: z.enum(['sum', 'avg', 'min', 'max', 'count']),
          alias: z.string().describe('Output field name for the aggregated result'),
        }),
      )
      .describe('Aggregation functions to apply when grouping. Empty array if no grouping'),
    having: z
      .array(
        z.object({
          field: z.string().describe('Aggregation alias to filter on (must match an alias from aggregations)'),
          operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
          value: z.string().describe('Value to compare against (use strings for numbers too)'),
        }),
      )
      .describe('HAVING conditions (applied AFTER grouping on aggregated values). Use this for conditions like "total spend > 200". Empty array for no post-aggregation filters')
      .default([]),
    orderBy: z
      .object({
        field: z.string().describe('Field name to sort by. For grouped queries, use an aggregation alias (e.g. "total_spend"). For non-grouped queries, use a dataset field name.'),
        direction: z.enum(['asc', 'desc']),
      })
      .nullable()
      .describe('ORDER BY clause, or null for no sorting'),
    limit: z
      .number()
      .nullable()
      .describe('Maximum number of results to return, or null for all'),
  })
  .describe('A structured data query (like SQL SELECT) to execute against in-memory campaign data');

// ─── Legacy LangGraph State (kept for margin_graph.ts backward compat) ──────────

export const MarginGraphStateDefinition = z
  .object({
    route: routerSchema.optional(),
    input: z.string().describe('The user input'),
    messages: z
      .array(z.instanceof(BaseMessage))
      .register(registry, MessagesZodMeta),
    channelId: z.string().describe('The channel id'),
    threadId: z
      .string()
      .describe('The thread id of the conversation'),
    timeout: z
      .boolean()
      .describe('Whether the conversation has timed out')
      .default(false),
    queryResult: z
      .string()
      .describe('JSON result from the data query, passed to the analyze node')
      .default(''),
  })
  .describe('The state of Margin Agent Graph');

export type MarginGraphState = z.infer<typeof MarginGraphStateDefinition>;
