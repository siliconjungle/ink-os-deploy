// Official sources inspected 2026-10-31. No account-specific resources or credentials are recorded.
export const CLOUD_API_SOURCES = Object.freeze({
  flyApps: 'https://docs.fly.io/machines/api/apps-resource',
  flyVolumes: 'https://docs.fly.io/machines/api/volumes-resource',
  flyMachines: 'https://docs.fly.io/machines/api/machines-resource',
  flyPublicAddress: 'https://docs.fly.io/model-context-protocol/deploy-with/machines-api',
  flySecretTransport: 'https://github.com/superfly/fly-go/blob/7b20a9b258873893c273712f4dc8fcf627c95878/flaps/flaps_secrets.go',
  flySecretShapes: 'https://github.com/superfly/fly-go/blob/7b20a9b258873893c273712f4dc8fcf627c95878/secrets_types.go',
  flyAddressQuery: 'https://github.com/superfly/fly-go/blob/7b20a9b258873893c273712f4dc8fcf627c95878/resource_ip_addresses.go',
  cloudflareBucket: 'https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/',
  cloudflareUpload: 'https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/',
  cloudflareSettings: 'https://developers.cloudflare.com/api/resources/workers/',
  cloudflareDomain: 'https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/',
  cloudflareDomainTLS: 'https://developers.cloudflare.com/workers/configuration/routing/custom-domains/',
  cloudflareRoutes: 'https://developers.cloudflare.com/workers/configuration/routing/routes/',
  cloudflareCertificateOrder: 'https://developers.cloudflare.com/api/resources/ssl/subresources/certificate_packs/methods/create/',
});

export const CLOUD_ACCEPTANCE_PREREQUISITES = Object.freeze([
  'Explicit Fly organization and region, billing/quota, provisioning token capable of creating new apps, volumes, secrets, and machines.',
  'Separate explicitly supplied runtime Fly token with the organization permissions needed by FlyProvider/RuntimePool. The token must pass selected-org inventory authentication before persistence or resource creation. Inventory-read authentication is not proof of create/start/lease/backend permission; the actual pooled backend canary remains required. Management credentials are never adopted from local CLI or environment settings.',
  'Published OS and pooled runtime OCI images pinned by sha256 digest, compatible with the selected Fly architecture. Image building, pushing, registry credentials and native toolchain packaging are separate acceptance gates.',
  'The selected OS image must durably initialize the declared INK_OS_INSTANCE_ID, INK_OS_ADMIN_TOKEN and INK_OS_ENV_KEY on first boot and reject drift on restart; expose the same identity in /api/health; support pooled FlyProvider and managed R2/edge environment; and mount writable /data.',
  'Explicit Cloudflare account and active full DNS zone; R2 enabled; Worker/R2/route/DNS/certificate API access within provider quotas.',
  'Cloudflare token with account Workers Scripts Write and Workers R2 Storage Write plus zone Zone Read, DNS Write, Workers Routes Write and SSL and Certificates Read. SSL and Certificates Write is needed only for explicit order-advanced mode.',
  'Generated storage/edge Custom Domains request automatic Cloudflare DNS/TLS. Their live HTTPS readiness still must pass.',
  'Choose cloudflare.tls explicitly BEFORE planning: existing requires out-of-band active coverage for the generated deeper wildcard (ordinary zone Universal SSL does not cover it); order-advanced explicitly permits a potentially billed Advanced Certificate order and may require account entitlement/DCV completion. Existing wildcard DNS/routes are never taken over. Explicit shared-zone-wildcard routing instead uses a generated first-level hostname suffix with existing active zone wildcard TLS and a read-only proxied root wildcard DNS dependency; it never orders a certificate or changes that shared record.',
  'Exact selected edge worker modules (worker.mjs and its game-assets.mjs import) and storage worker source are caller inputs, journal-bound by content hashes. No previous deployment identities are read.',
  'This bounded adapter fails closed on paginated provider lookups rather than inferring resource absence from a partial list. Large-account pagination traversal remains an integration gate.',
  'Setup requires authenticated GET /api/v1/apps?archived=true to return an empty array; it journals a deterministic proof file through POST /api/v1/data, PUT/GET /api/v1/files/:id/content, then archive + permanent DELETE. Exact OS and R2 bytes and removal of the proof record/R2 object must pass; no proof app is installed.',
  'Completed provisioning remains acceptance-pending. Actual pooled backend create/start/lease/invoke, independent app origins, zero remaining canary apps after cleanup, persistence/restart and real-account recovery acceptance are separate required gates before claiming cloud delivery.',
]);
