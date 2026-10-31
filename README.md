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

Node 22+ exposes `npm run cloud -- <command>` and the package executable `ink-os-cloud`. No npm dependencies are required. `npm test` or `npm run check:cloud` runs offline tests; the verifier integration fixtures require an explicit trusted platform checkout: `INK_OS_TEST_PLATFORM_ROOT=/path/to/ink-os-platform npm test`. Without that selection, only those six integration fixtures are skipped; the standalone deployment tests still run. An invalid explicit path fails rather than skipping. `npm run check` retains the Compose validator.

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

Provisioning first ends at **`acceptance-pending`**. It requires strict OS identity, an authenticated empty app catalog, working HTTPS/Worker endpoints and an exact OS-to-R2 write/read/delete proof with cleanup. Provisioning itself installs no canary apps. Once every provisioning step is complete, repeated `apply`/`resume` are offline status operations: they preserve recorded acceptance and do not replay the initial empty-catalog check after you install apps. An explicitly supplied different runtime token is still rejected locally; repeating apply never rotates it. Status labels are historical and state `liveAudit: "not-performed"`; they do not audit current health/provider drift or perform maintenance. Infrastructure deletion/rollback, image builds/uploads, upgrades and post-start credential rotation require separate operations.

### Hosted acceptance

Run acceptance before installing any apps. `verify` executes `verifyCloudHost` from the explicitly selected **trusted** platform checkout, using that checkout's owner SDK and the private saved owner credential. The selected platform root is executable code, so review it before selecting it. Its verifier and SDK source hashes are bound to the proof; keep those sources unchanged while resuming an attempt. The CLI accepts no uploaded “passed” proof and never calls Fly APIs or restarts the host itself.

```sh
npm run cloud -- verify --phase run --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

This creates one journal-owned backend canary, checks invocation/state, independent authenticated app origins and private source paths, then waits for quiescence and purges only its own app/source data. It refuses a nonempty initial catalog, including archived apps. Successful cleanup records `pooledBackendCanary: "passed"` and leaves restart persistence pending. A missing storage deletion acknowledgement leaves acceptance pending even if the app is absent; repeat the explicit verification command for a fresh guarded attempt. Interrupted calls reuse the private canary journal instead of creating duplicates. `verify --phase cleanup` is the explicit recovery operation for an unfinished attempt; it preserves unrelated apps and busy workers.

To include restart persistence, use this instead of the first command, or after a backend-only proof while the computer is still empty:

```sh
npm run cloud -- verify --phase prepare-restart --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

The result contains a challenge. The canary remains installed but quiescent. Perform the OS/backend restart separately under your normal operator controls, then save a private `0600` JSON receipt with the returned instance ID/challenge, an ISO `completedAt` after preparation, and the SHA-256 of retained external restart evidence:

```json
{
  "format": "ink-os-cloud-restart-receipt-v1",
  "instanceId": "RETURNED_INSTANCE_ID",
  "challenge": "RETURNED_CHALLENGE",
  "completedAt": "2026-10-31T00:00:00.000Z",
  "evidenceSha256": "SHA256_OF_YOUR_RETAINED_EXTERNAL_RESTART_EVIDENCE"
}
```

```sh
npm run cloud -- verify --phase resume --restart-receipt /private/restart.json --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- status --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Resume reads the existing canary state without replaying its write, then verifies zero remaining apps and source assets before recording **`ready`**, with `restartPersistence: "passed-with-external-attestation"`. This label distinguishes externally attested restart execution from the verifier's own state/read/cleanup checks; the health API has no process-generation proof. Retain the external evidence, private receipt and entire state directory, including `hosted-verification/`, together. Completed verification is historical evidence with a recorded timestamp/source hash. Use `status` after completion; verification refuses to rerun an accepted attempt against a computer that may now contain personal apps. These checks do not establish graphical browser behavior or ongoing maintenance health.

For a zone that already has an active root wildcard certificate and a proxied `*.YOUR-ZONE` DNS record, set `cloudflare.appRouting` to `shared-zone-wildcard` and `cloudflare.tls` to `existing`. The plan uses a generated instance suffix in first-level app hostnames and a distinct Worker route. The shared DNS record and certificate remain read-only dependencies; setup refuses missing, unproxied or changed DNS instead of creating/replacing it. This mode requires the selected platform image and edge Worker to support `INK_OS_APP_HOST_SUFFIX` / `APP_HOST_SUFFIX`. Dedicated routing remains available with a separate deeper wildcard certificate.
