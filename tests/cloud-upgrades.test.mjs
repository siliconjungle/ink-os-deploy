import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath, stat, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeCloudSetup } from '../lib/cloud-setup.mjs';
import { readPrivateJSON, writePrivateJSON } from '../lib/cloud-private.mjs';
import { CloudSetupError, osMachineConfig, OS_SERVICE_HEALTH_CHECK, normalizeMachineServices } from '../lib/cloud-providers.mjs';
import { planCloudUpgrade, describeCloudUpgrade, runCloudUpgrade, abandonCloudUpgrade, cancelCloudUpgrade, createCloudUpgradeMaintenance, CLOUD_UPGRADE_ACTIVITY } from '../lib/cloud-upgrades.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const zero = () => Object.fromEntries(CLOUD_UPGRADE_ACTIVITY.map(key => [key, 0]));
const image = (name, digit) => `example.test/${name}@sha256:${digit.repeat(64)}`;
const targets = { os: image('os', 'c'), runtime: image('runtime', 'd') };
const flyToken = 'private-upgrade-management-token-'.repeat(3);

test('a sealed source auto-start after a lost stop reply needs fresh quiescence', async t => {
 const f=await fixture(t,{lose:'stop'});
 await assert.rejects(runCloudUpgrade(f.runArgs));
 assert.equal(f.model.stops,1);assert.equal(f.model.updates,0);
 f.model.machine.state='started';f.model.bootId='7'.repeat(32);f.model.gate.state='draining';
 const waiting=await runCloudUpgrade(f.runArgs);
 assert.equal(f.model.stops,1);assert.equal(f.model.updates,0);
 f.model.gate.state='quiescent';
 await runCloudUpgrade(f.runArgs);
 assert.equal(f.model.stops,2);assert.equal(f.model.updates,1);assert.equal(f.model.gate.state,'complete');
});

test('source auto-start recovery refuses a gate without durable stop authority', async t => {
 const f=await fixture(t,{lose:'stop'});await assert.rejects(runCloudUpgrade(f.runArgs));
 f.model.machine.state='started';f.model.bootId='7'.repeat(32);f.model.gate.state='quiescent';f.model.gate.stopAuthorized=false;
 await assert.rejects(runCloudUpgrade(f.runArgs),{code:'upgrade-maintenance-stop-not-authorized'});
 assert.equal(f.model.stops,1);assert.equal(f.model.updates,0);
});
async function fixture(t, { mode = 'automatic', images = targets, stopped = false, pinMissing = false, busy = false, unsupported = false, lose, providerDuration = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-cloud-upgrade-'))); t.after(() => rm(directory, { force: true, recursive: true }));
  const config = { fly: { organization: 'proof-org', region: 'syd', osImage: image('os', 'a'), runtimeImage: image('runtime', 'b') }, cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.test', tls: 'existing' } };
  const artifacts = { storage: { 'worker.mjs': 'export default {};' }, edge: { 'worker.mjs': 'import x from "./game-assets.mjs";export default x;', 'game-assets.mjs': 'export default {};' } };
  const args = { directory, config, artifacts }, plan = await initializeCloudSetup(args), journalPath = join(directory, 'journal.json'), journal = await readPrivateJSON(journalPath);
  for (const step of journal.plan.steps) journal.steps[step] = { status: 'done', attempt: '0'.repeat(32), receipt: { id: step === 'fly-machine' ? 'os_machine_1' : step === 'fly-app' ? 'os_app_1' : step === 'fly-volume' ? 'vol_1' : step } };
  journal.storageProof = { stage: 'complete' }; journal.status = 'acceptance-pending'; await writePrivateJSON(journalPath, journal);
  const originalJournal = await readFile(journalPath, 'utf8'), secrets = await readPrivateJSON(join(directory, 'secrets.json'));
  const model = { machine: { id: 'os_machine_1', name: plan.resources.machine, region: 'syd', state: stopped ? 'stopped' : 'started', instance_id: 'old_version_1', config: osMachineConfig({ ...config, fly: { ...config.fly, volumeGB: 10, memoryMB: 1024 } }, plan.resources, 'vol_1') }, calls: [], mutations: [], updates: 0, stops: 0, starts: 0, seals: 0, lease: null, gate: null, bootId: '1'.repeat(32), activity: zero(), retired: [], slots: [], poolApps: [], poolMachines: new Map(), lost: false };
  model.machine.config.services[0].autostop = false; // Documented Fly normalization of "off".
  model.machine.config.mounts[0] = { ...model.machine.config.mounts[0], encrypted: true, size_gb: 10, name: plan.resources.volume };
  if (!pinMissing) model.machine.config.env.INK_OS_IMAGE_PIN = config.fly.osImage;
  if (busy) model.activity.nativeJobs = 1;
  const receipt = () => ({ format: 'ink-os-maintenance-receipt-v1', ...structuredClone(model.gate), bootId: model.bootId, durable: true, activity: { ...model.activity }, admissionClosed: !['complete','cancelled'].includes(model.gate.state), pool: { admissionClosed: !['complete', 'draining','cancelled'].includes(model.gate.state), active: busy && model.activity.nativeJobs ? 1 : 0, held: 0, uncertain: 0, oldRuntimeSlotsRemaining: model.gate.state === 'draining' ? 1 : 0, retired: [...model.retired], incompatibleRuntimeOverrides: 0, customRuntimeImages: [] } });
  model.cancel = () => { if (model.gate.stopAuthorized) throw new CloudSetupError('maintenance-stop-already-authorized',409); model.gate.state = 'cancelled'; model.gate.completedAt=new Date().toISOString(); };
  const maintenance = {
    inspect: async () => ({ ok: true, instanceId: plan.instanceId }),
    async prepare(input) {
      if (unsupported) throw new CloudSetupError('upgrade-maintenance-api-required');
      assert.equal(input.instanceId, plan.instanceId); assert.equal(input.retireRuntimeImage, input.fromImages.runtime !== input.targetImages.runtime);
      assert.equal(model.machine.config.env.INK_OS_IMAGE_PIN, input.fromImages.os, 'source image comes from env provenance');
      assert.equal(model.machine.config.env.INK_OS_RUNTIME_IMAGE, input.fromImages.runtime);
      if (!model.gate || ['complete','cancelled'].includes(model.gate.state)) model.gate = { instanceId: input.instanceId, operationId: input.operationId, challenge: input.challenge, fromImages: input.fromImages, targetImages: input.targetImages, preparedAt: new Date().toISOString(), stopAuthorized:false };
      assert.equal(model.gate.operationId, input.operationId);
      model.gate.state = Object.values(model.activity).some(Boolean) ? 'draining' : 'quiescent';
      if (model.gate.state === 'quiescent' && input.retireRuntimeImage) model.retired = ['3'.repeat(32)];
      return receipt();
    },
    async status(id) { assert.equal(id, model.gate.operationId); return receipt(); },
    async seal(id, input) {
      assert.ok(model.lease, 'seal follows provider lease acquisition');
      assert.equal(id, model.gate.operationId);
      assert.deepEqual(input, { challenge: model.gate.challenge, bootId: model.bootId, fromImages: model.gate.fromImages, targetImages: model.gate.targetImages });
      if (model.gate.state !== 'quiescent') throw new CloudSetupError('upgrade-maintenance-request-failed', 409);
      assert.ok(Object.values(model.activity).every(value => value === 0));
      model.seals++; model.gate.stopAuthorized = true;
      model.afterSeal?.();
      if (lose === 'seal' && !model.lost) { model.lost = true; throw Error(flyToken); }
      return receipt();
    },
    async cancel(id,input) {
      assert.ok(model.lease);assert.equal(id,model.gate.operationId);assert.deepEqual(input,{challenge:model.gate.challenge});model.beforeCancel?.();model.cancel();await model.afterCancel?.();
      if(lose==='cancel'&&!model.lost){model.lost=true;throw Error(flyToken);}return receipt();
    },
    async complete(id, input) { assert.equal(id, model.gate.operationId); assert.equal(input.challenge, model.gate.challenge); model.gate.state = 'complete'; if (lose === 'complete' && !model.lost) { model.lost = true; throw Error('private echoed token: ' + flyToken); } return receipt(); },
  };
  const provider = async (input, options = {}) => {
    const url = new URL(input), path = url.pathname, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    model.calls.push({ host: url.host, path, method });
    if (url.origin === plan.origin) {
      if (path === '/api/health') { assert.equal(new Headers(options.headers).get('authorization'), null); return Response.json({ ok: true, instanceId: plan.instanceId }); }
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + secrets.ownerToken);
      if (path.endsWith('/prepare')) return Response.json(await maintenance.prepare(body));
      if (path.endsWith('/seal')) return Response.json(await maintenance.seal(path.split('/').at(-2), body));
      if (path.endsWith('/cancel')) return Response.json(await maintenance.cancel(path.split('/').at(-2), body));
      if (path.endsWith('/complete')) return Response.json(await maintenance.complete(path.split('/').at(-2), body));
      return Response.json(await maintenance.status(path.split('/').at(-1)));
    }
    assert.equal(url.origin, 'https://api.machines.dev'); assert.equal(options.headers.Authorization, 'Bearer ' + flyToken);
    if (method !== 'GET') model.mutations.push({ path, method, body });
    const app = '/v1/apps/' + plan.resources.osApp, base = app + '/machines/os_machine_1';
    if (path === '/v1/apps') return Response.json({ apps: model.poolApps });
    if (path === app) return Response.json({ id: 'os_app_1', name: plan.resources.osApp, organization: { slug: config.fly.organization } });
    if (path === app + '/volumes') return Response.json([{ id: 'vol_1', name: plan.resources.volume, region: 'syd', encrypted: true, size_gb: 10, state: 'created' }]);
    if (path === app + '/machines') return Response.json([model.machine]);
    if (path === base && method === 'GET') return Response.json(model.machine);
    if (path === base + '/lease') {
      if (method === 'POST') { assert.equal(body.ttl, 300); model.beforeLease?.(); model.lease = { nonce: 'private-lease-nonce-' + model.calls.length, expires_at: Date.now() / 1000 + 300, description: body.description }; return Response.json({ data: model.lease }); }
      if (method === 'DELETE') { assert.equal(options.headers['fly-machine-lease-nonce'], model.lease.nonce); model.lease = null; return Response.json({ data: { ok: true } }); }
      return Response.json({ data: model.lease });
    }
    if (path === base + '/stop') {
      assert.equal(options.headers['fly-machine-lease-nonce'], model.lease.nonce); assert.equal(model.gate.state, 'quiescent'); assert.equal(model.gate.stopAuthorized, true); assert.ok(Object.values(model.activity).every(value => value === 0));
      assert.deepEqual(body, { signal: 'SIGTERM', timeout: '30s' }); model.stops++; model.machine.state = 'stopped';
      if (lose === 'stop' && !model.lost) { model.lost = true; throw Error(flyToken); } return Response.json({ ok: true });
    }
    if (path === base && method === 'POST') {
      assert.equal(options.headers['fly-machine-lease-nonce'], model.lease.nonce); assert.equal(model.machine.state, 'stopped'); assert.equal(body.current_version, model.machine.instance_id); assert.equal(body.skip_launch, true);
      model.machine.config = structuredClone(body.config); model.machine.instance_id = 'updated_version_' + ++model.updates; model.machine.image_ref = { digest: body.config.image.split('@')[1] };
      if(providerDuration)model.machine.config.services[0].checks[0].grace_period='1m0s';
      if (lose === 'update' && !model.lost) { model.lost = true; throw Error(flyToken); } return Response.json(model.machine);
    }
    if (path === base + '/start') {
      assert.equal(options.headers['fly-machine-lease-nonce'], model.lease.nonce); model.starts++; model.machine.state = 'started'; model.bootId = String(model.starts + 1).repeat(32);
      if (model.gate) model.gate.state = 'restarted';
      if (lose === 'start' && !model.lost) { model.lost = true; throw Error(flyToken); } return Response.json({ previous_state: 'stopped' });
    }
    for (const name of model.poolApps.map(app => app.name)) {
      if (path === '/v1/apps/' + name) return Response.json({ name, organization: { slug: config.fly.organization } });
      if (path === '/v1/apps/' + name + '/machines') return Response.json(model.poolMachines.get(name) || []);
    }
    assert.fail('Unexpected provider fixture path: ' + method + ' ' + path);
  };
  const planned = await planCloudUpgrade({ ...args, images, mode });
  const runArgs = { ...args, operationId: planned.operationId, credentials: { flyToken }, maintenance, fetch: provider };
  const bootstrap = async () => {
    const evidence = { format: 'ink-cloud-bootstrap-observations-v1', instanceId: plan.instanceId, observedAt: new Date().toISOString(), activity: zero(), health: { ok: true, instanceId: plan.instanceId }, pool: { slots: model.slots } }, evidencePath = join(directory, 'external-observations.json');
    await writePrivateJSON(evidencePath, evidence); const bytes = await readFile(evidencePath);
    const receiptPath = join(directory, 'external-receipt.json');
    await writePrivateJSON(receiptPath, { format: 'ink-cloud-bootstrap-quiescence-v1', operationId: planned.operationId, challenge: planned.challenge, instanceId: plan.instanceId, machineId: model.machine.id, observedVersion: model.machine.instance_id, fromImages: planned.fromImages, completedAt: new Date().toISOString(), evidenceSha256: sha(bytes), limitationAcknowledged: 'external-quiescence-not-automatically-verified' });
    return { receipt: receiptPath, evidence: evidencePath };
  };
  return { args, plan, planned, model, runArgs, originalJournal, journalPath, secrets, bootstrap };
}

test('offline upgrade intents bind explicit image pairs, preserve original setup and resume exact plans', async t => {
  const f = await fixture(t);
  const again = await planCloudUpgrade({ ...f.args, images: targets }); assert.equal(again.operationId, f.planned.operationId);
  await assert.rejects(planCloudUpgrade({ ...f.args, images: { ...targets, os: image('os', 'e') } }), { code: 'upgrade-active-operation-must-resume' });
  await assert.rejects(planCloudUpgrade({ ...f.args, images: { ...targets, os: 'example.test/os:latest' } }), { code: 'explicit-pinned-upgrade-image-pair-required' });
  assert.equal(await readFile(f.journalPath, 'utf8'), f.originalJournal); assert.equal((await describeCloudUpgrade(f.args)).generation, 0);
  assert.equal((await stat(join(f.args.directory, 'upgrades', f.planned.operationId, 'intent.json'))).mode & 0o777, 0o600);
});

test('pending local intent writes resume deterministically, while loss of committed lineage never resets to original images', async t => {
  const f = await fixture(t), currentPath = join(f.args.directory, 'current-images.json'), path = join(f.args.directory, 'upgrades', f.planned.operationId);
  const current = await readPrivateJSON(currentPath), intent = await readPrivateJSON(join(path, 'intent.json'));
  current.pendingIntent = intent; await writePrivateJSON(currentPath, current);
  await unlink(join(path, 'intent.json')); await unlink(join(path, 'progress.json'));
  assert.equal((await describeCloudUpgrade(f.args)).status, 'local-intent-write-incomplete-resume-plan');
  await assert.rejects(readFile(join(path, 'intent.json')), { code: 'ENOENT' });
  assert.equal((await planCloudUpgrade({ ...f.args, images: targets })).operationId, f.planned.operationId);
  await runCloudUpgrade(f.runArgs); await unlink(currentPath);
  await assert.rejects(describeCloudUpgrade(f.args), { code: 'upgrade-image-lineage-missing-recovery-required' });
});

test('actual provider transport performs gated lease/CAS stopped update and records separate image lineage', async t => {
  const f = await fixture(t), result = await runCloudUpgrade({ ...f.runArgs, maintenance: undefined });
  assert.equal(result.status, 'complete'); assert.equal(result.generation, 1); assert.deepEqual(result.currentImages, targets);
  assert.match(result.verification, /post-upgrade-runtime-use-pending/); assert.equal(f.model.updates, 1); assert.equal(f.model.stops, 1); assert.equal(f.model.starts, 1);
  assert.equal(f.model.gate.state, 'complete'); assert.deepEqual(f.model.retired, ['3'.repeat(32)]);
  assert.equal(f.model.machine.config.env.INK_OS_IMAGE_PIN, targets.os); assert.equal(f.model.machine.config.env.INK_OS_RUNTIME_IMAGE, targets.runtime);
  assert.equal(await readFile(f.journalPath, 'utf8'), f.originalJournal);
  const publicText = JSON.stringify(result); for (const secret of [flyToken, f.secrets.ownerToken, f.secrets.environmentKey, 'private-lease-nonce']) assert.ok(!publicText.includes(secret));
  const count = f.model.calls.length;
  assert.equal((await runCloudUpgrade({ ...f.args, operationId: f.planned.operationId, fetch: () => assert.fail('completed receipt is historical') })).status, 'complete'); assert.equal(f.model.calls.length, count);
});

test('subsequent upgrades bind current images and generation, while original provisioning stays immutable', async t => {
  const f = await fixture(t); await runCloudUpgrade(f.runArgs);
  const images = { os: image('os', 'e'), runtime: image('runtime', 'f') }, second = await planCloudUpgrade({ ...f.args, images });
  assert.deepEqual(second.fromImages, targets); assert.equal(second.generation, 1);
  const result = await runCloudUpgrade({ ...f.runArgs, operationId: second.operationId });
  assert.equal(result.generation, 2); assert.deepEqual(result.currentImages, images); assert.equal(f.model.updates, 2);
  assert.equal(await readFile(f.journalPath, 'utf8'), f.originalJournal);
});

test('active jobs block before provider mutation and finish naturally before a resumed upgrade', async t => {
  const f = await fixture(t, { busy: true }), waiting = await runCloudUpgrade(f.runArgs);
  assert.equal(waiting.status, 'waiting-for-quiescence'); assert.equal(f.model.mutations.length, 0); assert.equal(f.model.machine.state, 'started');
  assert.equal((await f.runArgs.maintenance.status(f.planned.operationId)).pool.admissionClosed, false, 'admitted job continuations retain pool access while draining');
  f.model.activity.nativeJobs = 0;
  assert.equal((await runCloudUpgrade(f.runArgs)).status, 'complete'); assert.equal(f.model.stops, 1);
  assert.ok(f.model.mutations.every(call => !call.path.endsWith('/suspend') && !(call.method === 'DELETE' && !call.path.endsWith('/lease'))));
});

for (const lose of ['seal', 'stop', 'update', 'start', 'complete']) test('lost ' + lose + ' reply reconciles exact observed machine/config before retry', async t => {
  const f = await fixture(t, { lose }); await assert.rejects(runCloudUpgrade(f.runArgs), error => !error.message.includes(flyToken));
  if (lose === 'seal') { assert.equal(f.model.stops, 0); assert.equal(f.model.updates, 0); assert.equal(f.model.gate.stopAuthorized, true); }
  const result = await runCloudUpgrade(f.runArgs); assert.equal(result.status, 'complete'); assert.equal(f.model.updates, 1); assert.equal(f.model.stops, 1); assert.equal(f.model.starts, 1);
});

test('cancellation winning after initial status but before seal prevents provider stop and update', async t => {
  const f = await fixture(t); f.model.beforeLease = () => f.model.cancel();
  await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-maintenance-request-failed' });
  assert.equal(f.model.gate.state, 'cancelled'); assert.equal(f.model.seals, 0); assert.equal(f.model.stops, 0); assert.equal(f.model.updates, 0);
  assert.equal(f.model.lease, null, 'provider lease is released on seal refusal');
});

test('seal winning permanently refuses source cancellation and is retained in restart evidence', async t => {
  const f = await fixture(t); let cancellationRefused = false;
  f.model.afterSeal = () => { assert.throws(() => f.model.cancel(), { code: 'maintenance-stop-already-authorized' }); cancellationRefused = true; };
  assert.equal((await runCloudUpgrade(f.runArgs)).status, 'complete'); assert.equal(cancellationRefused, true); assert.equal(f.model.stops, 1);
  const evidence = await readPrivateJSON(join(f.args.directory, 'upgrades', f.planned.operationId, 'evidence.json'));
  for (const key of ['gate', 'restarted', 'completion']) assert.equal(evidence[key].stopAuthorized, true);
});

test('missing seal support or malformed authorization never permits stop or stopped-source update', async t => {
  const unsupported = await fixture(t); delete unsupported.runArgs.maintenance.seal;
  await assert.rejects(runCloudUpgrade(unsupported.runArgs), { code: 'upgrade-maintenance-seal-api-required' }); assert.equal(unsupported.model.stops, 0);
  for (const corrupt of [value => delete value.stopAuthorized, value => value.stopAuthorized = false, value => value.stopAuthorized = 'true', value => value.bootId = '9'.repeat(32), value => value.challenge = '9'.repeat(64), value => value.fromImages.os = image('foreign', 'f'), value => value.state = 'cancelled', value => value.durable = false, value => value.activity.requests = 1, value => value.pool.admissionClosed = false]) {
    const f = await fixture(t), seal = f.runArgs.maintenance.seal;
    f.runArgs.maintenance.seal = async (...args) => { const value = await seal(...args); corrupt(value); return value; };
    await assert.rejects(runCloudUpgrade(f.runArgs)); assert.equal(f.model.stops, 0); assert.equal(f.model.updates, 0);
    f.model.machine.state = 'stopped';
    await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-maintenance-stop-not-authorized' }); assert.equal(f.model.updates, 0);
  }
});

test('automatic restart and completion require preserved stop authorization', async t => {
  for (const stage of ['status', 'complete']) {
    const f = await fixture(t), original = f.runArgs.maintenance[stage];
    f.runArgs.maintenance[stage] = async (...args) => { const value = await original(...args); if (['restarted', 'complete'].includes(value.state)) delete value.stopAuthorized; return value; };
    await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-maintenance-stop-not-authorized' });
    assert.equal((await describeCloudUpgrade(f.args)).generation, 0);
  }
});

test('explicit cancellation reconciles a busy source gate without stopping work or changing image lineage',async t=>{
  const f=await fixture(t,{busy:true});await runCloudUpgrade(f.runArgs);
  const result=await cancelCloudUpgrade({...f.runArgs,maintenance:undefined});assert.equal(result.status,'cancelled');assert.equal(result.generation,0);assert.deepEqual(result.currentImages,f.planned.fromImages);assert.equal(result.cancellation.liveAudit,'not-performed');
  assert.equal(f.model.activity.nativeJobs,1);assert.equal(f.model.gate.state,'cancelled');assert.equal(f.model.stops,0);assert.equal(f.model.updates,0);assert.equal(f.model.lease,null);
  assert.ok(f.model.mutations.every(call=>call.path.endsWith('/lease')));assert.equal(await readFile(f.journalPath,'utf8'),f.originalJournal);
  const current=await readPrivateJSON(join(f.args.directory,'current-images.json'));assert.equal(current.activeOperation,null);assert.equal(current.lastOperation,null);assert.equal(current.lastCancellation.operationId,f.planned.operationId);
  assert.equal((await describeCloudUpgrade(f.args)).status,'cancelled');
  const next=await planCloudUpgrade({...f.args,images:targets});assert.notEqual(next.operationId,f.planned.operationId);
  assert.equal((await cancelCloudUpgrade({...f.runArgs,fetch:()=>assert.fail('historical cancellation recovery is offline')})).status,'cancelled');
  assert.equal((await readPrivateJSON(join(f.args.directory,'current-images.json'))).activeOperation,next.operationId);
});

test('unsealed quiescent and ambiguous prepare phases can be explicitly cancelled',async t=>{
  for(const phase of ['quiescent','maintenance-intent']){
    const f=await fixture(t);
    if(phase==='quiescent')f.model.beforeLease=()=>{throw Error('lost before provider lease');};
    else {const prepare=f.runArgs.maintenance.prepare;f.runArgs.maintenance.prepare=async input=>{await prepare(input);throw Error('lost prepare reply');};}
    await assert.rejects(runCloudUpgrade(f.runArgs));delete f.model.beforeLease;
    assert.equal((await describeCloudUpgrade(f.args)).status,phase);
    assert.equal((await cancelCloudUpgrade(f.runArgs)).status,'cancelled');assert.equal(f.model.stops,0);
  }
});

test('lost cancellation replies require explicit cancellation recovery and never restart an upgrade',async t=>{
  const f=await fixture(t,{busy:true,lose:'cancel'});await runCloudUpgrade(f.runArgs);
  await assert.rejects(cancelCloudUpgrade(f.runArgs),{code:'upgrade-cancellation-failed-resume-same-operation'});assert.equal(f.model.gate.state,'cancelled');
  await assert.rejects(runCloudUpgrade(f.runArgs),{code:'upgrade-cancellation-resume-cancel-required'});
  assert.equal((await readPrivateJSON(join(f.args.directory,'current-images.json'))).activeOperation,f.planned.operationId);
  assert.equal((await cancelCloudUpgrade(f.runArgs)).status,'cancelled');assert.equal(f.model.stops,0);assert.equal(f.model.updates,0);
});

test('durable cancellation proof recovers lost local progress/pointer writes and rejects altered history',async t=>{
  const f=await fixture(t,{busy:true});await runCloudUpgrade(f.runArgs);
  const currentPath=join(f.args.directory,'current-images.json'),progressPath=join(f.args.directory,'upgrades',f.planned.operationId,'progress.json'),before=await readPrivateJSON(currentPath),previous=await readPrivateJSON(progressPath);
  await cancelCloudUpgrade(f.runArgs);await writePrivateJSON(currentPath,before);await writePrivateJSON(progressPath,{...previous,phase:'cancel-intent',cancelBootId:f.model.bootId});
  assert.equal((await cancelCloudUpgrade({...f.runArgs,fetch:()=>assert.fail('durable cancellation proof avoids provider calls')})).status,'cancelled');
  const path=join(f.args.directory,'upgrades',f.planned.operationId,'cancellation.json'),proof=await readPrivateJSON(path);proof.source.version='forged';await writePrivateJSON(path,proof);
  await assert.rejects(describeCloudUpgrade(f.args),{code:'upgrade-cancellation-lineage-invalid'});
});

test('seal wins, source drift and ineligible phases cannot clear active cancellation intent',async t=>{
  const sealed=await fixture(t,{lose:'seal'});await assert.rejects(runCloudUpgrade(sealed.runArgs));
  const count=sealed.model.calls.length;await assert.rejects(cancelCloudUpgrade(sealed.runArgs),{code:'upgrade-cancellation-blocked-resume-same-operation'});assert.equal(sealed.model.calls.length,count);
  const race=await fixture(t,{busy:true});await runCloudUpgrade(race.runArgs);race.model.beforeCancel=()=>{race.model.gate.stopAuthorized=true;};
  await assert.rejects(cancelCloudUpgrade(race.runArgs),{code:'upgrade-cancellation-blocked-resume-same-operation'});assert.equal((await describeCloudUpgrade(race.args)).status,'waiting-for-quiescence');assert.equal((await readPrivateJSON(join(race.args.directory,'current-images.json'))).activeOperation,race.planned.operationId);
  for(const change of [model=>model.machine.state='stopped',model=>model.machine.instance_id='new-source-version',model=>model.machine.config.env.EXTRA='foreign']){
    const f=await fixture(t,{busy:true});await runCloudUpgrade(f.runArgs);change(f.model);await assert.rejects(cancelCloudUpgrade(f.runArgs));assert.equal(f.model.gate.state,'draining');assert.equal(f.model.mutations.length,0);
  }
  const drift=await fixture(t,{busy:true});await runCloudUpgrade(drift.runArgs);drift.model.afterCancel=()=>{drift.model.machine.instance_id='changed-during-cancel';};await assert.rejects(cancelCloudUpgrade(drift.runArgs),{code:'upgrade-cancellation-source-drift'});assert.equal((await readPrivateJSON(join(drift.args.directory,'current-images.json'))).activeOperation,drift.planned.operationId);
  const planned=await fixture(t);await assert.rejects(cancelCloudUpgrade(planned.runArgs),{code:'upgrade-cancellation-blocked-resume-same-operation'});assert.equal(planned.model.calls.length,0);
  const bootstrap=await fixture(t,{mode:'external-stopped-bootstrap',images:{os:targets.os,runtime:image('runtime','b')},stopped:true});await assert.rejects(cancelCloudUpgrade(bootstrap.runArgs),{code:'upgrade-cancellation-automatic-source-only'});assert.equal(bootstrap.model.calls.length,0);
});

test('cancelled receipt identity, boot, admission and stop authority must be exact even with active counts',async t=>{
  for(const corrupt of [value=>value.stopAuthorized=true,value=>delete value.stopAuthorized,value=>value.bootId='9'.repeat(32),value=>value.challenge='9'.repeat(64),value=>value.admissionClosed=true,value=>value.pool.admissionClosed=true,value=>value.durable=false,value=>value.activity.nativeJobs=-1,value=>value.targetImages.os=image('foreign','f')]){
    const f=await fixture(t,{busy:true});await runCloudUpgrade(f.runArgs);const cancel=f.runArgs.maintenance.cancel;
    f.runArgs.maintenance.cancel=async(...args)=>{const value=await cancel(...args);corrupt(value);return value;};
    await assert.rejects(cancelCloudUpgrade(f.runArgs),{code:'upgrade-cancellation-receipt-invalid'});assert.equal(f.model.stops,0);assert.equal(f.model.updates,0);
    assert.equal((await readPrivateJSON(join(f.args.directory,'current-images.json'))).activeOperation,f.planned.operationId);
  }
});

test('later-generation cancellation preserves the prior successful image proof and remains historical after another plan',async t=>{
  const f=await fixture(t);await runCloudUpgrade(f.runArgs);const before=await readPrivateJSON(join(f.args.directory,'current-images.json'));
  const second=await planCloudUpgrade({...f.args,images:{os:image('os','e'),runtime:image('runtime','f')}});f.model.activity.nativeJobs=1;
  const args={...f.runArgs,operationId:second.operationId};await runCloudUpgrade(args);assert.equal((await cancelCloudUpgrade(args)).status,'cancelled');
  const after=await readPrivateJSON(join(f.args.directory,'current-images.json'));for(const key of ['generation','images','lastOperation','receiptHash','binding'])assert.deepEqual(after[key],before[key]);
  assert.equal(after.lastCancellation.operationId,second.operationId);f.model.activity.nativeJobs=0;
  const third=await planCloudUpgrade({...f.args,images:{os:image('os','e'),runtime:image('runtime','f')}});assert.equal((await runCloudUpgrade({...f.runArgs,operationId:third.operationId})).generation,2);
  assert.equal((await readPrivateJSON(join(f.args.directory,'current-images.json'))).lastCancellation.operationId,second.operationId);
});

test('cancellation rechecks source under its lease and refuses a changed host boot or owner probe',async t=>{
  const drift=await fixture(t,{busy:true});await runCloudUpgrade(drift.runArgs);drift.model.beforeLease=()=>{drift.model.machine.instance_id='changed-under-lease';};await assert.rejects(cancelCloudUpgrade(drift.runArgs),{code:'upgrade-cancellation-source-drift'});assert.equal(drift.model.gate.state,'draining');assert.equal(drift.model.lease,null);
  const boot=await fixture(t);boot.model.beforeLease=()=>{throw Error('hold before seal');};await assert.rejects(runCloudUpgrade(boot.runArgs));delete boot.model.beforeLease;boot.model.bootId='9'.repeat(32);
  await assert.rejects(cancelCloudUpgrade(boot.runArgs),{code:'upgrade-cancellation-source-boot-changed'});assert.equal(boot.model.gate.state,'quiescent');
  const owner=await fixture(t,{busy:true});await runCloudUpgrade(owner.runArgs);owner.runArgs.maintenance.inspect=async()=>{throw new CloudSetupError('upgrade-host-instance-mismatch');};await assert.rejects(cancelCloudUpgrade(owner.runArgs),{code:'upgrade-host-instance-mismatch'});assert.equal(owner.model.gate.state,'draining');assert.equal(owner.model.lease,null);
});

test('source identity/env/mount/config drift fails closed before maintenance or provider updates', async t => {
  for (const change of [machine => machine.name = 'foreign', machine => machine.config.image = image('os', 'e'), machine => machine.config.env.EXTRA_TOKEN = 'never-forward-secret', machine => machine.config.mounts[0].encrypted = false, machine => machine.config.mounts[0].volume = 'other', machine => machine.config.metadata.ink_os_instance = 'f'.repeat(32), machine => machine.config.init = { exec: ['unexpected'] }]) {
    const f = await fixture(t); change(f.model.machine);
    await assert.rejects(runCloudUpgrade(f.runArgs)); assert.equal(f.model.mutations.length, 0); assert.equal(f.model.gate, null);
  }
});

test('documented empty init/restart/HTTPS defaults normalize without widening executable configuration', async t => {
  const f = await fixture(t);
  f.model.machine.config.init = { exec: null, entrypoint: [], cmd: null, tty: false }; f.model.machine.config.dns = {};
  f.model.machine.config.restart.max_retries = 0; f.model.machine.config.services[0].ports[1].force_https = false;
  assert.equal((await runCloudUpgrade(f.runArgs)).status, 'complete');
});

test('observed legacy generation-zero service schema upgrades the same bootstrap intent to persisted supported health checks',async t=>{
  for(const oldHTTP of [false,true]){
    const f=await fixture(t,{mode:'external-stopped-bootstrap',images:{os:targets.os,runtime:image('runtime','b')},stopped:true,pinMissing:true});
    const service=f.model.machine.config.services[0];delete service.checks;service.force_instance_key=null;
    if(oldHTTP)service.http_checks=[{path:'/api/health',interval:'30s',timeout:'5s',grace_period:'60s',method:'GET'}];
    const original=structuredClone(f.model.machine.config),operation=f.planned.operationId;
    const result=await runCloudUpgrade({...f.runArgs,bootstrapEvidence:await f.bootstrap()});assert.equal(result.operationId,operation);assert.equal(result.generation,1);assert.equal(f.model.stops,0);assert.equal(f.model.updates,1);
    const expected=structuredClone(original);delete expected.services[0].http_checks;expected.services[0].checks=[{...OS_SERVICE_HEALTH_CHECK}];expected.image=targets.os;expected.env.INK_OS_IMAGE_PIN=targets.os;expected.metadata.ink_cloud_upgrade=operation;
    assert.deepEqual(f.model.machine.config,expected);assert.equal(await readFile(f.journalPath,'utf8'),f.originalJournal);
    const receipt=await readPrivateJSON(join(f.args.directory,'upgrades',operation,'receipt.json'));assert.equal(receipt.serviceHealth.sourceMonitoring,'legacy-health-unverified');assert.equal(receipt.serviceHealth.targetConfiguration,'supported-probe-configured-provider-observed');assert.equal(receipt.serviceHealth.passingStatusVerified,false);
  }
});

test('legacy profile rejects altered ports, mounts, services, foreign/default force keys and unknown or changed health checks',async t=>{
  for(const change of [m=>m.config.services[0].force_instance_key='foreign',m=>m.config.services[0].force_instance_key='',m=>m.config.services[0].ports[0].port=81,m=>m.config.services[0].ports[1].handlers=['http'],m=>m.config.services.push(structuredClone(m.config.services[0])),m=>m.config.mounts[0].path='/other',m=>m.config.services[0].checks=[],m=>m.config.services[0].checks=[{...OS_SERVICE_HEALTH_CHECK,path:'/other'}],m=>m.config.services[0].http_checks=[{path:'/foreign'}]]){
    const f=await fixture(t,{mode:'external-stopped-bootstrap',images:{os:targets.os,runtime:image('runtime','b')},stopped:true,pinMissing:true});delete f.model.machine.config.services[0].checks;f.model.machine.config.services[0].force_instance_key=null;change(f.model.machine);
    await assert.rejects(runCloudUpgrade({...f.runArgs,bootstrapEvidence:await f.bootstrap()}));assert.equal(f.model.mutations.length,0);assert.equal(f.model.updates,0);
  }
});

test('missing or unsupported service health is never accepted for provenance-bearing source or generation-one machines',async t=>{
  const source=await fixture(t);delete source.model.machine.config.services[0].checks;source.model.machine.config.services[0].force_instance_key=null;await assert.rejects(runCloudUpgrade(source.runArgs),{code:'upgrade-machine-service-config-conflict'});assert.equal(source.model.mutations.length,0);
  const next=await fixture(t);await runCloudUpgrade(next.runArgs);const planned=await planCloudUpgrade({...next.args,images:{os:image('os','e'),runtime:image('runtime','f')}});delete next.model.machine.config.services[0].checks;const before=next.model.mutations.length;
  await assert.rejects(runCloudUpgrade({...next.runArgs,operationId:planned.operationId}),{code:'upgrade-machine-service-config-conflict'});assert.equal(next.model.mutations.length,before);
});

test('Fly duration serialization canonicalizes only observed 1m0s grace to existing 60s bytes',()=>{
  const services=[{protocol:'tcp',internal_port:4318,autostop:false,checks:[{...OS_SERVICE_HEALTH_CHECK}]}],before=sha(JSON.stringify(services)),wire=structuredClone(services);wire[0].checks[0].grace_period='1m0s';
  assert.deepEqual(normalizeMachineServices(wire),services);assert.equal(sha(JSON.stringify(normalizeMachineServices(services))),before);assert.equal(sha(JSON.stringify(normalizeMachineServices(wire))),before);
  for(const [field,value]of[['grace_period','1m1s'],['grace_period','60ms'],['grace_period',60],['interval','1m0s'],['timeout','1m0s']]){const changed=structuredClone(services);changed[0].checks[0][field]=value;assert.notDeepEqual(normalizeMachineServices(changed),services);}
});

test('lost bootstrap update reply resumes observed normalized target without rewriting saved target config or updating twice',async t=>{
  const f=await fixture(t,{mode:'external-stopped-bootstrap',images:{os:targets.os,runtime:image('runtime','b')},stopped:true,pinMissing:true,lose:'update',providerDuration:true});delete f.model.machine.config.services[0].checks;f.model.machine.config.services[0].force_instance_key=null;
  await assert.rejects(runCloudUpgrade({...f.runArgs,bootstrapEvidence:await f.bootstrap()}));assert.equal(f.model.updates,1);assert.equal(f.model.machine.state,'stopped');assert.equal(f.model.machine.config.services[0].checks[0].grace_period,'1m0s');
  const path=join(f.args.directory,'upgrades',f.planned.operationId,'progress.json'),before=await readPrivateJSON(path);assert.equal(before.targetConfig.services[0].checks[0].grace_period,'60s');
  const result=await runCloudUpgrade(f.runArgs),after=await readPrivateJSON(path);assert.equal(result.status,'complete');assert.equal(f.model.updates,1);assert.equal(f.model.stops,0);assert.equal(f.model.starts,1);assert.equal(after.targetConfigHash,before.targetConfigHash);assert.equal(after.baselineConfigHash,before.baselineConfigHash);assert.deepEqual(after.targetConfig,before.targetConfig);
});

test('version changes under lease and corrupt private target configs never overwrite newer source', async t => {
  const f = await fixture(t); f.model.beforeLease = () => { f.model.machine.instance_id = 'foreign_updated_version'; };
  await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-source-version-drift' }); assert.equal(f.model.stops, 0); assert.equal(f.model.updates, 0);
  const g = await fixture(t, { busy: true }); await runCloudUpgrade(g.runArgs);
  const path = join(g.args.directory, 'upgrades', g.planned.operationId, 'progress.json'), progress = await readPrivateJSON(path);
  progress.targetConfig.env.EXTRA_TOKEN = 'private-value-must-not-be-forwarded'; await writePrivateJSON(path, progress); g.model.activity.nativeJobs = 0;
  await assert.rejects(runCloudUpgrade(g.runArgs), error => !error.message.includes('private-value-must-not-be-forwarded')); assert.equal(g.model.stops, 0); assert.equal(g.model.updates, 0);
  const folder = join(g.args.directory, 'upgrades', g.planned.operationId); await chmod(folder, 0o755);
  await assert.rejects(describeCloudUpgrade(g.args), { code: 'upgrade-state-directory-not-private' }); await chmod(folder, 0o700);
});

test('invalid quiescence and unchanged boot receipts cannot promote an upgrade or stop a busy host', async t => {
  const f = await fixture(t), prepare = f.runArgs.maintenance.prepare;
  f.runArgs.maintenance = { ...f.runArgs.maintenance, prepare: async input => ({ ...await prepare(input), activity: { ...zero(), codeTasks: 1 } }) };
  await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-host-not-quiescent' }); assert.equal(f.model.mutations.length, 0);
  const g = await fixture(t), status = g.runArgs.maintenance.status;
  g.runArgs.maintenance = { ...g.runArgs.maintenance, status: async id => ({ ...await status(id), bootId: '1'.repeat(32) }) };
  await assert.rejects(runCloudUpgrade(g.runArgs), { code: 'upgrade-new-host-boot-not-observed' }); assert.equal((await describeCloudUpgrade(g.args)).generation, 0); assert.equal(g.model.gate.state, 'restarted');
});

test('retiring-global release pins block; intentional custom runtimes are reported with separate compatibility scope', async t => {
  const f = await fixture(t), prepare = f.runArgs.maintenance.prepare;
  f.runArgs.maintenance = { ...f.runArgs.maintenance, prepare: async input => { const receipt = await prepare(input); receipt.pool.incompatibleRuntimeOverrides = 1; return receipt; } };
  await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-incompatible-release-runtime-pin' }); assert.equal(f.model.mutations.length, 0);
  const g = await fixture(t), custom = image('custom-codex-runtime', 'e'), decorate = receipt => ({ ...receipt, pool: { ...receipt.pool, customRuntimeImages: [custom] } }), original = g.runArgs.maintenance;
  g.runArgs.maintenance = { ...original, prepare: async input => decorate(await original.prepare(input)), status: async id => decorate(await original.status(id)), complete: async (id, input) => decorate(await original.complete(id, input)) };
  const result = await runCloudUpgrade(g.runArgs);
  assert.deepEqual(result.customRuntimeImages, [custom]); assert.equal(result.scope, 'os-and-global-pooled-runtime-default'); assert.ok(result.limitations.some(text => text.includes('not rewritten')));
});

test('unsupported old host is never stopped; an untouched intent can be explicitly abandoned', async t => {
  const f = await fixture(t, { unsupported: true }); await assert.rejects(runCloudUpgrade(f.runArgs), { code: 'upgrade-maintenance-api-required' }); assert.equal(f.model.mutations.length, 0);
  assert.equal((await abandonCloudUpgrade({ ...f.args, operationId: f.planned.operationId })).status, 'abandoned');
  const bootstrap = await planCloudUpgrade({ ...f.args, mode: 'external-stopped-bootstrap', images: { os: targets.os, runtime: f.args.config.fly.runtimeImage } });
  assert.notEqual(bootstrap.operationId, f.planned.operationId); assert.ok(bootstrap.limitations.some(text => text.includes('OS-only')));
});

test('bootstrap is explicitly OS-only and requires private evidence plus provider-observed stopped OS/pool', async t => {
  const f = await fixture(t, { mode: 'external-stopped-bootstrap', images: { os: targets.os, runtime: image('runtime', 'b') }, stopped: true, pinMissing: true });
  const evidence = await f.bootstrap(), result = await runCloudUpgrade({ ...f.runArgs, bootstrapEvidence: evidence });
  assert.equal(result.status, 'complete'); assert.match(result.verification, /external-quiescence-attestation-automatic-proof-pending/); assert.equal(f.model.stops, 0); assert.equal(f.model.gate, null); assert.equal(f.model.machine.config.env.INK_OS_RUNTIME_IMAGE, image('runtime', 'b'));
  const g = await fixture(t, { mode: 'external-stopped-bootstrap', images: { os: targets.os, runtime: image('runtime', 'b') } });
  await assert.rejects(runCloudUpgrade({ ...g.runArgs, bootstrapEvidence: await g.bootstrap() }), { code: 'upgrade-bootstrap-machine-must-already-be-stopped' }); assert.equal(g.model.mutations.length, 0);
  await assert.rejects(planCloudUpgrade({ ...g.args, mode: 'external-stopped-bootstrap', images: targets }), /upgrade-active-operation/);
  await assert.rejects(fixture(t, { mode: 'external-stopped-bootstrap' }), { code: 'bootstrap-cannot-upgrade-pooled-runtime' });
});

test('bootstrap inventories stopped custom runtimes without changing any app or worker', async t => {
  const f = await fixture(t, { mode: 'external-stopped-bootstrap', images: { os: targets.os, runtime: image('runtime', 'b') }, stopped: true });
  const slotId = '3'.repeat(32), app = f.plan.resources.runtimePrefix + '-p-' + slotId.slice(0, 12), custom = image('custom-ffmpeg-runtime', 'e');
  f.model.slots.push({ slotId, kind: 'module', status: 'idle', appId: null, releaseId: null, leaseId: null, inFlight: 0, holds: [], machineId: 'pool_machine_1' }); f.model.poolApps.push({ name: app });
  f.model.poolMachines.set(app, [{ id: 'pool_machine_1', name: 'runtime', state: 'stopped', config: { image: custom, metadata: { ink_pool_slot: slotId } } }]);
  const result = await runCloudUpgrade({ ...f.runArgs, bootstrapEvidence: await f.bootstrap() });
  assert.deepEqual(result.customRuntimeImages, [custom]); assert.ok(f.model.mutations.every(call => call.path.includes('/os_machine_1')));
  assert.equal(f.model.poolMachines.get(app)[0].config.image, custom);
});

test('bootstrap preserves running old workers and rejects altered external evidence', async t => {
  const f = await fixture(t, { mode: 'external-stopped-bootstrap', images: { os: targets.os, runtime: image('runtime', 'b') }, stopped: true });
  const slotId = '3'.repeat(32), app = f.plan.resources.runtimePrefix + '-p-' + slotId.slice(0, 12);
  f.model.slots.push({ slotId, kind: 'module', status: 'idle', appId: null, releaseId: null, leaseId: null, inFlight: 0, holds: [], machineId: 'pool_machine_1' }); f.model.poolApps.push({ name: app });
  f.model.poolMachines.set(app, [{ id: 'pool_machine_1', name: 'runtime', state: 'started', config: { metadata: { ink_pool_slot: slotId } } }]);
  const evidence = await f.bootstrap();
  await assert.rejects(runCloudUpgrade({ ...f.runArgs, bootstrapEvidence: evidence }), { code: 'upgrade-bootstrap-active-worker-preserved' }); assert.equal(f.model.mutations.length, 0);
  f.model.poolMachines.get(app)[0].state = 'stopped'; await writeFile(evidence.evidence, 'changed', { mode: 0o600 });
  await assert.rejects(runCloudUpgrade({ ...f.runArgs, bootstrapEvidence: evidence }), { code: 'upgrade-bootstrap-evidence-invalid' }); assert.equal(f.model.mutations.length, 0);
});

test('lost lineage write commits an already executed receipt without updating again, and altered evidence rejects', async t => {
  const f = await fixture(t), initial = await readPrivateJSON(join(f.args.directory, 'current-images.json')); await runCloudUpgrade(f.runArgs);
  await writePrivateJSON(join(f.args.directory, 'current-images.json'), initial); const before = f.model.calls.length;
  assert.equal((await runCloudUpgrade({ ...f.args, operationId: f.planned.operationId })).generation, 1); assert.equal(f.model.calls.length, before);
  const evidencePath = join(f.args.directory, 'upgrades', f.planned.operationId, 'evidence.json'), evidence = await readPrivateJSON(evidencePath); evidence.provider.updatedVersion = 'forged'; await writePrivateJSON(evidencePath, evidence);
  await assert.rejects(describeCloudUpgrade(f.args), { code: 'upgrade-lineage-evidence-mismatch' });
});

test('production maintenance adapter verifies public instance before sending owner authorization', async () => {
  const calls = [], maintenance = createCloudUpgradeMaintenance({ origin: 'https://selected.example.test', instanceId: '1'.repeat(32), ownerToken: 'private-owner-'.repeat(4), fetch: async (url, init) => { calls.push(init); return Response.json({ ok: true, instanceId: 'f'.repeat(32) }); } });
  await assert.rejects(maintenance.prepare({}), { code: 'upgrade-host-instance-mismatch' }); assert.equal(calls.length, 1); assert.equal(calls[0].headers, undefined);
});
