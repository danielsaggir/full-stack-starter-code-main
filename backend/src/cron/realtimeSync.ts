import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

const BUCKET_NAME = 'dashboard-realtime-breakdown';
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

async function findLatestKey(client: S3Client): Promise<string | null> {
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

  if (allKeys.length === 0) return null;

  allKeys.sort((a, b) => b.localeCompare(a));
  return allKeys[0];
}

async function downloadToRealtimeJson(
  client: S3Client,
  key: string,
): Promise<void> {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  const response = await client.send(command);

  const body = await response.Body?.transformToString();
  if (!body) {
    console.warn('[Realtime Sync] Empty body for key:', key);
    return;
  }

  const outPath = path.join(ASSETS_DIR, 'realtime.json');
  await writeFile(outPath, body, 'utf-8');
  console.log(`[Realtime Sync] Saved ${key} → realtime.json`);
}

export async function syncRealtime(): Promise<void> {
  console.log('[Realtime Sync] Pulling latest realtime breakdown...');
  const client = createS3Client();

  const key = await findLatestKey(client);
  if (!key) {
    console.warn('[Realtime Sync] No files found in bucket');
    return;
  }

  await downloadToRealtimeJson(client, key);
}

export function startRealtimeSyncCron(): void {
  // Run immediately on startup
  syncRealtime().catch((err) =>
    console.error('[Realtime Sync] Initial sync failed:', err),
  );

  // Run at :05 and :35 past every hour
  cron.schedule('5,35 * * * *', () => {
    syncRealtime().catch((err) =>
      console.error('[Realtime Sync] Scheduled sync failed:', err),
    );
  });

  console.log('[Realtime Sync] Cron scheduled — every hour at :05 and :35');
}
