# Ink OS deployment

Container and cloud deployment tooling for a clean Ink OS instance. Installations start with zero apps.

With the platform checkout next to this repository:

```sh
docker compose up --build -d --wait
```

The local container desktop is configured for `http://os.ink.localhost:8080`. Private instance credentials live in the named data volume. App releases have separate hostnames routed through the platform gateway. The setup builds its backend runtime image and starts with zero installed apps.

The OS container uses the Docker Engine socket to manage isolated app containers; app containers do not receive the socket. On Docker Desktop, set `INK_OS_DOCKER_SOCKET` if its socket is outside `/var/run/docker.sock`. Use distinct `COMPOSE_PROJECT_NAME`, `INK_OS_PORT` and `INK_OS_DOCKER_NETWORK` values for multiple installations.

The bundled CLI uses the private instance credential without printing it:

```sh
docker compose exec ink-os node cli/bin/ink-os.mjs whoami
docker compose exec ink-os node cli/bin/ink-os.mjs runtimes list
```

`docker compose down` preserves instance data. `npm run check` invokes the real Compose configuration validator. Linux Docker acceptance covers an empty instance, explicit module/OCI app installation, CLI/API/SDK invocation, app-host routing, held work across restart, and idle reuse. The selected proof is in the platform repository's `evidence/compose.json` and `evidence/docker-backends.json`.

Cloud provisioning, external domains/TLS and desktop Docker-engine acceptance remain separate checks.

## Cloud setup

Node 22+ exposes `npm run cloud -- <command>` and the package executable `ink-os-cloud`. No npm dependencies are required. `npm test` or `npm run check:cloud` runs offline tests; `npm run check` retains the Compose validator.

Create `cloud.json` with your Fly organization/region, published OS and pooled runtime image digests, and an active full Cloudflare zone with R2 enabled. Replace every example account, zone, domain and image value with your selected resources. Planning validates configuration syntax offline; building/publishing images and checking registry access remain deployment prerequisites.

```json
{
  "fly": {
    "organization": "your-fly-organization",
    "region": "syd",
    "osImage": "registry.example.com/ink/os@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "runtimeImage": "registry.example.com/ink/runtime@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "volumeGB": 10,
    "memoryMB": 1024
  },
  "cloudflare": {
    "accountId": "00000000000000000000000000000000",
    "zoneId": "11111111111111111111111111111111",
    "zoneName": "example.com",
    "tls": "existing"
  }
}
```

Choose TLS **before planning**. Setup generates a dedicated app subdomain and needs a certificate for its exact wildcard, shown in the plan. Ordinary zone Universal SSL does not cover this deeper wildcard. `existing` requires obtaining that certificate separately after seeing the generated hostname. Choosing `order-advanced` explicitly authorizes a potentially billable Advanced Certificate order, subject to Cloudflare entitlement and validation. The saved journal binds the selected mode and configuration.

```sh
npm run cloud -- plan --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- status --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Review the generated identities, TLS choice and returned prerequisites. Provisioning requires caller-supplied environment variables: `INK_CLOUD_FLY_TOKEN`, `INK_CLOUD_CLOUDFLARE_TOKEN` and `INK_CLOUD_RUNTIME_FLY_TOKEN`. Supply their values through your private environment or secret manager. Token arguments, ambient `flyctl`/`gh` credentials and existing `.env` deployment settings are not consumed. The Cloudflare token needs Workers/R2 account access and zone DNS/routes/certificate permissions; exact prerequisites are returned by `plan` and recorded in `lib/cloud-contract.mjs`.

```sh
npm run cloud -- apply --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- resume --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

`apply`/`resume` operate on the already planned instance. Keep the same selected configuration and Worker sources for retries. Runtime-token organization inventory authentication precedes persistence and resource creation. This read check does not prove permission to create or invoke a backend. Correct a runtime token before any machine-create attempt with `replace-runtime-credential` using the same arguments and the corrected private `INK_CLOUD_RUNTIME_FLY_TOKEN`; after a machine attempt, a controlled rotation workflow is required.

Private state uses an owned directory with mode `0700` and regular `0600` files. Retain `journal.json` and `secrets.json` together securely: they contain recovery state, owner/runtime credentials and the instance encryption key. Declare any alternate retained state path in `storage-retention.json`. Plans, status, progress and structured errors omit secret values. Never commit or publish this directory. Lost resource-create replies are reconciled by generated identity; ambiguous absent creates require explicit provider reconciliation through the library API. Lock recovery checks that its recorded process has exited.

Provisioning ends at **`acceptance-pending`**. It requires strict OS identity, an authenticated empty app catalog, working HTTPS/Worker endpoints and an exact OS-to-R2 write/read/delete proof with cleanup. It installs no canary apps. Actual pooled backend creation/start/lease/invocation, independent app origins, zero remaining canary apps after cleanup, restart persistence and real-account recovery remain required acceptance gates. Infrastructure deletion/rollback, image builds/uploads and post-start credential rotation are separate operations. See `npm run cloud -- --help` for the current contract.
