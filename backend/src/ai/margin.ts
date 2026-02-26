import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { getUserInput, logger } from './utils.js';
import { createAgent, tool, HumanMessage, SystemMessage, initChatModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod/v4';
import { dataQuerySchema } from '../types/margin.types.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration, ChartTypeRegistry } from 'chart.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ─── Configuration ─────────────────────────────────────────────────────────────

const QUERY_MODEL_NAME = 'gpt-5.2';
const AGENT_MODEL_NAME = 'gpt-5.2';

/**
 * Creates a config with thread_id derived from channelId + threadId
 * for persistent memory across conversations.
 */
export function createConfig(channelId: string, threadId: string) {
  return {
    configurable: {
      thread_id: `${channelId}_${threadId}`,
    },
  };
}

// ─── Campaign Data: In-Memory JSON Store ────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory for weekly report JSON files. */
const WEEKLY_DIR = join(__dirname, '../assets/weekly');

/** S3 bucket & prefix for weekly report uploads. */
const WEEKLY_REPORTS_BUCKET = 'dashboard-weekly-reports-twist';
const WEEKLY_REPORTS_S3_PREFIX = 'dor/weekly-report';

async function uploadWeeklyReportToS3(
  fileName: string,
  content: string,
): Promise<void> {
  const client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const key = `${WEEKLY_REPORTS_S3_PREFIX}/${fileName}`;
  await client.send(
    new PutObjectCommand({
      Bucket: WEEKLY_REPORTS_BUCKET,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    }),
  );
}

/** Raw campaign records loaded once at module init. */
const rawData = JSON.parse(
  readFileSync(join(__dirname, '../assets/data.json'), 'utf-8'),
) as Record<string, unknown>[];

/** Last week's campaign records loaded once at module init. */
let rawDataLastWeek: Record<string, unknown>[] = [];
try {
  rawDataLastWeek = JSON.parse(
    readFileSync(join(__dirname, '../assets/data_last_week.json'), 'utf-8'),
  ) as Record<string, unknown>[];
} catch {
  // data_last_week.json may not exist yet — deltas will be unavailable
}

/** All field names available in the dataset. */
const ALL_FIELD_NAMES = Object.keys(rawData[0]);
const ALL_FIELD_NAMES_SET = new Set(ALL_FIELD_NAMES);

// ─── Dynamic Field Metadata Catalog ──────────────────────────────────────────

interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'date' | 'nullable';
  uniqueValues?: string[];
  range?: { min: number; max: number };
}

const CATEGORICAL_THRESHOLD = 30;

function buildFieldCatalog(data: Record<string, unknown>[]): FieldMeta[] {
  const sample = data[0];
  if (!sample) return [];

  const catalog: FieldMeta[] = [];

  for (const fieldName of Object.keys(sample)) {
    const values = data.map((r) => r[fieldName]);
    const nonNull = values.filter((v) => v !== null && v !== undefined);

    if (nonNull.length === 0) {
      catalog.push({ name: fieldName, type: 'nullable' });
      continue;
    }

    const first = nonNull[0];

    if (fieldName === 'date' || fieldName === 'campaignStartTime') {
      catalog.push({ name: fieldName, type: 'date' });
      continue;
    }

    if (typeof first === 'number') {
      const nums = nonNull.map(Number).filter((n) => !isNaN(n));
      catalog.push({
        name: fieldName,
        type: 'number',
        range: nums.length > 0
          ? { min: Math.min(...nums), max: Math.max(...nums) }
          : undefined,
      });
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const unique = [...new Set(nonNull.map((v) => String(v)))].filter(Boolean).sort();
    const meta: FieldMeta = { name: fieldName, type: 'string' };
    if (unique.length <= CATEGORICAL_THRESHOLD) {
      meta.uniqueValues = unique;
    }
    catalog.push(meta);
  }

  return catalog;
}

const FIELD_CATALOG = buildFieldCatalog(rawData);

function formatFieldCatalogForPrompt(catalog: FieldMeta[]): string {
  const lines: string[] = [];
  for (const f of catalog) {
    let line = `  - ${f.name} (${f.type})`;
    if (f.uniqueValues) {
      line += `: [${f.uniqueValues.join(', ')}]`;
    } else if (f.range) {
      line += `: range ${f.range.min} to ${f.range.max}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Pre-built field catalog text for the query planner prompt. */
const FIELD_CATALOG_TEXT = formatFieldCatalogForPrompt(FIELD_CATALOG);

logger.log('system', `Loaded ${rawData.length} campaign records into memory.`);
logger.log('system', `Loaded ${rawDataLastWeek.length} last-week campaign records into memory.`);
logger.log('system', `Built field catalog with ${FIELD_CATALOG.length} fields.`);

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

// ─── Query Planner Model (cheap, for structured query generation) ───────────────

const queryPlannerModel = await initChatModel(QUERY_MODEL_NAME, { modelProvider: 'openai' });
const queryModel = queryPlannerModel.withStructuredOutput(dataQuerySchema as never) as unknown as {
  invoke: (messages: (SystemMessage | HumanMessage)[]) => Promise<DataQuery>;
};

/** Core identifying fields always included in every SELECT. */
const CORE_FIELDS = [
  'campaignName', 'campaignId', 'article', 'site', 'source', 'country',
  'device', 'bidStrategy', 'creativeType',
];

/** Metric fields always included alongside the core fields. */
const METRIC_FIELDS = [
  'spend', 'calculatedRevenue', 'roiPercentages', 'roiDollars',
  'clicks', 'results', 'ecomSales',
];

/** Returns today's date in PST as YYYY-MM-DD. */
function getTodayPST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Returns the min and max date values present in the dataset. */
function getDataDateRange(): { min: string; max: string } {
  const dates = rawData.map((r) => String(r.date ?? '')).filter(Boolean).sort();
  return { min: dates[0], max: dates[dates.length - 1] };
}

function buildQueryPlannerPrompt(intent?: string, context?: string): string {
  const today = getTodayPST();
  const range = getDataDateRange();

  const intentSection = intent
    ? `\nQUERY INTENT HINT: "${intent}" — use this to guide your query structure (e.g., ranking queries need ORDER BY + LIMIT, aggregation queries need GROUP BY, etc.).\n`
    : '';

  const contextSection = context
    ? `\nADDITIONAL CONTEXT FROM PRIOR CONVERSATION:\n${context}\nUse this context to resolve ambiguous references (e.g., "those campaigns", "the same period", "compare with the previous result").\n`
    : '';

  return `You are a deterministic data-query planner for a performance marketing company. Given a natural-language question about campaign performance data, produce a precise structured query that retrieves exactly the records needed.
${intentSection}${contextSection}
TODAY (PST): ${today}
DATA DATE RANGE: ${range.min} to ${range.max}

═══ DATE HANDLING (CRITICAL) ═══
- "today" → "${today}"
- "yesterday" → compute today minus 1 day as YYYY-MM-DD
- "N days ago" → compute the actual YYYY-MM-DD date
- "last 7 days" / "last week" → use gte/lte filters with computed start and end YYYY-MM-DD dates
- NEVER output placeholder tokens (PST_YESTERDAY, PST_TODAY_MINUS_2, etc.). Always output the resolved YYYY-MM-DD string.
- The "date" field is stored as a YYYY-MM-DD string.

═══ FIELD CATALOG (${rawData.length} records) ═══
Every field, its type, and allowed values or numeric range:
${FIELD_CATALOG_TEXT}

═══ FIELD ALIAS MAPPING (NLP → dataset field) ═══
Users often use natural language. Map these terms to the correct dataset field name:
  - "bid strategy" / "bidding" / "bid type" / "bidcap" / "costcap" / "BC" / "CC" → bidStrategy (values: bid cap, cost cap, max num, max val, roas val)
    SHORTHAND MAPPING: "bidcap"/"BC" → bid cap, "costcap"/"CC" → cost cap, "max" → max num OR max val, "roas" → roas val
  - "content manager" / "manager" / "CM" / "buyer" → member (values: admin, cami, jo, ju, lu, om, yn)
  - "platform" / "traffic source" → source (values: fb, tw) or topSource (values: facebook, twitter)
  - "geo" / "geography" / "location" → country (values: us, ms)
  - "topic" / "product" / "niche" → article
  - "device" / "device type" → device (values: m, ms)
  - "asset type" / "media" / "creative format" → mediaType (values: img)
  - "creative type" → creativeType (values: static)
  - "page" / "landing page" → pageName
  - "ROI" / "return" / "ROI%" → roiPercentages (number)
  - "ROI dollars" / "net profit" → roiDollars (number)
  - "revenue" / "earnings" → calculatedRevenue (number)
  - "spend" / "cost" / "budget spent" → spend (number)
  - "CPC" / "cost per click" → computed as spend / clicks
  - "vertical" / "category" → vertical
  - "OS" / "operating system" → os (values: all, and, ios, ms)
  - "date" / "day" / "when" → date

IMPORTANT: Use the EXACT string values listed above for filters. For example:
  - bidStrategy eq "cost cap" (NOT "costcap")
  - bidStrategy eq "bid cap" (NOT "bidcap")
  - bidStrategy eq "max num" (NOT "max")
  - source eq "fb" (NOT "facebook" — use topSource for full names)
  - device eq "m" for mobile

═══ CAMPAIGN NAME STRUCTURE ═══
Campaign names are structured metadata. The campaignName field contains all tokens:
  Format: bucket-platform-geo-device-topic-event_os_destination_type_audience_bidStrategy_optType_contentManager_assetType_pageName_lineId_rateGroup_launchDate
  Example: bst-fb-us-m-haircurlers-purchase_all_direct_a_all_max_num_ju_img_bestfindsonline_v10831505517_electronics_12.22.25
When the user references a specific campaign, match on campaignName using "contains".

═══ STRICT QUERY RULES ═══

ONLY USE FIELDS FROM THE FIELD CATALOG ABOVE. Do NOT invent fields (no "__computed__", "__multi__", or any synthetic field names). If a field is not listed in the catalog, it does not exist.

SELECT:
- ALWAYS include these core fields: ${CORE_FIELDS.join(', ')}
- ALWAYS include these metric fields: ${METRIC_FIELDS.join(', ')}
- You MAY add extra fields if the question specifically asks about them (e.g., "by OS" → add "os", "by date" → add "date", "by page" → add "pageName", "by vertical" → add "vertical").
- Do NOT omit core or metric fields.

FILTERS (WHERE) — applied BEFORE grouping to individual rows:
- ONLY add filters when the user explicitly states a row-level condition (e.g., "in the US" → country eq "us", "bid strategy is cost cap" → bidStrategy eq "cost cap", "date is yesterday" → date eq "<resolved>").
- Do NOT invent filters the user did not ask for. For example, "highest ROI campaign" means no filters — just sort and limit.
- For string matching, use the "contains" operator for partial matches and "eq" for exact matches.
- Use the exact field values from the FIELD CATALOG above. Do NOT guess values.
- CRITICAL: Do NOT use WHERE filters on metric thresholds (e.g., spend >= 200) when the intent is to filter on AGGREGATED totals. Use HAVING instead (see below). Individual rows often have small values; filtering rows by spend >= 200 before aggregation will eliminate most records and produce 0 results.

GROUP BY / AGGREGATIONS:
- ONLY use groupBy when the user explicitly asks for grouped/aggregated data (e.g., "total spend by country", "average ROI per bid strategy", "performance by content manager", "top campaigns by total spend").
- Also use groupBy when the user asks for "campaigns with total spend > X" — you need to aggregate first, then filter with HAVING.
- Do NOT group when the user asks for individual row-level records.
- When grouping, include appropriate aggregations: sum for spend/revenue, avg for ROI/CPC, count for campaign counts.
- Aggregation aliases (the "alias" field) become the output field names. Choose clear names like "total_spend", "total_revenue", "avg_roi", "campaign_count".

HAVING — post-aggregation filters (applied AFTER grouping):
- Use HAVING when the user wants to filter on aggregated values (e.g., "campaigns with total spend over 200", "groups with average ROI > 50").
- HAVING fields MUST reference aggregation aliases (e.g., "total_spend"), NOT raw dataset field names.
- HAVING only works with GROUP BY queries. If there is no groupBy, use WHERE filters instead.
- Example: "campaigns that spent more than $200 total" → GROUP BY campaignId, aggregate sum(spend) as total_spend, then HAVING total_spend gt "200".

ORDER BY:
- "best" / "highest" / "top" → order by the relevant metric DESC.
- "worst" / "lowest" / "bottom" → order by the relevant metric ASC.
- General questions → order by the most relevant metric DESC.
- For grouped queries, ORDER BY MUST use an aggregation alias (e.g., "total_spend", "avg_roi"), NOT a raw field name.
- For non-grouped queries, ORDER BY uses a raw dataset field name.
- ORDER BY accepts exactly ONE field and ONE direction. Do NOT combine multiple fields (e.g., "date desc, spend" is INVALID).

LIMIT:
- "top N" / "worst N" → limit to exactly N.
- "the highest" / "the lowest" (singular) → limit to 1.
- No number specified → default limit to 10.
- Aggregation / groupBy queries without a ranking intent → limit to null (return all groups).

Numbers are stored as numbers in the dataset (not strings). Use numeric comparisons (gt, gte, lt, lte) for numeric fields.

═══ FEW-SHOT EXAMPLES ═══

Q: "top 5 campaigns by ROI"
A: { select: [${[...CORE_FIELDS, ...METRIC_FIELDS].map(f => `"${f}"`).join(', ')}], filters: [], groupBy: null, aggregations: [], having: [], orderBy: { field: "roiPercentages", direction: "desc" }, limit: 5 }

Q: "campaigns with spend over 100 using cost cap"
A: { select: [${[...CORE_FIELDS, ...METRIC_FIELDS].map(f => `"${f}"`).join(', ')}], filters: [{ field: "spend", operator: "gt", value: "100" }, { field: "bidStrategy", operator: "eq", value: "cost cap" }], groupBy: null, aggregations: [], having: [], orderBy: { field: "spend", direction: "desc" }, limit: 10 }

Q: "total spend by country"
A: { select: ["country"], filters: [], groupBy: "country", aggregations: [{ field: "spend", function: "sum", alias: "total_spend" }, { field: "calculatedRevenue", function: "sum", alias: "total_revenue" }, { field: "roiPercentages", function: "avg", alias: "avg_roi" }], having: [], orderBy: { field: "total_spend", direction: "desc" }, limit: null }

Q: "yesterday's worst performing campaigns"
A: { select: [${[...CORE_FIELDS, ...METRIC_FIELDS, '"date"'].map(f => f.startsWith('"') ? f : `"${f}"`).join(', ')}], filters: [{ field: "date", operator: "eq", value: "<RESOLVED_YESTERDAY_DATE>" }], groupBy: null, aggregations: [], having: [], orderBy: { field: "roiPercentages", direction: "asc" }, limit: 10 }

Q: "average ROI by bid strategy for the last 3 days"
A: { select: ["bidStrategy"], filters: [{ field: "date", operator: "gte", value: "<RESOLVED_3_DAYS_AGO>" }, { field: "date", operator: "lte", value: "${today}" }], groupBy: "bidStrategy", aggregations: [{ field: "roiPercentages", function: "avg", alias: "avg_roi" }, { field: "spend", function: "sum", alias: "total_spend" }, { field: "calculatedRevenue", function: "sum", alias: "total_revenue" }], having: [], orderBy: { field: "avg_roi", direction: "desc" }, limit: null }

Q: "performance by content manager"
A: { select: ["member"], filters: [], groupBy: "member", aggregations: [{ field: "spend", function: "sum", alias: "total_spend" }, { field: "calculatedRevenue", function: "sum", alias: "total_revenue" }, { field: "roiPercentages", function: "avg", alias: "avg_roi" }, { field: "clicks", function: "sum", alias: "total_clicks" }], having: [], orderBy: { field: "total_spend", direction: "desc" }, limit: null }

Q: "which bid cap campaigns have negative ROI?"
A: { select: [${[...CORE_FIELDS, ...METRIC_FIELDS].map(f => `"${f}"`).join(', ')}], filters: [{ field: "bidStrategy", operator: "eq", value: "bid cap" }, { field: "roiPercentages", operator: "lt", value: "0" }], groupBy: null, aggregations: [], having: [], orderBy: { field: "roiPercentages", direction: "asc" }, limit: 10 }

Q: "top campaigns by total spend over $200 in the last 5 days, ranked by ROI dollars"
A: { select: ["campaignId", "campaignName"], filters: [{ field: "date", operator: "gte", value: "<RESOLVED_5_DAYS_AGO>" }, { field: "date", operator: "lte", value: "${today}" }], groupBy: "campaignId", aggregations: [{ field: "spend", function: "sum", alias: "total_spend" }, { field: "roiDollars", function: "sum", alias: "total_roi_dollars" }, { field: "calculatedRevenue", function: "sum", alias: "total_revenue" }, { field: "clicks", function: "sum", alias: "total_clicks" }], having: [{ field: "total_spend", operator: "gte", value: "200" }], orderBy: { field: "total_roi_dollars", direction: "desc" }, limit: 10 }

Q: "worst performing campaigns with at least $10 total spend"
A: { select: ["campaignId", "campaignName"], filters: [], groupBy: "campaignId", aggregations: [{ field: "spend", function: "sum", alias: "total_spend" }, { field: "roiDollars", function: "sum", alias: "total_roi_dollars" }, { field: "calculatedRevenue", function: "sum", alias: "total_revenue" }], having: [{ field: "total_spend", operator: "gte", value: "10" }], orderBy: { field: "total_roi_dollars", direction: "asc" }, limit: 10 }

NOTE: In the examples above, <RESOLVED_YESTERDAY_DATE>, <RESOLVED_3_DAYS_AGO>, and <RESOLVED_5_DAYS_AGO> are placeholders — YOU must resolve them to actual YYYY-MM-DD dates based on TODAY: ${today}.`;
}

// ─── Query Validation ────────────────────────────────────────────────────────

interface QueryValidation {
  correctedQuery: DataQuery;
  warnings: string[];
  corrections: string[];
}

/** Map of common misspellings / alternative names → correct field name. */
const FIELD_ALIAS_MAP: Record<string, string> = {
  bid_strategy: 'bidStrategy',
  bidstrategy: 'bidStrategy',
  campaign_name: 'campaignName',
  campaignname: 'campaignName',
  campaign_id: 'campaignId',
  campaignid: 'campaignId',
  creative_type: 'creativeType',
  creativetype: 'creativeType',
  media_type: 'mediaType',
  mediatype: 'mediaType',
  calculated_revenue: 'calculatedRevenue',
  calculatedrevenue: 'calculatedRevenue',
  revenue: 'calculatedRevenue',
  roi: 'roiPercentages',
  roi_percentages: 'roiPercentages',
  roipercentages: 'roiPercentages',
  roi_pct: 'roiPercentages',
  roi_dollars: 'roiDollars',
  roidollars: 'roiDollars',
  net_profit: 'roiDollars',
  ecom_sales: 'ecomSales',
  ecomsales: 'ecomSales',
  cost_impressions: 'costImpressions',
  costimpressions: 'costImpressions',
  impressions: 'costImpressions',
  page_name: 'pageName',
  pagename: 'pageName',
  content_manager: 'member',
  contentmanager: 'member',
  manager: 'member',
  campaign_start_time: 'campaignStartTime',
  campaignstarttime: 'campaignStartTime',
  start_time: 'campaignStartTime',
  article_type: 'articleType',
  articletype: 'articleType',
  top_source: 'topSource',
  topsource: 'topSource',
  platform: 'source',
  geo: 'country',
  geography: 'country',
  topic: 'article',
  product: 'article',
  niche: 'article',
  asset_type: 'mediaType',
  creative_version: 'creativeVersion',
  creativeversion: 'creativeVersion',
  campaign_type: 'campaignType',
  campaigntype: 'campaignType',
  ios_clicks: 'iosClicks',
  iosclicks: 'iosClicks',
  us_clicks: 'usClicks',
  usclicks: 'usClicks',
  ios_ratio: 'iosRatio',
  iosratio: 'iosRatio',
};

/** Numeric fields where "contains" operator is likely a mistake. */
const NUMERIC_FIELDS_SET = new Set(
  FIELD_CATALOG.filter((f) => f.type === 'number').map((f) => f.name),
);

function resolveFieldName(name: string): { resolved: string; corrected: boolean } {
  if (ALL_FIELD_NAMES_SET.has(name)) return { resolved: name, corrected: false };

  const lower = name.toLowerCase();
  const alias = FIELD_ALIAS_MAP[lower];
  if (alias && ALL_FIELD_NAMES_SET.has(alias)) return { resolved: alias, corrected: true };

  // Try case-insensitive exact match
  for (const f of ALL_FIELD_NAMES) {
    if (f.toLowerCase() === lower) return { resolved: f, corrected: true };
  }

  return { resolved: name, corrected: false };
}

function validateAndCorrectQuery(query: DataQuery): QueryValidation {
  const warnings: string[] = [];
  const corrections: string[] = [];

  const corrected: DataQuery = JSON.parse(JSON.stringify(query)) as DataQuery;

  // Ensure having array exists (may be missing from older LLM outputs)
  if (!corrected.having) corrected.having = [];

  // Collect aggregation aliases so ORDER BY and HAVING can reference them
  const aggAliases = new Set(corrected.aggregations.map((a) => a.alias));

  // Validate & correct SELECT fields
  corrected.select = corrected.select.map((field) => {
    const { resolved, corrected: wasCorrected } = resolveFieldName(field);
    if (wasCorrected) corrections.push(`SELECT: "${field}" → "${resolved}"`);
    if (!ALL_FIELD_NAMES_SET.has(resolved)) warnings.push(`SELECT: unknown field "${field}" (not in dataset)`);
    return resolved;
  });

  // Validate & correct FILTER (WHERE) fields — must be raw dataset fields
  for (const filter of corrected.filters) {
    const { resolved, corrected: wasCorrected } = resolveFieldName(filter.field);
    if (wasCorrected) corrections.push(`FILTER: "${filter.field}" → "${resolved}"`);
    if (!ALL_FIELD_NAMES_SET.has(resolved)) warnings.push(`FILTER: unknown field "${filter.field}" (not in dataset)`);
    filter.field = resolved;

    if (NUMERIC_FIELDS_SET.has(resolved) && filter.operator === 'contains') {
      warnings.push(`FILTER: "contains" operator used on numeric field "${resolved}" — this may not produce expected results`);
    }
  }

  // Validate & correct GROUP BY
  if (corrected.groupBy) {
    const { resolved, corrected: wasCorrected } = resolveFieldName(corrected.groupBy);
    if (wasCorrected) corrections.push(`GROUP BY: "${corrected.groupBy}" → "${resolved}"`);
    if (!ALL_FIELD_NAMES_SET.has(resolved)) warnings.push(`GROUP BY: unknown field "${corrected.groupBy}" (not in dataset)`);
    corrected.groupBy = resolved;
  }

  // Validate & correct AGGREGATION source fields — must be raw dataset fields
  for (const agg of corrected.aggregations) {
    const { resolved, corrected: wasCorrected } = resolveFieldName(agg.field);
    if (wasCorrected) corrections.push(`AGGREGATION: "${agg.field}" → "${resolved}"`);
    if (!ALL_FIELD_NAMES_SET.has(resolved)) warnings.push(`AGGREGATION: unknown field "${agg.field}" (not in dataset)`);
    agg.field = resolved;
  }

  // Validate HAVING fields — must reference aggregation aliases
  for (const hf of corrected.having) {
    if (!aggAliases.has(hf.field)) {
      warnings.push(`HAVING: field "${hf.field}" is not an aggregation alias. Available aliases: [${[...aggAliases].join(', ')}]`);
    }
  }

  // Validate & correct ORDER BY — can be a raw field OR an aggregation alias
  if (corrected.orderBy) {
    const orderField = corrected.orderBy.field;

    // If it's an aggregation alias, it's valid as-is
    if (aggAliases.has(orderField)) {
      // Valid — ordering by aggregation alias
    } else {
      // Try resolving as a raw dataset field
      const { resolved, corrected: wasCorrected } = resolveFieldName(orderField);
      if (wasCorrected) corrections.push(`ORDER BY: "${orderField}" → "${resolved}"`);
      if (!ALL_FIELD_NAMES_SET.has(resolved) && !aggAliases.has(resolved)) {
        warnings.push(`ORDER BY: unknown field "${orderField}" (not in dataset and not an aggregation alias)`);
      }
      corrected.orderBy.field = resolved;
    }
  }

  return { correctedQuery: corrected, warnings, corrections };
}

// ─── Query Description Builder ───────────────────────────────────────────────

function buildQueryDescription(query: DataQuery): string {
  let desc = `SELECT [${query.select.join(', ')}]`;
  if (query.filters.length > 0) {
    desc += ` WHERE ${query.filters.map((f) => `${f.field} ${f.operator} "${f.value}"`).join(' AND ')}`;
  }
  if (query.groupBy) desc += ` GROUP BY ${query.groupBy}`;
  if (query.aggregations.length > 0) {
    desc += ` AGG [${query.aggregations.map((a) => `${a.function}(${a.field}) AS ${a.alias}`).join(', ')}]`;
  }
  if (query.having && query.having.length > 0) {
    desc += ` HAVING ${query.having.map((h) => `${h.field} ${h.operator} "${h.value}"`).join(' AND ')}`;
  }
  if (query.orderBy) desc += ` ORDER BY ${query.orderBy.field} ${query.orderBy.direction}`;
  if (query.limit != null) desc += ` LIMIT ${String(query.limit)}`;
  return desc;
}

/** Max records returned to the agent to prevent context overflow. */
const MAX_RESULT_RECORDS = 10_000;

// ─── Tools ──────────────────────────────────────────────────────────────────────

/**
 * Tool: query_campaign_data
 * Translates a natural-language question into a structured SQL-like query,
 * validates the generated query against the actual dataset schema, executes
 * it against the in-memory dataset, and returns structured results with
 * metadata (count, warnings, truncation status).
 */
const queryCampaignData = tool(
  async ({ question, intent, context }: { question: string; intent?: string; context?: string }) => {
    logger.log('system', 'Generating data query from user input...');

    try {
      const querySpec = await queryModel.invoke([
        new SystemMessage(buildQueryPlannerPrompt(intent, context)),
        new HumanMessage(question),
      ]);

      const rawQuery: DataQuery = querySpec;

      // Validate and auto-correct the generated query
      const { correctedQuery, warnings, corrections } = validateAndCorrectQuery(rawQuery);

      if (corrections.length > 0) {
        logger.log('system', `Query auto-corrections: ${corrections.join('; ')}`);
      }
      if (warnings.length > 0) {
        logger.log('system', `Query warnings: ${warnings.join('; ')}`);
      }

      const queryDesc = buildQueryDescription(correctedQuery);
      logger.log('system', `Query: ${queryDesc}`);

      const queryResultJson = executeQuery(correctedQuery, rawData);
      const parsedResult = JSON.parse(queryResultJson) as unknown[];
      const totalCount = parsedResult.length;
      logger.log('system', `Query returned ${totalCount} records.`);

      // Handle 0 results
      if (totalCount === 0) {
        const result = {
          data: [],
          count: 0,
          query_description: queryDesc,
          warnings: [
            ...warnings,
            'Query returned 0 results. The filters may be too restrictive, or field values may not match. Consider broadening the query or checking exact field values.',
          ],
          corrections,
          truncated: false,
        };
        return JSON.stringify(result, null, 2);
      }

      // Cap large result sets
      const truncated = totalCount > MAX_RESULT_RECORDS;
      const cappedResult = truncated ? parsedResult.slice(0, MAX_RESULT_RECORDS) : parsedResult;

      if (truncated) {
        warnings.push(`Result set truncated from ${totalCount} to ${MAX_RESULT_RECORDS} records. Consider adding filters or a LIMIT to narrow results.`);
      }

      const result = {
        data: cappedResult,
        count: totalCount,
        query_description: queryDesc,
        warnings,
        corrections,
        truncated,
      };

      return JSON.stringify(result, null, 2);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.log('system', `Query generation/execution failed: ${errorMsg}`);
      return JSON.stringify({
        data: [],
        count: 0,
        query_description: 'FAILED',
        warnings: [`Error during query generation or execution: ${errorMsg}. Please try rephrasing the question.`],
        corrections: [],
        truncated: false,
      }, null, 2);
    }
  },
  {
    name: 'query_campaign_data',
    description: `Query the campaign performance dataset (${rawData.length} records). Use this tool whenever the user asks about campaign data, performance, ROI, spend, revenue, best/worst campaigns, comparisons, aggregations, or any data-driven question.

Available dimensions: campaignName, campaignId, article (topic/product), site, source (fb/tw), country (us/ms), device (m/ms), bidStrategy (bid cap/cost cap/max num/max val/roas val), creativeType, mediaType, member (content manager), os, date, vertical, pageName, campaignType.

Available metrics: spend, calculatedRevenue, roiPercentages, roiDollars, clicks, results, ecomSales, costImpressions, iosClicks, usClicks.

Pass the user's question. Optionally provide an intent hint and conversation context for better query accuracy. Results include metadata (count, warnings, corrections, truncation status).`,
    schema: z.object({
      question: z.string().describe('The user\'s analytical question about campaign data'),
      intent: z.enum(['ranking', 'aggregation', 'filter', 'comparison', 'overview', 'date_scoped']).optional()
        .describe('Optional hint about the query type to improve accuracy'),
      context: z.string().optional()
        .describe('Optional prior conversation context to resolve ambiguous references (e.g., "those campaigns", "same period")'),
    }),
  },
);

/**
 * Tool: get_conversation_history
 * Returns a summary of the conversation so far. The agent calls this
 * when the user asks to see their conversation history.
 */
const getConversationHistory = tool(
  ({ request }: { request: string }) => {
    logger.log('system', 'Retrieving conversation history...');
    return `The user requested a conversation summary: "${request}". Please review the message history in your context and provide a clear, concise summary highlighting key analyses performed and insights shared.`;
  },
  {
    name: 'get_conversation_history',
    description: 'Get the conversation history summary. Use this when the user asks to see what has been discussed so far, or wants a recap of prior analyses.',
    schema: z.object({
      request: z.string().describe('The user\'s request for conversation history'),
    }),
  },
);

/**
 * Tool: parse_campaign_name
 * Deterministically parses a structured campaign name into its component tokens
 * per the company's naming convention. No LLM involved — pure string splitting.
 *
 * Name format: {bucket}-{platform}-{geo}-{device}-{product}-{conversion}_{os}_{destination}_{textFlag}_{audience}_{bidStrategy}_{optType}_{contentMgr}_{assetType}_{pageName}_{lineId}_{rateGroup}_{launchDate}
 * Optional trailing tokens: BM/BM2/BMx (bid adjustment), scaler (duplication)
 */
function parseCampaignNameTokens(campaignName: string): Record<string, string> {
  // Split header (dash-separated) from body (underscore-separated)
  const firstUnderscoreIdx = campaignName.indexOf('_');
  let header: string;
  let bodyTokens: string[];

  if (firstUnderscoreIdx === -1) {
    header = campaignName;
    bodyTokens = [];
  } else {
    header = campaignName.substring(0, firstUnderscoreIdx);
    bodyTokens = campaignName.substring(firstUnderscoreIdx + 1).split('_');
  }

  const headerParts = header.split('-');

  const parsed: Record<string, string> = {
    raw: campaignName,
    bucket: headerParts[0] ?? 'unknown',
    platform: headerParts[1] ?? 'unknown',
    geo: headerParts[2] ?? 'unknown',
    device: headerParts[3] ?? 'unknown',
    product: headerParts.slice(4, -1).join('-') || 'unknown',
    conversion: headerParts[headerParts.length - 1] ?? 'unknown',
  };

  // Body tokens (positional)
  const bodyFields = [
    'os', 'destination', 'textFlag', 'audience', 'bidStrategy',
    'optimizationType', 'contentManager', 'assetType', 'pageName',
    'lineId', 'rateGroup', 'launchDate',
  ];

  for (let i = 0; i < bodyFields.length && i < bodyTokens.length; i++) {
    parsed[bodyFields[i]] = bodyTokens[i];
  }

  // Detect special tokens in any remaining body tokens or the full name
  const nameLower = campaignName.toLowerCase();
  if (nameLower.includes('scaler')) parsed.scaler = 'true';
  if (/\bbm\d*\b/i.test(campaignName)) parsed.bidAdjustment = 'true';

  // Extra tokens beyond the standard 12
  if (bodyTokens.length > bodyFields.length) {
    parsed.extraTokens = bodyTokens.slice(bodyFields.length).join('_');
  }

  return parsed;
}

const parseCampaignName = tool(
  ({ campaignName }: { campaignName: string }) => {
    logger.log('system', `Parsing campaign name: ${campaignName}`);
    const parsed = parseCampaignNameTokens(campaignName);
    return JSON.stringify(parsed, null, 2);
  },
  {
    name: 'parse_campaign_name',
    description: 'Parse a structured campaign name into its component tokens (bucket, platform, geo, device, product, conversion, OS, bid strategy, content manager, asset type, page name, line ID, rate group, launch date, etc.). Use this to break down any campaign name into meaningful metadata.',
    schema: z.object({
      campaignName: z.string().describe('The full campaign name string to parse'),
    }),
  },
);

// ─── Visualize Tool: Charts & Graphs ─────────────────────────────────────────────

const CHARTS_DIR = join(__dirname, '../assets/visuals/charts');
const GRAPHS_DIR = join(__dirname, '../assets/visuals/graphs');

if (!existsSync(CHARTS_DIR)) mkdirSync(CHARTS_DIR, { recursive: true });
if (!existsSync(GRAPHS_DIR)) mkdirSync(GRAPHS_DIR, { recursive: true });

const VISUAL_WIDTH = 1400;
const VISUAL_HEIGHT = 900;

/** Light-background canvas for charts (bar, pie, doughnut). */
const chartCanvas = new ChartJSNodeCanvas({
  width: VISUAL_WIDTH,
  height: VISUAL_HEIGHT,
  backgroundColour: '#FAFBFC',
});

/** Dark-background canvas for graphs (line). */
const graphCanvas = new ChartJSNodeCanvas({
  width: VISUAL_WIDTH,
  height: VISUAL_HEIGHT,
  backgroundColour: '#111827',
});

// ── Helper: hex → rgba ──
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Chart palette: vibrant on light background ──
const CHART_PALETTE = {
  solid: [
    '#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626',
    '#7C3AED', '#DB2777', '#0D9488', '#EA580C', '#2563EB',
    '#65A30D', '#9333EA',
  ],
  fill(i: number, a = 0.78) { return hexToRgba(CHART_PALETTE.solid[i % CHART_PALETTE.solid.length], a); },
  grid: '#E5E7EB',
  gridLight: '#F3F4F6',
  title: '#111827',
  text: '#374151',
  subtitle: '#6B7280',
};

// ── Graph palette: neon/glow on dark background ──
const GRAPH_PALETTE = {
  solid: [
    '#22D3EE', '#A78BFA', '#34D399', '#FBBF24', '#F87171',
    '#F472B6', '#60A5FA', '#2DD4BF', '#FB923C', '#C084FC',
    '#4ADE80', '#E879F9',
  ],
  fill(i: number, a = 0.20) { return hexToRgba(GRAPH_PALETTE.solid[i % GRAPH_PALETTE.solid.length], a); },
  grid: '#1F2937',
  gridLight: '#374151',
  title: '#F9FAFB',
  text: '#D1D5DB',
  subtitle: '#9CA3AF',
  pointFill: '#111827',
};

interface VisualInput {
  chartType: 'bar' | 'horizontalBar' | 'line' | 'pie' | 'doughnut';
  title: string;
  labels: string[];
  datasets: { label: string; data: number[] }[];
  xAxisLabel?: string;
  yAxisLabel?: string;
}

// ── Build config for CHARTS (bar, horizontalBar, pie, doughnut) — light theme ──
function buildChartConfig(input: VisualInput): ChartConfiguration {
  const { chartType, title, labels, datasets, xAxisLabel, yAxisLabel } = input;
  const P = CHART_PALETTE;

  const isPie = chartType === 'pie' || chartType === 'doughnut';
  const isHorizontal = chartType === 'horizontalBar';
  const resolvedType: keyof ChartTypeRegistry = isHorizontal ? 'bar' : (chartType as keyof ChartTypeRegistry);

  const styledDatasets = datasets.map((ds, dsIdx) => {
    if (isPie) {
      return {
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.data.map((_, i) => P.fill(i, 0.82)),
        borderColor: ds.data.map((_, i) => P.solid[i % P.solid.length]),
        borderWidth: 2,
        hoverOffset: 12,
      };
    }
    const singleSeries = datasets.length === 1;
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: singleSeries
        ? ds.data.map((_, i) => P.fill(i, 0.78))
        : P.fill(dsIdx, 0.78),
      borderColor: singleSeries
        ? ds.data.map((_, i) => P.solid[i % P.solid.length])
        : P.solid[dsIdx % P.solid.length],
      borderWidth: 2,
      borderRadius: 6,
      borderSkipped: false as const,
      maxBarThickness: 64,
    };
  });

  return {
    type: resolvedType,
    data: { labels, datasets: styledDatasets as ChartConfiguration['data']['datasets'] },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      indexAxis: isHorizontal ? ('y' as const) : ('x' as const),
      layout: { padding: { top: 24, right: 36, bottom: 24, left: 24 } },
      plugins: {
        title: {
          display: true, text: title, color: P.title,
          font: { size: 24, weight: 'bold' as const },
          padding: { top: 12, bottom: 28 },
        },
        subtitle: { display: false },
        legend: {
          display: datasets.length > 1 || isPie,
          position: isPie ? ('right' as const) : ('top' as const),
          labels: {
            color: P.text,
            font: { size: 13, weight: 'bold' as const },
            padding: 18, usePointStyle: true, pointStyle: 'circle' as const,
          },
        },
        tooltip: { enabled: false },
      },
      scales: isPie ? undefined : {
        x: {
          title: { display: !!xAxisLabel, text: xAxisLabel ?? '', color: P.subtitle, font: { size: 14, weight: 'bold' as const }, padding: { top: 12 } },
          ticks: { color: P.text, font: { size: 12 }, maxRotation: 45, minRotation: 0 },
          grid: { color: P.gridLight, drawTicks: false },
          border: { color: P.grid },
        },
        y: {
          title: { display: !!yAxisLabel, text: yAxisLabel ?? '', color: P.subtitle, font: { size: 14, weight: 'bold' as const }, padding: { bottom: 12 } },
          ticks: { color: P.text, font: { size: 12 } },
          grid: { color: P.gridLight, drawTicks: false },
          border: { color: P.grid, display: false },
          beginAtZero: true,
        },
      },
    },
  };
}

// ── Build config for GRAPHS (line) — dark theme with neon glow ──
function buildGraphConfig(input: VisualInput): ChartConfiguration {
  const { title, labels, datasets, xAxisLabel, yAxisLabel } = input;
  const P = GRAPH_PALETTE;

  const styledDatasets = datasets.map((ds, dsIdx) => ({
    label: ds.label,
    data: ds.data,
    borderColor: P.solid[dsIdx % P.solid.length],
    backgroundColor: P.fill(dsIdx, 0.18),
    borderWidth: 3.5,
    pointRadius: datasets.length > 1 ? 5 : 6,
    pointHoverRadius: 8,
    pointBackgroundColor: P.pointFill,
    pointBorderColor: P.solid[dsIdx % P.solid.length],
    pointBorderWidth: 3,
    fill: true,
    tension: 0.4,
  }));

  return {
    type: 'line',
    data: { labels, datasets: styledDatasets as ChartConfiguration['data']['datasets'] },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      layout: { padding: { top: 24, right: 36, bottom: 24, left: 24 } },
      plugins: {
        title: {
          display: true, text: title, color: P.title,
          font: { size: 24, weight: 'bold' as const },
          padding: { top: 12, bottom: 28 },
        },
        subtitle: { display: false },
        legend: {
          display: datasets.length > 1,
          position: 'top' as const,
          labels: {
            color: P.text,
            font: { size: 13, weight: 'bold' as const },
            padding: 18, usePointStyle: true, pointStyle: 'circle' as const,
          },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          title: { display: !!xAxisLabel, text: xAxisLabel ?? '', color: P.subtitle, font: { size: 14, weight: 'bold' as const }, padding: { top: 12 } },
          ticks: { color: P.text, font: { size: 12 }, maxRotation: 45, minRotation: 0 },
          grid: { color: P.gridLight, drawTicks: false },
          border: { color: P.grid },
        },
        y: {
          title: { display: !!yAxisLabel, text: yAxisLabel ?? '', color: P.subtitle, font: { size: 14, weight: 'bold' as const }, padding: { bottom: 12 } },
          ticks: { color: P.text, font: { size: 12 } },
          grid: { color: P.gridLight, drawTicks: false },
          border: { color: P.grid, display: false },
          beginAtZero: true,
        },
      },
    },
  };
}

/** Charts = categorical (bar, horizontalBar, pie, doughnut). Graphs = continuous/trend (line). */
function isGraphType(chartType: string): boolean {
  return chartType === 'line';
}

function generateVisualFileName(hint?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = hint
    ? hint.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 50)
    : 'visual';
  return `${base}_${ts}.png`;
}

/** Record of a visualization created during this session. */
interface VisualizationRecord {
  id: number;
  kind: 'chart' | 'graph';
  chartType: string;
  title: string;
  labels: string[];
  datasets: { label: string; data: number[] }[];
  xAxisLabel?: string;
  yAxisLabel?: string;
  filePath: string;
  createdAt: string;
}

/** Session-level memory of every visualization Margin has produced. */
const visualizationHistory: VisualizationRecord[] = [];

/** Returns the current number of stored visualizations. */
export function getVisualizationCount(): number {
  return visualizationHistory.length;
}

/** Returns visualizations added after `startIndex` (file path + title only). */
export function getVisualizationsSince(startIndex: number): { filePath: string; title: string }[] {
  return visualizationHistory.slice(startIndex).map(r => ({
    filePath: r.filePath,
    title: r.title,
  }));
}

const visualizeTool = tool(
  async (params: {
    chartType: 'bar' | 'horizontalBar' | 'line' | 'pie' | 'doughnut';
    title: string;
    labels: string[];
    datasets: { label: string; data: number[] }[];
    xAxisLabel?: string;
    yAxisLabel?: string;
    fileName?: string;
  }) => {
    const isGraph = isGraphType(params.chartType);
    const kind = isGraph ? 'graph' : 'chart';
    const outDir = isGraph ? GRAPHS_DIR : CHARTS_DIR;

    logger.log('system', `Generating ${kind} (${params.chartType}): "${params.title}"...`);

    const visualInput: VisualInput = {
      chartType: params.chartType,
      title: params.title,
      labels: params.labels,
      datasets: params.datasets,
      xAxisLabel: params.xAxisLabel,
      yAxisLabel: params.yAxisLabel,
    };

    const config = isGraph ? buildGraphConfig(visualInput) : buildChartConfig(visualInput);
    const canvas = isGraph ? graphCanvas : chartCanvas;
    const imageBuffer = await canvas.renderToBuffer(config);
    const fileName = generateVisualFileName(params.fileName);
    const filePath = join(outDir, fileName);

    writeFileSync(filePath, imageBuffer);
    logger.log('system', `${kind.charAt(0).toUpperCase() + kind.slice(1)} saved to: ${filePath}`);

    const record: VisualizationRecord = {
      id: visualizationHistory.length + 1,
      kind,
      chartType: params.chartType,
      title: params.title,
      labels: params.labels,
      datasets: params.datasets,
      xAxisLabel: params.xAxisLabel,
      yAxisLabel: params.yAxisLabel,
      filePath,
      createdAt: new Date().toISOString(),
    };
    visualizationHistory.push(record);

    const dataSummary = params.datasets.map(ds =>
      `  ${ds.label}: [${ds.data.map(n => n.toFixed(2)).join(', ')}]`,
    ).join('\n');

    return (
      `${kind.charAt(0).toUpperCase() + kind.slice(1)} #${record.id} generated and saved successfully.\n` +
      `File: ${filePath}\n` +
      `Type: ${params.chartType} | Title: ${params.title}\n` +
      `Dimensions: ${VISUAL_WIDTH}x${VISUAL_HEIGHT}px\n` +
      `Labels: [${params.labels.join(', ')}]\n` +
      `Data:\n${dataSummary}\n` +
      `This visualization is stored in memory as #${record.id}. ` +
      `Use recall_visualizations to retrieve it or any previous visualization for further analysis.`
    );
  },
  {
    name: 'visualize_tool',
    description:
      `Generate a professional visualization image from structured data and save it locally as a PNG file.\n` +
      `Use this tool AFTER retrieving data with query_campaign_data.\n\n` +
      `═══ CRITICAL: CHART vs GRAPH — TWO DIFFERENT THINGS ═══\n\n` +
      `This tool produces TWO distinct visualization types with completely different appearances:\n\n` +
      `CHARTS (light background, solid colors, categorical):\n` +
      `  chartType "bar"           → vertical bars comparing categories. Saved to charts/.\n` +
      `  chartType "horizontalBar" → horizontal bars (use when labels are long). Saved to charts/.\n` +
      `  chartType "pie"           → proportional slices of a whole. Saved to charts/.\n` +
      `  chartType "doughnut"      → same as pie, visually cleaner. Saved to charts/.\n\n` +
      `GRAPHS (dark background, neon glow lines, trends/time-series):\n` +
      `  chartType "line"          → connected data points showing trends over time. Saved to graphs/.\n\n` +
      `VOCABULARY RULES — FOLLOW STRICTLY:\n` +
      `- If the user says "chart" → use bar, horizontalBar, pie, or doughnut.\n` +
      `- If the user says "graph" → use "line". ALWAYS. A graph = line type. Never use bar/pie for a graph.\n` +
      `- If the user asks for "a chart AND a graph" → call this tool TWICE: once with a chart type (bar/pie/doughnut) and once with "line".\n` +
      `- If the user says "visualize" or "show me" without specifying → pick the most appropriate type based on the data.\n\n` +
      `WHEN TO USE:\n` +
      `- When the user asks for a chart, graph, visualization, or visual representation.\n` +
      `- When the user says "show me", "plot", "graph", "chart", "visualize", or similar.\n` +
      `- ALWAYS query data first with query_campaign_data, then call this tool.\n\n` +
      `DATA FORMATTING RULES:\n` +
      `- labels: array of category names (countries, dates, campaign short names, bid strategies, etc.).\n` +
      `- datasets: each object has "label" (series/legend name) and "data" (numbers matching labels length).\n` +
      `- For single-metric views: use ONE dataset.\n` +
      `- For comparisons (e.g., spend vs revenue): use MULTIPLE datasets.\n` +
      `- Round all numbers to 2 decimal places.\n` +
      `- Truncate very long labels (max ~25 chars).\n` +
      `- If more than 15 categories, show only top/bottom N.\n` +
      `- Always provide descriptive xAxisLabel and yAxisLabel for bar and line types.\n` +
      `- Provide a clear, specific title (e.g., "Top 10 Campaigns by ROI %" not just "Chart").`,
    schema: z.object({
      chartType: z.enum(['bar', 'horizontalBar', 'line', 'pie', 'doughnut'])
        .describe('The visualization type to generate'),
      title: z.string()
        .describe('Descriptive title displayed at the top of the image'),
      labels: z.array(z.string())
        .describe('Category labels — x-axis labels for bar/line, slice names for pie/doughnut'),
      datasets: z.array(
        z.object({
          label: z.string().describe('Legend label for this data series'),
          data: z.array(z.number()).describe('Numeric values, one per label, in matching order'),
        }),
      ).describe('One or more data series to plot'),
      xAxisLabel: z.string().optional()
        .describe('Label for the x-axis (bar/line types only)'),
      yAxisLabel: z.string().optional()
        .describe('Label for the y-axis (bar/line types only)'),
      fileName: z.string().optional()
        .describe('Optional descriptive filename hint (no extension). A timestamp is always appended'),
    }),
  },
);

/**
 * Tool: recall_visualizations
 * Returns the full history of charts/graphs created during this session,
 * including the data used, so Margin can do follow-up analysis.
 */
const recallVisualizations = tool(
  ({ id }: { id?: number }) => {
    if (visualizationHistory.length === 0) {
      return 'No visualizations have been created in this session yet.';
    }

    const records = id != null
      ? visualizationHistory.filter(r => r.id === id)
      : visualizationHistory;

    if (records.length === 0) {
      return `No visualization found with ID #${id}. Available IDs: ${visualizationHistory.map(r => r.id).join(', ')}.`;
    }

    return records.map(r => {
      const dataSummary = r.datasets.map(ds =>
        `    ${ds.label}: [${ds.data.map(n => n.toFixed(2)).join(', ')}]`,
      ).join('\n');

      return (
        `── Visualization #${r.id} ──\n` +
        `Kind: ${r.kind} | Type: ${r.chartType}\n` +
        `Title: ${r.title}\n` +
        `File: ${r.filePath}\n` +
        `Created: ${r.createdAt}\n` +
        `Labels: [${r.labels.join(', ')}]\n` +
        (r.xAxisLabel ? `X-Axis: ${r.xAxisLabel}\n` : '') +
        (r.yAxisLabel ? `Y-Axis: ${r.yAxisLabel}\n` : '') +
        `Data:\n${dataSummary}`
      );
    }).join('\n\n');
  },
  {
    name: 'recall_visualizations',
    description:
      `Retrieve the history of all charts and graphs created during this conversation session. ` +
      `Each record includes the visualization ID, type, title, file path, labels, and the full numeric data used.\n\n` +
      `WHEN TO USE:\n` +
      `- When the user asks about a previous chart or graph (e.g., "tell me more about that chart", "analyze the graph data", "compare the two charts").\n` +
      `- When the user asks for insights, trends, or further analysis on data that was already visualized.\n` +
      `- When the user references a visualization by number (e.g., "#1", "the first chart").\n` +
      `- When you need to recall what visualizations you have already produced to avoid duplicates.\n\n` +
      `Pass an id to retrieve a specific visualization, or omit it to get all of them.`,
    schema: z.object({
      id: z.number().optional()
        .describe('Optional visualization ID to retrieve. Omit to get all visualizations from this session.'),
    }),
  },
);

// ─── Weekly Report Tools ─────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD string. */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Tool: get_weekly_report
 * Reads a previously generated weekly report from the weekly/ directory.
 * Accepts an optional date; if omitted, returns the latest available report.
 */
const getWeeklyReport = tool(
  async ({ date }: { date?: string }) => {
    logger.log('system', `Retrieving weekly report${date ? ` for ${date}` : ' (latest)'}...`);

    try {
      if (date) {
        const filePath = join(WEEKLY_DIR, `weekly_report_${date}.json`);
        const content = await readFile(filePath, 'utf-8');
        logger.log('system', `Found weekly report for ${date}.`);
        return content +
          '\n\n[DASHBOARD LINK] The interactive weekly report is available at: https://staging-dash.twist.win/ — always include this link in your response so the user can view the full visual report.';
      }

      const files = await readdir(WEEKLY_DIR);
      const reportFiles = files
        .filter((f) => f.startsWith('weekly_report_') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));

      if (reportFiles.length === 0) {
        return 'No weekly reports found. Use the create_weekly_report tool to generate one.';
      }

      const latestFile = reportFiles[0];
      const content = await readFile(join(WEEKLY_DIR, latestFile), 'utf-8');
      logger.log('system', `Found latest weekly report: ${latestFile}`);
      return content +
        '\n\n[DASHBOARD LINK] The interactive weekly report is available at: https://staging-dash.twist.win/ — always include this link in your response so the user can view the full visual report.';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return `No weekly report found${date ? ` for date ${date}` : ''}. Use the create_weekly_report tool to generate one.`;
      }
      return `Error retrieving weekly report: ${msg}`;
    }
  },
  {
    name: 'get_weekly_report',
    description: 'Retrieve a previously generated weekly performance report. Use this when the user asks about a weekly report, weekly summary, or wants to see weekly performance data. Returns the full report JSON.',
    schema: z.object({
      date: z.string().optional().describe('Report end-date in YYYY-MM-DD format. Omit to get the latest available report.'),
    }),
  },
);

// ─── Reusable Metric Computation ──────────────────────────────────────────────

/** Safe number extraction from a record field. */
const num = (record: Record<string, unknown>, field: string): number =>
  Number(record[field] ?? 0) || 0;

/** Round to 2 decimal places. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

type GroupStats = { spend: number; revenue: number; clicks: number; results: number };

function buildBreakdown(
  records: Record<string, unknown>[],
  keyField: string,
  labelField: string,
): Record<string, unknown>[] {
  const groups = new Map<string, GroupStats>();
  for (const r of records) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const key = String(r[keyField] ?? 'unknown');
    const prev = groups.get(key) ?? { spend: 0, revenue: 0, clicks: 0, results: 0 };
    prev.spend += num(r, 'spend');
    prev.revenue += num(r, 'calculatedRevenue');
    prev.clicks += num(r, 'clicks');
    prev.results += num(r, 'results');
    groups.set(key, prev);
  }

  return Array.from(groups.entries()).map(([key, g]) => ({
    [labelField]: key,
    spend: round2(g.spend),
    revenue: round2(g.revenue),
    roi_pct: g.spend > 0 ? round2(((g.revenue - g.spend) / g.spend) * 100) : 0,
    cpc: g.clicks > 0 ? round2(g.spend / g.clicks) : 0,
    cpr: g.results > 0 ? round2(g.spend / g.results) : 0,
    results: g.results,
  }));
}

const MIN_SPEND_THRESHOLD = 10;

/**
 * Pure metric computation — no file I/O, no LLM calls.
 * Filters `allRecords` to the given date range and returns all aggregate metrics.
 */
function computeWeekMetrics(
  allRecords: Record<string, unknown>[],
  startStr: string,
  endStr: string,
) {
  const periodRecords = allRecords.filter((r) => {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const d = String(r.date ?? '');
    return d >= startStr && d <= endStr;
  });

  if (periodRecords.length === 0) return null;

  // ── summary_counts ───────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const uniqueCampaignIds = new Set(periodRecords.map((r) => String(r.campaignId ?? '')));
  const newCampaigns = periodRecords.filter((r) => {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const startTime = String(r.campaignStartTime ?? '');
    if (!startTime) return false;
    const launchDate = startTime.slice(0, 10);
    return launchDate >= startStr && launchDate <= endStr;
  });
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const uniqueNewCampaignIds = new Set(newCampaigns.map((r) => String(r.campaignId ?? '')));

  const summaryCounts = {
    total_campaigns: uniqueCampaignIds.size,
    new_campaigns: uniqueNewCampaignIds.size,
  };

  // ── KPIs ─────────────────────────────────────────────────────────────
  let totalSpend = 0;
  let totalRevenue = 0;
  let totalClicks = 0;
  let totalResults = 0;
  let totalImpressions = 0;
  let totalEcomSales = 0;

  for (const r of periodRecords) {
    totalSpend += num(r, 'spend');
    totalRevenue += num(r, 'calculatedRevenue');
    totalClicks += num(r, 'clicks');
    totalResults += num(r, 'results');
    totalImpressions += num(r, 'costImpressions');
    totalEcomSales += num(r, 'ecomSales');
  }

  const kpis = {
    spend: round2(totalSpend),
    revenue: round2(totalRevenue),
    roi_pct: totalSpend > 0 ? round2(((totalRevenue - totalSpend) / totalSpend) * 100) : 0,
    cpc: totalClicks > 0 ? round2(totalSpend / totalClicks) : 0,
    cpr: totalResults > 0 ? round2(totalSpend / totalResults) : 0,
    clicks: totalClicks,
    results: totalResults,
    impressions: totalImpressions,
    ecom_sales: totalEcomSales,
  };

  // ── Daily breakdown ──────────────────────────────────────────────────
  const dailyMap = new Map<string, Record<string, unknown>[]>();
  for (const r of periodRecords) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const d = String(r.date ?? '');
    if (!dailyMap.has(d)) dailyMap.set(d, []);
    dailyMap.get(d)!.push(r);
  }

  const daily: Record<string, unknown>[] = [];
  const startDate = new Date(`${startStr}T00:00:00`);
  const endDate = new Date(`${endStr}T00:00:00`);
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const ds = toDateStr(currentDate);
    const dayRecords = dailyMap.get(ds) ?? [];
    const daySpend = dayRecords.reduce((s, r) => s + num(r, 'spend'), 0);
    const dayRevenue = dayRecords.reduce((s, r) => s + num(r, 'calculatedRevenue'), 0);
    const dayClicks = dayRecords.reduce((s, r) => s + num(r, 'clicks'), 0);
    const dayResults = dayRecords.reduce((s, r) => s + num(r, 'results'), 0);

    daily.push({
      date: ds,
      spend: round2(daySpend),
      revenue: round2(dayRevenue),
      cpc: dayClicks > 0 ? round2(daySpend / dayClicks) : 0,
      roi_pct: daySpend > 0 ? round2(((dayRevenue - daySpend) / daySpend) * 100) : 0,
      clicks: dayClicks,
      results: dayResults,
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  // ── Top / Worst combinations (article + bidStrategy) ─────────────────
  const comboMap = new Map<string, { topic: string; strategy: string } & GroupStats>();
  for (const r of periodRecords) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const topic = String(r.article ?? 'unknown');
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const strategy = String(r.bidStrategy ?? 'unknown');
    const key = `${topic}||${strategy}`;
    const prev = comboMap.get(key) ?? { topic, strategy, spend: 0, revenue: 0, clicks: 0, results: 0 };
    prev.spend += num(r, 'spend');
    prev.revenue += num(r, 'calculatedRevenue');
    prev.clicks += num(r, 'clicks');
    prev.results += num(r, 'results');
    comboMap.set(key, prev);
  }

  const allCombos = Array.from(comboMap.values())
    .filter((c) => c.spend >= MIN_SPEND_THRESHOLD)
    .map((c) => ({
      topic: c.topic,
      strategy: c.strategy,
      roi_pct: c.spend > 0 ? round2(((c.revenue - c.spend) / c.spend) * 100) : 0,
      spend: round2(c.spend),
      cpr: c.results > 0 ? round2(c.spend / c.results) : 0,
      results: c.results,
    }));

  const topCombinations = [...allCombos]
    .sort((a, b) => b.roi_pct - a.roi_pct)
    .slice(0, 5)
    .map((c, i) => ({ rank: i + 1, ...c }));

  const worstCombinations = [...allCombos]
    .sort((a, b) => a.roi_pct - b.roi_pct)
    .slice(0, 5)
    .map((c, i) => ({ rank: i + 1, ...c }));

  // ── Breakdowns ───────────────────────────────────────────────────────
  const bidStrategyBreakdown = buildBreakdown(periodRecords, 'bidStrategy', 'strategy');
  const deviceBreakdown = buildBreakdown(periodRecords, 'device', 'device');
  const creativeTypeBreakdown = buildBreakdown(periodRecords, 'mediaType', 'type');
  const contentManagerBreakdown = buildBreakdown(periodRecords, 'member', 'member');

  return {
    recordCount: periodRecords.length,
    summaryCounts,
    kpis,
    daily,
    topCombinations,
    worstCombinations,
    bidStrategyBreakdown,
    deviceBreakdown,
    creativeTypeBreakdown,
    contentManagerBreakdown,
  };
}

/**
 * Tool: create_weekly_report
 * Generates a comprehensive weekly performance report from the in-memory
 * campaign dataset. All metrics are computed deterministically except the
 * analysis field, which is produced by an LLM.
 */
const createWeeklyReport = tool(
  async ({ periodEnd }: { periodEnd?: string }) => {
    const endDate = periodEnd ? new Date(`${periodEnd}T00:00:00`) : new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);

    const startStr = toDateStr(startDate);
    const endStr = toDateStr(endDate);

    logger.log('system', `Generating weekly report for ${startStr} to ${endStr}...`);

    // ── Compute current-week metrics ──────────────────────────────────────
    const currentMetrics = computeWeekMetrics(rawData, startStr, endStr);

    if (!currentMetrics) {
      return `No campaign data found for the period ${startStr} to ${endStr}. Cannot generate a weekly report.`;
    }

    logger.log('system', `Found ${currentMetrics.recordCount} records in period.`);

    const {
      summaryCounts, kpis, daily,
      topCombinations, worstCombinations,
      bidStrategyBreakdown, deviceBreakdown,
      creativeTypeBreakdown, contentManagerBreakdown,
    } = currentMetrics;

    // ── Compute last-week metrics from separate dataset ───────────────────
    const lastWeekEnd = new Date(startDate);
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
    const lastWeekStart = new Date(lastWeekEnd);
    lastWeekStart.setDate(lastWeekStart.getDate() - 6);

    const lastWeekStartStr = toDateStr(lastWeekStart);
    const lastWeekEndStr = toDateStr(lastWeekEnd);

    const lastWeekMetrics = rawDataLastWeek.length > 0
      ? computeWeekMetrics(rawDataLastWeek, lastWeekStartStr, lastWeekEndStr)
      : null;

    if (lastWeekMetrics) {
      logger.log('system', `Computed last-week metrics (${lastWeekStartStr} to ${lastWeekEndStr}): ${lastWeekMetrics.recordCount} records.`);
    } else {
      logger.log('system', 'No last-week data available — delta fields will be null.');
    }

    // ── Build prevReport for delta computation ────────────────────────────
    const prevReport = lastWeekMetrics ? {
      period: { start: lastWeekStartStr, end: lastWeekEndStr },
      summary_counts: lastWeekMetrics.summaryCounts,
      kpis: lastWeekMetrics.kpis,
      bid_strategy_breakdown: lastWeekMetrics.bidStrategyBreakdown,
      device_breakdown: lastWeekMetrics.deviceBreakdown,
      creative_type_breakdown: lastWeekMetrics.creativeTypeBreakdown,
      content_manager_breakdown: lastWeekMetrics.contentManagerBreakdown,
      top_combinations: lastWeekMetrics.topCombinations,
      worst_combinations: lastWeekMetrics.worstCombinations,
    } : null;

    // ── Delta Helpers ───────────────────────────────────────────────────

    /**
     * Computes absolute and percentage deltas for every numeric key in `current`
     * compared to `previous`. Returns null when no previous data is available.
     */
    function computeDeltas(
      current: Record<string, number>,
      previous: Record<string, number> | null,
    ): Record<string, number> | null {
      if (!previous) return null;
      const deltas: Record<string, number> = {};
      for (const key of Object.keys(current)) {
        const curr = current[key];
        const prev = previous[key] ?? 0;
        deltas[`${key}_delta`] = round2(curr - prev);
        deltas[`${key}_delta_pct`] = prev !== 0
          ? round2(((curr - prev) / Math.abs(prev)) * 100)
          : 0;
      }
      return deltas;
    }

    /**
     * Enriches each entry in a breakdown array with inline delta fields by
     * matching entries from the previous breakdown using `keyField`.
     */
    function computeBreakdownDeltas(
      current: Record<string, unknown>[],
      previous: Record<string, unknown>[] | null,
      keyField: string,
    ): Record<string, unknown>[] {
      if (!previous) return current;

      const prevMap = new Map<string, Record<string, unknown>>();
      for (const entry of previous) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        prevMap.set(String(entry[keyField] ?? ''), entry);
      }

      return current.map((entry) => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const key = String(entry[keyField] ?? '');
        const prevEntry = prevMap.get(key);
        if (!prevEntry) return entry;

        const enriched: Record<string, unknown> = { ...entry };
        for (const field of Object.keys(entry)) {
          if (field === keyField || field === 'rank') continue;
          const currVal = Number(entry[field]);
          const prevVal = Number(prevEntry[field] ?? 0);
          if (isNaN(currVal) || isNaN(prevVal)) continue;
          enriched[`${field}_delta`] = round2(currVal - prevVal);
          enriched[`${field}_delta_pct`] = prevVal !== 0
            ? round2(((currVal - prevVal) / Math.abs(prevVal)) * 100)
            : 0;
        }
        return enriched;
      });
    }

    /**
     * Enriches combination entries with inline deltas, matching by topic + strategy.
     */
    function computeComboDeltas(
      current: Record<string, unknown>[],
      previous: Record<string, unknown>[] | null,
    ): Record<string, unknown>[] {
      if (!previous) return current;

      const prevMap = new Map<string, Record<string, unknown>>();
      for (const entry of previous) {
        const comboKey = `${String(entry.topic)}||${String(entry.strategy)}`;
        prevMap.set(comboKey, entry);
      }

      return current.map((entry) => {
        const comboKey = `${String(entry.topic)}||${String(entry.strategy)}`;
        const prevEntry = prevMap.get(comboKey);
        if (!prevEntry) return entry;

        const enriched: Record<string, unknown> = { ...entry };
        for (const field of ['roi_pct', 'spend', 'cpr', 'results']) {
          const currVal = Number(entry[field]);
          const prevVal = Number(prevEntry[field] ?? 0);
          if (isNaN(currVal) || isNaN(prevVal)) continue;
          enriched[`${field}_delta`] = round2(currVal - prevVal);
          enriched[`${field}_delta_pct`] = prevVal !== 0
            ? round2(((currVal - prevVal) / Math.abs(prevVal)) * 100)
            : 0;
        }
        return enriched;
      });
    }

    // ── Compute Delta Sections ───────────────────────────────────────────

    const summaryCountsDelta = computeDeltas(summaryCounts, prevReport?.summary_counts ?? null);
    const kpisDelta = computeDeltas(kpis, prevReport?.kpis ?? null);

    // ── Enrich Breakdowns with Inline Deltas ─────────────────────────────

    const enrichedBidStrategyBreakdown = computeBreakdownDeltas(
      bidStrategyBreakdown, prevReport?.bid_strategy_breakdown ?? null, 'strategy',
    );
    const enrichedDeviceBreakdown = computeBreakdownDeltas(
      deviceBreakdown, prevReport?.device_breakdown ?? null, 'device',
    );
    const enrichedCreativeTypeBreakdown = computeBreakdownDeltas(
      creativeTypeBreakdown, prevReport?.creative_type_breakdown ?? null, 'type',
    );
    const enrichedContentManagerBreakdown = computeBreakdownDeltas(
      contentManagerBreakdown, prevReport?.content_manager_breakdown ?? null, 'member',
    );

    // ── Enrich Combinations with Inline Deltas ───────────────────────────

    const enrichedTopCombinations = computeComboDeltas(
      topCombinations, prevReport?.top_combinations ?? null,
    );
    const enrichedWorstCombinations = computeComboDeltas(
      worstCombinations, prevReport?.worst_combinations ?? null,
    );

    // ── AI-generated analysis ────────────────────────────────────────────
    logger.log('system', 'Generating AI analysis for weekly report...');

    const analysisModel = await initChatModel(QUERY_MODEL_NAME, { modelProvider: 'openai' });

    const analysisSummaryData = JSON.stringify({
      period: { start: startStr, end: endStr },
      previous_period: prevReport ? prevReport.period : null,
      kpis,
      kpis_delta: kpisDelta,
      summary_counts_delta: summaryCountsDelta,
      daily,
      topCombinations: enrichedTopCombinations,
      worstCombinations: enrichedWorstCombinations,
      bidStrategyBreakdown: enrichedBidStrategyBreakdown,
      deviceBreakdown: enrichedDeviceBreakdown,
    }, null, 2);

    const analysisPrompt = `You are a senior performance marketing analyst. Given the following weekly report data, write a concise 3-4 paragraph analysis covering:
1. Overall performance trends (spend, revenue, ROI trajectory across the week).
2. Key winners and losers — which topic + bid strategy combinations drove the best and worst results.
3. Actionable recommendations for the upcoming week (what to scale, what to pause, what to test).
4. Compared to last week: If delta data is available (kpis_delta, summary_counts_delta, and inline _delta fields on breakdowns/combinations), dedicate a paragraph to week-over-week comparison highlighting improvements and regressions, referencing exact delta numbers and percentages (e.g., "spend increased by $X (+Y%)","ROI declined by Z percentage points").

Be specific, reference exact numbers, and keep it professional. Do NOT use markdown formatting — plain text only.`;

    const analysisResult = await analysisModel.invoke([
      new SystemMessage(analysisPrompt),
      new HumanMessage(analysisSummaryData),
    ]);

    const analysis = typeof analysisResult.content === 'string'
      ? analysisResult.content
      : JSON.stringify(analysisResult.content);

    // ── Assemble final report ────────────────────────────────────────────
    const report = {
      period: { start: startStr, end: endStr },
      previous_period: prevReport ? prevReport.period : null,
      summary_counts: summaryCounts,
      summary_counts_delta: summaryCountsDelta,
      kpis,
      kpis_delta: kpisDelta,
      daily,
      top_combinations: enrichedTopCombinations,
      worst_combinations: enrichedWorstCombinations,
      bid_strategy_breakdown: enrichedBidStrategyBreakdown,
      device_breakdown: enrichedDeviceBreakdown,
      creative_type_breakdown: enrichedCreativeTypeBreakdown,
      content_manager_breakdown: enrichedContentManagerBreakdown,
      analysis,
    };

    // ── Save last-week report (idempotent — only if absent) ─────────────
    if (lastWeekMetrics) {
      const lastWeekFileName = `last_weekly_report_${lastWeekEndStr}.json`;
      const lastWeekFilePath = join(WEEKLY_DIR, lastWeekFileName);
      if (!existsSync(lastWeekFilePath)) {
        const lastWeekReport = {
          period: { start: lastWeekStartStr, end: lastWeekEndStr },
          previous_period: null,
          summary_counts: lastWeekMetrics.summaryCounts,
          summary_counts_delta: null,
          kpis: lastWeekMetrics.kpis,
          kpis_delta: null,
          daily: lastWeekMetrics.daily,
          top_combinations: lastWeekMetrics.topCombinations,
          worst_combinations: lastWeekMetrics.worstCombinations,
          bid_strategy_breakdown: lastWeekMetrics.bidStrategyBreakdown,
          device_breakdown: lastWeekMetrics.deviceBreakdown,
          creative_type_breakdown: lastWeekMetrics.creativeTypeBreakdown,
          content_manager_breakdown: lastWeekMetrics.contentManagerBreakdown,
          analysis: null,
        };
        await writeFile(lastWeekFilePath, JSON.stringify(lastWeekReport, null, 2), 'utf-8');
        logger.log('system', `Saved last-week report to ${lastWeekFileName}`);
      } else {
        logger.log('system', `Last-week report ${lastWeekFileName} already exists — skipping (idempotent).`);
      }
    }

    // ── Save current report (always overwrite — safe since last-week is separate) ──
    const fileName = `weekly_report_${endStr}.json`;
    const filePath = join(WEEKLY_DIR, fileName);
    await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    logger.log('system', `Weekly report saved to ${fileName}`);

    // ── Upload to S3 ─────────────────────────────────────────────────
    try {
      const reportJson = JSON.stringify(report, null, 2);
      await uploadWeeklyReportToS3(fileName, reportJson);
      logger.log('system', `Weekly report uploaded to S3: ${WEEKLY_REPORTS_BUCKET}/${WEEKLY_REPORTS_S3_PREFIX}/${fileName}`);
    } catch (err: unknown) {
      logger.log('system', `Failed to upload weekly report to S3: ${String(err)}`);
    }

    return JSON.stringify(report, null, 2) +
      '\n\n[DASHBOARD LINK] The interactive weekly report is available at: https://staging-dash.twist.win/ — always include this link in your response so the user can view the full visual report.';
  },
  {
    name: 'create_weekly_report',
    description: 'Generate and save a comprehensive weekly performance report with week-over-week delta comparisons. Use this when the user asks to create, generate, or produce a weekly report. Computes KPIs, daily trends, top/worst performing combinations, breakdowns by bid strategy, device, creative type, and content manager — each enriched with delta fields comparing to the previous week when available — plus an AI-generated analysis including a "compared to last week" section. Saves the report as a JSON file.',
    schema: z.object({
      periodEnd: z.string().optional().describe('End date of the 7-day reporting period in YYYY-MM-DD format. Defaults to today if omitted.'),
    }),
  },
);

// ─── Slack Formatting ────────────────────────────────────────────────────────────

/**
 * Converts standard Markdown to Slack mrkdwn syntax.
 * Pure string transformation — no LLM call involved.
 */
function convertMarkdownToSlackMrkdwn(text: string): string {
  let result = text;

  // 1. Headers: # Header -> *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 2. Bold: **text** or __text__ -> *text*
  //    Must run before italic conversion to avoid conflicts.
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // 3. Italic: *text* (single) -> _text_  (only when not already Slack bold)
  //    Match single asterisk italic that is NOT part of bold (no adjacent asterisks).
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

  // 4. Strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // 5. Links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // 6. Images: ![alt](url) -> <url|alt> (best-effort in text-only Slack)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

  // 7. Unordered list markers: leading *, + -> -  (preserve indentation)
  result = result.replace(/^(\s*)[*+]\s/gm, '$1- ');

  // 8. Horizontal rules: ---, ***, ___ (alone on a line) -> ———
  result = result.replace(/^[-*_]{3,}\s*$/gm, '———');

  // 9. Collapse excessive blank lines (3+ -> 2)
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Tool: format_for_slack
 * Converts a Markdown-formatted response into Slack mrkdwn syntax so it
 * renders cleanly in Slack. The agent should call this on every final
 * response before returning it to the user.
 */
const formatForSlack = tool(
  ({ text }: { text: string }) => {
    logger.log('system', 'Formatting response for Slack...');
    return convertMarkdownToSlackMrkdwn(text);
  },
  {
    name: 'format_for_slack',
    description: 'Format a response for Slack. Converts markdown to Slack mrkdwn syntax. ALWAYS use this tool on your final response text before returning it to the user, to ensure it renders correctly in Slack.',
    schema: z.object({
      text: z.string().describe('The full response text to format for Slack'),
    }),
  },
);

// ─── Dashboard Action Types & Draft State ────────────────────────────────────

interface ActionEntity {
  entityId: string;
  entityName: string;
  entityType: 'adset' | 'campaign';
  field: 'budget' | 'bid' | 'status';
  prevValue: number | string;
  nextValue: number | string;
  reason: string;
}

let currentActionDraft: ActionEntity[] | null = null;

const ACTIONS_BUCKET = 'actions-dashboard';
const META_API_VERSION = 'v22.0';
const META_ADSET_FIELDS = 'daily_budget,bid_amount,effective_status,name';

/**
 * Tool: get_meta_adset_details
 * Fetches current budget, bid, status, and name for one or more Meta adsets
 * via the Graph API. Converts cents → dollars for budget/bid values.
 */
const getMetaAdsetDetails = tool(
  async ({ adsetIds }: { adsetIds: string[] }) => {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) {
      return 'Error: META_ACCESS_TOKEN is not configured. Cannot fetch adset details from Meta.';
    }

    logger.log('system', `Fetching Meta adset details for ${adsetIds.length} adset(s) in parallel...`);

    const BATCH_SIZE = 10;
    const results: Record<string, unknown>[] = [];
    const errors: { id: string; error: string }[] = [];

    const fetchOne = async (id: string) => {
      const entityId = id.startsWith('fb') ? id.slice(2) : id;
      const url = `https://graph.facebook.com/${META_API_VERSION}/${entityId}?fields=${META_ADSET_FIELDS}&access_token=${token}`;

      try {
        const response = await fetch(url);
        const data = (await response.json()) as Record<string, unknown>;

        if (data.error) {
          const errorObj = data.error as Record<string, unknown>;
          const errMsg = typeof errorObj.message === 'string' ? errorObj.message : 'Unknown Meta API error';
          errors.push({ id: entityId, error: errMsg });
          return;
        }

        results.push({
          id: entityId,
          entityId: `fb${entityId}`,
          name: data.name ?? 'unknown',
          daily_budget: data.daily_budget != null ? Number(data.daily_budget) / 100 : null,
          bid_amount: data.bid_amount != null ? Number(data.bid_amount) / 100 : null,
          effective_status: data.effective_status ?? 'unknown',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ id: entityId, error: msg });
      }
    };

    for (let i = 0; i < adsetIds.length; i += BATCH_SIZE) {
      const batch = adsetIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fetchOne));
    }

    return JSON.stringify({ results, errors }, null, 2);
  },
  {
    name: 'get_meta_adset_details',
    description: 'Fetch current budget, bid, status, and name for Meta adsets via the Graph API. Use this BEFORE drafting any dashboard action to get the real prevValue. Pass campaignId values from DOR data (with or without "fb" prefix). Returns budget/bid in dollars (converted from Meta cents).',
    schema: z.object({
      adsetIds: z.array(z.string()).describe('Array of adset IDs (campaignId values from DOR data). Can include or omit "fb" prefix.'),
    }),
  },
);

/**
 * Tool: draft_dashboard_action
 * Creates a draft of dashboard actions (budget/bid/status changes) for review.
 * Replaces any previous draft. Returns a human-readable summary.
 */
const draftDashboardAction = tool(
  ({ actions }: { actions: ActionEntity[] }) => {
    logger.log('system', `Drafting dashboard action with ${actions.length} change(s)...`);

    currentActionDraft = actions;

    const lines = actions.map((a, i) => {
      const changeDesc = a.field === 'status'
        ? `${String(a.prevValue)} → ${String(a.nextValue)}`
        : `$${String(a.prevValue)} → $${String(a.nextValue)}`;
      return `${i + 1}. *${a.entityName}*\n   Field: ${a.field} | Change: ${changeDesc}\n   Reason: ${a.reason}`;
    });

    return `*Dashboard Action Draft* (${actions.length} change${actions.length !== 1 ? 's' : ''}):\n\n${lines.join('\n\n')}\n\n_Reply "approved" to submit, or suggest changes to revise the draft._`;
  },
  {
    name: 'draft_dashboard_action',
    description: 'Create a draft of dashboard actions for human review. Pass an array of action entities with entityId, entityName, entityType, field (budget/bid/status), prevValue (from Meta API), nextValue (calculated), and reason. Replaces any existing draft. ALWAYS present the draft summary to the user via format_for_slack and wait for explicit approval before submitting.',
    schema: z.object({
      actions: z.array(z.object({
        entityId: z.string().describe('Entity ID (e.g., "fb120241207091880394")'),
        entityName: z.string().describe('Human-readable entity name'),
        entityType: z.enum(['adset', 'campaign']).describe('Entity type'),
        field: z.enum(['budget', 'bid', 'status']).describe('Field to change'),
        prevValue: z.union([z.number(), z.string()]).describe('Current value (from Meta API)'),
        nextValue: z.union([z.number(), z.string()]).describe('New value to set'),
        reason: z.string().describe('Reason for the change'),
      })).describe('Array of action entities to include in the draft'),
    }),
  },
);

/**
 * Tool: submit_dashboard_action
 * Uploads the current action draft to S3 for the dashboard to execute.
 * Requires explicit "approved" confirmation and an existing draft.
 */
const submitDashboardAction = tool(
  async ({ confirmation }: { confirmation: string }) => {
    if (!currentActionDraft || currentActionDraft.length === 0) {
      return 'Error: No action draft exists. Use draft_dashboard_action first to create a draft.';
    }

    if (!confirmation.toLowerCase().includes('approved')) {
      return 'Error: Submission requires explicit approval. The confirmation must contain the word "approved".';
    }

    const uuid = crypto.randomUUID();
    const fileName = `${uuid}.json`;
    const content = JSON.stringify(currentActionDraft, null, 2);

    logger.log('system', `Submitting dashboard action ${fileName} to S3 (${currentActionDraft.length} change(s))...`);

    try {
      const client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });

      await client.send(
        new PutObjectCommand({
          Bucket: ACTIONS_BUCKET,
          Key: fileName,
          Body: content,
          ContentType: 'application/json',
        }),
      );

      const submittedCount = currentActionDraft.length;
      currentActionDraft = null;

      logger.log('system', `Dashboard action submitted successfully: ${fileName}`);
      return `Dashboard action submitted successfully!\n• File: ${fileName}\n• Changes: ${submittedCount}\n• Bucket: ${ACTIONS_BUCKET}\n\nThe dashboard will pick up and execute these changes.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log('system', `Failed to submit dashboard action: ${msg}`);
      return `Error submitting dashboard action to S3: ${msg}\n\nThe draft has been preserved — you can retry submission.`;
    }
  },
  {
    name: 'submit_dashboard_action',
    description: 'Upload the current action draft to S3 for the dashboard to execute. REQUIRES: (1) an existing draft from draft_dashboard_action, and (2) a confirmation string containing "approved". NEVER call this without explicit human approval.',
    schema: z.object({
      confirmation: z.string().describe('Confirmation string from the user — must contain the word "approved"'),
    }),
  },
);

// ─── System Prompt ─────────────────────────────────────────────────────────────

const MARGIN_SYSTEM_PROMPT = `You are "Margin Orchestrator", the orchestrator agent for a performance marketing company that operates structured digital campaigns primarily through Meta platforms and monetizes traffic through Amazon.

Our business model is launching, analyzing, optimizing, and scaling campaigns using strict operational logic and data-driven decision-making.
Every campaign, every action, and every optimization is based on measurable performance and predefined rules and conventions.

You have access to a pre-loaded campaign performance dataset with ${rawData.length} records.

═══ CORE CONSTRAINTS ═══

- Assume zero prior knowledge.
- Learn only from information explicitly provided in this prompt and the dashboard data you can access.
- Do not invent logic that we did not define.
- Be strict, explicit, and evidence-based.
- If something is unknown or missing, say so and state what is needed to resolve it.

═══ YOUR ROLE ═══

You exist to replicate our structured thinking process.
You must:
- Analyze campaign data (Campaign + Adset levels only).
- Understand and apply our structural logic (naming, time rules, KPI definitions).
- Detect when rule conditions are met (conceptually; you may not have rule-run logs).
- Generate structured recommendations and analysis with evidence.
- Provide outputs that let humans quickly find the relevant entities by name.
- EXECUTE DASHBOARD ACTIONS when the user requests changes (bid/budget/status). You have tools for this: get_meta_adset_details, draft_dashboard_action, submit_dashboard_action. USE THEM. Follow the DASHBOARD ACTIONS workflow described below.
You do NOT:
- DM users or post outside the Slack thread.
- Claim you can see rule-run logs, last-modified timestamps, or budget history (you currently cannot).

═══ SLACK OPERATION (THREAD-ONLY) ═══

- Questions arrive as free text (Slack).
- You must respond ONLY inside the same Slack thread (never outside the thread).
- You may answer with two plausible interpretations when ambiguity exists and it is safe to do so.
- If ambiguity materially changes conclusions or requires missing parameters/fields, ask 1–3 short follow-up questions.
- If you can provide a partial answer safely, you may do so, but must label it clearly as "PARTIAL" and list what is missing.

═══ DATA SCOPE & VIEWS ═══

Entity levels:
- Campaign
- Adset
No Ad-level analysis.

Two data views:
1) REAL-TIME VIEW
- Used for intraday tactical decisions.
- Contains current spend, CPC, pacing, delivery signals, and provisional ROI.
- Revenue/ROI in real-time are NOT final due to Amazon attribution lag.

2) DAILY VIEW
- Used for stabilized evaluation.
- Daily snapshot refresh occurs at 10:00 Asia/Jerusalem time.
- Daily values for recent days can still change due to revenue lag (see below).

Currency:
- USD only.

═══ DATA FRESHNESS & MISSINGNESS (MANDATORY) ═══

Staleness rule:
- If the latest Daily snapshot is older than 6 hours from "now" (or clearly did not refresh at the expected 10:00 Asia/Jerusalem schedule), begin with:
"DATA WARNING: Daily snapshot appears stale; using last available snapshot."
- Same approach for Real-time data if it appears stale.

Missing days rule:
- If Daily View is missing for any days in the requested window:
- Use the last available snapshot/days.
- Begin with:
"DATA WARNING: Missing daily data for [days]; using last available data."
- Never silently treat missing days as zero.

═══ REAL-TIME VS DAILY PREFERENCE ═══

- If user asks "today", "right now", "last X hours", "intraday", default to Real-time view.
- If user asks "last 7 days", "weekly", "multi-day", default to Daily view.
- If both are needed, keep them separated and explain the difference.

═══ TIME & DAY BOUNDARIES (CRITICAL) ═══

- Daily View day boundary is calendar day in PST.
- Server clickout date is PST.
- Daily snapshot refresh is 10:00 Asia/Jerusalem time.

Lag awareness:
- Same-day is provisional.
- Yesterday may still be incomplete.
- Day N-2 and older is generally safe for evaluation.

Default window rule for "last 7 days":
- Use Daily View and EXCLUDE today + yesterday by default (to avoid lag noise), unless the user explicitly asks to include them.
- State the window explicitly as PST days.

═══ AMAZON ATTRIBUTION & REVENUE MODEL (INTERNAL) ═══

We monetize through Amazon (combined Associates + Influencer).
Revenue definition:
- "Revenue" is expected net Amazon earnings after applying our internal weighting for estimated returns/cancellations.
- The dashboard shows one combined Revenue metric; you cannot split Associates vs Influencer.

Attribution:
- Revenue is attributed to the server clickout date (not order date), in PST.

Lag behavior:
- Revenue arrives gradually over ~72 hours.
For a given Day X spend:
- ~50% of revenue appears on Day X
- ~35–45% of revenue appears on Day X+1
- Remaining up to ~10% of revenue appears on Day X+2
After ~48–72 hours, revenue is considered almost fully realized.

Important implications:
- Same-day ROI is incomplete.
- Yesterday's ROI may still be incomplete depending on timing.
- A day becomes fully evaluable only after ~48–72 hours.
- You must NOT forecast or project future revenue.
- Use only dashboard values as provided and rely on time-window discipline to compensate for lag.

═══ KPI DEFINITIONS (SOURCE OF TRUTH) ═══

Primary metrics:
- Spend (USD)
- Budget (USD)
- Revenue (USD; expected net, weighted)
- ROI% definition:
ROI% = (Revenue - Spend) / Spend * 100
ROI% 30 = +30%
ROI% -60 = -60%
- CPC: Cost per Click (Meta) as provided by the dashboard CPC field.

Derived metrics:
- Net Profit (USD) = Revenue - Spend
Note: When asked for "ROI dollars", treat it as Net Profit (USD).

Spend relative to Budget:
- If Spend = 50 and Budget = 100 → remaining ratio = 50% → represented as -50%.
- If asked to compute:
BudgetRemaining% = -((Budget - Spend) / Budget) * 100
Interpretation:
- "Bigger than -50%" means campaign has spent at least ~50% of budget.

Budget increase math (when describing hypothetical changes):
- Increase 100% = Budget × 2
- Increase 150% = Budget × 2.5

═══ TRACKING ANOMALIES (EXCLUDE BY DEFAULT) ═══

If Spend > 0 but Clicks = 0, or CPC is missing/undefined:
- Flag as TRACKING ANOMALY.
- Exclude from segmented analysis and leaderboards by default.
- List them in a "Data Quality" section with names and spend.

If Revenue exists but Spend = 0 in the window:
- Exclude from leaderboards by default.
- If asked explicitly, show them in a separate "Revenue-only" section with a warning.

═══ MINIMUM SPEND THRESHOLD (PRECISE SEGMENTATION) ═══

Default minimum spend threshold for segmented comparisons:
- Require at least $10 total Spend per GROUP in the selected window.
- A "group" is the unit you are comparing (e.g., topic+bid_level+OS, topic+BM variant, etc.).
- Low-spend rows may be included if the group total meets $10.
- If asked to include low-spend groups, include them but label:
"LOW SPEND (<$10), NOT RELIABLE".

═══ CAMPAIGN NAMING — PRIMARY METADATA LAYER ═══

Campaign names are structured metadata.
Every token encodes a deterministic attribute.
Our dashboard segmentation depends entirely on parsing the campaign name.
You must always parse campaign and adset names into structured fields before analysis.
All naming logic applies at the Adset level as well.
Naming is our primary metadata source.

DELIMITERS & STRUCTURE (STRICT):
Names have two sections:

1) PREFIX BLOCK (hyphen-separated: "-")
Format:
bucket-platform-geo-device-topic-event

2) SUFFIX BLOCK (underscore-separated: "_")
Format (ordered required tokens):
os_destination_type_creative_marker_audience_scope_bid_strategy_optimization_type_content_manager_asset_type_page_name_line_id_rate_group_launch_date_[modifiers...]

Parsing rule:
- Identify the first underscore "_" in the name.
- Everything before it is the PREFIX BLOCK string; split that by "-".
- Everything after it is the SUFFIX BLOCK string; split that by "_".
- Do not merge "-" and "_" into one delimiter. Their roles differ.

CANONICAL EXAMPLE:
bst-fb-us-m-haircurlers-purchase_ios_direct_a_all_max_num_ju_img_bestfindsonline_v10831505517_electronics_12.22.25

Interpretation:
PREFIX BLOCK (hyphens)
- bst → Campaign bucket
- fb → Platform
- us → Geography
- m → Device
- haircurlers → Product / Topic
- purchase → Conversion event

SUFFIX BLOCK (underscores)
- ios → Operating system
- direct → Destination type (direct vs listicle vs other)
- a → Creative variation marker
- all → Audience scope
- max → Bid strategy (bidcap / costcap / max / roas)
- num → Optimization type (conversion optimization)
- val → Optimization type (value optimization) (appears instead of num when using value optimization)
- ju → Content manager identifier
- img → Asset type
- bestfindsonline → Page name
- v10831505517 → Internal Line ID
- electronics → Rate group
- 12.22.25 → Launch date (MM.DD.YY)

Special modifiers (usually at the end; can co-exist):
- BM / BM2 / BMx → Bid multiplier variant exists (treat separately)
- scaler → Campaign duplicated for scaling

STRICTNESS & ERROR HANDLING:
- All tokens are required and expected to appear in the defined order.
- If any required token is missing, out of order, or unparseable:
- Mark as NAMING_ERROR.
- Exclude from segmented breakdowns by default (topic/bid/OS/BM/destination comparisons).
- Still include in unsegmented totals, unless it is also a tracking anomaly.
- List under "Naming Errors" with the raw name and the reason.

Token constraints:
- Topic and page_name should not contain "-" or "_" characters. If they do, treat as NAMING_ERROR.
- launch_date must be parseable MM.DD.YY; otherwise NAMING_ERROR.
- line_id is typically v{digits}. If not matching:
- Set line_id=unknown
- Mark NAMING_WARNING (not fatal alone unless other issues exist).

OS token interpretation:
- OS token is positional (first token in suffix block).
- ios = iOS
- all = All OS / All devices
- If "all" appears again later in the name, it is often a different field (e.g., audience_scope). Disambiguate by position.

Destination type:
- If destination_type is unknown:
- Map destination_type=other
- Mark NAMING_WARNING
- Include in breakdowns (do not exclude solely for unknown destination_type).

Bid strategy + optimization strictness:
- bid_strategy must be one of: max, costcap, bidcap, roas
- optimization_type must be one of: num, val
- For max campaigns: max must be paired with exactly one optimization token:
- max_num OR max_val
If missing/malformed, mark NAMING_ERROR.

BM handling:
- Treat BM, BM2, BMx as separate variants.
- When comparing "BM vs non-BM", include:
- NONE
- BM
- BM2
- BMx
- plus ALL_BM combined rollup (BM+BM2+BMx)

═══ BID LEVEL (NOT IN NAME) ═══

Bid level is not encoded in the name. It exists in dashboard columns for bid-based strategies.
Rules:
- For costcap/bidcap strategies, always use the dashboard's bid-level column.
- Display:
- Raw value
- Formatted $ value when unit is clear.
Unit ambiguity:
- If unit is unclear, show both interpretations briefly and mark UNIT_UNCLEAR.
- Do not guess units without evidence from field name/metadata.

═══ DASHBOARD RULES (CONTEXT) ═══

Rules are predefined logic configurations inside the dashboard, usually operating at Adset level.
Each Rule conceptually includes:
- Data window (real-time hours, daily lookback, multi-day evaluation)
- Filters (state checks, name token filters)
- KPI thresholds (ROI%, CPC, Spend, Budget, spend relative to budget)
- Actions (budget increase, pause, activate, schedule)
Rules may run on schedules (e.g., every 30 minutes) and send notifications.
You may not have access to rule-run logs. If asked "why did a rule fire", you can infer from metrics and name fields, but you must state it is an inference.

═══ OUTPUT REQUIREMENTS (DEFAULT) ═══

Be precise and insightful. Lead with the answer, then add only the context and insights that matter for the specific question. Omit boilerplate sections that add no value. Match response depth to question complexity — a simple question gets a short, direct answer; a complex analysis gets structured detail.

Unless the user explicitly requests a different format, structure answers as:

1) Direct Answer (1–2 sentences)
- Answer the user's question immediately and concretely.
- If data is stale or incomplete, note it inline (do not dedicate a separate section to it).

2) Context (one compact line)
- Summarize in a single line: entity level, view, time window (PST), and any excluded days or DATA WARNINGs.
- Omit this section entirely for simple lookups or greetings.

3) Results & Insights
- Provide grouped results relevant to the question.
- Always show Net Profit (USD) and ROI% together unless user asked for only one.
- Include sample size (#campaigns / #adsets per group).
- If a group is dominated by a single entity, label "SINGLE-ENTITY DOMINATED".
- After the numbers, add 1–2 sentences of actionable insight — what the data means and what stands out.

4) Evidence (Names) — include only when the answer involves specific entities
- Provide real campaign/adset names so humans can locate them quickly.
- Limit to max 5 evidence names per key finding unless asked for more.

5) Recommendations — include only when asked or when findings strongly suggest action
- Each recommendation must include a Recommendation ID: REC-YYYYMMDD-PST-#### (stable within the response).
- Include: what to do, why (metrics), scope (names), and cautions (lag, low spend, naming errors).

6) Data Quality & Naming Issues — include only when anomalies or errors were found
- Tracking anomalies excluded (names + spend).
- Naming errors excluded from segmentation (raw names + reason).
- Unit unclear warnings (bid units).

═══ USER SHORTHAND GLOSSARY (ALWAYS APPLY — NO NEED TO ASK) ═══

Users frequently use informal shorthand. Map these DIRECTLY to dataset filters without asking for clarification:

Bid strategy shorthand → bidStrategy field filter:
- "bidcap" / "bid cap" / "BC" → bidStrategy = "bid cap"
- "costcap" / "cost cap" / "CC" → bidStrategy = "cost cap"
- "max" / "max campaigns" → bidStrategy contains "max" (covers max num + max val)
- "max num" → bidStrategy = "max num"
- "max val" → bidStrategy = "max val"
- "roas" / "roas val" → bidStrategy = "roas val"

OS shorthand → os field filter:
- "ios" / "iOS" → os = "ios"
- "android" / "and" → os = "and"
- "all os" → os = "all"

Combined shorthand examples:
- "bidcap ios campaigns" → bidStrategy = "bid cap" AND os = "ios" (filter on ADSETS, not campaigns)
- "costcap android" → bidStrategy = "cost cap" AND os = "and"
- "all ios campaigns" → os = "ios" (all bid strategies)

IMPORTANT: When the user says "[bidStrategy] [os] campaigns", they ALWAYS mean adsets matching those field values. Do NOT ask which interpretation they mean — use the field-level filters above. The default entity level for dashboard actions is ADSET.

═══ FINAL DISCIPLINE ═══

- Never treat same-day ROI as final.
- Never project future revenue.
- Never hide stale/missing data.
- Never guess missing naming tokens.
- Always provide enough evidence (names + parsed keys + window) so humans can verify quickly.

═══ DASHBOARD ACTIONS ═══

You can recommend and submit concrete changes to Meta adsets (budget, bid, status) via the dashboard actions system.

CRITICAL: When the user requests a direct action (e.g., "raise bid by 5% on all bidcap ios"), DO NOT over-analyze. Do NOT give lengthy performance breakdowns, recommendations with REC-IDs, or ask follow-up questions about date windows/thresholds. Just execute the workflow below. The user wants action, not analysis.

STRICT WORKFLOW (follow every step in order):

1. IDENTIFY ENTITIES — Use query_campaign_data to get the list of unique campaignId values matching the user's filter.
   HOW TO QUERY: Ask a simple question like "list all campaignId and campaignName where bidStrategy is bid cap and os is ios" with intent "filter".
   The query should SELECT campaignId and campaignName with the appropriate filters. Do NOT group, do NOT aggregate, do NOT add spend thresholds. Just get the list of matching entities.
   IMPORTANT: Extract the UNIQUE campaignId values from the results. Multiple rows may share the same campaignId (different dates). Deduplicate them.

2. FETCH CURRENT VALUES — Call get_meta_adset_details with ALL the unique campaignId values from step 1.
   This returns the REAL current bid/budget/status from Meta. NEVER guess prevValue.
   NOTE: Some IDs may return errors (deleted, archived, etc.) — skip those silently and proceed with the ones that succeed.

3. CALCULATE — Apply the user's requested change to each fetched prevValue.
   Example: "raise bid by 5%" → nextValue = prevValue × 1.05, rounded to 2 decimal places.
   Show brief math (e.g., "$12.00 → $12.60").

4. DRAFT — Call draft_dashboard_action with the complete action list. Then present the formatted summary to the user via format_for_slack.
   Each action needs: entityId ("fb" + campaignId), entityName (from Meta fetch or DOR data), entityType ("adset"), field ("bid"/"budget"/"status"), prevValue, nextValue, reason.

5. ITERATE — The user may request changes. If so, revise and re-draft.

6. APPROVE — Wait for the user to explicitly say "approved". NEVER assume approval.

7. SUBMIT — Only after explicit approval, call submit_dashboard_action with the user's confirmation text.

ENTITY ID CONSTRUCTION:
- campaignId in DOR data = Meta adset ID (numeric).
- entityId in dashboard actions = "fb" + campaignId (e.g., campaignId "120241207091880394" → entityId "fb120241207091880394").

FIELD VALUE TYPES:
- budget → number (dollars, e.g., 500)
- bid → number (dollars, e.g., 12.50)
- status → string ("ACTIVE", "PAUSED")

NEVER RULES:
- NEVER submit without explicit user approval.
- NEVER skip the Meta API fetch — always get real current values.
- NEVER show raw JSON to the user — always use the formatted draft summary.
- NEVER guess or fabricate prevValue — it must come from get_meta_adset_details.
- NEVER over-analyze when the user gives a direct action command. Execute the workflow, don't write essays.

═══ TOOL USAGE (MANDATORY) ═══

You have access to the following tools. Use them as specified:

- query_campaign_data: THE PRIMARY DATA RETRIEVAL TOOL. Use for ALL data questions — spend, ROI, revenue, performance, comparisons, aggregations, rankings, or any analytical question. ALWAYS query data before analyzing. This tool returns structured results with metadata.
  Parameters:
    - question (required): Your analytical question, written clearly and specifically. Include exact metric names and conditions.
    - intent (optional): Hint for query optimization. Use "ranking" for top/worst queries, "aggregation" for group-by summaries, "filter" for conditional lookups, "comparison" for A-vs-B, "overview" for broad summaries, "date_scoped" for time-range queries.
    - context (optional): Pass relevant prior conversation context when the user's question references previous results (e.g., "those campaigns", "same filters as before").
  The tool returns a JSON object with: data (array of records), count (total matches), query_description (SQL-like description of what was queried), warnings (any issues or auto-corrections), corrections (field name fixes applied), and truncated (whether results were capped at ${MAX_RESULT_RECORDS}).
  IMPORTANT: Always check the "warnings" and "count" fields in the response. If count is 0, the query may need to be rephrased. If warnings mention field corrections, note them in your analysis.
  Available dimensions: campaignName, campaignId, article (topic), site, source (fb/tw), country, device, bidStrategy (bid cap/cost cap/max num/max val/roas val), creativeType, mediaType, member (content manager: admin/cami/jo/ju/lu/om/yn), os, date, vertical, pageName, campaignType.
  Available metrics: spend, calculatedRevenue, roiPercentages, roiDollars, clicks, results, ecomSales, costImpressions.
- parse_campaign_name: Use to break down any campaign or adset name into its structured tokens (bucket, platform, geo, device, topic, bid strategy, content manager, etc.).
- get_conversation_history: Use when the user asks for a recap or summary of prior analyses in the conversation.
- get_weekly_report: Use when the user asks about a weekly report, weekly summary, or wants to review existing weekly performance data.
- create_weekly_report: Use when the user asks to generate, create, or produce a new weekly report. The report includes KPIs, daily trends, top/worst performing combinations, breakdowns by bid strategy, device, creative type, and content manager, granular week-over-week delta comparisons for every metric (when a previous week's report exists), plus an AI-generated analysis with a dedicated "compared to last week" section.
IMPORTANT: Whenever you present weekly report results to the user (whether newly created via create_weekly_report or retrieved via get_weekly_report), you MUST include the link https://staging-dash.twist.win/ in your response so the user can view the full interactive report dashboard. Format it as a clickable Slack link: <https://staging-dash.twist.win/|View the full interactive weekly report>.
- format_for_slack: ALWAYS use this tool on your final response text before returning it to the user. Write your full analysis first, then pass the entire text through format_for_slack and return its output as your final answer. This ensures proper rendering in Slack.
- get_meta_adset_details: Fetch current budget, bid, status, and name for Meta adsets. Use this BEFORE drafting any dashboard action to get real prevValue. Pass campaignId values from DOR data.
- draft_dashboard_action: Create a draft of dashboard actions (budget/bid/status changes) for human review. Always present the draft via format_for_slack and wait for approval before submitting.
- submit_dashboard_action: Upload the approved action draft to S3 for the dashboard to execute. ONLY call after the user explicitly approves the draft (message must contain "approved").

Additional behavior:
- When the user's request is unrelated to campaign analysis, politely explain you can only help with campaign data analysis.
- When the user's message is gibberish, politely ask them to rephrase.
- When greeting the user (first message), introduce yourself as Margin Orchestrator, the company's campaign analyst, and briefly list your capabilities.`;

// ─── Agent Creation ─────────────────────────────────────────────────────────────

const checkpointer = new MemorySaver();

export const agent = createAgent({
  model: AGENT_MODEL_NAME,
  tools: [queryCampaignData, parseCampaignName, getConversationHistory, visualizeTool, recallVisualizations, getWeeklyReport, createWeeklyReport, formatForSlack, getMetaAdsetDetails, draftDashboardAction, submitDashboardAction],
  systemPrompt: MARGIN_SYSTEM_PROMPT,
  checkpointer,
});

// ─── Terminal Input Helper ──────────────────────────────────────────────────────

async function getTerminalInput(): Promise<string> {
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

// ─── Agent Runner ───────────────────────────────────────────────────────────────

/**
 * Extracts the last AI message text from an agent result.
 */
function getLastAIMessage(result: { messages: { content: unknown }[] }): string {
  const lastMsg = result.messages[result.messages.length - 1];
  if (!lastMsg) return '';
  return typeof lastMsg.content === 'string'
    ? lastMsg.content
    : JSON.stringify(lastMsg.content);
}

/**
 * Runs the Margin agent in a terminal loop.
 * 1. Sends an initial greeting message
 * 2. Loops: get user input -> invoke agent -> log response
 * 3. Exits on "q", "quit", "exit", "bye", or timeout
 */
export async function runMarginAgent(channelId: string, threadId: string) {
  const config = createConfig(channelId, threadId);

  // Generate initial greeting
  logger.log('system', 'Starting Margin agent...');
  const greetingResult = await agent.invoke(
    { messages: [{ role: 'user', content: 'Hello, please introduce yourself and greet me.' }] },
    config,
  );
  const greeting = getLastAIMessage(greetingResult);
  logger.log('ai', greeting);

  // Terminal conversation loop
  while (true) {
    logger.log('system', 'Reading input from user...');
    const userInput = await getTerminalInput();

    // Handle exit conditions
    if (userInput === 'timeout') {
      logger.log('system', 'Timeout reached, ending conversation...');
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed || ['q', 'quit', 'exit', 'bye'].includes(trimmed.toLowerCase())) {
      logger.log('system', 'Ending conversation...');
      break;
    }

    logger.log('human', trimmed);

    // Invoke the agent with the user's message
    const result = await agent.invoke(
      { messages: [{ role: 'user', content: trimmed }] },
      config,
    );

    const response = getLastAIMessage(result);
    logger.log('ai', response);
  }

  logger.log('system', 'Margin agent session ended.');
}
