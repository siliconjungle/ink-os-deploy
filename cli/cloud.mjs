#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeCloudSetup, describeCloudSetup, runCloudSetup, replaceCloudRuntimeCredential, CloudSetupError, validateCloudConfig } from '../lib/cloud-setup.mjs';
import { CLOUD_ACCEPTANCE_PREREQUISITES, CLOUD_API_SOURCES } from '../lib/cloud-contract.mjs';
import { verifyCloudSetup } from '../lib/cloud-verification.mjs';

export const CLOUD_CREDENTIAL_ENV = Object.freeze({ flyToken: 'INK_CLOUD_FLY_TOKEN', cloudflareToken: 'INK_CLOUD_CLOUDFLARE_TOKEN', runtimeFlyToken: 'INK_CLOUD_RUNTIME_FLY_TOKEN' });
const usage = 'node cli/cloud.mjs <plan|apply|resume|status|replace-runtime-credential|verify> --config FILE --state PRIVATE_DIRECTORY --platform-root TRUSTED_SELECTED_PLATFORM_DIRECTORY [verify: --phase run|prepare-restart|resume|cleanup [--restart-receipt PRIVATE_FILE]]';
const hints = {
  'cloud-state-not-initialized': 'Run plan with these exact explicit paths before apply/resume.',
  'invalid-cloud-config-file': 'Use JSON containing only fly and cloudflare configuration; images need sha256 digest pins and cloudflare.tls must explicitly select existing or order-advanced before planning. Credentials and previous resource IDs are not configuration fields.',
  'cloud-setup-input-or-private-state-error': 'State must be an owned directory with mode 0700 and regular private 0600 files, without symlinks. Preserve journal.json and secrets.json together; inspect operation.lock before explicit crash recovery.',
  'shared-zone-proxied-wildcard-required': 'The explicitly selected shared-zone mode requires an existing proxied root wildcard DNS record. Setup never creates or alters that shared dependency.',
  'active-app-wildcard-certificate-required': 'The saved plan names the exact generated deeper wildcard that needs an active certificate; ordinary zone Universal SSL does not cover it. Explicit existing mode does not purchase a certificate.',
  'runtime-token-change-requires-explicit-correction': 'Use replace-runtime-credential with the corrected INK_CLOUD_RUNTIME_FLY_TOKEN. The same saved instance is retained; correction is blocked after a machine-create attempt.',
  'runtime-credential-correction-incomplete-repeat-command': 'Repeat replace-runtime-credential with the intended private runtime credential to complete its interrupted private-file update.',
  'runtime-credential-rotation-required-after-machine-attempt': 'A machine may already use the previous credential. Local-only correction is refused; a controlled app-secret and machine rotation workflow is required.',
  'resource-not-ready-resume-same-journal': 'Allow provider readiness or certificate validation to complete, then resume using the same paths and selected inputs.',
  'ambiguous-create-outcome-requires-provider-reconciliation': 'Inspect the provider outcome for the saved generated identity. Only after confirming no resource was created, use reconcileCloudStep with its saved attempt to rearm; no automatic duplicate creation is attempted.',
  'provider-pagination-requires-complete-lookup': 'The provider lookup was paginated. This bounded adapter refuses to infer absence from an incomplete list; complete-lookup support is required for this account.',
  'journal-inputs-changed': 'Use the exact configuration and selected Worker sources used for this plan. Upgrade/change workflows are separate from fresh setup.',
  'hosted-verification-already-recorded-use-status': 'Acceptance is recorded as historical evidence. Use status; maintenance and verification of a computer with user apps are separate operations.',
  'hosted-verifier-ink-cloud-proof-nonempty-catalog': 'The verifier requires an empty initial catalog including archived apps. It refuses to touch a personal computer or delete unrelated apps.',
  'hosted-verification-restart-receipt-required': 'The saved canary is awaiting an externally performed restart. Use verify --phase resume with the challenge-bound private receipt, or explicit cleanup.',
  'hosted-proof-storage-acknowledgement-pending': 'The canary is absent but a storage deletion acknowledgement was not observed. Readiness is not promoted; a fresh explicit verification attempt can obtain complete evidence.',
  'provision-cloud-before-hosted-verification': 'Complete provisioning and its initial empty-catalog/storage proof before starting hosted verification.',
};
const cliError = code => Object.assign(Error(code), { cliCode: code });
const emit = (stream, value) => stream.write(JSON.stringify(value) + '\n');

function parse(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [command, ...args] = argv;
  if (!['plan', 'apply', 'resume', 'status', 'replace-runtime-credential', 'verify'].includes(command)) throw cliError('explicit-cloud-command-required');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--state', '--platform-root', ...(command === 'verify' ? ['--phase', '--restart-receipt'] : [])].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) throw cliError('invalid-cloud-arguments');
    options[args[i]] = args[i + 1];
  }
  if (!['--config', '--state', '--platform-root'].every(key => options[key])) throw cliError('explicit-cloud-paths-required');
  if (command === 'verify' && !['run', 'prepare-restart', 'resume', 'cleanup'].includes(options['--phase'])) throw cliError('explicit-hosted-verification-phase-required');
  return { command, options };
}

async function boundedText(path, max) {
  if (!(await stat(path)).isFile() || (await stat(path)).size > max) throw cliError('invalid-cloud-input-file');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > max) throw cliError('invalid-cloud-input-file');
  return text;
}

async function inputs(options, cwd) {
  const configPath = resolve(cwd, options['--config']), directory = resolve(cwd, options['--state']), platform = resolve(cwd, options['--platform-root']);
  let config;
  try { config = validateCloudConfig(JSON.parse(await boundedText(configPath, 65536))); }
  catch { throw cliError('invalid-cloud-config-file'); }
  let artifacts;
  try {
    const [storage, edge, assets] = await Promise.all([
      boundedText(join(platform, 'infra/r2/worker.mjs'), 5 * 1024 * 1024),
      boundedText(join(platform, 'infra/edge/worker.mjs'), 5 * 1024 * 1024),
      boundedText(join(platform, 'infra/edge/game-assets.mjs'), 5 * 1024 * 1024),
    ]);
    artifacts = { storage: { 'worker.mjs': storage }, edge: { 'worker.mjs': edge, 'game-assets.mjs': assets } };
  } catch { throw cliError('selected-platform-worker-sources-required'); }
  return { config, directory, artifacts, platformRoot: platform };
}

/** No network calls occur for plan/status or completed apply/resume. verify explicitly runs
 *  a fresh-host canary through trusted selected platform code; no proof JSON is imported.
 *  No CLI token arguments, ambient flyctl credentials, previous .env settings, or inferred account IDs.
 *  stdout is one public JSON result; stderr is one sanitized JSON error. Values of env are never serialized.
 */
export async function runCloudCLI({ argv = [], env = {}, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), fetch } = {}) {
  let command;
  try {
    const parsed = parse(argv); command = parsed.command;
    if (parsed.help) { emit(stdout, { usage, credentials: CLOUD_CREDENTIAL_ENV, mutationCommands: ['apply', 'resume', 'verify'], credentialCorrectionCommand: 'replace-runtime-credential', prerequisites: CLOUD_ACCEPTANCE_PREREQUISITES }); return 0; }
    const args = await inputs(parsed.options, cwd);
    let deployment, verification;
    if (command === 'plan') deployment = await initializeCloudSetup(args);
    else if (command === 'status') deployment = await describeCloudSetup(args);
    else if (command === 'replace-runtime-credential') deployment = await replaceCloudRuntimeCredential({ ...args, runtimeFlyToken: env[CLOUD_CREDENTIAL_ENV.runtimeFlyToken], fetch });
    else if (command === 'verify') {
      verification = await verifyCloudSetup({ ...args, phase: parsed.options['--phase'], restartReceipt: parsed.options['--restart-receipt'] ? resolve(cwd, parsed.options['--restart-receipt']) : undefined, fetch });
      deployment = await describeCloudSetup(args);
    }
    else {
      // Never initialize or silently select a fresh instance during an apply/resume command.
      const existing = await describeCloudSetup(args);
      if (existing.provisioning.status === 'complete') deployment = await runCloudSetup({ ...args, ...(env[CLOUD_CREDENTIAL_ENV.runtimeFlyToken] !== undefined ? { credentials: { runtimeFlyToken: env[CLOUD_CREDENTIAL_ENV.runtimeFlyToken] } } : {}), fetch });
      else {
        const credentials = Object.fromEntries(Object.entries(CLOUD_CREDENTIAL_ENV).map(([key, name]) => [key, env[name]]).filter(([, value]) => value !== undefined));
        if (!credentials.flyToken || !credentials.cloudflareToken) throw cliError('explicit-provider-credentials-required');
        deployment = await runCloudSetup({ ...args, credentials, fetch });
      }
    }
    emit(stdout, { ok: true, command, deployment, ...(verification ? { verification } : {}), ...(command === 'plan' ? { prerequisites: CLOUD_ACCEPTANCE_PREREQUISITES, sources: CLOUD_API_SOURCES } : {}) });
    return 0;
  } catch (error) {
    let code = error.cliCode;
    if (!code && error instanceof CloudSetupError) code = error.code;
    if (!code && error.code === 'ENOENT') code = command === 'plan' ? 'cloud-input-not-found' : 'cloud-state-not-initialized';
    // Filesystem/JSON/callback exceptions can contain private paths or echoed values; keep only known codes.
    code ??= 'cloud-setup-input-or-private-state-error';
    emit(stderr, { ok: false, command: command ?? null, error: { code,
      ...(hints[code] ? { hint: hints[code] } : {}),
      ...(error instanceof CloudSetupError && Number.isInteger(error.status) ? { httpStatus: error.status } : {}),
      resumeSameState: ['apply', 'resume', 'verify'].includes(command), usage,
      ...(code.includes('credential') || code.includes('runtime-fly-token') ? { credentialEnvironment: CLOUD_CREDENTIAL_ENV } : {}),
      ...(code.includes('certificate') || code.includes('not-ready') || code.includes('provider') ? { prerequisites: CLOUD_ACCEPTANCE_PREREQUISITES } : {}),
    } });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runCloudCLI({ argv: process.argv.slice(2), env: process.env });
