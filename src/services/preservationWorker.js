const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');
const { getPreservationConfig, SCHEMA_VERSION } = require('../config');
const { getInstanceIdentity } = require('../instanceIdentity');
const preservation = require('./preservation');
const { getDestination } = require('./integrationManagement');
const { createSourceStream, mapAndFilterStream } = require('./preservationSources');
const {
  FORMAT_INFO,
  renderArtifact,
  encryptArtifact,
} = require('./preservationRenderers');
const {
  deliverArtifact,
  storageUri,
  resolveStorageUri,
} = require('./preservationDestinations');

function workerIdentity() {
  return `preservation-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function startPreservationWorker(options = {}) {
  const config = { ...getPreservationConfig(), ...options };
  if (!config.enabled) return { enabled: false, stop() {} };
  const workerId = options.workerId || workerIdentity();
  let stopped = false;
  let timer = null;
  let running = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    if (running || stopped) return schedule(config.pollMs);
    running = true;
    try {
      await runWorkerCycle({ workerId, config, pool: options.pool || getPool() });
    } catch (error) {
      console.error(`[preservation] worker cycle failed code=${safeCode(error)}`);
    } finally {
      running = false;
      schedule(config.pollMs);
    }
  };
  schedule(options.initialDelayMs ?? 2000);
  return {
    enabled: true,
    workerId,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function runWorkerCycle({ workerId, config = getPreservationConfig(), pool = getPool() }) {
  await fs.promises.mkdir(config.stagingRoot, { recursive: true });
  await preservation.recoverExpiredJobs({ maxAttempts: config.maxAttempts }, pool);
  await queueDueSchedules(pool);
  const job = await preservation.claimNextJob(workerId, { leaseSeconds: leaseSeconds(config) }, pool);
  if (!job) return { processed: false };
  try {
    const completed = await executeJob(job, { workerId, config, pool });
    return { processed: true, job: completed };
  } catch (error) {
    await failJob(job.id, error, { workerId, pool });
    return { processed: true, failed: true, errorCode: safeCode(error) };
  }
}

async function executeJob(job, { workerId, config, pool }) {
  if (job.jobType !== 'export') throw workerError('JOB_TYPE_UNSUPPORTED', 'Phase 2 worker supports export jobs only');
  const definition = await preservation.getDefinition(job.definitionId, pool);
  if (!definition || definition.status !== 'published') {
    throw workerError('DEFINITION_UNAVAILABLE', 'Published export definition is unavailable');
  }
  const version = definition.versions.find((item) => item.id === job.versionId);
  if (!version || !['published', 'superseded'].includes(version.status)) {
    throw workerError('VERSION_UNAVAILABLE', 'Immutable export definition version is unavailable');
  }
  const destination = await getDestination(job.destinationId, pool);
  if (!destination || !destination.is_enabled) {
    throw workerError('DESTINATION_UNAVAILABLE', 'Enabled export destination is unavailable');
  }
  const source = await createSourceStream(definition, version, {
    pool,
    chunkSize: config.chunkSize,
    maxRecords: config.maxRecords,
  });
  await preservation.heartbeatJob(job.id, workerId, {
    progressPercent: 5,
    watermark: source.watermark,
    leaseSeconds: leaseSeconds(config),
  }, pool);
  await preservation.transitionJob(job.id, 'rendering', {
    progressPercent: 10,
    watermark: source.watermark,
  }, serviceContext(workerId), pool);

  const jobFolder = safeJobFolder(config.stagingRoot, job.id);
  await fs.promises.rm(jobFolder, { recursive: true, force: true });
  await fs.promises.mkdir(jobFolder, { recursive: true });
  const formatInfo = FORMAT_INFO[definition.format];
  const baseName = safeFileName(`${definition.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const logicalName = `${baseName}.${formatInfo.extension}`;
  const plainPath = path.join(jobFolder, logicalName);
  const encryptedName = `${logicalName}.fse`;
  const encryptedPath = path.join(jobFolder, encryptedName);
  const stats = {
    progressEvery: config.chunkSize,
    onProgress: async (current) => {
      const estimate = Math.min(70, 10 + Math.floor((current.read / config.maxRecords) * 60));
      await preservation.heartbeatJob(job.id, workerId, {
        progressPercent: estimate,
        checkpoint: { cursor: current.lastCursor, recordsRead: current.read },
        watermark: source.watermark,
        leaseSeconds: leaseSeconds(config),
      }, pool);
    },
  };
  const records = mapAndFilterStream(source.records, version, stats);
  const rendered = await renderArtifact({
    format: definition.format,
    mappings: version.mappings,
    formatConfig: version.formatConfig,
    records,
    plainPath,
    maxBytes: config.maxArtifactBytes,
  });
  await preservation.heartbeatJob(job.id, workerId, {
    progressPercent: 75,
    checkpoint: { cursor: stats.lastCursor, recordsRead: stats.read, recordsWritten: stats.written },
    watermark: source.watermark,
    leaseSeconds: leaseSeconds(config),
  }, pool);
  const encrypted = await encryptArtifact(rendered.plainPath, encryptedPath);
  const artifact = await preservation.registerArtifact({
    jobId: job.id,
    logicalName,
    mediaType: rendered.mediaType,
    format: definition.format,
    storageUri: storageUri(job.id, encryptedName),
    byteCount: encrypted.byteCount,
    recordCount: stats.written,
    rejectedCount: stats.rejected,
    isEncrypted: true,
    encryption: encrypted.encryption,
  }, serviceContext(workerId), pool);
  const verifiedArtifact = await preservation.verifyArtifact(artifact.id, {
    sha256: encrypted.sha256,
    byteCount: encrypted.byteCount,
    recordCount: stats.written,
    rejectedCount: stats.rejected,
  }, serviceContext(workerId), pool);
  const identity = getInstanceIdentity();
  const manifest = await preservation.createManifest(job.id, {
    instanceId: identity.instanceId,
    application: {
      schemaVersion: SCHEMA_VERSION,
      component: 'preservation-worker',
      workerProtocol: 2,
    },
    warnings: [
      ...(stats.filtered ? [`${stats.filtered} records excluded by definition filters`] : []),
      ...(stats.rejected ? [`${stats.rejected} records rejected by mapping requirements`] : []),
    ],
  }, serviceContext(workerId), pool);
  await preservation.verifyManifest(job.id, manifest.sha256, serviceContext(workerId), pool);
  await preservation.transitionJob(job.id, 'delivering', {
    progressPercent: 85,
    checkpoint: { artifactId: verifiedArtifact.id, recordsWritten: stats.written },
    watermark: source.watermark,
  }, serviceContext(workerId), pool);
  await preservation.heartbeatJob(job.id, workerId, {
    progressPercent: 88,
    checkpoint: { artifactId: verifiedArtifact.id, recordsWritten: stats.written },
    watermark: source.watermark,
    leaseSeconds: leaseSeconds(config),
  }, pool);
  const attempt = await preservation.createDeliveryAttempt({
    jobId: job.id,
    artifactId: verifiedArtifact.id,
    destinationId: destination.id,
  }, serviceContext(workerId), pool);
  try {
    const delivery = await deliverArtifact({
      destination,
      artifact: verifiedArtifact,
      sourcePath: resolveStorageUri(verifiedArtifact.storageUri, config.stagingRoot),
    });
    await preservation.completeDeliveryAttempt(attempt.id, {
      succeeded: true,
      ...delivery,
    }, serviceContext(workerId), pool);
  } catch (error) {
    await preservation.completeDeliveryAttempt(attempt.id, {
      succeeded: false,
      errorCode: safeCode(error),
      errorSummary: safeMessage(error),
    }, serviceContext(workerId), pool);
    throw error;
  }
  return preservation.transitionJob(job.id, 'completed', {
    progressPercent: 100,
  }, serviceContext(workerId), pool);
}

async function failJob(jobId, error, { workerId, pool }) {
  try {
    const job = await preservation.getJob(jobId, pool);
    if (!job || !['extracting', 'rendering', 'delivering'].includes(job.status)) return;
    await preservation.transitionJob(jobId, 'failed', {
      errorCode: safeCode(error),
      errorSummary: safeMessage(error),
    }, serviceContext(workerId), pool);
  } catch (failure) {
    console.error(`[preservation] failed to close job code=${safeCode(failure)}`);
  }
}

async function queueDueSchedules(pool = getPool(), now = new Date()) {
  const [rows] = await pool.query(
    `SELECT id,schedule_cron FROM preservation_export_definitions
     WHERE status='published' AND schedule_cron IS NOT NULL AND schedule_cron<>''`
  );
  const minuteKey = now.toISOString().slice(0, 16).replace(/[-T:]/g, '');
  let queued = 0;
  for (const row of rows) {
    if (!cronMatches(row.schedule_cron, now)) continue;
    const result = await preservation.createExportJob({
      definitionId: row.id,
      idempotencyKey: `schedule:${row.id}:${minuteKey}`,
    }, { actorId: 'preservation-scheduler', actorType: 'service' }, pool);
    if (!result.reused) queued += 1;
  }
  return { queued };
}

function cronMatches(expression, date) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  return fields.every((field, index) => cronFieldMatches(field, values[index]));
}

function cronFieldMatches(field, value) {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = Math.max(Number(stepText) || 1, 1);
    if (range === '*') return value % step === 0;
    if (/^\d+$/.test(range)) return value === Number(range);
    const match = range.match(/^(\d+)-(\d+)$/);
    return Boolean(match && value >= Number(match[1]) && value <= Number(match[2]) &&
      (value - Number(match[1])) % step === 0);
  });
}

function safeJobFolder(root, jobId) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(jobId))) throw workerError('STORAGE_PATH_INVALID', 'Invalid job ID');
  const folder = path.resolve(root, 'jobs', jobId);
  const resolvedRoot = path.resolve(root);
  if (!folder.startsWith(`${resolvedRoot}${path.sep}`)) throw workerError('STORAGE_PATH_INVALID', 'Job path escapes staging root');
  return folder;
}

function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
}

function leaseSeconds(config) {
  return Math.max(120, Math.ceil(config.pollMs / 1000) * 4);
}

function serviceContext(workerId) {
  return { actorId: workerId, actorType: 'service' };
}

function safeCode(error) {
  return String(error?.code || error?.name || 'PRESERVATION_FAILED')
    .replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'PRESERVATION_FAILED';
}

function safeMessage(error) {
  return String(error?.message || 'Preservation job failed')
    .replace(/[\r\n\t]/g, ' ').slice(0, 1000);
}

function workerError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  startPreservationWorker,
  runWorkerCycle,
  executeJob,
  queueDueSchedules,
  cronMatches,
  safeJobFolder,
};
