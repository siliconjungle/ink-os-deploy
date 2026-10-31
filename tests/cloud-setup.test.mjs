import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, stat, symlink, realpath, writeFile, unlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeCloudSetup, describeCloudSetup, runCloudSetup, replaceCloudRuntimeCredential, reconcileCloudStep, recoverCloudLock, validateCloudConfig } from '../lib/cloud-setup.mjs';
import { createCloudTransport, osMachineConfig } from '../lib/cloud-providers.mjs';

const config = () => ({ fly: { organization: 'proof-org', region: 'syd', osImage: `example.test/ink/os@sha256:${'a'.repeat(64)}`, runtimeImage: `example.test/ink/runtime@sha256:${'b'.repeat(64)}` }, cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.test', tls: 'order-advanced' } });
const artifacts = () => ({ storage: { 'worker.mjs': 'export default {fetch(){return new Response("storage")}}' }, edge: { 'worker.mjs': 'import x from "./game-assets.mjs"; export default x;', 'game-assets.mjs': 'export default {fetch(){return new Response("edge")}}' } });
const credentials = () => ({ flyToken: 'provision-only-'.repeat(4), cloudflareToken: 'cloudflare-private-'.repeat(4), runtimeFlyToken: 'runtime-only-'.repeat(4) });
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'ink-cloud-proof-'))); t.after(() => rm(path, { force: true, recursive: true })); return path; }
const json = (value, status = 200) => Response.json(value, { status });

function fakeCloud(plan, cfg = config()) {
  const n = plan.resources, state = { calls: [], mutations: [], bucket: null, workers: new Map(), domains: [], dns: [], routes: [], packs: [], app: null, ip: false, volumes: [], secrets: [], machines: [], lost: null, failBefore: null, pendingCertificate: false, healthId: n.id,
    runtimeTokens: new Set([credentials().runtimeFlyToken]), expectedRuntimeToken: credentials().runtimeFlyToken, r2: new Map(), proof: null, apps: [] };
  const cf = value => json({ success: true, result: value });
  const missing = () => json({ error: 'not found' }, 404);
  state.fetch = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? 'GET', path = u.pathname;
    state.calls.push({ host: u.host, path, method, headers: options.headers, body: options.body });
    if (u.host === 'api.cloudflare.com') assert.equal(options.headers.Authorization, `Bearer ${credentials().cloudflareToken}`);
    if (['api.machines.dev', 'api.fly.io'].includes(u.host)) {
      const supplied = options.headers.Authorization.slice(7);
      if (u.host === 'api.machines.dev' && path === '/v1/apps' && method === 'GET') {
        if (supplied !== credentials().flyToken && !state.runtimeTokens.has(supplied)) return json({ error: supplied }, 403);
      } else assert.equal(supplied, credentials().flyToken);
    }
    let body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    const mutation = method !== 'GET' && !(u.host === 'api.fly.io' && !body.query.startsWith('mutation'));
    if (mutation) {
      state.mutations.push({ path, method });
      if (['api.machines.dev', 'api.cloudflare.com', 'api.fly.io'].includes(u.host)) assert.notEqual(method, 'DELETE', 'setup must not delete infrastructure resources');
      if (state.failBefore === path) { state.failBefore = null; return json({ error: credentials().flyToken }, 503); }
    }
    let response;
    if (u.host === 'api.cloudflare.com') {
      if (path === `/client/v4/zones/${cfg.cloudflare.zoneId}`) return cf({ id: cfg.cloudflare.zoneId, name: cfg.cloudflare.zoneName, account: { id: cfg.cloudflare.accountId }, status: 'active', type: 'full' });
      if (path.endsWith('/ssl/certificate_packs')) return cf(state.packs);
      if (path.endsWith('/ssl/certificate_packs/order')) {
        assert.deepEqual(body.hosts, [cfg.cloudflare.zoneName, `*.${n.appDomain}`]);
        state.packs.push({ id: 'certificate_1', hosts: body.hosts, status: state.pendingCertificate ? 'pending_validation' : 'active' }); response = cf(state.packs.at(-1));
      } else if (path.endsWith(`/r2/buckets/${n.bucket}`)) return state.bucket ? cf(state.bucket) : missing();
      else if (path.endsWith('/r2/buckets')) { state.bucket = { name: body.name }; response = cf(state.bucket); }
      else if (path.includes('/workers/scripts/')) {
        const script = path.split('/workers/scripts/')[1].split('/')[0];
        if (path.endsWith('/settings')) return state.workers.has(script) ? cf(state.workers.get(script)) : missing();
        assert.ok(body instanceof FormData); const metadata = JSON.parse(await body.get('metadata').text());
        assert.equal(metadata.main_module, 'worker.mjs'); assert.equal(await body.get('worker.mjs').text(), script === n.storageWorker ? artifacts().storage['worker.mjs'] : artifacts().edge['worker.mjs']);
        if (script === n.edgeWorker) assert.equal(await body.get('game-assets.mjs').text(), artifacts().edge['game-assets.mjs']);
        state.workers.set(script, { ...metadata, bindings: metadata.bindings.map(binding => binding.type === 'secret_text' ? { type: binding.type, name: binding.name } : binding) }); response = cf({ id: script });
      } else if (path.endsWith('/workers/domains')) {
        if (method === 'GET') return cf(state.domains.filter(domain => domain.hostname === u.searchParams.get('hostname')));
        state.domains.push({ ...body, id: `domain_${state.domains.length + 1}` }); response = cf(state.domains.at(-1));
      } else if (path.endsWith('/dns_records')) {
        if (method === 'GET') return cf(state.dns.filter(record => record.name === u.searchParams.get('name')));
        state.dns.push({ ...body, id: 'dns_1' }); response = cf(state.dns.at(-1));
      } else if (path.endsWith('/workers/routes')) {
        if (method === 'GET') return cf(state.routes);
        state.routes.push({ ...body, id: 'route_1' }); response = cf(state.routes.at(-1));
      }
    } else if (u.host === 'api.machines.dev') {
      if (path === '/v1/apps' && method === 'GET') return json({ apps: [] });
      if (path === '/v1/apps' && method === 'POST') { state.app = { id: 'new_fly_app', name: body.app_name, organization: { slug: body.org_slug } }; assert.equal(body.network, n.osApp); response = json(state.app, 201); }
      else if (path === `/v1/apps/${n.osApp}`) return state.app ? json(state.app) : missing();
      else if (path.endsWith('/volumes')) {
        if (method === 'GET') return json(state.volumes);
        state.volumes.push({ ...body, id: 'vol_1', state: 'created' }); response = json(state.volumes.at(-1));
      } else if (path.endsWith('/secrets')) {
        if (method === 'GET') return json({ secrets: state.secrets });
        assert.equal(body.values.FLY_API_TOKEN, state.expectedRuntimeToken);
        assert.ok(!Object.values(body.values).includes(credentials().flyToken));
        state.ownerToken = body.values.INK_OS_ADMIN_TOKEN;
        assert.equal(Buffer.from(body.values.INK_OS_ENV_KEY, 'base64').length, 32);
        state.secrets = Object.keys(body.values).map(name => ({ name, digest: 'not-the-secret' })); response = json({ secrets: state.secrets, version: 1 });
      } else if (path.endsWith('/machines')) {
        if (method === 'GET') return json(state.machines);
        assert.equal(body.config.env.INK_OS_INSTANCE_ID, n.id); assert.equal(body.config.env.INK_OS_R2_BUCKET, n.bucket);
        assert.equal(body.config.env.INK_OS_APP_PREFIX, n.runtimePrefix);
        body.config.mounts=body.config.mounts.map(mount=>({encrypted:true,path:mount.path,size_gb:cfg.fly.volumeGB,volume:mount.volume,name:n.volume}));
        state.machines.push({ ...body, id: 'machine_1', state: 'started' }); response = json(state.machines.at(-1));
      }
    } else if (u.host === 'api.fly.io') {
      if (body.query.startsWith('mutation')) { state.ip = true; response = json({ data: { allocateIpAddress: { app: { sharedIpAddress: '192.0.2.1' } } } }); }
      else return json({ data: { app: { sharedIpAddress: state.ip ? '192.0.2.1' : null } } });
    } else if (u.host === `${n.osApp}.fly.dev`) {
      if (path === '/api/health') return json({ ok: true, instanceId: state.healthId });
      if (state.ownerDenied) return json({ error: 'owner denied' }, 403);
      assert.equal(options.headers.Authorization, `Bearer ${state.ownerToken}`);
      if (path === '/api/v1/apps') { assert.equal(u.searchParams.get('archived'), 'true'); return json(state.apps); }
      if (path === '/api/v1/data' && method === 'POST') { state.proof = { ...body, namespace: 'os', revision: 1, location: '', archived: false }; response = json(state.proof, 201); }
      else if (path.startsWith('/api/v1/data/')) return state.proof?.id === path.split('/').at(-1) ? json(state.proof) : missing();
      else if (path.endsWith('/content')) {
        if (method === 'GET') return new Response(state.corruptProof ? Buffer.from('corrupt') : state.proofBytes);
        assert.equal(body.expected, state.proof.revision);
        state.proofBytes = Buffer.from(body.text); const digest = createHash('sha256').update(state.proofBytes).digest('hex');
        state.r2.set(digest, state.proofBytes); state.proof.location = `r2://${n.bucket}/objects/${digest}`; state.proof.revision++;
        response = json(state.proof);
      } else if (path.startsWith('/api/v1/files/') && method === 'DELETE') {
        if (!u.searchParams.has('permanent')) { state.proof.archived = true; state.proof.revision++; response = json(state.proof); }
        else { assert.equal(state.proof.archived, true); state.r2.delete(state.proof.location.split('/').at(-1)); state.proof = null; response = json({ deleted: true, permanent: true, removedBlobs: 1 });
          if (state.losePurgeResponse) { state.losePurgeResponse = false; throw Error('lost permanent delete response'); } }
      }
    }
    else if (u.host === n.storageDomain) return path === '/_health' ? json({ ok: true }) : state.r2.has(path.split('/').at(-1)) ? new Response(state.r2.get(path.split('/').at(-1))) : missing();
    else if ([n.edgeDomain, `${'0'.repeat(32)}-${n.appHostSuffix || 'inkos'}.${n.appDomain}`].includes(u.host)) return missing();
    if (!response) throw Error(`Unexpected fake provider request: ${method} ${u.host}${path}`);
    if (state.lost === path) { state.lost = null; throw Error(`lost response with echoed ${credentials().flyToken}`); }
    return response;
  };
  return state;
}

test('planning generates isolated fresh identities, pinned images and no credentials; resume binds exact inputs', async t => {
  const path = await directory(t), cfg = config(), args = { directory: path, config: cfg, artifacts: artifacts() };
  const first = await initializeCloudSetup(args), again = await initializeCloudSetup(args);
  assert.deepEqual(again, first); assert.match(first.instanceId, /^[a-f0-9]{32}$/);
  assert.equal(first.tls.mayCreateBillableCertificate, true);
  const other = await initializeCloudSetup({ ...args, directory: await directory(t) }); assert.notEqual(first.instanceId, other.instanceId);
  const secrets = JSON.parse(await readFile(join(path, 'secrets.json')));
  assert.ok(!JSON.stringify(first).includes(secrets.ownerToken)); assert.equal((await stat(join(path, 'secrets.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, 'journal.json'))).mode & 0o777, 0o600);
  await assert.rejects(initializeCloudSetup({ ...args, config: { ...cfg, fly: { ...cfg.fly, region: 'ord' } } }), /inputs-changed/);
  await assert.rejects(initializeCloudSetup({ ...args, artifacts: { ...artifacts(), storage: { 'worker.mjs': 'changed' } } }), /inputs-changed/);
});

test('configuration rejects credential fields, previous resources, mutable images, invalid IDs and domains', () => {
  for (const mutate of [c => c.fly.token = 'secret', c => c.fly.app = 'previous', c => c.fly.osImage = 'example/os:latest', c => c.fly.volumeGB = -1,
    c => c.cloudflare.zoneName = 'https://example.test', c => c.cloudflare.accountId = '../account', c => c.cloudflare.compatibilityDate = '2026-02-30', c => c.cloudflare.tls = 'automatic']) {
    const c = config(); mutate(c); assert.throws(() => validateCloudConfig(c), /Invalid cloud configuration/);
  }
  assert.throws(() => validateCloudConfig({ ...config(), cloudflare: { ...config().cloudflare, tls: undefined } }), /cloudflare.tls/);
});

test('real adapters execute complete setup through fake HTTP, retain private runtime credential, and resume without mutations', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan), progress = [];
  const result = await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch, onProgress: value => progress.push(value) });
  assert.equal(result.status, 'acceptance-pending'); assert.equal(cloud.machines.length, 1); assert.equal(cloud.volumes.length, 1);
  assert.equal(result.acceptance.emptyCatalog, 'passed'); assert.equal(result.acceptance.storageRoundtrip, 'passed-and-cleaned');
  assert.equal(result.acceptance.pooledBackendCanary, 'pending'); assert.equal(cloud.proof, null); assert.equal(cloud.r2.size, 0); assert.deepEqual(cloud.apps, []);
  const count = cloud.mutations.length;
  await runCloudSetup({ ...args, credentials: { flyToken: credentials().flyToken, cloudflareToken: credentials().cloudflareToken }, fetch: cloud.fetch });
  assert.equal(cloud.mutations.length, count);
  const publicBytes = JSON.stringify([result, progress, JSON.parse(await readFile(join(path, 'journal.json')))]);
  const privateSecrets = JSON.parse(await readFile(join(path, 'secrets.json')));
  for (const secret of [...Object.values(credentials()), privateSecrets.ownerToken, privateSecrets.storageToken, privateSecrets.edgeToken, privateSecrets.environmentKey]) assert.ok(!publicBytes.includes(secret));
  assert.equal(privateSecrets.runtimeFlyToken, credentials().runtimeFlyToken);
  const before = cloud.calls.length;
  await assert.rejects(runCloudSetup({ ...args, credentials: { ...credentials(), runtimeFlyToken: 'changed-secret-'.repeat(4) }, fetch: cloud.fetch }), /runtime-token-change/);
  assert.equal(cloud.calls.length, before);
  assert.equal(JSON.parse(await readFile(join(path, 'secrets.json'))).runtimeFlyToken, credentials().runtimeFlyToken);
  assert.ok(!JSON.stringify(osMachineConfig(validateCloudConfig(config()), plan.resources, 'vol_1')).includes(privateSecrets.ownerToken));
});

test('completed apply remains historical and offline after user apps are installed', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch });
  cloud.apps.push({ id: 'f'.repeat(32), title: 'Owner app installed later' });
  const before = await readFile(join(path, 'journal.json'), 'utf8'), calls = cloud.calls.length;
  const status = await runCloudSetup({ ...args, fetch: () => assert.fail('completed provisioning must not replay the empty catalog guard') });
  assert.equal(status.generation, 0); assert.deepEqual(status.currentImages, plan.images); assert.equal(status.activeUpgrade, null);
  assert.equal(status.provisioning.liveAudit, 'not-performed'); assert.equal(status.acceptance.scope, 'historical-provisioning-and-acceptance');
  assert.equal(cloud.calls.length, calls); assert.equal(cloud.apps.length, 1); assert.equal(await readFile(join(path, 'journal.json'), 'utf8'), before);
});

test('lost create response resumes by generated identity without duplicate volume or secret leakage', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  cloud.lost = `/v1/apps/${plan.resources.osApp}/volumes`;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), error => error.code === 'provider-transport-or-response-failed' && !error.message.includes(credentials().flyToken));
  assert.equal(cloud.volumes.length, 1);
  const pending = await describeCloudSetup(args); assert.equal(pending.progress['fly-volume'].status, 'creating');
  const result = await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch });
  assert.equal(result.status, 'acceptance-pending'); assert.equal(cloud.volumes.length, 1);
});

test('absent ambiguous volume is never retried until explicit attempt-bound reconciliation', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  cloud.failBefore = `/v1/apps/${plan.resources.osApp}/volumes`;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /HTTP 503/);
  const before = cloud.mutations.length;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /ambiguous-create-outcome/);
  assert.equal(cloud.mutations.length, before);
  const pending = await describeCloudSetup(args), expectedAttempt = pending.progress['fly-volume'].attempt;
  await assert.rejects(reconcileCloudStep({ ...args, step: 'fly-volume', expectedAttempt: 'wrong', resolution: 'confirmed-not-created' }), /invalid-reconciliation/);
  await reconcileCloudStep({ ...args, step: 'fly-volume', expectedAttempt, resolution: 'confirmed-not-created' });
  assert.equal((await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch })).status, 'acceptance-pending');
});

test('pending advanced certificate is journaled once and resumes only after active coverage', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  cloud.pendingCertificate = true;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /not-ready/);
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /not-ready/);
  assert.equal(cloud.packs.length, 1); assert.equal(cloud.app, null);
  cloud.packs[0].status = 'active';
  assert.equal((await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch })).status, 'acceptance-pending');
});

test('existing TLS mode never purchases certificates, and existing foreign names are never adopted', async t => {
  const path = await directory(t), cfg = config(); cfg.cloudflare.tls = 'existing';
  const args = { directory: path, config: cfg, artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan, cfg);
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /wildcard-certificate-required/);
  assert.ok(!cloud.mutations.some(call => call.path.endsWith('/order')));
  cloud.packs.push({ id: 'external_certificate', hosts: [`*.${plan.resources.appDomain}`], status: 'active' });
  cloud.bucket = { name: plan.resources.bucket };
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /fresh-resource-name-already-exists/);
});

test('completed resources disappearing, foreign DNS/worker/machine drift fail closed without replacement', async t => {
  for (const mutate of [cloud => { cloud.bucket = null; }, cloud => { cloud.dns[0].comment = 'foreign'; }, cloud => { cloud.workers.values().next().value.bindings[0].bucket_name = 'foreign'; }, cloud => { cloud.machines[0].config.metadata.ink_os_instance = 'foreign'; }]) {
    const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
    // Keep provisioning active: completed apply is historical status, not a maintenance audit.
    cloud.healthId = 'not-ready';
    await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /instance-mismatch/);
    cloud.healthId = plan.instanceId; const before = cloud.mutations.length;
    mutate(cloud); await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /drift|conflict/); assert.equal(cloud.mutations.length, before);
    assert.equal((await describeCloudSetup(args)).status, 'attention');
  }
});

test('health rejects wrong OS identity before sending any token to that origin', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  cloud.healthId = 'foreign'; await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /instance-mismatch/);
  assert.ok(cloud.calls.filter(call => call.host === `${plan.resources.osApp}.fly.dev`).every(call => !call.headers.Authorization));
});

test('runtime token authenticates selected org before persistence or resource creation, and explicit correction retains the journal', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  const rejected = 'rejected-runtime-private-'.repeat(3);
  await assert.rejects(runCloudSetup({ ...args, credentials: { ...credentials(), runtimeFlyToken: rejected }, fetch: cloud.fetch }), /HTTP 403/);
  assert.equal(JSON.parse(await readFile(join(path, 'secrets.json'))).runtimeFlyToken, undefined);
  assert.equal(cloud.mutations.length, 0); assert.ok(!JSON.stringify(await describeCloudSetup(args)).includes(rejected));
  cloud.pendingCertificate = true;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /not-ready/);
  const saved = JSON.parse(await readFile(join(path, 'secrets.json'))).runtimeFlyToken;
  await assert.rejects(replaceCloudRuntimeCredential({ ...args, runtimeFlyToken: rejected, fetch: cloud.fetch }), /HTTP 403/);
  assert.equal(JSON.parse(await readFile(join(path, 'secrets.json'))).runtimeFlyToken, saved);
  const corrected = 'corrected-runtime-private-'.repeat(3); cloud.runtimeTokens.add(corrected); cloud.expectedRuntimeToken = corrected;
  const result = await replaceCloudRuntimeCredential({ ...args, runtimeFlyToken: corrected, fetch: cloud.fetch });
  assert.equal(result.instanceId, plan.instanceId); assert.equal(result.acceptance.runtimeCredential.capability, 'inventory-read');
  assert.ok(!JSON.stringify(result).includes(corrected)); cloud.packs[0].status = 'active';
  const ready = await runCloudSetup({ ...args, credentials: { ...credentials(), runtimeFlyToken: corrected }, fetch: cloud.fetch });
  assert.equal(ready.status, 'acceptance-pending');
  await assert.rejects(replaceCloudRuntimeCredential({ ...args, runtimeFlyToken: credentials().runtimeFlyToken, fetch: cloud.fetch }), /rotation-required-after-machine-attempt/);
});

test('owner authentication and genuinely empty catalog are required before storage acceptance', async t => {
  for (const mutate of [cloud => cloud.ownerDenied = true, cloud => cloud.apps = [{ id: 'foreign-installed-app' }]]) {
    const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan); mutate(cloud);
    await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /owner-catalog|fresh-owner-catalog/);
    assert.equal((await describeCloudSetup(args)).acceptance.emptyCatalog, 'pending');
    assert.equal(cloud.calls.some(call => call.path === '/api/v1/data' && call.method === 'POST'), false);
  }
});

test('actual OS storage routes verify exact bytes and resume lost PUT/permanent-delete replies with complete cleanup', async t => {
  for (const kind of ['put', 'purge']) {
    const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
    if (kind === 'put') { const proofId = createHash('sha256').update(`ink-cloud-storage-proof:${plan.instanceId}`).digest('hex').slice(0, 32); cloud.lost = `/api/v1/files/${proofId}/content`; }
    else cloud.losePurgeResponse = true;
    await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /storage-proof/);
    const result = await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch });
    assert.equal(result.acceptance.storageRoundtrip, 'passed-and-cleaned'); assert.equal(result.acceptance.pooledBackendCanary, 'pending');
    assert.equal(cloud.proof, null); assert.equal(cloud.r2.size, 0); assert.deepEqual(cloud.apps, []);
    assert.ok(cloud.calls.some(call => call.path.endsWith('/content') && call.method === 'PUT'));
    assert.ok(cloud.calls.some(call => call.path.endsWith('/content') && call.method === 'GET'));
  }
});

test('storage proof refuses foreign record ownership and byte corruption rather than accepting public health', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), cloud = fakeCloud(plan);
  const proofId = createHash('sha256').update(`ink-cloud-storage-proof:${plan.instanceId}`).digest('hex').slice(0, 32);
  cloud.proof = { id: proofId, kind: 'file', namespace: 'os', revision: 1, title: 'caller-owned-data', tags: [] };
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /storage-proof-ownership-conflict/);
  assert.equal(cloud.calls.some(call => call.method === 'DELETE' || call.path.endsWith('/content') && call.method === 'PUT'), false);
  cloud.proof = null; cloud.corruptProof = true;
  await assert.rejects(runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch }), /storage-proof-byte-mismatch/);
  assert.equal((await describeCloudSetup(args)).acceptance.storageRoundtrip, 'pending'); cloud.corruptProof = false;
  assert.equal((await runCloudSetup({ ...args, credentials: credentials(), fetch: cloud.fetch })).acceptance.storageRoundtrip, 'passed-and-cleaned');
});

test('private state refuses insecure files, symlinks and running locks; crash between secrets/journal preserves keys', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() }, plan = await initializeCloudSetup(args), privateBefore = await readFile(join(path, 'secrets.json'), 'utf8');
  await unlink(join(path, 'journal.json')); const recovered = await initializeCloudSetup(args);
  assert.equal(plan.instanceId, recovered.instanceId); assert.equal(await readFile(join(path, 'secrets.json'), 'utf8'), privateBefore);
  await chmod(join(path, 'journal.json'), 0o644); await assert.rejects(describeCloudSetup(args), /private/); await chmod(join(path, 'journal.json'), 0o600);
  const lock = { nonce: 'a'.repeat(32), pid: process.pid, host: hostname() };
  await writeFile(join(path, 'operation.lock'), JSON.stringify(lock), { mode: 0o600 });
  await assert.rejects(initializeCloudSetup(args), /locked/); await assert.rejects(recoverCloudLock(path, lock.nonce), /still running/); await unlink(join(path, 'operation.lock'));
  const link = join(await directory(t), 'linked'); await symlink(path, link); await assert.rejects(initializeCloudSetup({ ...args, directory: link }), /symbolic links/);
});

test('transport strips provider bodies and network errors, blocks redirects and unbounded responses', async () => {
  for (const response of [() => json({ message: credentials().flyToken }, 401), () => new Response('not json ' + credentials().flyToken), () => { throw Error(credentials().flyToken); }, () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const request = createCloudTransport({ ...credentials(), fetch: async (url, options) => { assert.equal(options.redirect, 'error'); return response(); } });
    await assert.rejects(request('fly', '/apps'), error => !JSON.stringify({ message: error.message, ...error }).includes(credentials().flyToken) && !error.cause);
  }
  const paginated = createCloudTransport({ ...credentials(), fetch: async () => json({ success: true, result: [], result_info: { total_pages: 2 } }) });
  await assert.rejects(paginated('cloudflare', '/accounts/proof/workers/domains'), /pagination-requires-complete-lookup/);
});

test('a missing private key file is never regenerated for an existing journal', async t => {
  const path = await directory(t), args = { directory: path, config: config(), artifacts: artifacts() };
  await initializeCloudSetup(args); const journal = await readFile(join(path, 'journal.json'), 'utf8');
  await unlink(join(path, 'secrets.json'));
  await assert.rejects(initializeCloudSetup(args), { code: 'ENOENT' });
  await assert.rejects(readFile(join(path, 'secrets.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(path, 'journal.json'), 'utf8'), journal);
});


test('explicit shared-zone routing uses existing TLS and DNS read-only with a distinct instance route', async t => {
  const cfg=config();cfg.cloudflare.tls='existing';cfg.cloudflare.appRouting='shared-zone-wildcard';
  const args={directory:await directory(t),config:cfg,artifacts:artifacts()},plan=await initializeCloudSetup(args),cloud=fakeCloud(plan,cfg),n=plan.resources;
  assert.equal(n.appDomain,cfg.cloudflare.zoneName);assert.match(n.appHostSuffix,/^inkos-[a-f0-9]{16}$/);
  assert.equal(plan.tls.mayCreateBillableCertificate,false);assert.equal(plan.sharedWildcardDNS.access,'read-only');
  const shared={id:'shared_dns',name:'*.'+cfg.cloudflare.zoneName,type:'A',content:'192.0.2.8',proxied:true,comment:'existing user resource'};
  cloud.dns.push(structuredClone(shared));cloud.packs.push({id:'zone_certificate',hosts:[cfg.cloudflare.zoneName,'*.'+cfg.cloudflare.zoneName],status:'active'});
  const previousRoute={id:'other_route',pattern:'*-inkos.'+cfg.cloudflare.zoneName+'/*',script:'existing_edge'};cloud.routes.push(structuredClone(previousRoute));
  const result=await runCloudSetup({...args,credentials:credentials(),fetch:cloud.fetch});assert.equal(result.status,'acceptance-pending');
  assert.deepEqual(cloud.dns,[shared]);assert.deepEqual(cloud.routes[0],previousRoute);
  assert.equal(cloud.routes[1].pattern,'*-'+n.appHostSuffix+'.'+n.appDomain+'/*');
  assert.equal(cloud.machines[0].config.env.INK_OS_APP_HOST_SUFFIX,n.appHostSuffix);
  assert.equal(cloud.workers.get(n.edgeWorker).bindings.find(b=>b.name==='APP_HOST_SUFFIX').text,n.appHostSuffix);
  assert.ok(!cloud.mutations.some(m=>m.path.endsWith('/dns_records')||m.path.endsWith('/ssl/certificate_packs/order')));
  const count=cloud.mutations.length;await runCloudSetup({...args,credentials:credentials(),fetch:cloud.fetch});assert.equal(cloud.mutations.length,count);
  // Provider drift belongs to active provisioning; completed apply above is historical status.
  const activeArgs={...args,directory:await directory(t)},activePlan=await initializeCloudSetup(activeArgs),activeCloud=fakeCloud(activePlan,cfg);
  activeCloud.dns.push(structuredClone(shared));activeCloud.packs.push({id:'zone_certificate',hosts:[cfg.cloudflare.zoneName,'*.'+cfg.cloudflare.zoneName],status:'active'});
  activeCloud.healthId='not-ready';await assert.rejects(runCloudSetup({...activeArgs,credentials:credentials(),fetch:activeCloud.fetch}),/instance-mismatch/);activeCloud.healthId=activePlan.instanceId;
  const activeCount=activeCloud.mutations.length;activeCloud.dns[0].content='192.0.2.9';await assert.rejects(runCloudSetup({...activeArgs,credentials:credentials(),fetch:activeCloud.fetch}),/completed-resource-drift/);assert.equal(activeCloud.mutations.length,activeCount);
});

test('shared-zone routing requires existing proxied wildcard and never creates one or purchases certificates', async t => {
  for(const invalid of [{appRouting:'unknown',tls:'existing'},{appRouting:'shared-zone-wildcard',tls:'order-advanced'}])assert.throws(()=>validateCloudConfig({...config(),cloudflare:{...config().cloudflare,...invalid}}),/cloudflare.appRouting/);
  const cfg=config();cfg.cloudflare.tls='existing';cfg.cloudflare.appRouting='shared-zone-wildcard';const args={directory:await directory(t),config:cfg,artifacts:artifacts()},plan=await initializeCloudSetup(args),cloud=fakeCloud(plan,cfg);
  cloud.packs.push({id:'zone_certificate',hosts:['*.'+cfg.cloudflare.zoneName],status:'active'});
  await assert.rejects(runCloudSetup({...args,credentials:credentials(),fetch:cloud.fetch}),/shared-zone-proxied-wildcard-required/);
  assert.equal(cloud.dns.length,0);assert.ok(!cloud.mutations.some(m=>m.path.endsWith('/dns_records')||m.path.endsWith('/ssl/certificate_packs/order')));
});


test('Fly normalized mount facts are accepted while changed volume, path, encryption or extra mounts remain conflicts', async t => {
  for(const mutate of [m=>m.config.mounts[0].volume='foreign_volume',m=>m.config.mounts[0].path='/other',m=>m.config.mounts[0].encrypted=false,m=>m.config.mounts[0].size_gb++,m=>m.config.mounts[0].name='foreign_name',m=>m.config.mounts.push({...m.config.mounts[0],path:'/extra'}),m=>m.config.mounts[0].read_only=true]){
    const args={directory:await directory(t),config:config(),artifacts:artifacts()},plan=await initializeCloudSetup(args),cloud=fakeCloud(plan);
    // Keep provisioning active; normalized mounts were checked before the health gate failed.
    cloud.healthId='not-ready';await assert.rejects(runCloudSetup({...args,credentials:credentials(),fetch:cloud.fetch}),/instance-mismatch/);cloud.healthId=plan.instanceId;mutate(cloud.machines[0]);
    const before=cloud.mutations.length;await assert.rejects(runCloudSetup({...args,credentials:credentials(),fetch:cloud.fetch}),/resource-ownership-or-configuration-conflict/);assert.equal(cloud.mutations.length,before);
  }
});
