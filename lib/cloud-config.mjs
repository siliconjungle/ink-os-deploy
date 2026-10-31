import { createHash, randomBytes } from 'node:crypto';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad = field => { throw Error(`Invalid cloud configuration: ${field}`); };
const object = (value, keys, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) bad(field);
};
const matches = (value, pattern, field) => { if (typeof value !== 'string' || !pattern.test(value)) bad(field); return value; };
const integer = (value, min, max, field) => { if (!Number.isSafeInteger(value) || value < min || value > max) bad(field); return value; };
const domain = (value, field) => {
  matches(value, /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/, field);
  if (value.split('.').some(label => label.length > 63)) bad(field);
  return value;
};
const image = (value, field) => matches(value, /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/, field);

// This API deliberately accepts no previous app/resource IDs, credentials, or .env input.
export function validateCloudConfig(input) {
  object(input, ['fly', 'cloudflare'], 'keys');
  object(input.fly, ['organization', 'region', 'osImage', 'runtimeImage', 'volumeGB', 'memoryMB'], 'fly');
  object(input.cloudflare, ['accountId', 'zoneId', 'zoneName', 'tls', 'compatibilityDate', 'appRouting'], 'cloudflare');
  const fly = {
    organization: matches(input.fly.organization, /^[a-z0-9][a-z0-9-]{0,62}$/, 'fly.organization'),
    region: matches(input.fly.region, /^[a-z]{3}$/, 'fly.region'),
    osImage: image(input.fly.osImage, 'fly.osImage'), runtimeImage: image(input.fly.runtimeImage, 'fly.runtimeImage'),
    volumeGB: integer(input.fly.volumeGB ?? 10, 1, 1000, 'fly.volumeGB'),
    memoryMB: integer(input.fly.memoryMB ?? 1024, 256, 32768, 'fly.memoryMB'),
  };
  const cf = input.cloudflare;
  if (typeof cf.zoneName === 'string' && cf.zoneName.length > 192) bad('cloudflare.zoneName');
  // A generated deeper wildcard is not ordinarily covered by zone Universal SSL.
  // Choosing an existing certificate or a potentially billed order must be explicit before planning.
  const tls = cf.tls;
  if (!['existing', 'order-advanced'].includes(tls)) bad('cloudflare.tls');
  const appRouting = cf.appRouting ?? 'dedicated';
  if (!['dedicated', 'shared-zone-wildcard'].includes(appRouting) || appRouting === 'shared-zone-wildcard' && tls !== 'existing') bad('cloudflare.appRouting');
  const compatibilityDate = cf.compatibilityDate ?? '2026-10-01';
  matches(compatibilityDate, /^\d{4}-\d{2}-\d{2}$/, 'cloudflare.compatibilityDate');
  if (!Number.isFinite(Date.parse(compatibilityDate)) || new Date(compatibilityDate).toISOString().slice(0, 10) !== compatibilityDate) bad('cloudflare.compatibilityDate');
  return { fly, cloudflare: {
    accountId: matches(cf.accountId, /^[a-f0-9]{32}$/, 'cloudflare.accountId'),
    zoneId: matches(cf.zoneId, /^[a-f0-9]{32}$/, 'cloudflare.zoneId'),
    zoneName: domain(cf.zoneName, 'cloudflare.zoneName'), tls, compatibilityDate,
    ...(appRouting === 'shared-zone-wildcard' ? { appRouting } : {}),
  } };
}

export function createCloudIdentity(config) {
  const id = randomBytes(16).toString('hex'), suffix = id.slice(0, 16), prefix = `ink-${suffix}`;
  return { id, osApp: `${prefix}-os`, runtimePrefix: `${prefix}-app`, bucket: `${prefix}-assets`,
    volume: `ink_${suffix}`, machine: `${prefix}-os`, storageWorker: `${prefix}-storage`, edgeWorker: `${prefix}-edge`,
    storageDomain: `storage-${suffix}.${config.cloudflare.zoneName}`, edgeDomain: `edge-${suffix}.${config.cloudflare.zoneName}`,
    appDomain: config.cloudflare.appRouting === 'shared-zone-wildcard' ? config.cloudflare.zoneName : `apps-${suffix}.${config.cloudflare.zoneName}`,
    ...(config.cloudflare.appRouting === 'shared-zone-wildcard' ? { appHostSuffix: `inkos-${suffix}` } : {}) };
}

export function validateCloudIdentity(config, identity) {
  if (!identity || !/^[a-f0-9]{32}$/.test(identity.id)) throw Error('Invalid cloud instance identity');
  const suffix = identity.id.slice(0, 16), prefix = `ink-${suffix}`;
  const expected = { id: identity.id, osApp: `${prefix}-os`, runtimePrefix: `${prefix}-app`, bucket: `${prefix}-assets`,
    volume: `ink_${suffix}`, machine: `${prefix}-os`, storageWorker: `${prefix}-storage`, edgeWorker: `${prefix}-edge`,
    storageDomain: `storage-${suffix}.${config.cloudflare.zoneName}`, edgeDomain: `edge-${suffix}.${config.cloudflare.zoneName}`,
    appDomain: config.cloudflare.appRouting === 'shared-zone-wildcard' ? config.cloudflare.zoneName : `apps-${suffix}.${config.cloudflare.zoneName}`,
    ...(config.cloudflare.appRouting === 'shared-zone-wildcard' ? { appHostSuffix: `inkos-${suffix}` } : {}) };
  if (JSON.stringify(identity) !== JSON.stringify(expected)) throw Error('Invalid cloud instance identity');
  return identity;
}

// Module bytes must be supplied from the selected platform revision, including its imports.
export function validateCloudArtifacts(artifacts) {
  object(artifacts, ['storage', 'edge'], 'artifacts');
  const result = {};
  for (const kind of ['storage', 'edge']) {
    const modules = artifacts[kind];
    if (!modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.hasOwn(modules, 'worker.mjs')) bad(`artifacts.${kind}`);
    let bytes = 0;
    result[kind] = Object.fromEntries(Object.keys(modules).sort().map(name => {
      if (!/^[a-zA-Z0-9_-]+\.(?:mjs|js)$/.test(name) || typeof modules[name] !== 'string') bad(`artifacts.${kind}.modules`);
      bytes += Buffer.byteLength(modules[name]);
      return [name, fingerprint(modules[name])];
    }));
    if (bytes === 0 || bytes > 5 * 1024 * 1024) bad(`artifacts.${kind}.size`);
  }
  return result;
}

export function publicCloudPlan(config, identity, moduleHashes) {
  return { format: 'ink-cloud-plan-v1', instanceId: identity.id, resources: { ...identity }, images: { os: config.fly.osImage, runtime: config.fly.runtimeImage },
    origin: `https://${identity.osApp}.fly.dev`, storageURL: `https://${identity.storageDomain}`, edgeURL: `https://${identity.edgeDomain}`,
    appOriginPattern: `https://<release-id>-${identity.appHostSuffix || 'inkos'}.${identity.appDomain}`, moduleHashes,
    ...(identity.appHostSuffix ? { sharedWildcardDNS: { name: `*.${identity.appDomain}`, access: 'read-only' }, appRoute: `*-${identity.appHostSuffix}.${identity.appDomain}/*` } : {}),
    tls: { mode: config.cloudflare.tls, wildcard: `*.${identity.appDomain}`, mayCreateBillableCertificate: config.cloudflare.tls === 'order-advanced' },
    acceptanceRequired: ['authenticated-empty-catalog', 'os-managed-r2-write-read-delete', 'pooled-backend-canary-and-cleanup', 'restart-persistence'],
    steps: ['wildcard-tls', 'bucket', 'storage-worker', 'edge-worker', 'storage-domain', 'edge-domain', 'app-dns', 'app-route', 'fly-app', 'fly-ip', 'fly-volume', 'fly-secrets', 'fly-machine', 'health', 'storage-proof'],
  };
}
