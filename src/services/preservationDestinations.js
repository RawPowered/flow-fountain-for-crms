const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const posix = path.posix;
const SftpClient = require('ssh2-sftp-client');
const { getPreservationConfig } = require('../config');
const { resolveSecret, validateHttpsUrl } = require('./integrationManagement');

async function deliverArtifact({ destination, artifact, sourcePath }) {
  const config = parseJson(destination.config_json, {});
  if (destination.destination_type === 'local_staging') {
    return deliverLocal(destination, config, artifact, sourcePath);
  }
  const credential = destination.credential_id
    ? await resolveSecret(destination.credential_id)
    : null;
  if (destination.destination_type === 'https') {
    return deliverHttps(config, credential, artifact, sourcePath);
  }
  if (destination.destination_type === 's3') {
    return deliverS3(config, credential, artifact, sourcePath);
  }
  if (destination.destination_type === 'sftp') {
    return deliverSftp(config, credential, artifact, sourcePath);
  }
  throw deliveryError('DESTINATION_UNSUPPORTED', 'Unsupported preservation destination');
}

async function deliverLocal(destination, config, artifact, sourcePath) {
  const root = getPreservationConfig().stagingRoot;
  const relative = safeRelativePath(config.relativePath || 'delivered');
  const folder = path.resolve(root, relative, destination.slug);
  assertWithin(root, folder);
  await fs.promises.mkdir(folder, { recursive: true });
  const target = path.join(folder, path.basename(sourcePath));
  await fs.promises.copyFile(sourcePath, target, fs.constants.COPYFILE_EXCL);
  return {
    remoteReference: `local://${relative.replace(/\\/g, '/')}/${destination.slug}/${path.basename(target)}`,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
  };
}

async function deliverHttps(config, credential, artifact, sourcePath) {
  const url = new URL(validateHttpsUrl(config.url, 'destination URL'));
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(artifact.byteCount),
    'X-Content-SHA256': artifact.sha256,
    'X-Artifact-Name': artifact.logicalName,
  };
  applyHttpCredential(headers, credential);
  const response = await upload(url, config.method === 'POST' ? 'POST' : 'PUT', headers, sourcePath);
  return {
    remoteReference: String(response.headers.location || url.toString()).slice(0, 1000),
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
  };
}

async function deliverS3(config, credential, artifact, sourcePath) {
  if (!credential || !['aws_credentials', 'connection_json'].includes(credential.kind)) {
    throw deliveryError('S3_CREDENTIAL_INVALID', 'S3 requires an AWS or structured credential');
  }
  const values = credential.value || {};
  const accessKeyId = String(values.accessKeyId || '');
  const secretAccessKey = String(values.secretAccessKey || '');
  if (!accessKeyId || !secretAccessKey) throw deliveryError('S3_CREDENTIAL_INVALID', 'S3 credential is incomplete');
  const bucket = String(config.bucket || '');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw deliveryError('S3_BUCKET_INVALID', 'Invalid S3 bucket');
  }
  const region = String(config.region || 'us-east-1');
  if (!/^[a-z0-9-]{3,32}$/.test(region)) throw deliveryError('S3_REGION_INVALID', 'Invalid S3 region');
  const objectKey = safeObjectKey(config.prefix, artifact.logicalName);
  let url;
  if (config.endpoint) {
    const endpoint = new URL(validateHttpsUrl(config.endpoint, 'S3 endpoint'));
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(bucket)}/${encodePath(objectKey)}`;
    url = endpoint;
  } else {
    url = new URL(`https://${bucket}.s3.${region}.amazonaws.com/${encodePath(objectKey)}`);
  }
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = {
    host: url.host,
    'content-length': String(artifact.byteCount),
    'content-type': 'application/octet-stream',
    'x-amz-content-sha256': artifact.sha256,
    'x-amz-date': amzDate,
    'x-amz-meta-sha256': artifact.sha256,
  };
  if (values.sessionToken) headers['x-amz-security-token'] = String(values.sessionToken);
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const canonicalRequest = [
    'PUT',
    url.pathname,
    canonicalQuery(url),
    canonicalHeaders,
    signedNames.join(';'),
    artifact.sha256,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  await upload(url, 'PUT', headers, sourcePath);
  return {
    remoteReference: `s3://${bucket}/${objectKey}`,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
  };
}

async function deliverSftp(config, credential, artifact, sourcePath) {
  if (!credential) throw deliveryError('SFTP_CREDENTIAL_INVALID', 'SFTP credential is required');
  const values = typeof credential.value === 'object' ? credential.value : {};
  const username = String(config.username || values.username || '');
  if (!username) throw deliveryError('SFTP_CREDENTIAL_INVALID', 'SFTP username is required');
  const connect = {
    host: String(config.host),
    port: Number(config.port || 22),
    username,
    readyTimeout: 20000,
  };
  if (credential.kind === 'ssh_key') connect.privateKey = credential.value;
  else if (values.privateKey) connect.privateKey = values.privateKey;
  else if (values.password) connect.password = values.password;
  else throw deliveryError('SFTP_CREDENTIAL_INVALID', 'SFTP password or private key is required');
  if (values.passphrase) connect.passphrase = values.passphrase;
  const basePath = safeRemotePath(config.path || '/workbench');
  const remotePath = posix.join(basePath, path.basename(sourcePath));
  const client = new SftpClient();
  try {
    await client.connect(connect);
    await client.mkdir(basePath, true);
    await client.fastPut(sourcePath, remotePath);
  } finally {
    await client.end().catch(() => {});
  }
  return {
    remoteReference: `sftp://${config.host}:${connect.port}${remotePath}`,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
  };
}

function upload(url, method, headers, sourcePath) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      timeout: 30000,
      rejectUnauthorized: true,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 4096) chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ statusCode: response.statusCode, headers: response.headers });
        } else {
          reject(deliveryError(
            'DELIVERY_HTTP_FAILED',
            `Remote destination returned ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 256)}`
          ));
        }
      });
    });
    request.on('timeout', () => request.destroy(deliveryError('DELIVERY_TIMEOUT', 'Remote delivery timed out')));
    request.on('error', reject);
    fs.createReadStream(sourcePath).on('error', reject).pipe(request);
  });
}

function applyHttpCredential(headers, credential) {
  if (!credential) return;
  if (credential.kind === 'bearer_token') headers.Authorization = `Bearer ${credential.value}`;
  else if (credential.kind === 'api_key') headers['X-API-Key'] = credential.value;
  else if (credential.kind === 'basic_auth' || credential.kind === 'connection_json') {
    const values = credential.value || {};
    headers.Authorization = `Basic ${Buffer.from(`${values.username || ''}:${values.password || ''}`).toString('base64')}`;
  } else {
    throw deliveryError('HTTPS_CREDENTIAL_INVALID', 'Credential kind is not supported by HTTPS delivery');
  }
}

function storageUri(jobId, fileName) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(jobId))) throw deliveryError('STORAGE_PATH_INVALID', 'Invalid job storage ID');
  const safeName = path.basename(String(fileName));
  if (safeName !== fileName || !/^[A-Za-z0-9_.-]{1,255}$/.test(safeName)) {
    throw deliveryError('STORAGE_PATH_INVALID', 'Invalid artifact filename');
  }
  return `staging://${jobId}/${safeName}`;
}

function resolveStorageUri(uri, root = getPreservationConfig().stagingRoot) {
  const match = String(uri || '').match(/^staging:\/\/([A-Za-z0-9-]{1,64})\/([A-Za-z0-9_.-]{1,255})$/);
  if (!match) throw deliveryError('STORAGE_PATH_INVALID', 'Invalid artifact storage reference');
  const target = path.resolve(root, 'jobs', match[1], match[2]);
  assertWithin(root, target);
  return target;
}

function assertWithin(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw deliveryError('STORAGE_PATH_INVALID', 'Storage path escapes the preservation root');
  }
}

function safeRelativePath(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('..') || path.isAbsolute(text)) {
    throw deliveryError('STORAGE_PATH_INVALID', 'Destination path must be relative');
  }
  return text;
}

function safeRemotePath(value) {
  const normalized = posix.normalize(`/${String(value || '').replace(/\\/g, '/')}`);
  if (normalized.includes('..')) throw deliveryError('REMOTE_PATH_INVALID', 'Invalid remote path');
  return normalized;
}

function safeObjectKey(prefix, logicalName) {
  const base = String(prefix || 'preservation').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!base || base.split('/').includes('..')) throw deliveryError('S3_KEY_INVALID', 'Invalid S3 prefix');
  return `${base}/${String(logicalName).replace(/[^A-Za-z0-9_.-]/g, '_')}.enc`;
}

function encodePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function deliveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  deliverArtifact,
  storageUri,
  resolveStorageUri,
  safeObjectKey,
  canonicalQuery,
};
