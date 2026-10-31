import { constants } from 'node:fs';
import { open, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { privateDirectory, readPrivateJSON, writePrivateJSON, acquireCloudLock } from './cloud-private.mjs';
import { describeCloudProvisioning } from './cloud-setup.mjs';
import { fingerprint, validateCloudConfig } from './cloud-config.mjs';
import { CloudSetupError, createCloudTransport, osMachineConfig, normalizeMachineServices } from './cloud-providers.mjs';

export const CLOUD_UPGRADE_API_SOURCES = Object.freeze([
  'https://docs.fly.io/machines/api/machines-resource',
  'https://docs.fly.io/machines/guides-examples/managing-machines-with-the-api',
]);
export const CLOUD_UPGRADE_ACTIVITY = Object.freeze(['requests', 'writers', 'publications', 'workflows', 'schedules', 'nativeJobs', 'codeTasks', 'poolAssignments', 'poolRequests']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = (value, size = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const pin = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value);
const fail = code => { throw new CloudSetupError(code); };
const check = (value, code) => { if (!value) fail(code); };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const digest = value => sha(canonical(value));
const modeValid = mode => ['automatic', 'external-stopped-bootstrap'].includes(mode);
const imagesValid = images => images && Object.keys(images).sort().join(',') === 'os,runtime' && pin(images.os) && pin(images.runtime);
const zeroActivity = activity => activity && Object.keys(activity).sort().join(',') === [...CLOUD_UPGRADE_ACTIVITY].sort().join(',') && CLOUD_UPGRADE_ACTIVITY.every(key => activity[key] === 0);
const phases = ['planned', 'abandoned', 'maintenance-intent', 'maintenance-unsupported', 'waiting-for-quiescence', 'bootstrap-evidence-recorded', 'quiescent', 'cancel-intent', 'cancelled', 'stop-intent', 'waiting-for-stopped-machine', 'update-intent', 'target-config-observed', 'start-intent', 'waiting-for-started-machine', 'verifying-new-host', 'release-maintenance-intent', 'complete'];
async function optional(path) { try { return await readPrivateJSON(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
const originalBinding = journal => ({ instanceId: journal.identity.id, configHash: journal.configHash, artifactHash: journal.artifactHash, planHash: fingerprint(journal.plan) });
const operationPath = (root, id) => { check(hex(id, 32), 'invalid-upgrade-operation'); return join(root, 'upgrades', id); };
async function privateExistingDirectory(path) {
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid()) && await realpath(path) === path, 'upgrade-state-directory-not-private'); return path;
}

async function state(args) {
  const root = await privateDirectory(args.directory), plan = await describeCloudProvisioning(args), journal = await readPrivateJSON(join(root, 'journal.json'));
  check(plan.provisioning.status === 'complete', 'complete-provisioning-before-upgrade');
  const binding = originalBinding(journal), initialImages = { os: plan.images.os, runtime: plan.images.runtime };
  let current = await optional(join(root, 'current-images.json'));
  if (!current) {
    let entries = []; try { await privateExistingDirectory(join(root, 'upgrades')); entries = await readdir(join(root, 'upgrades')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const id of entries) {
      check(hex(id, 32), 'upgrade-image-lineage-missing-recovery-required');
      await privateExistingDirectory(join(root, 'upgrades', id)); check(!(await readdir(join(root, 'upgrades', id))).length, 'upgrade-image-lineage-missing-recovery-required');
    }
    current = { format: 'ink-cloud-current-images-v1', binding, generation: 0, images: initialImages, activeOperation: null, lastOperation: null, receiptHash: null };
  }
  check(current.format === 'ink-cloud-current-images-v1' && same(current.binding, binding) && Number.isSafeInteger(current.generation) && current.generation >= 0 && imagesValid(current.images) && (current.activeOperation === null || hex(current.activeOperation, 32)) && (current.lastOperation === null || hex(current.lastOperation, 32)), 'invalid-current-image-state');
  if (current.pendingIntent) check(current.pendingIntent.format === 'ink-cloud-upgrade-intent-v1' && current.pendingIntent.operationId === current.activeOperation && same(current.pendingIntent.binding, binding) && current.pendingIntent.fromGeneration === current.generation && same(current.pendingIntent.fromImages, current.images) && imagesValid(current.pendingIntent.targetImages) && modeValid(current.pendingIntent.mode) && hex(current.pendingIntent.challenge), 'invalid-pending-upgrade-intent');
  if (current.generation === 0) check(same(current.images, initialImages) && current.lastOperation === null && current.receiptHash === null, 'invalid-current-image-state');
  else {
    await privateExistingDirectory(join(root, 'upgrades')); await privateExistingDirectory(operationPath(root, current.lastOperation));
    const receipt = await readPrivateJSON(join(operationPath(root, current.lastOperation), 'receipt.json'));
    check(digest(receipt) === current.receiptHash && receipt.generation === current.generation && same(receipt.targetImages, current.images) && same(receipt.binding, binding), 'upgrade-lineage-receipt-mismatch');
    const evidence = await readPrivateJSON(join(operationPath(root, current.lastOperation), 'evidence.json'));
    check(digest(evidence) === receipt.evidenceSha256 && evidence.operationId === current.lastOperation && evidence.intentHash === receipt.intentHash, 'upgrade-lineage-evidence-mismatch');
  }
  const context = { root, journal, binding, current, config: validateCloudConfig(args.config) };
  if (current.lastCancellation !== undefined) {
    check(current.lastCancellation && Object.keys(current.lastCancellation).sort().join(',') === 'operationId,receiptHash' && hex(current.lastCancellation.operationId,32) && hex(current.lastCancellation.receiptHash), 'upgrade-cancellation-lineage-invalid');
    await privateExistingDirectory(join(root,'upgrades')); const path=await privateExistingDirectory(operationPath(root,current.lastCancellation.operationId));
    const intent=await readPrivateJSON(join(path,'intent.json')), cancellation=await readPrivateJSON(join(path,'cancellation.json'));
    validateCancellation(context,intent,cancellation);check(digest(cancellation)===current.lastCancellation.receiptHash && cancellation.fromGeneration<=current.generation,'upgrade-cancellation-lineage-invalid');
  }
  return context;
}
async function operation(context, id) {
  const path = operationPath(context.root, id);
  await privateExistingDirectory(join(context.root, 'upgrades'));
  // The pointer contains the complete pending local intent before any intent files or
  // provider calls. Recover that narrow write window, never regenerate lost active progress.
  if (context.current.pendingIntent) {
    const pending = context.current.pendingIntent;
    check(pending.operationId === id && context.current.activeOperation === id && same(pending.binding, context.binding) && pending.fromGeneration === context.current.generation && same(pending.fromImages, context.current.images) && imagesValid(pending.targetImages) && modeValid(pending.mode) && hex(pending.challenge), 'invalid-pending-upgrade-intent');
    await privateDirectory(path);
    if (!await optional(join(path, 'intent.json'))) await writePrivateJSON(join(path, 'intent.json'), pending, { exclusive: true });
    if (!await optional(join(path, 'progress.json'))) await writePrivateJSON(join(path, 'progress.json'), { format: 'ink-cloud-upgrade-progress-v1', operationId: id, intentHash: digest(pending), phase: 'planned' }, { exclusive: true });
  }
  await privateExistingDirectory(path);
  const intent = await readPrivateJSON(join(path, 'intent.json')), progress = await readPrivateJSON(join(path, 'progress.json'));
  check(intent.format === 'ink-cloud-upgrade-intent-v1' && intent.operationId === id && same(intent.binding, context.binding) && modeValid(intent.mode) && imagesValid(intent.fromImages) && imagesValid(intent.targetImages) && hex(intent.challenge) && Number.isSafeInteger(intent.fromGeneration) && intent.fromGeneration >= 0 && (intent.mode !== 'external-stopped-bootstrap' || intent.targetImages.runtime === intent.fromImages.runtime), 'invalid-upgrade-intent');
  check(progress.format === 'ink-cloud-upgrade-progress-v1' && progress.operationId === id && progress.intentHash === digest(intent) && phases.includes(progress.phase) && (!progress.baselineVersion || safeId(progress.baselineVersion) && hex(progress.baselineConfigHash) && hex(progress.targetConfigHash)), 'invalid-upgrade-progress');
  if (context.current.pendingIntent) { check(same(context.current.pendingIntent, intent) && progress.phase === 'planned', 'invalid-pending-upgrade-intent'); delete context.current.pendingIntent; await writePrivateJSON(join(context.root, 'current-images.json'), context.current); }
  const cancellation=await optional(join(path,'cancellation.json'));
  if(cancellation) { validateCancellation(context,intent,cancellation);check(!progress.cancellationHash||progress.cancellationHash===digest(cancellation),'upgrade-cancellation-lineage-invalid'); }
  if(progress.phase==='cancelled')check(cancellation&&progress.cancellationHash===digest(cancellation),'upgrade-cancellation-lineage-invalid');
  return { path, intent, progress, cancellation };
}
const publicOperation = (context, intent, progress, receipt) => ({ format: 'ink-cloud-upgrade-status-v1', scope: 'os-and-global-pooled-runtime-default', instanceId: context.binding.instanceId, currentImages: context.current.images, generation: context.current.generation, operationId: intent.operationId, mode: intent.mode, fromImages: intent.fromImages, targetImages: intent.targetImages, challenge: intent.challenge, status: progress.phase, ...(progress.cancellationHash ? { cancellationSha256:progress.cancellationHash,cancellation:{status:'historical-cancelled',liveAudit:'not-performed'} } : {}), ...(receipt ? { receiptSha256: digest(receipt), verification: receipt.verification, completedAt: receipt.completedAt, customRuntimeImages: receipt.customRuntimeImages } : {}), limitations: intent.mode === 'external-stopped-bootstrap' ? ['OS-only external-stopped bootstrap; quiescence is externally attested and provider stopped-state is independently observed.', 'Automatic maintenance/restart proof remains pending; the pooled runtime digest is unchanged.'] : ['Automatic upgrade requires the authenticated durable maintenance gate.', 'Health and image provenance checks do not prove application/backend behavior after upgrade.', 'Intentional per-app custom runtime images are inventoried, not rewritten; their rebuild/base-update and compatibility checks remain separate. Selected release pins recreating the retiring global runtime block this upgrade.'] });

/** Offline planning. Original journal/config/images remain byte-for-byte unchanged. */
export async function planCloudUpgrade(args) {
  check(imagesValid(args.images) && modeValid(args.mode || 'automatic'), 'explicit-pinned-upgrade-image-pair-required');
  const root = await privateDirectory(args.directory), unlock = await acquireCloudLock(root);
  try {
    const context = await state(args), { current } = context, mode = args.mode || 'automatic';
    if (current.activeOperation) {
      const { intent, progress, path } = await operation(context, current.activeOperation);
      check(same(intent.targetImages, args.images) && intent.mode === mode, 'upgrade-active-operation-must-resume');
      return publicOperation(context, intent, progress, await optional(join(path, 'receipt.json')));
    }
    if (same(current.images, args.images) && current.lastOperation) {
      const { intent, progress, path } = await operation(context, current.lastOperation);
      return publicOperation(context, intent, progress, await readPrivateJSON(join(path, 'receipt.json')));
    }
    check(!same(current.images, args.images), 'upgrade-images-unchanged');
    check(mode !== 'external-stopped-bootstrap' || args.images.runtime === current.images.runtime, 'bootstrap-cannot-upgrade-pooled-runtime');
    const parent = await privateDirectory(join(root, 'upgrades')), id = randomBytes(16).toString('hex'), path = join(parent, id);
    await mkdir(path, { mode: 0o700 });
    const intent = { format: 'ink-cloud-upgrade-intent-v1', operationId: id, binding: context.binding, fromGeneration: current.generation, fromImages: current.images, targetImages: { ...args.images }, mode, challenge: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    const progress = { format: 'ink-cloud-upgrade-progress-v1', operationId: id, intentHash: digest(intent), phase: 'planned' };
    current.activeOperation = id; current.pendingIntent = intent; await writePrivateJSON(join(root, 'current-images.json'), current);
    await writePrivateJSON(join(path, 'intent.json'), intent, { exclusive: true }); await writePrivateJSON(join(path, 'progress.json'), progress, { exclusive: true });
    delete current.pendingIntent; await writePrivateJSON(join(root, 'current-images.json'), current);
    return publicOperation(context, intent, progress);
  } finally { await unlock(); }
}

export async function describeCloudUpgrade(args) {
  const context = await state(args), id = args.operationId || context.current.activeOperation || context.current.lastOperation || context.current.lastCancellation?.operationId;
  if (!id) return { format: 'ink-cloud-upgrade-status-v1', instanceId: context.binding.instanceId, generation: 0, currentImages: context.current.images, status: 'no-upgrade-planned' };
  if (context.current.pendingIntent) { check(context.current.pendingIntent.operationId === id, 'upgrade-active-operation-must-resume'); return publicOperation(context, context.current.pendingIntent, { phase: 'local-intent-write-incomplete-resume-plan' }); }
  const { intent, progress, path } = await operation(context, id);
  return publicOperation(context, intent, progress, await optional(join(path, 'receipt.json')));
}

/** Abandon only an untouched intent or a definite unsupported-API response, never an active gate. */
export async function abandonCloudUpgrade(args) {
  const root = await privateDirectory(args.directory), unlock = await acquireCloudLock(root);
  try {
    const context = await state(args), { intent, progress, path } = await operation(context, args.operationId);
    check(context.current.activeOperation === intent.operationId && ['planned', 'maintenance-unsupported'].includes(progress.phase) && !progress.gateReceipt && !progress.updateIntent, 'upgrade-cannot-abandon-active-maintenance');
    progress.phase = 'abandoned'; await writePrivateJSON(join(path, 'progress.json'), progress);
    context.current.activeOperation = null; await writePrivateJSON(join(root, 'current-images.json'), context.current);
    return publicOperation(context, intent, progress);
  } finally { await unlock(); }
}

const emptyInit = value => value === null || value && !Array.isArray(value) && typeof value === 'object' && Object.entries(value).every(([key, item]) => ['exec', 'entrypoint', 'cmd', 'kernel_args'].includes(key) ? item === null || Array.isArray(item) && !item.length : key === 'tty' ? item === false || item === null : key === 'swap_size_mb' ? item === null || item === 0 : false);
function normalize(config) {
  const result = structuredClone(config);
  if (result.restart?.policy === 'always' && result.restart.max_retries === 0) delete result.restart.max_retries;
  for (const key of ['dns', 'init', 'metrics', 'checks']) if (result[key] === null || same(result[key], {}) || same(result[key], []) || key === 'init' && emptyInit(result[key])) delete result[key];
  for (const mount of result.mounts || []) for (const key of ['encrypted', 'size_gb', 'name']) delete mount[key];
  if (Array.isArray(result.services)) result.services = normalizeMachineServices(result.services);
  return result;
}
function machineServiceProfile(context,actual,expected,upgradeId) {
  const services=normalizeMachineServices(actual.services),modern=normalizeMachineServices(expected.services);
  if(Array.isArray(services)&&same(services,modern))return 'machines-service-check-v1';
  if(context.current.generation===0&&!upgradeId&&!Object.hasOwn(actual.env,'INK_OS_IMAGE_PIN')&&!Object.hasOwn(actual.metadata,'ink_cloud_upgrade')){
    const absent=structuredClone(modern);delete absent[0].checks;
    if(same(services,absent))return 'legacy-generation-zero-missing-service-health';
    const unsupported=structuredClone(absent);unsupported[0].http_checks=[{path:'/api/health',interval:'30s',timeout:'5s',grace_period:'60s',method:'GET'}];
    if(same(services,unsupported))return 'legacy-generation-zero-unsupported-http-checks';
  }
  fail('upgrade-machine-service-config-conflict');
}
function ownedMachine(context, machine, images, upgradeId) {
  const { journal, config } = context, n = journal.identity;
  check(machine?.id === journal.steps['fly-machine'].receipt.id && machine.name === n.machine && machine.region === config.fly.region && safeId(machine.instance_id) && machine.config?.metadata?.ink_os_instance === n.id, 'upgrade-machine-ownership-conflict');
  const expected = osMachineConfig({ ...config, fly: { ...config.fly, osImage: images.os, runtimeImage: images.runtime } }, n, journal.steps['fly-volume'].receipt.id), actual = machine.config;
  const env = { ...expected.env, ...(actual.env?.INK_OS_IMAGE_PIN !== undefined ? { INK_OS_IMAGE_PIN: images.os } : {}) };
  check(actual.image === images.os && same(actual.env, env) && (!upgradeId || actual.env.INK_OS_IMAGE_PIN === images.os) && same(actual.guest, expected.guest) && same(normalize(actual).restart, normalize(expected).restart), 'upgrade-machine-source-config-conflict');
  const metadata = { ...expected.metadata, ...(upgradeId ? { ink_cloud_upgrade: upgradeId } : {}) };
  check(same(actual.metadata, metadata), 'upgrade-machine-metadata-conflict');
  check(Array.isArray(actual.mounts) && actual.mounts.length === 1, 'upgrade-machine-mount-conflict');
  const mount = actual.mounts[0];
  check(Object.keys(mount).every(key => ['volume', 'path', 'encrypted', 'size_gb', 'name'].includes(key)) && mount.volume === expected.mounts[0].volume && mount.path === '/data' && (mount.encrypted === undefined || mount.encrypted === true) && (mount.size_gb === undefined || mount.size_gb === config.fly.volumeGB) && (mount.name === undefined || mount.name === n.volume), 'upgrade-machine-mount-conflict');
  machineServiceProfile(context,actual,expected,upgradeId);
  // The initial API may add empty defaults. Nonempty init/files/checks would change the
  // selected runtime contract and are never silently carried into a purported image-only upgrade.
  for (const [key, value] of Object.entries(actual)) if (!Object.hasOwn(expected, key)) check(['dns', 'init', 'metrics', 'checks'].includes(key) && (value === null || same(value, {}) || same(value, []) || key === 'init' && emptyInit(value)), 'upgrade-machine-unsupported-config');
  if (machine.image_ref?.digest) check(machine.image_ref.digest === images.os.slice(images.os.indexOf('@') + 1), 'upgrade-machine-image-digest-conflict');
  return actual;
}

async function boundedJSON(response) {
  let size = 0; const chunks = [];
  for await (const bytes of response.body || []) { size += bytes.length; check(size <= 2 * 1024 * 1024, 'upgrade-host-response-limit'); chunks.push(Buffer.from(bytes)); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail('upgrade-host-response-invalid'); }
}

/** Actual production host protocol. No endpoint fallback to unsafe read-then-update. */
export function createCloudUpgradeMaintenance({ origin, instanceId, ownerToken, fetch: transport = globalThis.fetch }) {
  const host = new URL(origin);
  check(host.protocol === 'https:' && host.origin === origin && !host.username && !host.password && hex(instanceId, 32), 'upgrade-host-origin-invalid');
  check(typeof ownerToken === 'string' && ownerToken.length >= 32 && ownerToken.length <= 16384 && !/[\r\n]/.test(ownerToken), 'upgrade-private-owner-credential-required');
  let verified = false;
  const protect = async run => { try { return await run(); } catch (error) { if (error instanceof CloudSetupError) throw error; throw new CloudSetupError('upgrade-host-transport-or-response-failed'); } };
  const inspect = () => protect(async () => {
    const response = await transport(new URL('/api/health', origin), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new CloudSetupError('upgrade-host-not-healthy', response.status); }
    const value = await boundedJSON(response); check(value.ok === true && value.instanceId === instanceId, 'upgrade-host-instance-mismatch'); verified = true; return value;
  });
  const request = (path, body) => protect(async () => {
    if (!verified) await inspect();
    const response = await transport(new URL('/api/v1/maintenance' + path, origin), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + ownerToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (response.status === 404) { await response.body?.cancel(); fail('upgrade-maintenance-api-required'); }
    if (!response.ok) { await response.body?.cancel(); throw new CloudSetupError('upgrade-maintenance-request-failed', response.status); } return boundedJSON(response);
  });
  return {
    inspect,
    prepare: input => request('/prepare', input),
    status: id => { check(hex(id, 32), 'invalid-upgrade-operation'); return request('/' + id); },
    seal: (id, input) => { check(hex(id, 32), 'invalid-upgrade-operation'); return request('/' + id + '/seal', input); },
    cancel: (id, input) => { check(hex(id, 32), 'invalid-upgrade-operation'); return request('/' + id + '/cancel', input); },
    complete: (id, input) => { check(hex(id, 32), 'invalid-upgrade-operation'); return request('/' + id + '/complete', input); },
  };
}

function gateReceipt(intent, value, states, requireStopAuthorization = false) {
  check(value?.format === 'ink-os-maintenance-receipt-v1' && value.instanceId === intent.binding.instanceId && value.operationId === intent.operationId && value.challenge === intent.challenge && same(value.fromImages, intent.fromImages) && same(value.targetImages, intent.targetImages) && states.includes(value.state) && hex(value.bootId, 32) && value.durable === true && Number.isFinite(Date.parse(value.preparedAt)), 'upgrade-maintenance-receipt-invalid');
  check(value.stopAuthorized === undefined || typeof value.stopAuthorized === 'boolean', 'upgrade-maintenance-receipt-invalid');
  check(!(requireStopAuthorization || ['restarted', 'complete'].includes(value.state)) || value.stopAuthorized === true, 'upgrade-maintenance-stop-not-authorized');
  // External admission closes first. Already admitted jobs may still need the pool for
  // continuations while draining; only the final quiescent receipt closes pool admission.
  check(value.admissionClosed === (value.state !== 'complete') && typeof value.pool?.admissionClosed === 'boolean' && (value.state === 'draining' || value.pool.admissionClosed === (value.state !== 'complete')), 'upgrade-maintenance-admission-not-closed');
  if (value.state !== 'draining') {
    check(zeroActivity(value.activity) && value.pool?.active === 0 && value.pool.held === 0 && value.pool.uncertain === 0 && value.pool.oldRuntimeSlotsRemaining === 0 && Array.isArray(value.pool.retired) && value.pool.retired.every(id => hex(id, 32)) && new Set(value.pool.retired).size === value.pool.retired.length, 'upgrade-host-not-quiescent');
    check(value.pool.incompatibleRuntimeOverrides === 0 && Array.isArray(value.pool.customRuntimeImages) && value.pool.customRuntimeImages.length <= 1000 && value.pool.customRuntimeImages.every(pin) && new Set(value.pool.customRuntimeImages).size === value.pool.customRuntimeImages.length && (intent.fromImages.runtime === intent.targetImages.runtime || !value.pool.customRuntimeImages.includes(intent.fromImages.runtime)), 'upgrade-incompatible-release-runtime-pin');
  }
  return value;
}

function cancelledGate(intent,value,bootId) {
  check(value?.format==='ink-os-maintenance-receipt-v1'&&value.instanceId===intent.binding.instanceId&&value.operationId===intent.operationId&&value.challenge===intent.challenge&&same(value.fromImages,intent.fromImages)&&same(value.targetImages,intent.targetImages)&&value.state==='cancelled'&&value.durable===true&&value.stopAuthorized===false&&hex(value.bootId,32)&&(!bootId||value.bootId===bootId)&&Number.isFinite(Date.parse(value.preparedAt))&&Number.isFinite(Date.parse(value.completedAt)),'upgrade-cancellation-receipt-invalid');
  check(value.admissionClosed===false&&value.pool?.admissionClosed===false,'upgrade-cancellation-receipt-invalid');
  // Cancellation reopens admission; its historical activity proof need not be idle.
  check(value.activity&&Object.keys(value.activity).sort().join(',')===[...CLOUD_UPGRADE_ACTIVITY].sort().join(',')&&Object.values(value.activity).every(n=>Number.isSafeInteger(n)&&n>=0)&&['active','held','uncertain','oldRuntimeSlotsRemaining','incompatibleRuntimeOverrides'].every(key=>Number.isSafeInteger(value.pool[key])&&value.pool[key]>=0)&&Array.isArray(value.pool.retired)&&value.pool.retired.length<=2000&&value.pool.retired.every(id=>hex(id,32))&&new Set(value.pool.retired).size===value.pool.retired.length&&Array.isArray(value.pool.customRuntimeImages)&&value.pool.customRuntimeImages.length<=1000&&value.pool.customRuntimeImages.every(pin)&&new Set(value.pool.customRuntimeImages).size===value.pool.customRuntimeImages.length,'upgrade-cancellation-receipt-invalid');
  return value;
}
function validateCancellation(context,intent,value) {
  check(intent?.format==='ink-cloud-upgrade-intent-v1'&&intent.mode==='automatic'&&hex(intent.operationId,32)&&hex(intent.challenge)&&same(intent.binding,context.binding)&&imagesValid(intent.fromImages)&&imagesValid(intent.targetImages)&&Number.isSafeInteger(intent.fromGeneration)&&intent.fromGeneration>=0,'upgrade-cancellation-lineage-invalid');
  check(value?.format==='ink-cloud-upgrade-cancellation-v1'&&value.operationId===intent.operationId&&value.intentHash===digest(intent)&&same(value.binding,context.binding)&&same(value.fromImages,intent.fromImages)&&value.fromGeneration===intent.fromGeneration&&value.source?.machineId===context.journal.steps['fly-machine'].receipt.id&&safeId(value.source.version)&&hex(value.source.configHash)&&hex(value.source.bootId,32)&&Number.isFinite(Date.parse(value.cancelledAt)),'upgrade-cancellation-lineage-invalid');
  cancelledGate(intent,value.receipt,value.source.bootId);return value;
}

/** Explicit source-side cancellation. It never stops a host, worker, or provider
 * resource. A durable remote cancellation is retained before clearing local intent. */
export async function cancelCloudUpgrade(args) {
  const root=await privateDirectory(args.directory),unlock=await acquireCloudLock(root);let request,base,lease,progress,save;
  try {
    const context=await state(args),{current,journal,config}=context,{intent,path,cancellation,progress:saved}=await operation(context,args.operationId);progress=saved;
    check(intent.mode==='automatic','upgrade-cancellation-automatic-source-only');
    check(args.credentials&&Object.keys(args.credentials).length===1&&typeof args.credentials.flyToken==='string'&&args.credentials.flyToken.length>=16&&!/[\r\n]/.test(args.credentials.flyToken),'upgrade-explicit-fly-credential-required');
    save=async()=>writePrivateJSON(join(path,'progress.json'),progress);
    const finish=async proof=>{
      validateCancellation(context,intent,proof);
      check(current.activeOperation===intent.operationId||current.lastCancellation?.operationId===intent.operationId,'upgrade-operation-not-selected');
      if(current.lastCancellation?.operationId===intent.operationId&&current.activeOperation!==intent.operationId)return publicOperation(context,intent,{...progress,phase:'cancelled',cancellationHash:digest(proof)});
      check(current.generation===intent.fromGeneration&&same(current.images,intent.fromImages),'upgrade-current-image-generation-changed');
      progress.phase='cancelled';progress.cancellationHash=digest(proof);await save();
      current.lastCancellation={operationId:intent.operationId,receiptHash:progress.cancellationHash};current.activeOperation=null;await writePrivateJSON(join(root,'current-images.json'),current);
      return publicOperation(context,intent,progress);
    };
    if(cancellation)return await finish(cancellation);
    check(current.activeOperation===intent.operationId&&current.generation===intent.fromGeneration&&same(current.images,intent.fromImages),'upgrade-operation-not-selected');
    check(['maintenance-intent','waiting-for-quiescence','quiescent','cancel-intent'].includes(progress.phase)&&!progress.sealIntent&&!progress.gateReceipt?.stopAuthorized&&!progress.updateIntent&&!progress.bootstrap,'upgrade-cancellation-blocked-resume-same-operation');
    check(safeId(progress.baselineVersion)&&hex(progress.baselineConfigHash),'upgrade-cancellation-source-baseline-required');
    request=createCloudTransport({flyToken:args.credentials.flyToken,fetch:args.fetch});
    const app=await request('fly','/apps/'+journal.identity.osApp);
    check(app.name===journal.identity.osApp&&app.id===journal.steps['fly-app'].receipt.id&&app.organization?.slug===config.fly.organization,'upgrade-app-ownership-conflict');
    const volumes=await request('fly','/apps/'+journal.identity.osApp+'/volumes'),volume=Array.isArray(volumes)&&volumes.find(row=>row.id===journal.steps['fly-volume'].receipt.id);
    check(volume&&volume.name===journal.identity.volume&&volume.region===config.fly.region&&volume.encrypted===true&&volume.size_gb===config.fly.volumeGB&&volume.state==='created','upgrade-volume-ownership-conflict');
    const machines=await request('fly','/apps/'+journal.identity.osApp+'/machines');check(Array.isArray(machines)&&machines.length===1&&machines[0].id===journal.steps['fly-machine'].receipt.id,'upgrade-machine-inventory-conflict');
    base='/apps/'+journal.identity.osApp+'/machines/'+machines[0].id;
    const source=machine=>{ownedMachine(context,machine,intent.fromImages,current.lastOperation);check(machine.state==='started'&&machine.config.env.INK_OS_IMAGE_PIN===intent.fromImages.os&&machine.instance_id===progress.baselineVersion&&digest(normalize(machine.config))===progress.baselineConfigHash,'upgrade-cancellation-source-drift');return machine;};
    source(await request('fly',base));
    if(progress.lease?.expiresAt>Date.now()/1000+60){const found=await request('fly',base+'/lease');check(found.data?.nonce===progress.lease.nonce&&found.data?.description==='ink-cloud-upgrade:'+intent.operationId,'upgrade-machine-lease-foreign');lease=progress.lease.nonce;}
    else {const grant=await request('fly',base+'/lease',{method:'POST',body:{ttl:300,description:'ink-cloud-upgrade:'+intent.operationId}});check(typeof grant.data?.nonce==='string'&&grant.data.nonce.length>=8&&Number.isFinite(grant.data.expires_at)&&grant.data.expires_at>Date.now()/1000+60,'upgrade-private-lease-invalid');lease=grant.data.nonce;progress.lease={nonce:lease,expiresAt:grant.data.expires_at};await save();}
    source(await request('fly',base,{lease}));
    const secrets=await readPrivateJSON(join(root,'secrets.json'));check(secrets.format==='ink-cloud-secrets-v1'&&same(secrets.identity,journal.identity)&&secrets.configHash===journal.configHash&&secrets.artifactHash===journal.artifactHash,'upgrade-private-state-mismatch');
    const maintenance=args.maintenance||createCloudUpgradeMaintenance({origin:journal.plan.origin,instanceId:journal.identity.id,ownerToken:secrets.ownerToken,fetch:args.fetch});await maintenance.inspect();
    let remote=await maintenance.status(intent.operationId);
    if(remote?.state==='cancelled')cancelledGate(intent,remote,progress.cancelBootId||progress.gateReceipt?.bootId);
    else {gateReceipt(intent,remote,['draining','quiescent']);check(!remote.stopAuthorized,'upgrade-cancellation-blocked-resume-same-operation');}
    const bootId=progress.cancelBootId||progress.gateReceipt?.bootId||remote.bootId;check(remote.bootId===bootId,'upgrade-cancellation-source-boot-changed');
    progress.cancelBootId=bootId;progress.cancelPreviousPhase??=progress.phase;progress.phase='cancel-intent';await save();
    if(remote.state!=='cancelled'){
      check(typeof maintenance.cancel==='function','upgrade-maintenance-cancel-api-required');
      check(progress.lease.expiresAt>Date.now()/1000+30,'upgrade-machine-lease-expired-resume');
      try{remote=await maintenance.cancel(intent.operationId,{challenge:intent.challenge});}
      catch(error){if(error instanceof CloudSetupError&&error.status===409){check(['maintenance-intent','waiting-for-quiescence','quiescent'].includes(progress.cancelPreviousPhase),'upgrade-cancellation-blocked-resume-same-operation');progress.phase=progress.cancelPreviousPhase;await save();fail('upgrade-cancellation-blocked-resume-same-operation');}throw error;}
    }
    cancelledGate(intent,remote,bootId);check(progress.lease.expiresAt>Date.now()/1000+30,'upgrade-machine-lease-expired-resume');const machine=source(await request('fly',base,{lease}));
    const proof={format:'ink-cloud-upgrade-cancellation-v1',operationId:intent.operationId,intentHash:digest(intent),binding:context.binding,fromGeneration:intent.fromGeneration,fromImages:intent.fromImages,source:{machineId:machine.id,version:machine.instance_id,configHash:digest(normalize(machine.config)),bootId},receipt:remote,cancelledAt:new Date().toISOString()};
    // The operation lock and prior absent-proof read provide exclusivity; atomic
    // replacement keeps a crashed first write from leaving a truncated receipt.
    await writePrivateJSON(join(path,'cancellation.json'),proof);return await finish(proof);
  }catch(error){if(error instanceof CloudSetupError)throw error;throw new CloudSetupError('upgrade-cancellation-failed-resume-same-operation');}
  finally{if(lease){try{await request('fly',base+'/lease',{method:'DELETE',lease});delete progress.lease;await save();}catch{/* Retain uncertain private lease authority for same-operation recovery. */}}await unlock();}
}

async function privateBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); check(info.isFile() && !(info.mode & 0o077) && info.nlink === 1 && (!process.getuid || info.uid === process.getuid()) && info.size <= 128 * 1024, 'upgrade-evidence-file-not-private'); return await handle.readFile(); }
  finally { await handle.close(); }
}

async function bootstrapEvidence(context, intent, machine, paths) {
  check(paths && typeof paths.receipt === 'string' && typeof paths.evidence === 'string', 'upgrade-bootstrap-private-evidence-required');
  const receipt = await readPrivateJSON(paths.receipt), bytes = await privateBytes(paths.evidence); let evidence;
  try { evidence = JSON.parse(bytes); } catch { fail('upgrade-bootstrap-evidence-invalid'); }
  check(receipt.format === 'ink-cloud-bootstrap-quiescence-v1' && receipt.operationId === intent.operationId && receipt.challenge === intent.challenge && receipt.instanceId === intent.binding.instanceId && receipt.machineId === machine.id && receipt.observedVersion === machine.instance_id && same(receipt.fromImages, intent.fromImages) && receipt.evidenceSha256 === sha(bytes) && receipt.limitationAcknowledged === 'external-quiescence-not-automatically-verified' && Number.isFinite(Date.parse(receipt.completedAt)) && Date.parse(receipt.completedAt) >= Date.parse(intent.createdAt) && Date.parse(receipt.completedAt) <= Date.now() + 60000, 'upgrade-bootstrap-receipt-invalid');
  check(evidence.format === 'ink-cloud-bootstrap-observations-v1' && evidence.instanceId === intent.binding.instanceId && Number.isFinite(Date.parse(evidence.observedAt)) && Date.parse(evidence.observedAt) >= Date.parse(intent.createdAt) && Date.parse(evidence.observedAt) <= Date.parse(receipt.completedAt) && zeroActivity(evidence.activity) && evidence.health?.ok === true && evidence.health.instanceId === intent.binding.instanceId && Array.isArray(evidence.pool?.slots) && evidence.pool.slots.length <= 1000 && evidence.pool.slots.every(slot => hex(slot.slotId, 32) && ['module', 'oci'].includes(slot.kind) && slot.status === 'idle' && slot.appId === null && slot.releaseId === null && slot.leaseId === null && slot.inFlight === 0 && Array.isArray(slot.holds) && !slot.holds.length) && new Set(evidence.pool.slots.map(slot => slot.slotId)).size === evidence.pool.slots.length, 'upgrade-bootstrap-quiescence-evidence-invalid');
  return { receipt, evidence, evidenceHash: sha(bytes), evidenceBytes: bytes.toString('base64') };
}

function recordedBootstrap(intent, progress) {
  const saved = progress.bootstrap, receipt = saved?.receipt;
  check(receipt?.format === 'ink-cloud-bootstrap-quiescence-v1' && receipt.operationId === intent.operationId && receipt.challenge === intent.challenge && receipt.instanceId === intent.binding.instanceId && same(receipt.fromImages, intent.fromImages) && receipt.observedVersion === progress.baselineVersion && typeof saved.evidenceBytes === 'string' && saved.evidenceBytes.length <= 180000, 'upgrade-recorded-bootstrap-evidence-invalid');
  const bytes = Buffer.from(saved.evidenceBytes, 'base64');
  check(bytes.toString('base64') === saved.evidenceBytes && sha(bytes) === saved.evidenceHash && receipt.evidenceSha256 === saved.evidenceHash, 'upgrade-recorded-bootstrap-evidence-invalid');
  let evidence; try { evidence = JSON.parse(bytes); } catch { fail('upgrade-recorded-bootstrap-evidence-invalid'); }
  check(same(evidence, saved.observations) && zeroActivity(evidence.activity), 'upgrade-recorded-bootstrap-evidence-invalid'); return evidence;
}

async function stoppedBootstrapPool(context, evidence, request) {
  const inventory = await request('fly', '/apps?org_slug=' + context.config.fly.organization);
  check(Array.isArray(inventory.apps) && inventory.apps.length <= 1000 && !inventory.next_cursor && !inventory.next_token && inventory.has_more !== true && (inventory.total_apps === undefined || inventory.total_apps === inventory.apps.length), 'upgrade-bootstrap-inventory-incomplete');
  const prefix = context.journal.identity.runtimePrefix + '-p-', slots = new Map(evidence.pool.slots.map(slot => [slot.slotId, slot]));
  let observed = 0; const customRuntimeImages = new Set();
  for (const app of inventory.apps.filter(app => app.name?.startsWith(context.journal.identity.runtimePrefix + '-'))) {
    check(app.name.startsWith(prefix) && /^[a-f0-9]{12}(?:-srv)?$/.test(app.name.slice(prefix.length)), 'upgrade-bootstrap-foreign-pool-resource');
    const owner = await request('fly', '/apps/' + app.name);
    check(owner.name === app.name && owner.organization?.slug === context.config.fly.organization, 'upgrade-bootstrap-foreign-pool-resource');
    const machines = await request('fly', '/apps/' + app.name + '/machines');
    check(Array.isArray(machines) && machines.length <= 1, 'upgrade-bootstrap-foreign-pool-resource');
    for (const machine of machines) {
      const slotId = machine.config?.metadata?.ink_pool_slot, slot = slots.get(slotId), backend = app.name.endsWith('-srv');
      check(slot && hex(slotId, 32) && app.name === prefix + slotId.slice(0, 12) + (backend ? '-srv' : '') && (!backend || slot.kind === 'oci') && machine.id === (backend ? slot.backendMachineId : slot.machineId) && machine.name === 'runtime' && !machine.config?.mounts?.length, 'upgrade-bootstrap-foreign-pool-resource');
      check(machine.state === 'stopped', 'upgrade-bootstrap-active-worker-preserved');
      if (!backend) { check(pin(machine.config.image), 'upgrade-bootstrap-runtime-image-unpinned'); if (machine.config.image !== context.current.images.runtime) customRuntimeImages.add(machine.config.image); }
      observed++;
    }
  }
  return { observedStoppedPoolMachines: observed, customRuntimeImages: [...customRuntimeImages].sort() };
}

/** A bounded run advances one durable operation. Waiting never forces jobs or workers.
 * maintenance injection has inspect(), prepare(request), status(operationId),
 * seal(id,{challenge,bootId,fromImages,targetImages}), complete(id,body).
 * Production uses the exact authenticated protocol above; tests may supply deterministic adapters.
 */
export async function runCloudUpgrade(args) {
  const root = await privateDirectory(args.directory), unlock = await acquireCloudLock(root);
  let progress, save, request, base, lease;
  try {
    const context = await state(args), { current, journal, config } = context;
    const op = await operation(context, args.operationId), { intent, path } = op; progress = op.progress;
    check(!op.cancellation&&!['cancel-intent','cancelled'].includes(progress.phase),'upgrade-cancellation-resume-cancel-required');
    check(current.activeOperation === intent.operationId || current.lastOperation === intent.operationId, 'upgrade-operation-not-selected');
    const commit = async receipt => {
      check(receipt.format === 'ink-cloud-upgrade-receipt-v1' && receipt.operationId === intent.operationId && receipt.intentHash === digest(intent) && same(receipt.binding, context.binding) && same(receipt.targetImages, intent.targetImages) && receipt.generation === intent.fromGeneration + 1 && hex(receipt.evidenceSha256), 'upgrade-receipt-mismatch');
      check(current.generation === intent.fromGeneration && same(current.images, intent.fromImages) || current.generation === receipt.generation && current.lastOperation === intent.operationId && same(current.images, intent.targetImages), 'upgrade-current-image-generation-changed');
      const evidence = await readPrivateJSON(join(path, 'evidence.json'));
      check(digest(evidence) === receipt.evidenceSha256 && evidence.operationId === intent.operationId && evidence.intentHash === receipt.intentHash, 'upgrade-lineage-evidence-mismatch');
      Object.assign(current, { generation: receipt.generation, images: intent.targetImages, activeOperation: null, lastOperation: intent.operationId, receiptHash: digest(receipt) });
      await writePrivateJSON(join(root, 'current-images.json'), current); progress.phase = 'complete';
      await writePrivateJSON(join(path, 'progress.json'), progress); return publicOperation(context, intent, progress, receipt);
    };
    const completed = await optional(join(path, 'receipt.json')); if (completed) return commit(completed);
    check(current.generation === intent.fromGeneration && same(current.images, intent.fromImages), 'upgrade-current-image-generation-changed');
    check(args.credentials && Object.keys(args.credentials).length === 1 && typeof args.credentials.flyToken === 'string' && args.credentials.flyToken.length >= 16 && !/[\r\n]/.test(args.credentials.flyToken), 'upgrade-explicit-fly-credential-required');
    request = createCloudTransport({ flyToken: args.credentials.flyToken, fetch: args.fetch });
    save = async phase => { if (phase) progress.phase = phase; await writePrivateJSON(join(path, 'progress.json'), progress); };
    const app = await request('fly', '/apps/' + journal.identity.osApp);
    check(app.name === journal.identity.osApp && app.id === journal.steps['fly-app'].receipt.id && app.organization?.slug === config.fly.organization, 'upgrade-app-ownership-conflict');
    const volumes = await request('fly', '/apps/' + journal.identity.osApp + '/volumes'), volumeId = journal.steps['fly-volume'].receipt.id;
    const volume = Array.isArray(volumes) && volumes.find(volume => volume.id === volumeId);
    check(volume && volume.name === journal.identity.volume && volume.region === config.fly.region && volume.encrypted === true && volume.size_gb === config.fly.volumeGB && volume.state === 'created', 'upgrade-volume-ownership-conflict');
    const machines = await request('fly', '/apps/' + journal.identity.osApp + '/machines');
    check(Array.isArray(machines) && machines.length === 1 && machines[0].id === journal.steps['fly-machine'].receipt.id, 'upgrade-machine-inventory-conflict');
    base = '/apps/' + journal.identity.osApp + '/machines/' + machines[0].id;
    let machine = await request('fly', base);
    const alreadyTarget = machine.config?.metadata?.ink_cloud_upgrade === intent.operationId;
    if (alreadyTarget) {
      check(progress.updateIntent && digest(normalize(machine.config)) === progress.targetConfigHash, 'upgrade-unexpected-target-config');
      ownedMachine(context, machine, intent.targetImages, intent.operationId);
    } else {
      const baseline = ownedMachine(context, machine, intent.fromImages, current.lastOperation);
      const serviceExpected=osMachineConfig(config,journal.identity,journal.steps['fly-volume'].receipt.id);
      const sourceServiceProfile=machineServiceProfile(context,baseline,serviceExpected,current.lastOperation);
      if (intent.mode === 'automatic') check(baseline.env.INK_OS_IMAGE_PIN === intent.fromImages.os, 'upgrade-source-image-provenance-required');
      if (progress.baselineVersion) check(machine.instance_id === progress.baselineVersion && digest(normalize(baseline)) === progress.baselineConfigHash, 'upgrade-source-version-drift');
      else {
        progress.baselineVersion = machine.instance_id; progress.baselineConfigHash = digest(normalize(baseline));
        progress.targetConfig = structuredClone(baseline); progress.targetConfig.image = intent.targetImages.os;
        delete progress.targetConfig.services[0].http_checks;
        progress.targetConfig.services[0].checks=structuredClone(serviceExpected.services[0].checks);
        progress.sourceServiceProfile=sourceServiceProfile;
        Object.assign(progress.targetConfig.env, { INK_OS_IMAGE_PIN: intent.targetImages.os, INK_OS_RUNTIME_IMAGE: intent.targetImages.runtime });
        progress.targetConfig.metadata.ink_cloud_upgrade = intent.operationId;
        progress.targetConfigHash = digest(normalize(progress.targetConfig)); await save();
      }
    }
    ownedMachine(context, { ...machine, image_ref: undefined, config: progress.targetConfig }, intent.targetImages, intent.operationId);
    check(digest(normalize(progress.targetConfig)) === progress.targetConfigHash, 'upgrade-private-target-config-mismatch');
    const secrets = await readPrivateJSON(join(root, 'secrets.json'));
    check(secrets.format === 'ink-cloud-secrets-v1' && same(secrets.identity, journal.identity) && secrets.configHash === journal.configHash && secrets.artifactHash === journal.artifactHash, 'upgrade-private-state-mismatch');
    const maintenance = args.maintenance || createCloudUpgradeMaintenance({ origin: journal.plan.origin, instanceId: journal.identity.id, ownerToken: secrets.ownerToken, fetch: args.fetch });
    if (!progress.gateReceipt && !progress.bootstrap) {
      if (intent.mode === 'external-stopped-bootstrap') {
        check(!alreadyTarget && machine.state === 'stopped', 'upgrade-bootstrap-machine-must-already-be-stopped');
        const external = await bootstrapEvidence(context, intent, machine, args.bootstrapEvidence);
        const pool = await stoppedBootstrapPool(context, external.evidence, request);
        progress.bootstrap = { receipt: external.receipt, evidenceHash: external.evidenceHash, evidenceBytes: external.evidenceBytes, observations: external.evidence, pool }; await save('bootstrap-evidence-recorded');
      } else {
        check(machine.state === 'started', 'upgrade-maintenance-evidence-required-for-stopped-host');
        await maintenance.inspect();
        const input = { format: 'ink-os-maintenance-request-v1', instanceId: journal.identity.id, operationId: intent.operationId, challenge: intent.challenge, fromImages: intent.fromImages, targetImages: intent.targetImages, retireRuntimeImage: intent.fromImages.runtime !== intent.targetImages.runtime };
        await save('maintenance-intent');
        let receipt;
        try { receipt = await maintenance.prepare(input); }
        catch (error) { if (error instanceof CloudSetupError && error.code === 'upgrade-maintenance-api-required') await save('maintenance-unsupported'); throw error; }
        gateReceipt(intent, receipt, ['draining', 'quiescent']);
        if (receipt.state === 'draining') { await save('waiting-for-quiescence'); return publicOperation(context, intent, progress); }
        progress.gateReceipt = receipt; await save('quiescent');
      }
    }
    if (intent.mode === 'automatic' && !alreadyTarget && machine.state === 'started') {
      await maintenance.inspect();
      const stoppedSource = progress.sealIntent && progress.gateReceipt.stopAuthorized === true && ['stop-intent','waiting-for-stopped-machine'].includes(progress.phase);
      const currentReceipt = gateReceipt(intent, await maintenance.status(intent.operationId), stoppedSource ? ['draining','quiescent'] : ['quiescent'], stoppedSource);
      if (currentReceipt.bootId !== progress.gateReceipt.bootId) {
        // Fly may auto-start the same source image when a client reconnects after
        // an authorized stop. Its durable gate must remain sealed and bound to
        // the original request; a fresh quiescence proof precedes another stop.
        check(stoppedSource && currentReceipt.preparedAt === progress.gateReceipt.preparedAt, 'upgrade-host-boot-changed-before-stop');
        if (currentReceipt.state === 'draining') return publicOperation(context, intent, progress);
        const restarts = progress.sourceRestarts || [];
        check(restarts.length < 16, 'upgrade-source-keeps-restarting');
        progress.sourceRestarts = [...restarts, { before: progress.gateReceipt.bootId, receipt: currentReceipt }];
        progress.gateReceipt = currentReceipt; await save();
      }
    }
    if (progress.lease?.expiresAt > Date.now() / 1000 + 60) {
      const found = await request('fly', base + '/lease');
      check(found.data?.nonce === progress.lease.nonce && found.data?.description === 'ink-cloud-upgrade:' + intent.operationId, 'upgrade-machine-lease-foreign'); lease = progress.lease.nonce;
    } else {
      const grant = await request('fly', base + '/lease', { method: 'POST', body: { ttl: 300, description: 'ink-cloud-upgrade:' + intent.operationId } });
      check(typeof grant.data?.nonce === 'string' && grant.data.nonce.length >= 8 && Number.isFinite(grant.data.expires_at) && grant.data.expires_at > Date.now() / 1000 + 60, 'upgrade-private-lease-invalid');
      lease = grant.data.nonce; progress.lease = { nonce: lease, expiresAt: grant.data.expires_at }; await save();
    }
    const mutate = async (path, body) => { check(progress.lease.expiresAt > Date.now() / 1000 + 30, 'upgrade-machine-lease-expired-resume'); return request('fly', path, { method: 'POST', body, lease }); };
    machine = await request('fly', base, { lease });
    if (machine.config?.metadata?.ink_cloud_upgrade !== intent.operationId) {
      ownedMachine(context, machine, intent.fromImages, current.lastOperation);
      check(machine.instance_id === progress.baselineVersion && digest(normalize(machine.config)) === progress.baselineConfigHash, 'upgrade-source-version-drift');
      if (machine.state === 'started') {
        check(intent.mode === 'automatic' && progress.gateReceipt, 'upgrade-bootstrap-machine-must-already-be-stopped');
        // The provider lease does not protect host admission. The source host must
        // durably revoke cancellation before this operation gains stop authority.
        check(typeof maintenance.seal === 'function', 'upgrade-maintenance-seal-api-required');
        progress.sealIntent = true; await save();
        const sealed = gateReceipt(intent, await maintenance.seal(intent.operationId, { challenge: intent.challenge, bootId: progress.gateReceipt.bootId, fromImages: intent.fromImages, targetImages: intent.targetImages }), ['quiescent'], true);
        check(sealed.bootId === progress.gateReceipt.bootId, 'upgrade-host-boot-changed-before-stop');
        progress.gateReceipt = sealed; await save('quiescent');
        await save('stop-intent'); await mutate(base + '/stop', { signal: 'SIGTERM', timeout: '30s' });
        machine = await request('fly', base, { lease });
      }
      if (machine.state !== 'stopped') { await save('waiting-for-stopped-machine'); return publicOperation(context, intent, progress); }
      if (intent.mode === 'automatic') gateReceipt(intent, progress.gateReceipt, ['quiescent'], true);
      if (intent.mode === 'external-stopped-bootstrap') {
        const pool = await stoppedBootstrapPool(context, recordedBootstrap(intent, progress), request);
        check(same(pool, progress.bootstrap.pool), 'upgrade-bootstrap-pool-inventory-changed');
      }
      ownedMachine(context, machine, intent.fromImages, current.lastOperation);
      check(machine.instance_id === progress.baselineVersion && digest(normalize(machine.config)) === progress.baselineConfigHash, 'upgrade-source-version-drift');
      ownedMachine(context, { ...machine, image_ref: undefined, config: progress.targetConfig }, intent.targetImages, intent.operationId);
      check(digest(normalize(progress.targetConfig)) === progress.targetConfigHash, 'upgrade-private-target-config-mismatch');
      progress.updateIntent = true; await save('update-intent');
      await mutate(base, { config: progress.targetConfig, current_version: machine.instance_id, skip_launch: true });
      machine = await request('fly', base, { lease });
    }
    if (intent.mode === 'automatic') gateReceipt(intent, progress.gateReceipt, ['quiescent'], true);
    ownedMachine(context, machine, intent.targetImages, intent.operationId);
    check(progress.updateIntent && digest(normalize(machine.config)) === progress.targetConfigHash && machine.instance_id !== progress.baselineVersion, 'upgrade-target-config-or-version-mismatch');
    progress.updatedVersion = machine.instance_id; await save('target-config-observed');
    if (machine.state === 'stopped') { await save('start-intent'); await mutate(base + '/start'); machine = await request('fly', base, { lease }); }
    if (machine.state !== 'started') { await save('waiting-for-started-machine'); return publicOperation(context, intent, progress); }
    ownedMachine(context, machine, intent.targetImages, intent.operationId);
    check(machine.instance_id === progress.updatedVersion && digest(normalize(machine.config)) === progress.targetConfigHash, 'upgrade-target-config-or-version-mismatch');
    await save('verifying-new-host'); await maintenance.inspect();
    let restarted = null, completion = null;
    if (intent.mode === 'automatic') {
      restarted = gateReceipt(intent, await maintenance.status(intent.operationId), ['restarted', 'complete']);
      check(restarted.bootId !== progress.gateReceipt.bootId, 'upgrade-new-host-boot-not-observed');
      await save('release-maintenance-intent');
      completion = gateReceipt(intent, await maintenance.complete(intent.operationId, { challenge: intent.challenge, targetImages: intent.targetImages }), ['complete']);
      check(completion.bootId === restarted.bootId, 'upgrade-host-boot-changed-during-completion');
    }
    const serviceHealth={sourceProfile:progress.sourceServiceProfile||'not-recorded',sourceMonitoring:progress.sourceServiceProfile?.startsWith('legacy-generation-zero-')?'legacy-health-unverified':'passing-status-not-verified',targetConfiguration:'supported-probe-configured-provider-observed',passingStatusVerified:false};
    const evidence = { format: 'ink-cloud-upgrade-evidence-v1', operationId: intent.operationId, intentHash: digest(intent), provider: { machineId: machine.id, previousVersion: progress.baselineVersion, updatedVersion: machine.instance_id, fromConfigHash: progress.baselineConfigHash, targetConfigHash: progress.targetConfigHash,serviceHealth }, gate: progress.gateReceipt || null, restarted, completion, bootstrap: progress.bootstrap || null };
    await writePrivateJSON(join(path, 'evidence.json'), evidence);
    const receipt = { format: 'ink-cloud-upgrade-receipt-v1', operationId: intent.operationId, intentHash: digest(intent), binding: context.binding, generation: intent.fromGeneration + 1, fromImages: intent.fromImages, targetImages: intent.targetImages, evidenceSha256: digest(evidence), serviceHealth,customRuntimeImages: completion?.pool.customRuntimeImages || progress.bootstrap?.pool.customRuntimeImages || [], completedAt: new Date().toISOString(), verification: intent.mode === 'automatic' ? 'host-restart-and-image-provenance-verified-post-upgrade-runtime-use-pending' : 'bootstrap-applied-with-external-quiescence-attestation-automatic-proof-pending' };
    await writePrivateJSON(join(path, 'receipt.json'), receipt, { exclusive: true }); return await commit(receipt);
  } catch (error) {
    if (error instanceof CloudSetupError) throw error;
    throw new CloudSetupError('upgrade-failed-resume-same-operation');
  } finally {
    if (lease) {
      try { await request('fly', base + '/lease', { method: 'DELETE', lease }); if (progress) { delete progress.lease; await save(); } }
      catch { /* Retained private nonce/expiry permits explicit same-operation recovery; no force. */ }
    }
    await unlock();
  }
}
