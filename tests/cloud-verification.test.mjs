import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, realpath, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { initializeCloudSetup, describeCloudSetup, runCloudSetup } from '../lib/cloud-setup.mjs';
import { verifyCloudSetup } from '../lib/cloud-verification.mjs';
import { readPrivateJSON, writePrivateJSON } from '../lib/cloud-private.mjs';
import { runCloudCLI } from '../cli/cloud.mjs';


const hash = value => createHash('sha256').update(value).digest('hex');
const platformRoot = process.env.INK_OS_TEST_PLATFORM_ROOT ? await realpath(resolve(process.env.INK_OS_TEST_PLATFORM_ROOT)) : null;
const edgeModule = platformRoot ? await import(pathToFileURL(join(platformRoot, 'infra/edge/worker.mjs')).href) : null;
const edgeWorker = edgeModule?.default, sign = edgeModule?.sign;
const integration = (name, run) => test(name, { skip: platformRoot ? false : 'Set INK_OS_TEST_PLATFORM_ROOT to a trusted selected platform checkout for integration fixtures.' }, run);
async function fixture(t, { foreign = false, wrongInstance = false, noAck = false, loseCreate = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-cloud-verification-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { fly: { organization: 'proof-org', region: 'syd', osImage: 'example.test/os@sha256:' + 'a'.repeat(64), runtimeImage: 'example.test/runtime@sha256:' + 'b'.repeat(64) }, cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.test', tls: 'existing', appRouting: 'shared-zone-wildcard' } };
  const [storage, edge, assets] = await Promise.all(['infra/r2/worker.mjs', 'infra/edge/worker.mjs', 'infra/edge/game-assets.mjs'].map(path => readFile(join(platformRoot, path), 'utf8')));
  const artifacts = { storage: { 'worker.mjs': storage }, edge: { 'worker.mjs': edge, 'game-assets.mjs': assets } };
  const args = { directory, config, artifacts, platformRoot }, plan = await initializeCloudSetup(args);
  const journalPath = join(directory, 'journal.json'), initial = await readPrivateJSON(journalPath), secrets = await readPrivateJSON(join(directory, 'secrets.json'));
  for (const step of initial.plan.steps) initial.steps[step] = { status: 'done', attempt: '0'.repeat(32), receipt: { id: step } };
  initial.status = 'acceptance-pending'; initial.storageProof = { stage: 'complete' }; await writePrivateJSON(journalPath, initial);
  const apps = new Map(), records = new Map(), releases = new Map(), objects = new Map(), state = new Map(), calls = [], mutations = [];
  if (foreign) apps.set('f'.repeat(32), { id: 'f'.repeat(32), title: 'Personal data', archived: true, body: JSON.stringify({ slug: 'personal-app' }) });
  let backend, bundle, sourceBytes, sourceAssetId, lost = false, wrapperIntent;
  const env = { EDGE_TOKEN: secrets.edgeToken, APP_DOMAIN: plan.resources.appDomain, APP_HOST_SUFFIX: plan.resources.appHostSuffix, OS_ORIGIN: plan.origin, ASSETS: { get: async key => objects.has(key) ? new Response(objects.get(key)) : null } };
  const invoke = async (appId, input) => {
    const ink = { state: {
      get: async key => ({ value: state.get(key) || null, revision: state.has(key) ? 1 : 0 }),
      set: async (key, value) => { state.set(key, value); const id = hash(appId + '\0state\0' + key).slice(0, 32); records.set(id, { id, namespace: appId, kind: 'state', title: key, body: JSON.stringify(value) }); },
    }, compute: { allowIdle: async () => {} } };
    const response = await backend.fetch(new Request('https://backend.test' + input.path, { method: input.method || 'GET', ...(input.body ? { body: JSON.stringify(input.body), headers: { 'Content-Type': 'application/json' } } : {}) }), { ink });
    return { status: response.status, headers: {}, body: await response.json() };
  };
  const server = createServer(async (request, response) => {
    const json = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      const url = new URL(request.url, plan.origin), path = url.pathname, method = request.method;
      calls.push({ path, method, authorization: request.headers.authorization });
      if (path === '/api/health') return json({ ok: true, instanceId: wrongInstance ? 'f'.repeat(32) : plan.instanceId });
      assert.equal(request.headers.authorization, 'Bearer ' + (path === '/_ink/edge/invoke' ? secrets.edgeToken : secrets.ownerToken));
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      if (path === '/_ink/edge/invoke') return json(await invoke(input.appId, input));
      if (method !== 'GET') mutations.push({ path, method });
      const api = path.slice('/api/v1/'.length);
      if (api === 'apps' && method === 'GET') return json([...apps.values()]);
      if (api === 'runtimes') return json({ slots: [] });
      if (api === 'apps' && method === 'POST') {
        wrapperIntent = await readPrivateJSON(journalPath);
        const id = hash('ink-os-app:' + input.slug).slice(0, 32), app = { id, title: input.title, body: JSON.stringify({ slug: input.slug }) }; apps.set(id, app);
        if (loseCreate && !lost) { lost = true; return response.destroy(); } return json(app, 201);
      }
      const appId = api.split('/')[1], app = apps.get(appId);
      if (api === 'apps/' + appId + '/status') return json({ app, releases: [...releases.values()] });
      if (api.endsWith('/releases') && method === 'POST') {
        bundle = input; sourceBytes = Buffer.from(JSON.stringify(input)); const digest = hash(sourceBytes), id = '2'.repeat(32); sourceAssetId = '6'.repeat(32);
        const record = { id: sourceAssetId, namespace: appId, kind: 'file', tags: ['app-source'], location: 'r2://proof/objects/' + digest }; records.set(sourceAssetId, record); objects.set('objects/' + digest, sourceBytes);
        backend = await import('data:text/javascript;base64,' + input.files.find(file => file.path === 'server/main.mjs').base64);
        const release = { id, body: JSON.stringify({ appId, digest, bundleObjectId: sourceAssetId, bundleLocation: record.location }) }; releases.set(id, release); return json(release, 201);
      }
      if (api.startsWith('runtime/bundle/')) return json(bundle);
      if (api.startsWith('assets/')) { if (!records.has(api.slice(7))) return json({}, 404); response.writeHead(200); return response.end(sourceBytes); }
      if (api.endsWith('/publish')) {
        const releaseId = api.split('/')[3], meta = JSON.parse(releases.get(releaseId).body); app.body = JSON.stringify({ ...JSON.parse(app.body), releaseId });
        objects.set('edge/releases/' + releaseId + '.json', JSON.stringify({ appId, releaseId, digest: meta.digest, backend: bundle.backend, entry: bundle.entry })); return json(app);
      }
      if (api.endsWith('/invoke')) return json(await invoke(appId, input));
      if (api.startsWith('state/')) return json({ value: state.get('hosted-canary') || null });
      if (api.endsWith('/launch')) {
        const releaseId = JSON.parse(app.body).releaseId, origin = 'https://' + releaseId + '-' + plan.resources.appHostSuffix + '.' + plan.resources.appDomain;
        const ticket = await sign({ kind: 'launch', appId, releaseId, exp: Date.now() + 60000 }, secrets.edgeToken);
        return json({ releaseId, origin, url: origin + '/_ink/launch?ticket=' + ticket });
      }
      if (api === 'data') return json([...records.values()].filter(record => record.namespace === url.searchParams.get('namespace')));
      if (api === 'apps/' + appId && method === 'DELETE') {
        if (!url.searchParams.has('permanent')) { app.archived = true; return json(app); }
        apps.delete(appId); records.clear(); releases.clear(); state.clear(); objects.clear();
        if (noAck && !lost) { lost = true; return response.destroy(); }
        return json({ deleted: true, permanent: true, removedBlobs: 1 });
      }
      return json({ error: 'Unimplemented fixture route' }, 404);
    } catch { json({ error: 'Fixture assertion failed' }, 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const local = 'http://127.0.0.1:' + server.address().port;
  env.OS_ORIGIN = local;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== plan.origin) { assert.equal(new Headers(init.headers).get('authorization'), null); return edgeWorker.fetch(new Request(input, init), env); }
    return fetch(local + url.pathname + url.search, init);
  };
  const configPath = join(directory, 'config-input.json'); await writePrivateJSON(configPath, config);
  const cli = async (phase, extra = []) => {
    let output = '', errors = '';
    const status = await runCloudCLI({ argv: ['verify', '--config', configPath, '--state', directory, '--platform-root', platformRoot, '--phase', phase, ...extra], fetch: transport, stdout: { write: value => output += value }, stderr: { write: value => errors += value } });
    return { status, text: output + errors, result: JSON.parse(output || errors) };
  };
  return { args, plan, apps, mutations, calls, secrets, directory, state, journalPath, cli, wrapperIntent: () => structuredClone(wrapperIntent), fetch: transport };
}

integration('actual selected verifier/owner SDK/edge Worker over HTTP records backend proof and leaves restart pending', async t => {
  const f = await fixture(t), result = await f.cli('run');
  assert.equal(result.status, 0, result.text); assert.equal(result.result.deployment.status, 'acceptance-pending');
  assert.equal(result.result.deployment.acceptance.pooledBackendCanary, 'passed'); assert.equal(result.result.deployment.acceptance.restartPersistence, 'pending');
  assert.equal(f.apps.size, 0); assert.ok(f.mutations.some(call => call.path.endsWith('/invoke')));
  for (const secret of [f.secrets.ownerToken, f.secrets.edgeToken]) assert.ok(!result.text.includes(secret));
  const saved = await readPrivateJSON(f.journalPath); assert.equal(saved.verification.proofHash, hash(JSON.stringify(saved.verification.proof)));
  assert.equal((await stat(join(f.directory, 'hosted-verification', saved.verificationAttempt.id, 'proof.json'))).mode & 0o777, 0o600);
  const before = f.calls.length;
  f.apps.set('f'.repeat(32), { title: 'Installed after acceptance' });
  const repeated = await runCloudSetup({ ...f.args, fetch: () => assert.fail('completed apply must be offline') });
  assert.equal(repeated.acceptance.pooledBackendCanary, 'passed'); assert.equal(f.calls.length, before);
  await assert.rejects(verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch }), { code: 'hosted-verification-already-recorded-use-status' });
  assert.equal(f.calls.length, before);
});

integration('prepare-restart binds external receipt and resume observes old state before zero-app cleanup/readiness', async t => {
  const f = await fixture(t); assert.equal((await f.cli('run')).status, 0);
  const originalAttempt = (await readPrivateJSON(f.journalPath)).verificationAttempt.id;
  const pending = await f.cli('prepare-restart');
  assert.equal(pending.status, 0, pending.text); assert.equal(pending.result.verification.status, 'awaiting-restart'); assert.equal(f.apps.size, 1);
  assert.notEqual((await readPrivateJSON(f.journalPath)).verificationAttempt.id, originalAttempt);
  assert.equal(pending.result.deployment.acceptance.installedCanaryApps, 'may-exist-cleanup-pending');
  const receipt = join(f.directory, 'external-restart.json'), input = { format: 'ink-os-cloud-restart-receipt-v1', instanceId: f.plan.instanceId, challenge: pending.result.verification.challenge, completedAt: new Date().toISOString(), evidenceSha256: '9'.repeat(64) };
  await writePrivateJSON(receipt, { ...input, challenge: '0'.repeat(64) });
  const rejected = await f.cli('resume', ['--restart-receipt', receipt]); assert.equal(rejected.status, 1); assert.equal(rejected.result.error.code, 'hosted-verification-restart-receipt-invalid');
  await writePrivateJSON(receipt, { ...input, completedAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await f.cli('resume', ['--restart-receipt', receipt])).result.error.code, 'hosted-verification-restart-receipt-invalid');
  const writes = f.mutations.filter(call => call.path.endsWith('/invoke')).length;
  await writePrivateJSON(receipt, input); const ready = await f.cli('resume', ['--restart-receipt', receipt]);
  assert.equal(ready.status, 0, ready.text); assert.equal(ready.result.deployment.status, 'ready'); assert.equal(ready.result.deployment.acceptance.restartPersistence, 'passed-with-external-attestation');
  assert.equal(f.mutations.filter(call => call.path.endsWith('/invoke')).length, writes + 1); assert.equal(f.apps.size, 0);
  const before = f.calls.length;
  assert.equal((await describeCloudSetup(f.args)).status, 'ready');
  assert.equal((await runCloudSetup({ ...f.args, fetch: () => assert.fail('historical readiness is offline') })).status, 'ready');
  await assert.rejects(runCloudSetup({ ...f.args, credentials: { runtimeFlyToken: 'changed-private-runtime-token-'.repeat(3) }, fetch: () => assert.fail('credential correction is not implicit') }), { code: 'runtime-token-change-requires-explicit-correction' });
  assert.equal((await describeCloudSetup(f.args)).status, 'ready');
  assert.equal(f.calls.length, before);
});

integration('missing restart state is never initialized again, and explicit cleanup does not claim restart success', async t => {
  const f = await fixture(t), pending = await f.cli('prepare-restart');
  const receipt = join(f.directory, 'restart.json'); await writePrivateJSON(receipt, { format: 'ink-os-cloud-restart-receipt-v1', instanceId: f.plan.instanceId, challenge: pending.result.verification.challenge, completedAt: new Date().toISOString(), evidenceSha256: '8'.repeat(64) });
  f.state.clear(); const before = f.mutations.filter(call => call.path.endsWith('/invoke')).length;
  await assert.rejects(verifyCloudSetup({ ...f.args, phase: 'resume', restartReceipt: receipt, fetch: f.fetch }));
  assert.equal(f.state.size, 0); assert.equal(f.mutations.filter(call => call.path.endsWith('/invoke')).length, before + 1);
  assert.equal((await readPrivateJSON(f.journalPath)).verification, undefined);
  const g = await fixture(t); await g.cli('prepare-restart');
  const cleaned = await g.cli('cleanup'); assert.equal(cleaned.status, 0, cleaned.text); assert.equal(g.apps.size, 0);
  assert.equal(cleaned.result.deployment.acceptance.restartPersistence, 'pending'); assert.notEqual(cleaned.result.deployment.status, 'ready');
});

integration('lost wrapper receipt write resumes completed actual-verifier journals without a duplicate canary', async t => {
  const f = await fixture(t); await verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch });
  const intent = f.wrapperIntent(), before = f.mutations.length;
  // Model power loss after the verifier completed but before the outer atomic receipt write.
  await writePrivateJSON(f.journalPath, intent);
  assert.equal((await verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch })).acceptance.pooledBackendCanary, 'passed');
  assert.equal(f.mutations.length, before);
  const g = await fixture(t), pending = await g.cli('prepare-restart'), awaiting = await readPrivateJSON(g.journalPath);
  const receipt = join(g.directory, 'restart.json'); await writePrivateJSON(receipt, { format: 'ink-os-cloud-restart-receipt-v1', instanceId: g.plan.instanceId, challenge: pending.result.verification.challenge, completedAt: new Date().toISOString(), evidenceSha256: '8'.repeat(64) });
  await verifyCloudSetup({ ...g.args, phase: 'resume', restartReceipt: receipt, fetch: g.fetch });
  const mutations = g.mutations.length; await writePrivateJSON(g.journalPath, awaiting);
  assert.equal((await verifyCloudSetup({ ...g.args, phase: 'resume', restartReceipt: receipt, fetch: g.fetch })).status, 'ready');
  assert.equal(g.mutations.length, mutations);
});

integration('wrong instance or nonempty initial catalog blocks mutation, and private proof flags cannot be imported as acceptance', async t => {
  const foreign = await fixture(t, { foreign: true }); await assert.rejects(verifyCloudSetup({ ...foreign.args, phase: 'run', fetch: foreign.fetch }), { code: 'hosted-verifier-ink-cloud-proof-nonempty-catalog' }); assert.equal(foreign.mutations.length, 0);
  const wrong = await fixture(t, { wrongInstance: true }); await assert.rejects(verifyCloudSetup({ ...wrong.args, phase: 'run', fetch: wrong.fetch }), { code: 'hosted-verification-instance-mismatch' }); assert.equal(wrong.calls.filter(call => call.authorization).length, 0);
  const f = await fixture(t); await writePrivateJSON(join(f.directory, 'proof.json'), { status: 'passed', backendVerified: true });
  const result = await verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch }); assert.equal(result.acceptance.pooledBackendCanary, 'passed'); assert.ok(f.mutations.length > 0);
  const journal = await readPrivateJSON(f.journalPath); journal.verification.proof.instanceId = 'f'.repeat(32); await writePrivateJSON(f.journalPath, journal);
  await assert.rejects(describeCloudSetup(f.args), { code: 'invalid-hosted-verification-receipt' });
});

integration('lost create resumes the same verifier-owned canary and no storage acknowledgement means no promoted proof', async t => {
  const f = await fixture(t, { loseCreate: true }); await assert.rejects(verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch }));
  const before = await readPrivateJSON(f.journalPath), id = [...f.apps.keys()][0];
  await verifyCloudSetup({ ...f.args, phase: 'run', fetch: f.fetch }); const after = await readPrivateJSON(f.journalPath);
  assert.equal(after.verificationAttempt.id, before.verificationAttempt.id); assert.equal(after.verification.proof.canaryId, id); assert.equal(f.mutations.filter(call => call.path === '/api/v1/apps' && call.method === 'POST').length, 1);
  const g = await fixture(t, { noAck: true }); await assert.rejects(verifyCloudSetup({ ...g.args, phase: 'run', fetch: g.fetch }));
  await assert.rejects(verifyCloudSetup({ ...g.args, phase: 'run', fetch: g.fetch }), { code: 'hosted-proof-storage-acknowledgement-pending' });
  assert.equal((await readPrivateJSON(g.journalPath)).verification, undefined); assert.equal((await describeCloudSetup(g.args)).acceptance.pooledBackendCanary, 'pending'); assert.equal(g.apps.size, 0);
  assert.equal((await verifyCloudSetup({ ...g.args, phase: 'run', fetch: g.fetch })).acceptance.pooledBackendCanary, 'passed');
});

integration('new selected verifier sources require a new completed attempt and cannot replace an active binding', async t => {
  const f = await fixture(t), selected = join(f.directory, 'selected-platform');
  const files = ['scripts/verify-cloud-host.mjs', 'sdk/src/server.js', 'sdk/src/projects.js', 'sdk/src/workflows.js', 'sdk/src/commands.js', 'sdk/src/live-query.js', 'sdk/src/app-api.js'];
  for (const path of files) {
    const target = join(selected, path); await mkdir(join(target, '..'), { recursive: true });
    const source = await readFile(join(platformRoot, path), 'utf8');
    await writeFile(target, source + (path === 'sdk/src/server.js' ? '\n// Selected revision marker.\n' : ''));
  }
  await verifyCloudSetup({ ...f.args, phase: 'prepare-restart', fetch: f.fetch });
  const before = f.mutations.length;
  await assert.rejects(verifyCloudSetup({ ...f.args, platformRoot: selected, phase: 'cleanup', fetch: f.fetch }), { code: 'hosted-verification-inputs-changed' });
  assert.equal(f.mutations.length, before);
  await verifyCloudSetup({ ...f.args, phase: 'cleanup', fetch: f.fetch });
  const previous = (await readPrivateJSON(f.journalPath)).verificationAttempt.id;
  const result = await verifyCloudSetup({ ...f.args, platformRoot: selected, phase: 'prepare-restart', fetch: f.fetch });
  assert.equal(result.status, 'awaiting-restart');
  assert.notEqual((await readPrivateJSON(f.journalPath)).verificationAttempt.id, previous);
  await verifyCloudSetup({ ...f.args, platformRoot: selected, phase: 'cleanup', fetch: f.fetch });
});
