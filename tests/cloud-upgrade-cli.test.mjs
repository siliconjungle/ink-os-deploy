import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runCloudCLI } from '../cli/cloud.mjs';
import { readPrivateJSON, writePrivateJSON } from '../lib/cloud-private.mjs';
import { fingerprint, validateCloudConfig } from '../lib/cloud-config.mjs';
import { osMachineConfig } from '../lib/cloud-providers.mjs';
import { verifyCloudSetup } from '../lib/cloud-verification.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const image = (name, digit) => `example.test/${name}@sha256:${digit.repeat(64)}`;
const target = { os: image('os', 'c'), runtime: image('runtime', 'd') };
const management = 'private-explicit-upgrade-management-'.repeat(3), runtime = 'private-saved-runtime-token-'.repeat(3);
const activity = () => Object.fromEntries(['requests', 'writers', 'publications', 'workflows', 'schedules', 'nativeJobs', 'codeTasks', 'poolAssignments', 'poolRequests'].map(key => [key, 0]));

// This is a pre-existing historical generation-0 receipt fixture, not a verifier invocation.
function history(journal) {
  const proof = { format: 'ink-os-cloud-host-proof-v1', status: 'passed', instanceId: journal.identity.id, hostOriginSha256: hash(journal.plan.origin), canaryId: '5'.repeat(32), releaseId: '6'.repeat(32), bundleSha256: '7'.repeat(64), edgeOriginSha256: hash(`https://${'6'.repeat(32)}-inkos.${journal.identity.appDomain}`), backendVerified: true, edgeVerified: true, sourcePrivacyVerified: true, quiescentCleanup: true, appsIncludingArchived: 0, sourceAssetsRemaining: 0, removedBlobs: 1, sourceDeletionAcknowledged: true, restartExternallyAttested: true, restartAttestationSha256: '8'.repeat(64), persistenceAfterRestartHookVerified: true };
  const binding = { format: 'ink-cloud-verifier-binding-v1', instanceId: journal.identity.id, originSha256: hash(journal.plan.origin), configHash: journal.configHash, artifactHash: journal.artifactHash, planHash: fingerprint(journal.plan), sourcesHash: '9'.repeat(64) }, recordedAt = new Date().toISOString(), proofHash = fingerprint(proof);
  journal.verification = { format: 'ink-cloud-verification-receipt-v1', binding, proof, proofHash, recordedAt, receiptHash: fingerprint({ binding, proofHash, recordedAt }) }; journal.status = 'ready';
}

async function fixture(t, { bootstrap = false, oldReady = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-upgrade-cli-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private-state'), platform = join(root, 'selected-platform'), configPath = join(root, 'cloud.json');
  const config = { fly: { organization: 'proof-org', region: 'syd', osImage: image('os', 'a'), runtimeImage: image('runtime', 'b') }, cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.test', tls: 'existing' } };
  await mkdir(join(platform, 'infra/r2'), { recursive: true }); await mkdir(join(platform, 'infra/edge'), { recursive: true });
  for (const path of ['infra/r2/worker.mjs', 'infra/edge/worker.mjs', 'infra/edge/game-assets.mjs']) await writeFile(join(platform, path), 'export default { fixture: true };');
  await writePrivateJSON(configPath, config);
  const common = ['--config', configPath, '--state', directory, '--platform-root', platform];
  const invoke = async (argv, options = {}) => {
    let output = '', errors = '';
    const code = await runCloudCLI({ argv: [...argv, ...common], env: {}, stdout: { write: text => output += text }, stderr: { write: text => errors += text }, ...options });
    return { code, output, errors, result: JSON.parse(output || errors) };
  };
  const planned = await invoke(['plan']); assert.equal(planned.code, 0, planned.errors);
  const journalPath = join(directory, 'journal.json'), journal = await readPrivateJSON(journalPath);
  for (const step of journal.plan.steps) journal.steps[step] = { status: 'done', attempt: '0'.repeat(32), receipt: { id: step === 'fly-app' ? 'app_1' : step === 'fly-volume' ? 'vol_1' : step === 'fly-machine' ? 'machine_1' : step } };
  journal.status = 'acceptance-pending'; journal.storageProof = { stage: 'complete' }; if (oldReady) history(journal);
  await writePrivateJSON(journalPath, journal);
  const secrets = await readPrivateJSON(join(directory, 'secrets.json')); secrets.runtimeFlyToken = runtime; await writePrivateJSON(join(directory, 'secrets.json'), secrets);
  const original = await readFile(journalPath, 'utf8'), model = { calls: [], mutations: [], updates: 0, busy: false, loseUpdate: false, lost: false, gate: null, bootId: '1'.repeat(32), nonce: 'private-upgrade-cli-lease-nonce', machine: { id: 'machine_1', name: journal.identity.machine, region: 'syd', state: bootstrap ? 'stopped' : 'started', instance_id: 'source_version', config: osMachineConfig(validateCloudConfig(config), journal.identity, 'vol_1') } };
  if (!bootstrap) model.machine.config.env.INK_OS_IMAGE_PIN = config.fly.osImage;
  const receipt = () => ({ format: 'ink-os-maintenance-receipt-v1', ...model.gate, bootId: model.bootId, durable: true, admissionClosed: model.gate.state !== 'complete', activity: { ...activity(), nativeJobs: model.busy ? 1 : 0 }, pool: { admissionClosed: !['draining', 'complete'].includes(model.gate.state), active: model.busy ? 1 : 0, held: 0, uncertain: 0, oldRuntimeSlotsRemaining: 0, retired: [], incompatibleRuntimeOverrides: 0, customRuntimeImages: [] } });
  const fetch = async (input, options = {}) => {
    const url = new URL(input), path = url.pathname, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    model.calls.push({ path, method });
    if (url.origin === journal.plan.origin) {
      if (path === '/api/health') { assert.equal(new Headers(options.headers).get('authorization'), null); return Response.json({ ok: true, instanceId: journal.identity.id }); }
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + secrets.ownerToken);
      if (path.endsWith('/prepare')) { model.gate ||= { instanceId: body.instanceId, operationId: body.operationId, challenge: body.challenge, fromImages: body.fromImages, targetImages: body.targetImages, preparedAt: new Date().toISOString(),stopAuthorized:false }; model.gate.state = model.busy ? 'draining' : 'quiescent'; }
      if (path.endsWith('/seal')) { assert.equal(model.gate.state, 'quiescent'); assert.equal(model.busy, false); assert.deepEqual(body, { challenge: model.gate.challenge, bootId: model.bootId, fromImages: model.gate.fromImages, targetImages: model.gate.targetImages }); model.gate.stopAuthorized = true; }
      if (path.endsWith('/cancel')) { assert.equal(model.gate.stopAuthorized,false);assert.deepEqual(body,{challenge:model.gate.challenge});model.gate.state='cancelled';model.gate.completedAt=new Date().toISOString(); }
      if (path.endsWith('/complete')) model.gate.state = 'complete';
      const value=receipt();if(model.gate.state==='cancelled'){value.admissionClosed=false;value.pool.admissionClosed=false;}return Response.json(value);
    }
    assert.equal(url.origin, 'https://api.machines.dev'); assert.equal(options.headers.Authorization, 'Bearer ' + management);
    if (method !== 'GET') model.mutations.push({ path, method });
    const app = '/v1/apps/' + journal.identity.osApp, base = app + '/machines/machine_1';
    if (path === '/v1/apps') return Response.json({ apps: [] });
    if (path === app) return Response.json({ id: 'app_1', name: journal.identity.osApp, organization: { slug: config.fly.organization } });
    if (path === app + '/volumes') return Response.json([{ id: 'vol_1', name: journal.identity.volume, region: 'syd', encrypted: true, size_gb: 10, state: 'created' }]);
    if (path === app + '/machines') return Response.json([model.machine]);
    if (path === base && method === 'GET') return Response.json(model.machine);
    if (path === base + '/lease') return Response.json({ data: method === 'DELETE' ? { ok: true } : { nonce: model.nonce, expires_at: Date.now() / 1000 + 300, description: body?.description } });
    assert.equal(options.headers['fly-machine-lease-nonce'], model.nonce);
    if (path === base + '/stop') { assert.equal(model.gate.state, 'quiescent'); assert.equal(model.gate.stopAuthorized, true); model.machine.state = 'stopped'; return Response.json({ ok: true }); }
    if (path === base && method === 'POST') { assert.equal(body.current_version, model.machine.instance_id); assert.equal(body.skip_launch, true); model.machine.config = body.config; model.machine.instance_id = 'target_version'; model.updates++; if (model.loseUpdate && !model.lost) { model.lost = true; throw Error(management); } return Response.json(model.machine); }
    if (path === base + '/start') { model.machine.state = 'started'; model.bootId = '2'.repeat(32); if (model.gate) model.gate.state = 'restarted'; return Response.json({ previous_state: 'stopped' }); }
    assert.fail('Unexpected fixture route');
  };
  return { root, directory, platform, configPath, config, journalPath, journal, secrets, original, model, fetch, invoke, common };
}

test('upgrade CLI plans/status/abandon are offline and reject unsafe or ambiguous arguments', async t => {
  const f = await fixture(t), offline = () => assert.fail('offline command accessed network');
  const planned = await f.invoke(['upgrade', 'plan', '--os-image', target.os, '--runtime-image', target.runtime], { fetch: offline });
  assert.equal(planned.code, 0, planned.errors); const id = planned.result.upgrade.operationId;
  assert.equal(planned.result.deployment.activeUpgrade.operationId, id);
  assert.equal((await f.invoke(['upgrade', 'status', '--operation', id], { fetch: offline })).result.upgrade.operationId, id);
  for (const args of [[], ['unknown'], ['plan', '--os-image', target.os], ['run'], ['run', '--operation', 'old-app-id'], ['plan', '--os-image', target.os, '--runtime-image', target.runtime, '--mode', 'force'], ['run', '--operation', id, '--token', 'never-print-private-token'], ['run', '--operation', id, '--bootstrap-receipt', '/private/incomplete.json']]) {
    const failed = await f.invoke(['upgrade', ...args], { fetch: offline }); assert.equal(failed.code, 1); assert.ok(!failed.errors.includes('never-print-private-token'));
  }
  assert.equal((await f.invoke(['upgrade', 'abandon', '--operation', id], { fetch: offline })).result.upgrade.status, 'abandoned');
  assert.equal((await f.invoke(['status'], { fetch: offline })).result.deployment.activeUpgrade, null);
  assert.equal(await readFile(f.journalPath, 'utf8'), f.original);
});

test('upgrade run/resume use only explicit Fly env and preserve original readiness as historical after new generation', async t => {
  const f = await fixture(t, { oldReady: true });
  assert.equal((await f.invoke(['status'])).result.deployment.status, 'ready');
  const planned = await f.invoke(['upgrade', 'plan', '--os-image', target.os, '--runtime-image', target.runtime]), id = planned.result.upgrade.operationId;
  assert.equal(planned.result.deployment.status, 'upgrade-in-progress'); assert.equal(planned.result.deployment.acceptance.scope, 'uncommitted-image-transition'); assert.equal(planned.result.deployment.historicalProvisioning.status, 'ready');
  assert.equal((await f.invoke(['upgrade', 'run', '--operation', id], { env: { FLY_API_TOKEN: management }, fetch: () => assert.fail('ambient token was consumed') })).result.error.code, 'upgrade-explicit-fly-credential-required');
  f.model.loseUpdate = true;
  const failed = await f.invoke(['upgrade', 'run', '--operation', id], { env: { INK_CLOUD_FLY_TOKEN: management }, fetch: f.fetch }); assert.equal(failed.code, 1); assert.ok(!failed.errors.includes(management));
  const resumed = await f.invoke(['upgrade', 'resume', '--operation', id], { env: { INK_CLOUD_FLY_TOKEN: management }, fetch: f.fetch }); assert.equal(resumed.code, 0, resumed.errors);
  assert.equal(f.model.updates, 1); const deployment = resumed.result.deployment;
  assert.equal(deployment.generation, 1); assert.deepEqual(deployment.currentImages, target); assert.equal(deployment.status, 'post-upgrade-runtime-use-pending');
  assert.equal(deployment.provisioning.scope, 'historical-original-provisioning'); assert.equal(deployment.historicalProvisioning.status, 'ready');
  assert.equal(deployment.acceptance.pooledBackendCanary, 'pending-for-current-generation'); assert.equal(deployment.acceptance.restartPersistence, 'not-accepted-for-current-generation');
  for (const secret of [management, runtime, f.secrets.ownerToken, f.secrets.environmentKey, f.model.nonce]) assert.ok(!JSON.stringify(resumed.result).includes(secret));
  const count = f.model.calls.length;
  for (const command of [['status'], ['apply'], ['resume'], ['upgrade', 'status'], ['upgrade', 'resume', '--operation', id]]) {
    const result = await f.invoke(command, { fetch: () => assert.fail('completed operation/status must be offline') }); assert.equal(result.code, 0, result.errors); assert.equal(result.result.deployment.status, 'post-upgrade-runtime-use-pending');
  }
  assert.equal(f.model.calls.length, count); assert.equal(await readFile(f.journalPath, 'utf8'), f.original);
  const changed = await f.invoke(['apply'], { env: { INK_CLOUD_RUNTIME_FLY_TOKEN: 'wrong-runtime-'.repeat(4) }, fetch: () => assert.fail('credential comparison is local') }); assert.equal(changed.result.error.code, 'runtime-token-change-requires-explicit-correction');
  assert.equal((await f.invoke(['verify', '--phase', 'run'], { fetch: () => assert.fail('generation 1 cannot run original acceptance') })).result.error.code, 'hosted-verification-original-generation-only');
  await assert.rejects(verifyCloudSetup({ directory: f.directory, config: f.config, artifacts: { storage: { 'worker.mjs': await readFile(join(f.platform, 'infra/r2/worker.mjs'), 'utf8') }, edge: { 'worker.mjs': await readFile(join(f.platform, 'infra/edge/worker.mjs'), 'utf8'), 'game-assets.mjs': await readFile(join(f.platform, 'infra/edge/game-assets.mjs'), 'utf8') } }, platformRoot: f.platform, phase: 'run', fetch: () => assert.fail('direct verification guard must be offline') }), { code: 'hosted-verification-original-generation-only' });
});

test('active gates cannot be abandoned and their transient draining preserves admitted work', async t => {
  const f = await fixture(t), plan = await f.invoke(['upgrade', 'plan', '--os-image', target.os, '--runtime-image', target.runtime]), id = plan.result.upgrade.operationId;
  f.model.busy = true; const waiting = await f.invoke(['upgrade', 'run', '--operation', id], { env: { INK_CLOUD_FLY_TOKEN: management }, fetch: f.fetch });
  assert.equal(waiting.result.upgrade.status, 'waiting-for-quiescence'); assert.equal(f.model.mutations.length, 0);
  assert.equal((await f.invoke(['upgrade', 'abandon', '--operation', id])).result.error.code, 'upgrade-cannot-abandon-active-maintenance');
  const wrongRuntime = await f.invoke(['upgrade', 'resume', '--operation', id], { env: { INK_CLOUD_FLY_TOKEN: management, INK_CLOUD_RUNTIME_FLY_TOKEN: 'wrong-runtime-'.repeat(4) }, fetch: () => assert.fail('runtime input mismatch is offline') });
  assert.equal(wrongRuntime.result.error.code, 'runtime-token-change-requires-explicit-correction');
  f.model.busy = false; assert.equal((await f.invoke(['upgrade', 'resume', '--operation', id], { env: { INK_CLOUD_FLY_TOKEN: management }, fetch: f.fetch })).code, 0);
});

test('explicit CLI cancellation requires private Fly env, retains historical proof and releases only the selected intent',async t=>{
  const f=await fixture(t,{oldReady:true}),plan=await f.invoke(['upgrade','plan','--os-image',target.os,'--runtime-image',target.runtime]),id=plan.result.upgrade.operationId;
  f.model.busy=true;await f.invoke(['upgrade','run','--operation',id],{env:{INK_CLOUD_FLY_TOKEN:management},fetch:f.fetch});
  const absent=await f.invoke(['upgrade','cancel','--operation',id],{env:{FLY_API_TOKEN:management},fetch:()=>assert.fail('ambient credential consumed')});assert.equal(absent.result.error.code,'upgrade-explicit-fly-credential-required');
  for(const args of [['cancel'],['cancel','--operation',id,'--token','never-print-token'],['cancel','--operation',id,'--bootstrap-receipt','/private/evidence']]){const failed=await f.invoke(['upgrade',...args]);assert.equal(failed.code,1);assert.ok(!failed.errors.includes('never-print-token'));}
  const cancelled=await f.invoke(['upgrade','cancel','--operation',id],{env:{INK_CLOUD_FLY_TOKEN:management},fetch:f.fetch});assert.equal(cancelled.code,0,cancelled.errors);
  assert.equal(cancelled.result.upgrade.status,'cancelled');assert.equal(cancelled.result.upgrade.cancellation.liveAudit,'not-performed');assert.equal(cancelled.result.deployment.activeUpgrade,null);assert.equal(cancelled.result.deployment.generation,0);assert.equal(cancelled.result.deployment.status,'ready');assert.equal(f.model.busy,true);assert.equal(f.model.updates,0);
  assert.ok(!f.model.mutations.some(call=>call.path.endsWith('/stop')));assert.equal(await readFile(f.journalPath,'utf8'),f.original);
  for(const secret of[management,runtime,f.secrets.ownerToken,f.model.nonce])assert.ok(!JSON.stringify(cancelled.result).includes(secret));
  const status=await f.invoke(['upgrade','status','--operation',id],{fetch:()=>assert.fail('status accessed network')});assert.equal(status.result.upgrade.status,'cancelled');
  const resumed=await f.invoke(['upgrade','resume','--operation',id],{env:{INK_CLOUD_FLY_TOKEN:management},fetch:()=>assert.fail('cancelled upgrade resumed')});assert.equal(resumed.result.error.code,'upgrade-cancellation-resume-cancel-required');
  const next=await f.invoke(['upgrade','plan','--os-image',target.os,'--runtime-image',target.runtime]);assert.equal(next.code,0,next.errors);assert.notEqual(next.result.upgrade.operationId,id);
});

test('OS-only bootstrap CLI binds private external evidence and labels automatic acceptance pending', async t => {
  const f = await fixture(t, { bootstrap: true, oldReady: true });
  const plan = await f.invoke(['upgrade', 'plan', '--os-image', target.os, '--runtime-image', f.config.fly.runtimeImage, '--mode', 'external-stopped-bootstrap']), op = plan.result.upgrade;
  const evidencePath = join(f.root, 'evidence.json'), receiptPath = join(f.root, 'receipt.json');
  await writePrivateJSON(evidencePath, { format: 'ink-cloud-bootstrap-observations-v1', instanceId: f.journal.identity.id, observedAt: new Date().toISOString(), activity: activity(), health: { ok: true, instanceId: f.journal.identity.id }, pool: { slots: [] } });
  await writePrivateJSON(receiptPath, { format: 'ink-cloud-bootstrap-quiescence-v1', operationId: op.operationId, challenge: op.challenge, instanceId: f.journal.identity.id, machineId: 'machine_1', observedVersion: 'source_version', fromImages: op.fromImages, completedAt: new Date().toISOString(), evidenceSha256: hash(await readFile(evidencePath)), limitationAcknowledged: 'external-quiescence-not-automatically-verified' });
  const result = await f.invoke(['upgrade', 'run', '--operation', op.operationId, '--bootstrap-receipt', receiptPath, '--bootstrap-evidence', evidencePath], { env: { INK_CLOUD_FLY_TOKEN: management }, fetch: f.fetch });
  assert.equal(result.code, 0, result.errors); assert.equal(result.result.deployment.status, 'bootstrap-automatic-proof-pending'); assert.equal(result.result.deployment.historicalProvisioning.status, 'ready');
  assert.equal(result.result.deployment.currentImages.runtime, f.config.fly.runtimeImage); assert.ok(!f.model.mutations.some(call => call.path.endsWith('/stop')));
  const proofPath = join(f.directory, 'upgrades', op.operationId, 'evidence.json'), proof = await readPrivateJSON(proofPath); proof.provider.updatedVersion = 'tampered'; await writePrivateJSON(proofPath, proof);
  const bad = await f.invoke(['status']); assert.equal(bad.code, 1); assert.equal(bad.result.error.code, 'upgrade-lineage-evidence-mismatch');
});
