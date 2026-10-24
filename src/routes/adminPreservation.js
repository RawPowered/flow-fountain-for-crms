const express = require('express');
const path = require('path');
const { ROOT } = require('../config');
const { getPreservationConfig } = require('../config');
const {
  requireAdminSession,
  principalType,
} = require('../middleware/sessionAuth');
const {
  preservationCapabilities,
  requirePreservationCapability,
} = require('../middleware/preservationAccess');
const { getInstanceIdentity } = require('../instanceIdentity');
const integrationManagement = require('../services/integrationManagement');
const preservation = require('../services/preservation');
const { listPreservationAudit } = require('../services/preservationAudit');
const { recordPreservationAudit } = require('../services/preservationAudit');
const { createDecryptionStream } = require('../services/preservationRenderers');
const { resolveStorageUri } = require('../services/preservationDestinations');
const { listConnections: listSqlConnections } = require('../services/sqlConnections');
const { listIntegrations: listCrmIntegrations } = require('../services/crmIntegrations');

function createAdminPreservationRouter() {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/preservation', requirePreservationCapability('view'), (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin', 'preservation.html'));
  });

  router.use('/api/preservation', requirePreservationCapability('view'));

  router.get('/api/preservation/bootstrap', async (req, res) => {
    try {
      const [
        secrets,
        integrations,
        destinations,
        definitions,
        jobs,
        sqlConnections,
        crmIntegrations,
      ] = await Promise.all([
        integrationManagement.listSecrets(),
        integrationManagement.listIntegrations(),
        integrationManagement.listDestinations(),
        preservation.listDefinitions(),
        preservation.listJobs({ limit: 100 }),
        listSqlConnections(),
        listCrmIntegrations(),
      ]);
      const identity = getInstanceIdentity();
      res.json({
        ok: true,
        phase: 2,
        instance: {
          id: identity.instanceId,
          displayName: identity.apiDisplayName,
        },
        access: {
          capabilities: preservationCapabilities(req.session.admin),
          canManage: preservationCapabilities(req.session.admin).includes('design_exports'),
          canManageSecrets: preservationCapabilities(req.session.admin).includes('manage_secrets'),
        },
        worker: {
          enabled: getPreservationConfig().enabled,
          formats: preservation.EXPORT_FORMATS,
          encryptedStaging: true,
        },
        catalogs: {
          secretKinds: integrationManagement.SECRET_KINDS,
          adapterTypes: integrationManagement.ADAPTER_TYPES,
          sourceRefTypes: integrationManagement.SOURCE_REF_TYPES,
          destinationTypes: integrationManagement.DESTINATION_TYPES,
          sourceTypes: preservation.SOURCE_TYPES,
          sourceCatalog: preservation.SOURCE_CATALOG,
          formats: preservation.EXPORT_FORMATS,
          valueTypes: preservation.VALUE_TYPES,
          transforms: preservation.TRANSFORMS,
          filterOperators: preservation.FILTER_OPERATORS,
          jobStates: preservation.JOB_STATES,
        },
        references: {
          sqlConnections,
          crmIntegrations,
        },
        secrets,
        integrations,
        destinations,
        definitions,
        jobs,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/secrets', async (req, res) => {
    try {
      res.json({ ok: true, secrets: await integrationManagement.listSecrets() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(
    '/api/preservation/secrets',
    requirePreservationCapability('manage_secrets'),
    async (req, res) => {
    try {
      const secret = await integrationManagement.createSecret(req.body || {}, requestContext(req));
      setControl(req, 'integration.secret.create', 'integration_secret', secret.id);
      res.status(201).json({ ok: true, secret });
    } catch (error) {
      sendError(res, error);
    }
    }
  );

  router.post(
    '/api/preservation/secrets/:id/rotate',
    requirePreservationCapability('manage_secrets'),
    async (req, res) => {
    try {
      const secret = await integrationManagement.rotateSecret(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'integration.secret.rotate', 'integration_secret', secret.id);
      res.json({ ok: true, secret });
    } catch (error) {
      sendError(res, error);
    }
    }
  );

  router.post(
    '/api/preservation/secrets/:id/retire',
    requirePreservationCapability('manage_secrets'),
    async (req, res) => {
    try {
      const secret = await integrationManagement.retireSecret(req.params.id, requestContext(req));
      setControl(req, 'integration.secret.retire', 'integration_secret', secret.id);
      res.json({ ok: true, secret });
    } catch (error) {
      sendError(res, error);
    }
    }
  );

  router.get('/api/preservation/integrations', async (req, res) => {
    try {
      res.json({ ok: true, integrations: await integrationManagement.listIntegrations() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/integrations', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const integration = await integrationManagement.createIntegration(
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'integration.registry.create', 'integration', integration.id);
      res.status(201).json({ ok: true, integration });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/preservation/integrations/:id', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const integration = await integrationManagement.updateIntegration(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'integration.registry.update', 'integration', integration.id);
      res.json({ ok: true, integration });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/integrations/:id/validate', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const validation = await integrationManagement.validateIntegration(
        req.params.id,
        requestContext(req)
      );
      setControl(req, 'integration.registry.validate', 'integration', req.params.id);
      res.json({ ok: true, validation });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/destinations', async (req, res) => {
    try {
      res.json({ ok: true, destinations: await integrationManagement.listDestinations() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/destinations', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const destination = await integrationManagement.createDestination(
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'preservation.destination.create', 'preservation_destination', destination.id);
      res.status(201).json({ ok: true, destination });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/preservation/destinations/:id', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const destination = await integrationManagement.updateDestination(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'preservation.destination.update', 'preservation_destination', destination.id);
      res.json({ ok: true, destination });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/destinations/:id/validate', requirePreservationCapability('manage_integrations'), async (req, res) => {
    try {
      const validation = await integrationManagement.validateDestination(
        req.params.id,
        requestContext(req)
      );
      setControl(req, 'preservation.destination.validate', 'preservation_destination', req.params.id);
      res.json({ ok: true, validation });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/definitions', async (req, res) => {
    try {
      const definitions = await preservation.listDefinitions(req.query || {});
      res.json({ ok: true, definitions });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/definitions/:id', async (req, res) => {
    try {
      const definition = await preservation.getDefinition(req.params.id);
      if (!definition) return res.status(404).json({ error: 'Export definition not found' });
      res.json({ ok: true, definition });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/definitions', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const definition = await preservation.createDefinition(req.body || {}, requestContext(req));
      setControl(req, 'preservation.definition.create', 'preservation_definition', definition.id);
      res.status(201).json({ ok: true, definition });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/preservation/definitions/:id', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const definition = await preservation.updateDefinition(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'preservation.definition.update', 'preservation_definition', definition.id);
      res.json({ ok: true, definition });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/definitions/:id/versions', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const version = await preservation.createDraftVersion(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'preservation.version.create', 'preservation_export_version', version.id);
      res.status(201).json({ ok: true, version });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/preservation/versions/:id', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const version = await preservation.updateDraftVersion(
        req.params.id,
        req.body || {},
        requestContext(req)
      );
      setControl(req, 'preservation.version.update', 'preservation_export_version', version.id);
      res.json({ ok: true, version });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/definitions/:id/versions/:versionId/validate', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const validation = await preservation.validateDefinitionVersion(
        req.params.id,
        req.params.versionId
      );
      setControl(
        req,
        'preservation.version.validate',
        'preservation_export_version',
        req.params.versionId
      );
      res.json({ ok: true, validation });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/definitions/:id/versions/:versionId/publish', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const definition = await preservation.publishVersion(
        req.params.id,
        req.params.versionId,
        requestContext(req)
      );
      setControl(
        req,
        'preservation.version.publish',
        'preservation_export_version',
        req.params.versionId
      );
      res.json({ ok: true, definition });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/definitions/:id/archive', requirePreservationCapability('design_exports'), async (req, res) => {
    try {
      const definition = await preservation.archiveDefinition(req.params.id, requestContext(req));
      setControl(req, 'preservation.definition.archive', 'preservation_definition', definition.id);
      res.json({ ok: true, definition });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/jobs', async (req, res) => {
    try {
      res.json({ ok: true, jobs: await preservation.listJobs(req.query || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/jobs/:id', async (req, res) => {
    try {
      const job = await preservation.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Preservation job not found' });
      res.json({ ok: true, job });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(
    '/api/preservation/artifacts/:id/download',
    requirePreservationCapability('download_artifacts'),
    async (req, res) => {
      try {
        const artifact = await preservation.getArtifactRow(req.params.id);
        if (!artifact || artifact.status !== 'verified' || !artifact.is_encrypted) {
          return res.status(404).json({ error: 'Verified encrypted artifact not found' });
        }
        const encryption = JSON.parse(artifact.encryption_json || '{}');
        const filePath = resolveStorageUri(
          artifact.storage_uri,
          getPreservationConfig().stagingRoot
        );
        const stream = await createDecryptionStream(filePath, encryption);
        const fileName = String(artifact.logical_name || 'preservation-export')
          .replace(/[^A-Za-z0-9_.-]/g, '_');
        res.setHeader('Content-Type', artifact.media_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        setControl(req, 'preservation.artifact.download', 'preservation_artifact', artifact.id);
        await recordPreservationAudit({
          ...requestContext(req),
          action: 'preservation.artifact.download',
          entityType: 'preservation_artifact',
          entityId: artifact.id,
          details: { jobId: artifact.job_id },
        });
        stream.on('error', (error) => {
          if (!res.headersSent) sendError(res, error);
          else res.destroy(error);
        });
        stream.pipe(res);
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  router.post('/api/preservation/jobs', requirePreservationCapability('run_exports'), async (req, res) => {
    try {
      const result = await preservation.createExportJob(req.body || {}, requestContext(req));
      setControl(req, 'preservation.job.queue', 'preservation_job', result.job.id);
      res.status(result.reused ? 200 : 202).json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/preservation/jobs/:id/cancel', requirePreservationCapability('run_exports'), async (req, res) => {
    try {
      const job = await preservation.transitionJob(
        req.params.id,
        'cancelled',
        {},
        requestContext(req)
      );
      setControl(req, 'preservation.job.cancel', 'preservation_job', job.id);
      res.json({ ok: true, job });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/preservation/audit', requirePreservationCapability('view_audit'), async (req, res) => {
    try {
      res.json({ ok: true, events: await listPreservationAudit(req.query || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

function requestContext(req) {
  return {
    requestId: req.sentinelRequestId || null,
    actorType: principalType(req.session?.admin),
    actorId: req.session?.admin?.id || null,
  };
}

function setControl(req, action, entityType, entityId) {
  req.sentinelControl = {
    ...(req.sentinelControl || {}),
    action,
    entityType,
    entityId,
  };
}

function sendError(res, error) {
  const duplicate = error && error.code === 'ER_DUP_ENTRY';
  const status = duplicate ? 409 : Number(error?.status) || 500;
  const message = duplicate
    ? 'A record with that identifier already exists'
    : status >= 500
      ? 'Preservation control-plane error'
      : error.message || 'Request failed';
  if (status >= 500) console.error('Preservation control-plane error:', error);
  res.status(status).json({ error: message });
}

module.exports = {
  createAdminPreservationRouter,
  requestContext,
  sendError,
};
