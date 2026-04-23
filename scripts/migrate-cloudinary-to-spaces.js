const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const axios = require('axios');
const { v2: cloudinary } = require('cloudinary');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_ENV_VARS = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'DO_SPACES_ACCESS_KEY',
  'DO_SPACES_SECRET_KEY',
  'DO_SPACES_BUCKET',
  'DO_SPACES_REGION',
];

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const bucket = process.env.DO_SPACES_BUCKET;
const region = process.env.DO_SPACES_REGION;
const endpoint = `https://${region}.digitaloceanspaces.com`;
const concurrency = Number(process.env.MIGRATION_CONCURRENCY || 4);
const maxResults = Number(process.env.CLOUDINARY_PAGE_SIZE || 500);
const insecureTls = process.env.MIGRATION_INSECURE_TLS !== 'false';
const logDir = path.resolve(__dirname, '../logs/cloudinary-to-spaces');
const successLogPath = path.join(logDir, 'success.jsonl');
const errorLogPath = path.join(logDir, 'errors.jsonl');
const checkpointPath = path.join(logDir, 'checkpoint.json');
const runLogPath = path.join(logDir, 'run.log');

fs.mkdirSync(logDir, { recursive: true });

function writeLine(stream, line) {
  try {
    stream.write(`${line}\n`);
  } catch (_error) {
    // Ignore broken pipes when the parent shell disconnects.
  }
}

function log(message) {
  fs.appendFileSync(runLogPath, `${message}\n`, 'utf8');
  writeLine(process.stdout, message);
}

function logError(message) {
  fs.appendFileSync(runLogPath, `${message}\n`, 'utf8');
  writeLine(process.stderr, message);
}

if (insecureTls && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  logError('[tls] MIGRATION_INSECURE_TLS enabled for this one-shot migration');
}

const httpsAgent = new https.Agent({ rejectUnauthorized: !insecureTls });

const s3 = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId: process.env.DO_SPACES_ACCESS_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET_KEY,
  },
  requestHandler: new NodeHttpHandler({
    httpsAgent,
  }),
});

function appendJsonLine(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function formatError(error) {
  if (!error) {
    return 'UnknownError';
  }

  const pieces = [];
  if (error.name) pieces.push(error.name);
  if (error.message) pieces.push(error.message);
  if (error.code) pieces.push(`code=${error.code}`);
  if (error.$metadata?.httpStatusCode) pieces.push(`status=${error.$metadata.httpStatusCode}`);
  if (error.Cause?.message) pieces.push(`cause=${error.Cause.message}`);
  if (error.cause?.message) pieces.push(`cause=${error.cause.message}`);

  return pieces.length > 0 ? pieces.join(' | ') : String(error);
}

function readTransferredKeys() {
  if (!fs.existsSync(successLogPath)) {
    return new Set();
  }

  const lines = fs.readFileSync(successLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);

  const keys = new Set();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.key) {
        keys.add(parsed.key);
      }
    } catch (_error) {
      // Ignore malformed log lines and keep going.
    }
  }

  return keys;
}

function writeCheckpoint(nextCursor) {
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify(
      {
        nextCursor: nextCursor || null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
}

function loadCheckpoint() {
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    return parsed.nextCursor || null;
  } catch (_error) {
    return null;
  }
}

function buildObjectKey(asset) {
  const publicId = asset.public_id;
  const format = asset.format;

  if (!format) {
    throw new Error(`Missing format for asset ${publicId}`);
  }

  const normalizedFormat = String(format).replace(/^\./, '');
  const suffix = `.${normalizedFormat}`;
  return publicId.endsWith(suffix) ? publicId : `${publicId}${suffix}`;
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (statusCode === 404 || error?.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

async function transferAsset(asset, transferredKeys) {
  const key = buildObjectKey(asset);

  if (transferredKeys.has(key)) {
    log(`[skip:log] ${key}`);
    return;
  }

  if (await objectExists(key)) {
    appendJsonLine(successLogPath, {
      key,
      publicId: asset.public_id,
      status: 'already_exists',
      bytes: asset.bytes,
      at: new Date().toISOString(),
    });
    transferredKeys.add(key);
    log(`[skip:bucket] ${key}`);
    return;
  }

  const sourceUrl = asset.secure_url || asset.url;
  if (!sourceUrl) {
    throw new Error(`Missing source URL for asset ${asset.public_id}`);
  }

  const response = await axios({
    method: 'get',
    url: sourceUrl,
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 30000,
    httpsAgent,
  });

  const body = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ACL: 'public-read',
      ContentType: response.headers['content-type'] || asset.resource_type || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: {
        cloudinary_public_id: asset.public_id,
        cloudinary_asset_id: asset.asset_id || '',
      },
    },
  });

  const uploadPromise = upload.done();
  await pipeline(response.data, body);
  await uploadPromise;

  appendJsonLine(successLogPath, {
    key,
    publicId: asset.public_id,
    status: 'uploaded',
    bytes: asset.bytes,
    at: new Date().toISOString(),
  });
  transferredKeys.add(key);
  log(`[uploaded] ${key}`);
}

async function processAssetPages(startCursor, onPage) {
  let nextCursor = startCursor || undefined;
  let total = 0;

  do {
    const page = await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'image',
      max_results: maxResults,
      next_cursor: nextCursor,
      direction: 'asc',
    });

    total += page.resources.length;
    await onPage(page.resources);
    nextCursor = page.next_cursor;
    writeCheckpoint(nextCursor);
    log(`[cloudinary] fetched ${page.resources.length} assets, next_cursor=${nextCursor || 'null'}`);
  } while (nextCursor);

  return total;
}

async function runPool(items, worker, limit) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        return;
      }
      await worker(item);
    }
  });

  await Promise.all(runners);
}

async function main() {
  const transferredKeys = readTransferredKeys();
  const resumeCursor = process.env.CLOUDINARY_START_CURSOR || loadCheckpoint();

  log(`[start] bucket=${bucket} region=${region} concurrency=${concurrency}`);
  if (resumeCursor) {
    log(`[resume] next_cursor=${resumeCursor}`);
  }

  let totalAssets = 0;
  let uploaded = 0;
  let failed = 0;

  totalAssets = await processAssetPages(
    resumeCursor,
    async (assets) => {
      await runPool(
        assets,
        async (asset) => {
          try {
            await transferAsset(asset, transferredKeys);
            uploaded += 1;
          } catch (error) {
            failed += 1;
            appendJsonLine(errorLogPath, {
              publicId: asset.public_id,
              error: formatError(error),
              key: (() => {
                try {
                  return buildObjectKey(asset);
                } catch (_err) {
                  return null;
                }
              })(),
              at: new Date().toISOString(),
            });
            logError(`[failed] ${asset.public_id}: ${formatError(error)}`);
          }
        },
        concurrency
      );
    }
  );

  writeCheckpoint(null);
  log(`[done] processed=${totalAssets} ok=${uploaded} failed=${failed}`);
  log(`[logs] success=${successLogPath} errors=${errorLogPath} run=${runLogPath}`);
}

main().catch((error) => {
  appendJsonLine(errorLogPath, {
    scope: 'fatal',
    error: formatError(error),
    at: new Date().toISOString(),
  });
  logError(formatError(error));
  process.exit(1);
});
