import { createHash } from 'node:crypto';
import { fingerprint } from './cloud-config.mjs';
import { cloudStorageProof } from './cloud-acceptance.mjs';

export class CloudSetupError extends Error {
  constructor(code, status) { super(`Cloud setup: ${code}${status ? ` (HTTP ${status})` : ''}`); this.code = code; if (status) this.status = status; }
}
const conflict = () => { throw new CloudSetupError('resource-ownership-or-configuration-conflict'); };
const one = values => { if (!Array.isArray(values) || values.length > 1) conflict(); return values[0] ?? null; };
const id = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new CloudSetupError('invalid-resource-identity'); return value; };
const same = (actual, expected) => Object.entries(expected).every(([key, value]) => actual?.[key] === value);
function sameDataMount(actual, expected, config, identity) {
  if (!Array.isArray(actual) || actual.length !== 1) return false;
  const mount = actual[0];
  // Fly reports these volume facts in addition to the submitted mount reference.
  return mount && Object.keys(mount).every(key => ['volume', 'path', 'encrypted', 'size_gb', 'name'].includes(key))
    && same(mount, expected[0])
    && (mount.encrypted === undefined || mount.encrypted === true)
    && (mount.size_gb === undefined || mount.size_gb === config.fly.volumeGB)
    && (mount.name === undefined || mount.name === identity.volume);
}

// Raw provider bodies, headers, response errors and credentials never escape this transport.
export function createCloudTransport({ flyToken, cloudflareToken, fetch: fetcher = globalThis.fetch }) {
  if (typeof fetcher !== 'function') throw new CloudSetupError('explicit-provider-credentials-required');
  return async function request(provider, path, { method = 'GET', body, form, missing = false } = {}) {
    const base = { fly: 'https://api.machines.dev/v1', graphql: 'https://api.fly.io', cloudflare: 'https://api.cloudflare.com/client/v4' }[provider];
    if (!base || !path.startsWith('/') || path.startsWith('//')) throw new CloudSetupError('invalid-provider-path');
    const token = provider === 'cloudflare' ? cloudflareToken : flyToken;
    if (typeof token !== 'string' || token.length < 16 || /[\r\n]/.test(token)) throw new CloudSetupError('explicit-provider-credentials-required');
    let response;
    try {
      response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(form ? { body: form } : {}) });
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new CloudSetupError('provider-request-failed', response.status); }
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new CloudSetupError('provider-response-too-large'); } chunks.push(value); }
      const text = Buffer.concat(chunks).toString('utf8'), result = text ? JSON.parse(text) : {};
      if (provider === 'cloudflare') {
        if (result.success !== true) throw new CloudSetupError('provider-api-rejected-request');
        // Do not mistake a truncated lookup for absence and create/replace an existing resource.
        if (result.result_info && ((result.result_info.total_pages ?? 1) > 1 || (result.result_info.total_count ?? 0) > (result.result_info.count ?? result.result?.length ?? Infinity))) throw new CloudSetupError('provider-pagination-requires-complete-lookup');
        return result.result;
      }
      if (provider === 'graphql') { if (result.errors?.length || !result.data) throw new CloudSetupError('provider-api-rejected-request'); return result.data; }
      return result;
    } catch (error) { if (error instanceof CloudSetupError) throw error; throw new CloudSetupError('provider-transport-or-response-failed'); }
  };
}

// Inventory authentication is a read check only. Actual create/start/lease/backend capability still needs a canary.
export async function validateRuntimeFlyCredential({ token, organization, fetch }) {
  if (typeof organization !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(organization)) throw new CloudSetupError('invalid-runtime-fly-organization');
  const request = createCloudTransport({ flyToken: token, fetch });
  const result = await request('fly', `/apps?org_slug=${organization}`);
  if (!Array.isArray(result.apps)) throw new CloudSetupError('invalid-runtime-fly-inventory-response');
  return { organization, capability: 'inventory-read', backendCanary: 'pending' };
}

export function osMachineConfig(config, identity, volumeId) {
  return { image: config.fly.osImage, env: {
    NODE_ENV: 'production', PORT: '4318', INK_OS_BIND: '0.0.0.0', INK_OS_DATA_DIR: '/data', INK_OS_INSTANCE_ID: identity.id,
    INK_OS_ORIGIN: `https://${identity.osApp}.fly.dev`, FLY_ORG: config.fly.organization, FLY_REGION: config.fly.region,
    INK_OS_APP_PREFIX: identity.runtimePrefix, INK_OS_RUNTIME_IMAGE: config.fly.runtimeImage, INK_OS_HOSTING: 'pool',
    INK_OS_R2_URL: `https://${identity.storageDomain}`, INK_OS_R2_BUCKET: identity.bucket,
    INK_OS_EDGE_URL: `https://${identity.edgeDomain}`, INK_OS_APP_DOMAIN: identity.appDomain,
    ...(identity.appHostSuffix ? { INK_OS_APP_HOST_SUFFIX: identity.appHostSuffix } : {}),
  }, metadata: { ink_os_instance: identity.id }, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: config.fly.memoryMB },
    mounts: [{ volume: volumeId, path: '/data' }], restart: { policy: 'always' },
    services: [{ protocol: 'tcp', internal_port: 4318, autostart: true, autostop: 'off', min_machines_running: 1,
      ports: [{ port: 80, handlers: ['http'], force_https: true }, { port: 443, handlers: ['tls', 'http'] }],
      http_checks: [{ path: '/api/health', interval: '30s', timeout: '5s', grace_period: '60s', method: 'GET' }] }] };
}

// All probes return only allowlisted receipts. A resource with the wrong marker/configuration is never updated.
export function createCloudAdapters({ config, identity: n, artifacts, secrets, credentials, fetch: fetcher = globalThis.fetch }) {
  const request = createCloudTransport({ flyToken: credentials.flyToken, cloudflareToken: credentials.cloudflareToken, fetch: fetcher });
  const cf = config.cloudflare, account = `/accounts/${cf.accountId}`, zone = `/zones/${cf.zoneId}`, app = `/apps/${n.osApp}`;
  const marker = `ink-os:${n.id}`, osOrigin = `https://${n.osApp}.fly.dev`, secretValues = {
    INK_OS_ADMIN_TOKEN: secrets.ownerToken, INK_OS_ENV_KEY: secrets.environmentKey, INK_OS_R2_TOKEN: secrets.storageToken, INK_OS_EDGE_TOKEN: secrets.edgeToken, FLY_API_TOKEN: secrets.runtimeFlyToken,
  };
  const sharedDNS = cf.appRouting === 'shared-zone-wildcard';
  const appRoute = sharedDNS ? `*-${n.appHostSuffix}.${n.appDomain}/*` : `*.${n.appDomain}/*`;
  const hashes = Object.fromEntries(['storage', 'edge'].map(kind => [kind, fingerprint(Object.fromEntries(Object.keys(artifacts[kind]).sort().map(key => [key, fingerprint(artifacts[kind][key])])))]));
  const worker = kind => {
    const name = kind === 'storage' ? n.storageWorker : n.edgeWorker;
    const bindings = [{ type: 'r2_bucket', name: 'ASSETS', bucket_name: n.bucket },
      { type: 'plain_text', name: 'INK_OS_INSTANCE', text: n.id }, { type: 'plain_text', name: 'INK_OS_MODULES', text: hashes[kind] },
      ...(kind === 'storage' ? [{ type: 'secret_text', name: 'STORAGE_TOKEN', text: secrets.storageToken }] : [
        { type: 'secret_text', name: 'EDGE_TOKEN', text: secrets.edgeToken }, { type: 'plain_text', name: 'APP_DOMAIN', text: n.appDomain },
        ...(n.appHostSuffix ? [{ type: 'plain_text', name: 'APP_HOST_SUFFIX', text: n.appHostSuffix }] : []),
        { type: 'plain_text', name: 'OS_ORIGIN', text: osOrigin }])];
    return {
      async probe() {
        const value = await request('cloudflare', `${account}/workers/scripts/${name}/settings`, { missing: true });
        if (!value) return null;
        if (!Array.isArray(value.bindings)) conflict();
        for (const expected of bindings) {
          const actual = value.bindings.find(binding => binding.name === expected.name);
          if (!actual || actual.type !== expected.type || (expected.type !== 'secret_text' && !same(actual, expected))) conflict();
        }
        if (value.compatibility_date !== cf.compatibilityDate) conflict();
        return { id: name, ready: true };
      },
      async create() {
        const form = new FormData();
        form.set('metadata', new Blob([JSON.stringify({ main_module: 'worker.mjs', compatibility_date: cf.compatibilityDate, bindings })], { type: 'application/json' }));
        for (const [filename, source] of Object.entries(artifacts[kind])) form.set(filename, new Blob([source], { type: 'application/javascript+module' }), filename);
        await request('cloudflare', `${account}/workers/scripts/${name}`, { method: 'PUT', form });
      },
    };
  };
  const domain = kind => {
    const hostname = kind === 'storage' ? n.storageDomain : n.edgeDomain, service = kind === 'storage' ? n.storageWorker : n.edgeWorker;
    return {
      async probe() {
        const found = one(await request('cloudflare', `${account}/workers/domains?hostname=${hostname}`));
        if (!found) return null;
        if (!same(found, { hostname, service, zone_id: cf.zoneId, enabled: true })) conflict();
        return { id: id(found.id), ready: true };
      },
      async create() {
        // A Custom Domain must never replace an existing caller-owned DNS record.
        const records = await request('cloudflare', `${zone}/dns_records?name=${hostname}`);
        if (!Array.isArray(records) || records.length) conflict();
        await request('cloudflare', `${account}/workers/domains`, { method: 'PUT', body: { hostname, service, zone_id: cf.zoneId, enabled: true, previews_enabled: false } });
      },
    };
  };
  return {
    async preflight() {
      const zoneInfo = await request('cloudflare', zone);
      if (!same(zoneInfo, { id: cf.zoneId, name: cf.zoneName, status: 'active', type: 'full' }) || zoneInfo.account?.id !== cf.accountId) throw new CloudSetupError('active-full-zone-in-selected-account-required');
      // Does not adopt any returned apps. This verifies that the explicitly selected organization is accessible.
      const apps = await request('fly', `/apps?org_slug=${config.fly.organization}`);
      if (!Array.isArray(apps.apps)) throw new CloudSetupError('invalid-fly-organization-response');
    },
    steps: {
      bucket: {
        async probe() { const found = await request('cloudflare', `${account}/r2/buckets/${n.bucket}`, { missing: true }); if (!found) return null; if (found.name !== n.bucket) conflict(); return { id: n.bucket, ready: true }; },
        async create() { await request('cloudflare', `${account}/r2/buckets`, { method: 'POST', body: { name: n.bucket, storageClass: 'Standard' } }); },
      },
      'storage-worker': worker('storage'), 'edge-worker': worker('edge'), 'storage-domain': domain('storage'), 'edge-domain': domain('edge'),
      'wildcard-tls': {
        adopt: true,
        async probe() {
          const packs = await request('cloudflare', `${zone}/ssl/certificate_packs?status=all`);
          if (!Array.isArray(packs)) throw new CloudSetupError('invalid-certificate-response');
          const relevant = packs.filter(pack => pack.hosts?.includes(`*.${n.appDomain}`));
          const active = relevant.find(pack => pack.status === 'active');
          const found = active ?? one(relevant);
          return found ? { id: id(found.id), ready: found.status === 'active' } : null;
        },
        async create() {
          if (cf.tls !== 'order-advanced') throw new CloudSetupError('active-app-wildcard-certificate-required');
          await request('cloudflare', `${zone}/ssl/certificate_packs/order`, { method: 'POST', body: { type: 'advanced', hosts: [cf.zoneName, `*.${n.appDomain}`], certificate_authority: 'lets_encrypt', validation_method: 'txt', validity_days: 90 } });
        },
      },
      'app-dns': {
        ...(sharedDNS ? { adopt: true } : {}),
        async probe() {
          const found = one(await request('cloudflare', `${zone}/dns_records?name=${encodeURIComponent(`*.${n.appDomain}`)}`));
          if (!found) return null;
          if (sharedDNS) {
            if (found.name !== `*.${n.appDomain}` || !['A', 'AAAA', 'CNAME'].includes(found.type) || found.proxied !== true || typeof found.content !== 'string' || !found.content) conflict();
            return { id: id(found.id), ready: true, shared: true, dependencyHash: fingerprint({ name: found.name, type: found.type, content: found.content, proxied: found.proxied }) };
          }
          if (!same(found, { name: `*.${n.appDomain}`, type: 'AAAA', content: '100::', proxied: true, comment: marker })) conflict();
          return { id: id(found.id), ready: true };
        },
        async create() { if (sharedDNS) throw new CloudSetupError('shared-zone-proxied-wildcard-required'); await request('cloudflare', `${zone}/dns_records`, { method: 'POST', body: { type: 'AAAA', name: `*.${n.appDomain}`, content: '100::', proxied: true, ttl: 1, comment: marker } }); },
      },
      'app-route': {
        async probe() {
          const routes = await request('cloudflare', `${zone}/workers/routes`);
          if (!Array.isArray(routes)) throw new CloudSetupError('invalid-route-response');
          const found = one(routes.filter(route => route.pattern === appRoute));
          if (!found) return null;
          if (found.script !== n.edgeWorker) conflict();
          return { id: id(found.id), ready: true };
        },
        async create() { await request('cloudflare', `${zone}/workers/routes`, { method: 'POST', body: { pattern: appRoute, script: n.edgeWorker } }); },
      },
      'fly-app': {
        async probe() { const found = await request('fly', app, { missing: true }); if (!found) return null; if (found.name !== n.osApp || found.organization?.slug !== config.fly.organization) conflict(); return { id: id(found.id), ready: true }; },
        async create() { await request('fly', '/apps', { method: 'POST', body: { app_name: n.osApp, org_slug: config.fly.organization, network: n.osApp } }); },
      },
      'fly-ip': {
        async probe() { const result = await request('graphql', '/graphql', { method: 'POST', body: { query: 'query($name: String!) { app(name: $name) { sharedIpAddress } }', variables: { name: n.osApp } } }); return result.app?.sharedIpAddress ? { id: n.osApp, ready: true } : null; },
        async create() { await request('graphql', '/graphql', { method: 'POST', body: { query: 'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }', variables: { input: { appId: n.osApp, type: 'shared_v4', region: '' } } } }); },
      },
      'fly-volume': {
        async probe() {
          const values = await request('fly', `${app}/volumes`);
          if (!Array.isArray(values)) throw new CloudSetupError('invalid-volume-response');
          const found = one(values.filter(value => value.name === n.volume));
          if (!found) return null;
          if (!same(found, { region: config.fly.region, size_gb: config.fly.volumeGB, encrypted: true }) || ['destroyed', 'destroying'].includes(found.state)) conflict();
          return { id: id(found.id), ready: found.state === 'created' };
        },
        async create() { await request('fly', `${app}/volumes`, { method: 'POST', body: { name: n.volume, region: config.fly.region, size_gb: config.fly.volumeGB, encrypted: true, auto_backup_enabled: true, snapshot_retention: 5, compute: { cpu_kind: 'shared', cpus: 1, memory_mb: config.fly.memoryMB } } }); },
      },
      'fly-secrets': {
        repeatPending: true,
        async probe() { const found = await request('fly', `${app}/secrets`); if (!Array.isArray(found.secrets)) throw new CloudSetupError('invalid-secret-metadata'); return Object.keys(secretValues).every(name => found.secrets.some(secret => secret.name === name)) ? { id: n.osApp, ready: true } : null; },
        async create() { await request('fly', `${app}/secrets`, { method: 'POST', body: { values: secretValues } }); },
      },
      'fly-machine': {
        async probe(journal) {
          const values = await request('fly', `${app}/machines`);
          if (!Array.isArray(values)) throw new CloudSetupError('invalid-machine-response');
          const found = one(values.filter(value => value.name === n.machine));
          if (!found) return null;
          const expected = osMachineConfig(config, n, journal.steps['fly-volume'].receipt.id);
          if (found.region !== config.fly.region || found.config?.metadata?.ink_os_instance !== n.id || found.config?.image !== expected.image || !same(found.config.env, expected.env) || !sameDataMount(found.config.mounts, expected.mounts, config, n)) conflict();
          if (Object.keys(found.config.env).some(key => /TOKEN|SECRET|PASSWORD/.test(key))) conflict();
          return { id: id(found.id), ready: found.state === 'started' };
        },
        async create(journal) { await request('fly', `${app}/machines`, { method: 'POST', body: { name: n.machine, region: config.fly.region, config: osMachineConfig(config, n, journal.steps['fly-volume'].receipt.id) } }); },
      },
      health: {
        adopt: true,
        async probe() {
          // Public health is identity-checked before any owner credential is sent to the origin.
          async function get(url, headers = {}) {
            try { return await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
            catch { throw new CloudSetupError('https-or-health-not-ready'); }
          }
          const health = await get(`${osOrigin}/api/health`); let result;
          try { result = await health.json(); } catch { throw new CloudSetupError('https-or-health-not-ready'); }
          if (!health.ok || result.ok !== true || result.instanceId !== n.id) throw new CloudSetupError('os-health-instance-mismatch');
          const catalog = await get(`${osOrigin}/api/v1/apps?archived=true`, { Authorization: `Bearer ${secrets.ownerToken}` }); let apps;
          try { apps = await catalog.json(); } catch { throw new CloudSetupError('owner-catalog-authentication-not-ready'); }
          if (!catalog.ok || !Array.isArray(apps)) throw new CloudSetupError('owner-catalog-authentication-not-ready');
          if (apps.length !== 0) throw new CloudSetupError('fresh-owner-catalog-not-empty');
          const storage = await get(`https://${n.storageDomain}/_health`); let storageResult;
          try { storageResult = await storage.json(); } catch { throw new CloudSetupError('storage-health-not-ready'); }
          if (!storage.ok || storageResult.ok !== true) throw new CloudSetupError('storage-health-not-ready');
          const digest = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
          const storageAuth = await get(`https://${n.storageDomain}/objects/${digest}`, { Authorization: `Bearer ${secrets.storageToken}` });
          if (![200, 404].includes(storageAuth.status)) { await storageAuth.body?.cancel(); throw new CloudSetupError('storage-authentication-not-ready'); }
          await storageAuth.body?.cancel();
          const edge = await get(`https://${n.edgeDomain}/_internal/releases/${'0'.repeat(32)}`, { Authorization: `Bearer ${secrets.edgeToken}` });
          if (edge.status !== 404) { await edge.body?.cancel(); throw new CloudSetupError('edge-authentication-not-ready'); }
          await edge.body?.cancel();
          const appHealth = await get(`https://${'0'.repeat(32)}-${n.appHostSuffix || 'inkos'}.${n.appDomain}/`);
          if (appHealth.status !== 404) { await appHealth.body?.cancel(); throw new CloudSetupError('app-wildcard-https-not-ready'); }
          await appHealth.body?.cancel();
          return { id: n.id, ready: true };
        },
        async create() { throw new CloudSetupError('https-health-not-ready'); },
      },
      'storage-proof': cloudStorageProof({ fetch: fetcher, identity: n, ownerToken: secrets.ownerToken, storageToken: secrets.storageToken, error: code => new CloudSetupError(code) }),
    },
  };
}
