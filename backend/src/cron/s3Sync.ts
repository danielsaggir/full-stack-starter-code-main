import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import cron from 'node-cron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

const BUCKET_NAME = process.env.S3_BUCKET_NAME ?? 'dashboard-daliy-breakdown';
const S3_PREFIX = 'dor';

function createS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

async function listLatestKeys(
  client: S3Client,
  count: number,
): Promise<string[]> {
  const allKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: `${S3_PREFIX}/`,
      ContinuationToken: continuationToken,
    });
    const response = await client.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key?.endsWith('.json')) {
          allKeys.push(obj.Key);
        }
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  // Lexicographic descending sort works for dor/YYYY/MM/DD.json format
  allKeys.sort((a, b) => b.localeCompare(a));
  return allKeys.slice(0, count);
}

function dateFromS3Key(key: string): string {
  // "dor/2026/02/14.json" → "2026-02-14"
  const match = key.match(/(\d{4})\/(\d{2})\/(\d{2})\.json$/);
  if (!match) return 'unknown';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function s3KeyToLocalPath(key: string): string {
  return path.join(ASSETS_DIR, key);
}

async function downloadFile(client: S3Client, key: string): Promise<boolean> {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    const response = await client.send(command);

    const body = await response.Body?.transformToString();
    if (!body) {
      console.warn(`[S3 Sync] Empty body for key: ${key}`);
      return false;
    }

    const localPath = s3KeyToLocalPath(key);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, body, 'utf-8');
    console.log(`[S3 Sync] Downloaded: ${key}`);
    return true;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'AccessDenied') {
      console.warn(`[S3 Sync] File not found in S3: ${key}`);
    } else {
      console.error(`[S3 Sync] Error downloading ${key}:`, err);
    }
    return false;
  }
}

async function mergeToDataJson(keys: string[]): Promise<void> {
  const merged: Record<string, unknown>[] = [];

  for (const key of keys) {
    const localPath = s3KeyToLocalPath(key);
    try {
      const raw = await readFile(localPath, 'utf-8');
      const records: Record<string, unknown>[] = JSON.parse(raw);
      const date = dateFromS3Key(key);
      for (const record of records) {
        if (!record.date) record.date = date;
        merged.push(record);
      }
    } catch (err) {
      console.warn(`[S3 Sync] Failed to read/parse ${localPath}, skipping:`, err);
    }
  }

  const outPath = path.join(ASSETS_DIR, 'data.json');
  await writeFile(outPath, JSON.stringify(merged), 'utf-8');
  console.log(`[S3 Sync] Merged ${merged.length} records into data.json`);
}

export async function syncLatest7Days(): Promise<void> {
  console.log('[S3 Sync] Starting sync of last 7 available days...');
  const client = createS3Client();

  const keys = await listLatestKeys(client, 7);
  console.log(`[S3 Sync] Found ${keys.length} available files:`, keys);

  let downloaded = 0;
  let skipped = 0;

  for (const key of keys) {
    const ok = await downloadFile(client, key);
    if (ok) downloaded++;
    else skipped++;
  }

  console.log(
    `[S3 Sync] Download complete — downloaded: ${downloaded}, skipped: ${skipped}`,
  );

  await mergeToDataJson(keys);
}

export function startS3SyncCron(): void {
  // Run immediately on startup
  syncLatest7Days().catch((err) =>
    console.error('[S3 Sync] Initial sync failed:', err),
  );

  // Schedule daily at 2:00 AM
  cron.schedule('0 2 * * *', () => {
    syncLatest7Days().catch((err) =>
      console.error('[S3 Sync] Scheduled sync failed:', err),
    );
  });

  console.log('[S3 Sync] Cron scheduled — daily at 2:00 AM');
}
