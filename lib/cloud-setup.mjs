import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCloudConfig, validateCloudArtifacts, createCloudIdentity, validateCloudIdentity, fingerprint, publicCloudPlan } from './cloud-config.mjs';
import { privateDirectory, readPrivateJSON, writePrivateJSON, acquireCloudLock } from './cloud-private.mjs';
import { createCloudAdapters, CloudSetupError, validateRuntimeFlyCredential } from './cloud-providers.mjs';
import { cloudVerificationSummary } from './cloud-verification.mjs';
import { describeCloudUpgrade } from './cloud-upgrades.mjs';
import { cloudUpgradeVerificationSummary } from './cloud-upgrade-verification.mjs';

export { recoverCloudLock } from './cloud-private.mjs';
export { validateCloudConfig, validateCloudArtifacts } from './cloud-config.mjs';
export { CloudSetupError } from './cloud-providers.mjs';

const token = () => randomBytes(32).toString('base64url');
const provisioned = journal => journal.plan.steps.every(name => journal.steps[name]?.status === 'done');
const publicState = journal => {
  const verified = cloudVerificationSummary(journal);
  if (journal.verificationAttempt?.status === 'awaiting-restart' && !/^[a-f0-9]{64}$/.test(journal.verificationAttempt.challenge || '')) throw new CloudSetupError('invalid-hosted-verification-attempt');
  if (journal.status === 'ready' && verified?.restartPersistence !== 'passed-with-external-attestation') throw new CloudSetupError('invalid-hosted-verification-receipt');
  return { ...journal.plan, status: journal.status,
  provisioning: { status: provisioned(journal) ? 'complete' : 'pending', repeatApply: 'status-only-after-completion', maintenance: 'separate-explicit-operation', liveAudit: 'not-performed' },
  acceptance: { runtimeCredential: journal.runtimeCredentialValidation ? { status: 'authenticated', capability: 'inventory-read', backendCanary: verified ? 'passed' : 'pending' } : { status: 'pending' },
    emptyCatalog: journal.steps.health?.status === 'done' ? 'passed' : 'pending', storageRoundtrip: journal.storageProof?.stage === 'complete' ? 'passed-and-cleaned' : 'pending',
    pooledBackendCanary: 'pending', restartPersistence: 'pending', installedCanaryApps: 'none-created', scope: 'historical-provisioning-and-acceptance', ...(verified || {}),
    ...(journal.verificationAttempt && journal.verificationAttempt.status !== 'complete' ? { installedCanaryApps: 'may-exist-cleanup-pending' } : {}) },
  ...(journal.verificationAttempt?.status === 'awaiting-restart' ? { restartChallenge: journal.verificationAttempt.challenge } : {}),
  progress: Object.fromEntries(Object.entries(journal.steps).map(([name, step]) => [name, { status: step.status, ...(step.receipt ? { resourceId: step.receipt.id } : {}), ...(step.attempt ? { attempt: step.attempt } : {}) }])) };
};
const secretValid = value => typeof value === 'string' && value.length >= 32 && value.length <= 16384 && !/[\r\n]/.test(value);
async function currentImageState(args, original) {
  const initial = { os: original.images.os, runtime: original.images.runtime };
  if (original.provisioning.status !== 'complete') return { ...original, generation: 0, currentImages: initial, activeUpgrade: null };
  const upgrade = await describeCloudUpgrade(args);
  let lineage = null;
  try { lineage = await readPrivateJSON(join(args.directory, 'current-images.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!lineage && upgrade.status !== 'no-upgrade-planned') throw new CloudSetupError('upgrade-status-changed-retry');
  const activeUpgrade = lineage?.activeOperation ? { operationId: lineage.activeOperation, status: upgrade.status, mode: upgrade.mode, fromImages: upgrade.fromImages, targetImages: upgrade.targetImages } : null;
  if (lineage && (lineage.generation !== upgrade.generation || fingerprint(lineage.images) !== fingerprint(upgrade.currentImages) || lineage.activeOperation && upgrade.operationId !== lineage.activeOperation)) throw new CloudSetupError('upgrade-status-changed-retry');
  const common = { generation: upgrade.generation, currentImages: upgrade.currentImages, activeUpgrade };
  if (!upgrade.generation && !activeUpgrade) return { ...original, ...common };
  const historical = { generation: 0, scope: 'historical-original-provisioning', status: original.status, images: original.images, acceptance: original.acceptance };
  if (!upgrade.generation) return { ...original, ...common, status: 'upgrade-in-progress', provisioning: { ...original.provisioning, generation: 0, scope: 'historical-original-provisioning' }, historicalProvisioning: historical,
    acceptance: { generation: 0, scope: 'uncommitted-image-transition', status: 'upgrade-in-progress', pooledBackendCanary: 'pending-for-image-transition', restartPersistence: 'not-accepted-for-image-transition' } };
  const receipt = upgrade.operationId === lineage.lastOperation ? upgrade : await describeCloudUpgrade({ ...args, operationId: lineage.lastOperation });
  if (receipt.generation !== upgrade.generation || receipt.operationId !== lineage.lastOperation || !/^[a-f0-9]{64}$/.test(receipt.receiptSha256 || '') || fingerprint(receipt.currentImages) !== fingerprint(upgrade.currentImages)) throw new CloudSetupError('upgrade-current-generation-receipt-invalid');
  const accepted = {
    'host-restart-and-image-provenance-verified-post-upgrade-runtime-use-pending': 'post-upgrade-runtime-use-pending',
    'bootstrap-applied-with-external-quiescence-attestation-automatic-proof-pending': 'bootstrap-automatic-proof-pending',
  }[receipt.verification];
  if (!accepted) throw new CloudSetupError('upgrade-current-generation-receipt-invalid');
  const currentVerification=await cloudUpgradeVerificationSummary({directory:args.directory,journal:await readPrivateJSON(join(args.directory,'journal.json')),lineage});
  const runtimePassed=currentVerification?.acceptance==='passed';
  const currentStatus=runtimePassed&&accepted==='post-upgrade-runtime-use-pending'?'post-upgrade-runtime-verified':accepted;
  return { ...original, ...common, status: activeUpgrade ? 'upgrade-in-progress' : currentStatus,
    provisioning: { ...original.provisioning, generation: 0, scope: 'historical-original-provisioning' },
    historicalProvisioning: historical,
    acceptance: { generation: upgrade.generation, scope: 'current-image-generation', status: currentStatus, runtimeCredential: { status: 'historical-original-provisioning-only' }, pooledBackendCanary: runtimePassed?'passed':'pending-for-current-generation', restartPersistence: 'not-accepted-for-current-generation', storageRoundtrip: 'historical-original-provisioning-only', installedCanaryApps: currentVerification?.installedCanaryApps||'not-created-for-current-generation', imageTransition: receipt.verification, customRuntimeImages: receipt.customRuntimeImages || [],...(currentVerification?{runtimeVerification:currentVerification}:{}),...(runtimePassed&&accepted==='bootstrap-automatic-proof-pending'?{automaticMaintenanceProof:'pending'}:{}) },
    currentImageReceipt: { operationId: receipt.operationId, sha256: receipt.receiptSha256, verification: receipt.verification, completedAt: receipt.completedAt },
  };
}
function validateSecrets(secrets, journal) {
  if (secrets?.format !== 'ink-cloud-secrets-v1' || fingerprint(secrets.identity) !== fingerprint(journal.identity) || secrets.configHash !== journal.configHash || secrets.artifactHash !== journal.artifactHash || !['ownerToken', 'storageToken', 'edgeToken', 'environmentKey'].every(name => secretValid(secrets[name])) || Buffer.from(secrets.environmentKey, 'base64').length !== 32) throw new CloudSetupError('private-state-inputs-mismatch');
  return secrets;
}
function validateState(journal, config, moduleHashes) {
  if (journal?.format !== 'ink-cloud-journal-v1' || journal.configHash !== fingerprint(config) || journal.artifactHash !== fingerprint(moduleHashes)) throw new CloudSetupError('journal-inputs-changed');
  validateCloudIdentity(config, journal.identity);
  const plan = publicCloudPlan(config, journal.identity, moduleHashes);
  if (fingerprint(plan) !== fingerprint(journal.plan) || !journal.steps || Object.keys(journal.steps).some(key => !plan.steps.includes(key))) throw new CloudSetupError('invalid-journal');
  for (const value of Object.values(journal.steps)) {
    if (!['creating', 'done'].includes(value.status) || !/^[a-f0-9]{32}$/.test(value.attempt || '')) throw new CloudSetupError('invalid-journal');
    if (value.receipt && (typeof value.receipt.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.receipt.id))) throw new CloudSetupError('invalid-journal');
  }
  return journal;
}

async function loadState(root, config, moduleHashes) {
  return validateState(await readPrivateJSON(join(root, 'journal.json')), config, moduleHashes);
}

/** Local-only planning. Creates a fresh durable identity and private owner/storage/edge keys.
 *  No environment variables, provider credentials, old deployment settings, or provider calls are consulted.
 *  The directory must be an explicitly selected private 0700 location (normally .local/cloud/<new-name>).
 *  Keep journal.json and secrets.json together; neither is a generated disposable build output.
 */
export async function initializeCloudSetup({ directory, config: input, artifacts }) {
  const config = validateCloudConfig(input), moduleHashes = validateCloudArtifacts(artifacts), root = await privateDirectory(directory);
  const release = await acquireCloudLock(root);
  try {
    let existing;
    try { existing = await loadState(root, config, moduleHashes); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      validateSecrets(await readPrivateJSON(join(root, 'secrets.json')), existing);
      return await currentImageState({ directory: root, config, artifacts }, publicState(existing));
    }
    let secrets;
    try { secrets = await readPrivateJSON(join(root, 'secrets.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const identity = createCloudIdentity(config);
      secrets = { format: 'ink-cloud-secrets-v1', identity, configHash: fingerprint(config), artifactHash: fingerprint(moduleHashes), ownerToken: token(), storageToken: token(), edgeToken: token(), environmentKey: randomBytes(32).toString('base64') };
      await writePrivateJSON(join(root, 'secrets.json'), secrets, { exclusive: true });
    }
    // Recovers interruption between durable secret creation and journal creation without changing identities/keys.
    if (secrets.format !== 'ink-cloud-secrets-v1' || secrets.configHash !== fingerprint(config) || secrets.artifactHash !== fingerprint(moduleHashes) || !['ownerToken', 'storageToken', 'edgeToken', 'environmentKey'].every(name => secretValid(secrets[name]))) throw new CloudSetupError('private-state-inputs-mismatch');
    const identity = validateCloudIdentity(config, secrets.identity), plan = publicCloudPlan(config, identity, moduleHashes);
    const journal = { format: 'ink-cloud-journal-v1', identity, configHash: fingerprint(config), artifactHash: fingerprint(moduleHashes), plan, status: 'planned', steps: {} };
    await writePrivateJSON(join(root, 'journal.json'), journal, { exclusive: true });
    return await currentImageState({ directory: root, config, artifacts }, publicState(journal));
  } finally { await release(); }
}

/** Original immutable provisioning evidence, without an upgrade overlay (used by lineage validation). */
export async function describeCloudProvisioning({ directory, config: input, artifacts }) {
  const config = validateCloudConfig(input), hashes = validateCloudArtifacts(artifacts), root = await privateDirectory(directory);
  return publicState(await loadState(root, config, hashes));
}

export async function describeCloudSetup(args) {
  const original = await describeCloudProvisioning(args);
  return currentImageState(args, original);
}

/** Explicitly mutating operation; callers should review initializeCloudSetup's public plan first.
 *  credentials = {flyToken, cloudflareToken, runtimeFlyToken}; no ambient credentials are accepted.
 *  Only runtimeFlyToken is persisted, in secrets.json (0600). Provider management tokens remain in memory.
 *  A run is bounded: each resource is probed once, created at most once, and then probed again.
 *  Eventual readiness/certificate issuance returns a typed error; rerun with the same directory to resume.
 *  A lost create response is reconciled by lookup. Nonunique resources are never blindly recreated.
 *  Storage acceptance creates/writes/deletes only its deterministic proof file. No application canary,
 *  infrastructure rollback/delete/stop, token minting, image build, registry upload, or install is performed.
 *  After all steps complete this is historical status, not maintenance: no remote checks run.
 *  An explicitly different runtime credential is still rejected against private saved input.
 */
export async function runCloudSetup({ directory, config: input, artifacts, credentials, fetch, onProgress, adapterFactory = createCloudAdapters }) {
  const config = validateCloudConfig(input), hashes = validateCloudArtifacts(artifacts), root = await privateDirectory(directory);
  const release = await acquireCloudLock(root);
  let journal, historicalOnly = false;
  try {
    journal = await loadState(root, config, hashes);
    // Provisioning is a fresh-instance operation, not a maintenance probe. In particular,
    // never replay its empty-catalog/storage checks after real applications are installed.
    historicalOnly = provisioned(journal);
    if (historicalOnly) {
      const secrets = validateSecrets(await readPrivateJSON(join(root, 'secrets.json')), journal);
      if (credentials?.runtimeFlyToken !== undefined && credentials.runtimeFlyToken !== secrets.runtimeFlyToken) throw new CloudSetupError('runtime-token-change-requires-explicit-correction');
      return await currentImageState({ directory: root, config, artifacts }, publicState(journal));
    }
    if (!credentials || Object.keys(credentials).some(key => !['flyToken', 'cloudflareToken', 'runtimeFlyToken'].includes(key)) || !['flyToken', 'cloudflareToken'].every(key => secretValid(credentials[key]))) throw new CloudSetupError('explicit-provider-credentials-required');
    if (journal.runtimeCredentialCorrection === 'pending') throw new CloudSetupError('runtime-credential-correction-incomplete-repeat-command');
    const secretsPath = join(root, 'secrets.json'), secrets = validateSecrets(await readPrivateJSON(secretsPath), journal);
    if (credentials.runtimeFlyToken !== undefined) {
      if (!secretValid(credentials.runtimeFlyToken)) throw new CloudSetupError('explicit-runtime-fly-token-required');
      if (secrets.runtimeFlyToken && secrets.runtimeFlyToken !== credentials.runtimeFlyToken) throw new CloudSetupError('runtime-token-change-requires-explicit-correction');
    }
    const runtimeFlyToken = credentials.runtimeFlyToken ?? secrets.runtimeFlyToken;
    if (!secretValid(runtimeFlyToken)) throw new CloudSetupError('explicit-runtime-fly-token-required');
    const runtimeAuthentication = await validateRuntimeFlyCredential({ token: runtimeFlyToken, organization: config.fly.organization, fetch });
    const needsSave = secrets.runtimeFlyToken !== runtimeFlyToken;
    secrets.runtimeFlyToken = runtimeFlyToken;
    const adapters = adapterFactory({ config, identity: journal.identity, artifacts, secrets, credentials, fetch });
    await adapters.preflight();
    // Credentials are persisted only after runtime authentication and read-only provider preflight succeed.
    if (needsSave) await writePrivateJSON(secretsPath, secrets);
    journal.runtimeCredentialValidation = runtimeAuthentication;
    journal.status = 'provisioning'; await writePrivateJSON(join(root, 'journal.json'), journal);
    for (const name of journal.plan.steps) {
      const handler = adapters.steps[name];
      if (!handler || typeof handler.probe !== 'function' || typeof handler.create !== 'function') throw new CloudSetupError('missing-step-adapter');
      const previous = journal.steps[name];
      let receipt = await handler.probe(journal);
      if (previous?.status === 'done') {
        if (!receipt?.ready || receipt.id !== previous.receipt?.id || previous.receipt?.dependencyHash && receipt.dependencyHash !== previous.receipt.dependencyHash) throw new CloudSetupError('completed-resource-drift');
        continue;
      }
      if (receipt && !previous && !handler.adopt) throw new CloudSetupError('fresh-resource-name-already-exists');
      if (receipt && previous?.receipt && receipt.id !== previous.receipt.id) throw new CloudSetupError('resource-identity-changed');
      if (!previous) {
        journal.steps[name] = { status: 'creating', attempt: randomBytes(16).toString('hex') };
        await writePrivateJSON(join(root, 'journal.json'), journal);
      }
      if ((!receipt || handler.repeatPending) && !(previous && !handler.retrySafe && !handler.repeatPending && !receipt)) {
        await handler.create(journal, () => writePrivateJSON(join(root, 'journal.json'), journal));
        receipt = await handler.probe(journal);
      } else if (!receipt) {
        throw new CloudSetupError('ambiguous-create-outcome-requires-provider-reconciliation');
      }
      if (receipt) {
        if (typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id) || typeof receipt.ready !== 'boolean') throw new CloudSetupError('invalid-adapter-receipt');
        if (receipt.dependencyHash !== undefined && !/^[a-f0-9]{64}$/.test(receipt.dependencyHash)) throw new CloudSetupError('invalid-adapter-receipt');
        journal.steps[name].receipt = { id: receipt.id, ...(receipt.dependencyHash ? { dependencyHash: receipt.dependencyHash } : {}), ...(receipt.shared === true ? { shared: true } : {}) };
      }
      if (receipt?.ready) journal.steps[name].status = 'done';
      await writePrivateJSON(join(root, 'journal.json'), journal);
      // Only generated identities, phase names and status go to optional caller logging.
      if (onProgress) await onProgress({ instanceId: journal.identity.id, step: name, status: journal.steps[name].status });
      if (!receipt?.ready) throw new CloudSetupError('resource-not-ready-resume-same-journal');
    }
    // Inventory reads and storage proofs cannot prove create/start/lease/backend or restart capability.
    journal.status = 'acceptance-pending'; await writePrivateJSON(join(root, 'journal.json'), journal);
    return await currentImageState({ directory: root, config, artifacts }, publicState(journal));
  } catch (error) {
    if (journal && !historicalOnly) {
      journal.status = error instanceof CloudSetupError && error.code === 'resource-not-ready-resume-same-journal' ? 'waiting' : 'attention';
      await writePrivateJSON(join(root, 'journal.json'), journal).catch(() => {});
    }
    // Adapters and optional callbacks may fail with echoed secrets. Do not preserve causes or raw messages.
    if (error instanceof CloudSetupError) throw error;
    throw new CloudSetupError('setup-failed-resume-same-journal');
  } finally { await release(); }
}

/** Correct a runtime credential in the SAME journal before machine creation has begun.
 *  The new value is accepted only from private caller input and authenticated before persistence.
 *  Once a machine create was attempted, correction needs a separate controlled rotation workflow;
 *  changing only local secrets could leave a live OS using the previous token.
 */
export async function replaceCloudRuntimeCredential({ directory, config: input, artifacts, runtimeFlyToken, fetch }) {
  const config = validateCloudConfig(input), hashes = validateCloudArtifacts(artifacts), root = await privateDirectory(directory), release = await acquireCloudLock(root);
  try {
    const journal = await loadState(root, config, hashes), path = join(root, 'secrets.json'), secrets = validateSecrets(await readPrivateJSON(path), journal);
    if (journal.steps['fly-machine']) throw new CloudSetupError('runtime-credential-rotation-required-after-machine-attempt');
    if (!secretValid(runtimeFlyToken)) throw new CloudSetupError('explicit-runtime-fly-token-required');
    const validation = await validateRuntimeFlyCredential({ token: runtimeFlyToken, organization: config.fly.organization, fetch });
    // Existing app-secret metadata must not make resume skip installing the corrected value.
    if (journal.steps['fly-secrets']) journal.steps['fly-secrets'] = { status: 'creating', attempt: randomBytes(16).toString('hex') };
    journal.runtimeCredentialCorrection = 'pending'; journal.status = 'attention';
    await writePrivateJSON(join(root, 'journal.json'), journal);
    secrets.runtimeFlyToken = runtimeFlyToken; await writePrivateJSON(path, secrets);
    journal.runtimeCredentialValidation = validation; delete journal.runtimeCredentialCorrection;
    journal.status = 'planned'; await writePrivateJSON(join(root, 'journal.json'), journal);
    return await currentImageState({ directory: root, config, artifacts }, publicState(journal));
  } catch (error) { if (error instanceof CloudSetupError) throw error; throw new CloudSetupError('runtime-credential-correction-failed'); }
  finally { await release(); }
}

/** Rearm an ambiguous absent create only after an operator has reconciled its provider outcome.
 *  This is deliberately separate from run/resume and never called automatically.
 *  expectedAttempt must come from describeCloudSetup; accepted resolution is explicit and recorded.
 *  The next run probes ownership/absence again before issuing any create.
 */
export async function reconcileCloudStep({ directory, config: input, artifacts, step, expectedAttempt, resolution }) {
  const config = validateCloudConfig(input), hashes = validateCloudArtifacts(artifacts), root = await privateDirectory(directory), release = await acquireCloudLock(root);
  try {
    const journal = await loadState(root, config, hashes), current = journal.steps[step];
    if (resolution !== 'confirmed-not-created' || !current || current.status !== 'creating' || current.receipt || current.attempt !== expectedAttempt) throw new CloudSetupError('invalid-reconciliation');
    journal.reconciliations ??= [];
    journal.reconciliations.push({ step, attempt: expectedAttempt, resolution });
    delete journal.steps[step];
    await writePrivateJSON(join(root, 'journal.json'), journal);
    return await currentImageState({ directory: root, config, artifacts }, publicState(journal));
  } finally { await release(); }
}
