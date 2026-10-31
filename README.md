# Ink OS deployment

Container and cloud deployment tooling for a clean Ink OS instance. Installations start with Finder, Preview and Ink Environment.

With the platform checkout next to this repository:

```sh
docker compose up --build -d --wait
```

The local container desktop is configured for `http://os.ink.localhost:8080`. Private instance credentials live in the named data volume. App releases have separate hostnames routed through the platform gateway. The setup builds its backend runtime image and starts with Finder, Preview and Ink Environment.

The OS container uses the Docker Engine socket to manage isolated app containers; app containers do not receive the socket. On Docker Desktop, set `INK_OS_DOCKER_SOCKET` if its socket is outside `/var/run/docker.sock`. Use distinct `COMPOSE_PROJECT_NAME`, `INK_OS_PORT` and `INK_OS_DOCKER_NETWORK` values for multiple installations.

The bundled CLI uses the private instance credential without printing it:

```sh
docker compose exec ink-os node cli/bin/ink-os.mjs whoami
docker compose exec ink-os node cli/bin/ink-os.mjs runtimes list
```

`docker compose down` preserves instance data. `npm run check` invokes the real Compose configuration validator. Linux Docker acceptance covers an empty instance, explicit module/OCI app installation, CLI/API/SDK invocation, app-host routing, held work across restart, and idle reuse. The selected proof is in the platform repository's `evidence/compose.json` and `evidence/docker-backends.json`.

Cloud provisioning, external domains/TLS and desktop Docker-engine acceptance remain separate checks.

## Cloud setup

Node 22+ exposes `npm run cloud -- <command>` and the package executable `ink-os-cloud`. No npm dependencies are required. `npm test` or `npm run check:cloud` runs offline tests; the verifier integration fixtures require an explicit trusted platform checkout: `INK_OS_TEST_PLATFORM_ROOT=/path/to/ink-os-platform npm test`. Without that selection, only those integration fixtures are skipped; the standalone deployment tests still run. An invalid explicit path fails rather than skipping. `npm run check` retains the Compose validator.

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

Provisioning first ends at **`acceptance-pending`**. It requires strict OS identity, an authenticated default-only app catalog, working HTTPS/Worker endpoints and an exact OS-to-R2 write/read/delete proof with cleanup. Provisioning itself installs no canary apps. Once every provisioning step is complete, repeated `apply`/`resume` are offline status operations: they preserve recorded acceptance and do not replay the initial default-catalog check after you install apps. An explicitly supplied different runtime token is still rejected locally; repeating apply never rotates it. Status labels are historical and state `liveAudit: "not-performed"`; they do not audit current health/provider drift or perform maintenance. Infrastructure deletion/rollback, image builds/uploads, upgrades and post-start credential rotation require separate operations.

### Hosted acceptance

Run acceptance before installing any apps. `verify` executes `verifyCloudHost` from the explicitly selected **trusted** platform checkout, using that checkout's owner SDK and the private saved owner credential. The selected platform root is executable code, so review it before selecting it. Its verifier and SDK source hashes are bound to the proof; keep those sources unchanged while resuming an attempt. The CLI accepts no uploaded “passed” proof and never calls Fly APIs or restarts the host itself.

```sh
npm run cloud -- verify --phase run --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

This creates one journal-owned backend canary, checks invocation/state, independent authenticated app origins and private source paths, then waits for quiescence and purges only its own app/source data. It refuses a initial catalog containing anything beyond the three distribution apps, including archived user apps. Successful cleanup records `pooledBackendCanary: "passed"` and leaves restart persistence pending. A missing storage deletion acknowledgement leaves acceptance pending even if the app is absent; repeat the explicit verification command for a fresh guarded attempt. Interrupted calls reuse the private canary journal instead of creating duplicates. `verify --phase cleanup` is the explicit recovery operation for an unfinished attempt; it preserves unrelated apps and busy workers.

To include restart persistence, use this instead of the first command, or after a backend-only proof before installing additional apps:

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

Resume reads the existing canary state without replaying its write, then verifies removal of its own canary and source assets while preserving the default apps before recording **`ready`**, with `restartPersistence: "passed-with-external-attestation"`. This label distinguishes externally attested restart execution from the verifier's own state/read/cleanup checks; the health API has no process-generation proof. Retain the external evidence, private receipt and entire state directory, including `hosted-verification/`, together. Completed verification is historical evidence with a recorded timestamp/source hash. Use `status` after completion; verification refuses to rerun an accepted attempt against a computer that may now contain personal apps. These checks do not establish graphical browser behavior or ongoing maintenance health.

For a zone that already has an active root wildcard certificate and a proxied `*.YOUR-ZONE` DNS record, set `cloudflare.appRouting` to `shared-zone-wildcard` and `cloudflare.tls` to `existing`. The plan uses a generated instance suffix in first-level app hostnames and a distinct Worker route. The shared DNS record and certificate remain read-only dependencies; setup refuses missing, unproxied or changed DNS instead of creating/replacing it. This mode requires the selected platform image and edge Worker to support `INK_OS_APP_HOST_SUFFIX` / `APP_HOST_SUFFIX`. Dedicated routing remains available with a separate deeper wildcard certificate.

### Image upgrades

Keep the original `cloud.json`, Worker sources and provisioning journal unchanged. Upgrade targets are a separate explicit pair of published image digest pins. Upgrades affect the OS image and global pooled runtime default; they do not publish images, deploy Workers, rotate credentials or rewrite app releases.

```sh
npm run cloud -- upgrade plan --os-image registry.example.com/ink/os@sha256:2222222222222222222222222222222222222222222222222222222222222222 --runtime-image registry.example.com/ink/runtime@sha256:3333333333333333333333333333333333333333333333333333333333333333 --mode automatic --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- upgrade status --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Replace the example pins and `RETURNED_OPERATION_ID` below with the selected images and the plan's full operation ID. Planning and status are offline. `run`, `resume` and `cancel` consume only the explicit private `INK_CLOUD_FLY_TOKEN`; the owner credential is loaded from the saved private instance state. Management credentials, owner credentials and lease nonces are never printed. A different explicitly supplied runtime token is rejected locally; upgrading does not rotate it.

```sh
npm run cloud -- upgrade run --operation RETURNED_OPERATION_ID --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- upgrade resume --operation RETURNED_OPERATION_ID --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Automatic upgrades require a host image that implements authenticated, durable maintenance admission and reports image provenance from `INK_OS_IMAGE_PIN` / `INK_OS_RUNTIME_IMAGE`. The host closes external admission while admitted work finishes naturally. Pool continuations may remain available while draining; the final quiescent receipt must close pool admission and prove all operations/holds are zero and old idle global-runtime slots retired. Busy, held or uncertain workers block progress. Live release pins that would recreate the retiring global image also block; publish updated releases separately. Intentional custom runtime images such as Codex/ffmpeg remain unchanged, are inventoried in the receipt, and need separate rebuild/base-update and compatibility acceptance.

Only after quiescence does the library lease and revalidate the selected machine, durably seal source-host stop authorization, stop the idle OS, apply a version-checked full configuration with unchanged volume/environment bindings, and start the target image. Sealing permanently refuses source cancellation for that operation, closing the cancellation/stop race. Lost seal replies resume the same idempotent handshake; lost update replies are reconciled against exact observed target configuration and operation identity. It never force-stops workers or deletes apps. `waiting-for-quiescence` is a normal resumable result; allow work to finish rather than forcing it. A host without the gate/provenance cannot use automatic mode, and the tool does not stop it.

For the first upgrade of such an older host, explicitly select `--mode external-stopped-bootstrap`, keep `--runtime-image` equal to the exact current global runtime digest, and choose the new OS digest. Bootstrap is OS-only. It requires independently retained quiescence observations and a provider-observed **already stopped** OS and mapped pool machines; the library never stops the legacy host or its workers. The observations must include the selected instance's health identity, the nine zero activity counts named by `CLOUD_UPGRADE_ACTIVITY`, and full idle public pool slots. Save the observations as a private `0600` JSON file:

```json
{
  "format": "ink-cloud-bootstrap-observations-v1",
  "instanceId": "RETURNED_INSTANCE_ID",
  "observedAt": "ACTUAL_OBSERVATION_ISO_TIME",
  "health": { "ok": true, "instanceId": "RETURNED_INSTANCE_ID" },
  "activity": { "requests": 0, "writers": 0, "publications": 0, "workflows": 0, "schedules": 0, "nativeJobs": 0, "codeTasks": 0, "poolAssignments": 0, "poolRequests": 0 },
  "pool": { "slots": [] }
}
```

An empty slots array is valid only when the observed pool is empty. Otherwise include every observed slot with its `slotId`, `kind`, `status: "idle"`, null `appId`/`releaseId`/`leaseId`, zero `inFlight`, empty `holds`, and any `machineId`/`backendMachineId`. Provider inventory must match those owned stopped machines. The receipt is another private JSON file with `format: "ink-cloud-bootstrap-quiescence-v1"`, the plan's `operationId`, `challenge`, `instanceId`, the exact `machineId`/`observedVersion`, `fromImages`, an actual ISO `completedAt`, `evidenceSha256` of the observation file's exact bytes, and `limitationAcknowledged: "external-quiescence-not-automatically-verified"`. Observation time must follow planning and precede completion. Retain actual observations; do not manufacture an idle receipt. This external attestation is deliberately distinct from automatic drain proof.

```sh
npm run cloud -- upgrade run --operation RETURNED_OPERATION_ID --bootstrap-receipt /private/bootstrap-receipt.json --bootstrap-evidence /private/bootstrap-observations.json --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

The private `current-images.json` and `upgrades/` directory retain image generation, intent, progress, raw bootstrap evidence and hash-bound receipts. Keep them with the original private state. `status` revalidates that lineage and shows `generation`, `currentImages` and `activeUpgrade`. For later generations, original `ready`/canary results appear only under `historicalProvisioning`, labeled `historical-original-provisioning`. Current acceptance starts at **`post-upgrade-runtime-use-pending`**, or **`bootstrap-automatic-proof-pending`** for bootstrap. The original empty-host `verify` workflow refuses later generations. Repeated completed `apply`/`resume` stay offline and preserve this distinction.

After completing an upgrade, explicitly exercise the current generation without requiring an empty computer:

```sh
npm run cloud -- upgrade verify --phase run --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
npm run cloud -- status --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

This invokes the selected platform's `verifyUpgradedHost` export and its bounded, hash-checked SDK dependency graph. It loads the saved private owner token and uses no Fly/Cloudflare credentials. Public health identity is checked before owner requests; authenticated inspection binds the actual open host's images and stable boot to the current generation and immutable upgrade receipt. It creates, invokes and purges only its nonce-owned canary, verifies state `1`, owner/edge authentication and source privacy, waits only for its own naturally idle worker, and requires acknowledged source-blob cleanup. Existing apps/data and unrelated busy or held workers are preserved. It never invokes user commands, globally reaps workers or restarts the host.

Automatic generations with a valid proof become **`post-upgrade-runtime-verified`**. Bootstrap retains **`bootstrap-automatic-proof-pending`** even when `acceptance.pooledBackendCanary` is `passed`; an actual automatic maintenance proof remains separate. This canary does not claim pre-upgrade state restart persistence, graphical browser behavior or compatibility of each installed/custom runtime app. Status and repeated completed verification return historical evidence with `liveAudit: "not-performed"`. Later generations or changed upgrade receipts cannot inherit an older proof.

Retry `upgrade verify --phase run` with the same paths after a lost reply. Its separate private `upgrade-verification.json` and `upgrade-verification/` retain the attempt, exact verifier sources, canary journal, proof and acceptance receipt; they do not alter the original provisioning journal or image-transition receipt. A missing active journal after a mutation attempt is never recreated. For explicit recovery cleanup:

```sh
npm run cloud -- upgrade verify --phase cleanup --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Cleanup can remove owned remnants after images change, but cannot promote acceptance. A lost purge acknowledgement remains **`cleanup-acknowledgement-pending`**, even when the canary is absent. Only a completed, validated proof with acknowledged cleanup promotes current runtime acceptance. Caller-provided proof JSON, restart commands and provider credentials are not accepted by this command.

```sh
npm run cloud -- upgrade abandon --operation RETURNED_OPERATION_ID --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Abandonment is local and allowed only for untouched intents or a definite unsupported-maintenance response. It retains the journal/proofs and cannot reopen an active gate or forget an attempted update.

To explicitly release eligible automatic source-side maintenance before any seal, stop or update attempt:

```sh
npm run cloud -- upgrade cancel --operation RETURNED_OPERATION_ID --config cloud.json --state .local/cloud/new-instance --platform-root ../ink-os-platform
```

Cancellation validates the exact started source machine/configuration/version under an exclusive Fly lease, authenticates the saved instance, and asks its maintenance API to reopen admission. Active work can continue; cancellation never stops a host or worker. A sealed gate, changed source, bootstrap mode or attempted update blocks cancellation and keeps the operation selected. A definite API refusal leaves the same operation available for upgrade resume. After an ambiguous or lost cancellation reply, retry **`upgrade cancel` with the same operation**, because ordinary upgrade resume cannot safely infer whether admission reopened. A lost reply reconciles the actual cancelled receipt; retained private proof permits recovery of interrupted local writes.

The private per-operation `cancellation.json` is written before clearing the active pointer, and `current-images.json` retains its separately hash-bound `lastCancellation`. Status revalidates this historical proof without claiming current health. Cancellation preserves image generation, original provisioning and prior successful image lineage; a fresh explicit upgrade plan can follow. Retain cancellation evidence with the other private operation files. The CLI never automatically cancels or forces admission open.

Fresh hosted acceptance accepts either the three unmodified distribution apps or an explicitly empty installation. It rejects additional/archived user apps. Canary verification binds and preserves the default app release/source identities and removes only its own canary. Existing historical acceptance receipts retain their original meaning.
