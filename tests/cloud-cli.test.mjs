import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCloudCLI } from '../cli/cloud.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-cloud-cli-proof-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'cloud.json'), directory = join(root, 'private-state'), platform = join(root, 'selected-platform');
  await mkdir(join(platform, 'infra/r2'), { recursive: true }); await mkdir(join(platform, 'infra/edge'), { recursive: true });
  await writeFile(join(platform, 'infra/r2/worker.mjs'), 'export default { fetch() {} };');
  await writeFile(join(platform, 'infra/edge/worker.mjs'), 'import x from "./game-assets.mjs"; export default x;');
  await writeFile(join(platform, 'infra/edge/game-assets.mjs'), 'export default { fetch() {} };');
  await writeFile(configPath, JSON.stringify({ fly: { organization: 'proof-org', region: 'syd', osImage: `example.test/ink/os@sha256:${'a'.repeat(64)}`, runtimeImage: `example.test/ink/runtime@sha256:${'b'.repeat(64)}` }, cloudflare: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.test', tls: 'existing' } }));
  const args = ['--config', configPath, '--state', directory, '--platform-root', platform];
  const invoke = async (command, overrides = {}) => {
    let output = '', errors = '';
    const status = await runCloudCLI({ argv: [command, ...args], env: {}, stdout: { write(value) { output += value; } }, stderr: { write(value) { errors += value; } }, ...overrides });
    return { status, output, errors, result: JSON.parse(output || errors) };
  };
  return { root, configPath, directory, platform, args, invoke };
}

test('actual standalone CLI plans and reports status offline without any credentials', async t => {
  const f = await fixture(t), cli = fileURLToPath(new URL('../cli/cloud.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'plan', ...f.args], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, true); assert.equal(plan.deployment.status, 'planned'); assert.equal(plan.deployment.tls.mode, 'existing');
  assert.equal(plan.deployment.generation, 0); assert.deepEqual(plan.deployment.currentImages, plan.deployment.images); assert.equal(plan.deployment.activeUpgrade, null);
  assert.ok(plan.prerequisites.some(value => value.includes('OCI images')));
  const described = await f.invoke('status', { fetch() { throw Error('status must not access network'); } });
  assert.equal(described.status, 0); assert.equal(described.result.deployment.instanceId, plan.deployment.instanceId);
  const secrets = JSON.parse(await readFile(join(f.directory, 'secrets.json'))); assert.ok(!result.stdout.includes(secrets.ownerToken));
});

test('apply/resume require prior explicit plan and caller cloud env; unrelated ambient tokens are ignored', async t => {
  const f = await fixture(t); let called = false;
  const fetch = () => { called = true; throw Error('no actual cloud access'); };
  const unplanned = await f.invoke('apply', { fetch }); assert.equal(unplanned.result.error.code, 'cloud-state-not-initialized');
  await f.invoke('plan');
  const absent = await f.invoke('apply', { fetch, env: { FLY_API_TOKEN: 'ambient-private-'.repeat(4), CLOUDFLARE_API_TOKEN: 'ambient-private-'.repeat(4) } });
  assert.equal(absent.result.error.code, 'explicit-provider-credentials-required'); assert.equal(called, false);
  const env = { INK_CLOUD_FLY_TOKEN: 'provision-secret-'.repeat(4), INK_CLOUD_CLOUDFLARE_TOKEN: 'cloudflare-secret-'.repeat(4), INK_CLOUD_RUNTIME_FLY_TOKEN: 'runtime-secret-'.repeat(4) };
  for (const command of ['apply', 'resume']) {
    const failed = await f.invoke(command, { env, fetch: async () => Response.json({ error: env.INK_CLOUD_FLY_TOKEN }, { status: 401 }) });
    assert.equal(failed.status, 1); assert.equal(failed.result.error.code, 'provider-request-failed'); assert.equal(failed.result.error.httpStatus, 401);
    assert.equal(failed.result.error.resumeSameState, true);
    for (const value of Object.values(env)) assert.ok(!failed.errors.includes(value));
  }
  const state = await f.invoke('status'); assert.equal(state.result.deployment.status, 'attention');
  const privateState = JSON.parse(await readFile(join(f.directory, 'secrets.json')));
  assert.equal(privateState.runtimeFlyToken, undefined); assert.ok(!JSON.stringify(privateState).includes(env.INK_CLOUD_FLY_TOKEN));
});

test('CLI rejects credential argv, duplicate/implicit paths, unsafe state and changed selected sources with structured errors', async t => {
  const f = await fixture(t), secret = 'private-argv-secret-'.repeat(4);
  for (const argv of [['apply', ...f.args, '--token', secret], ['plan', ...f.args, '--state', f.directory], ['plan'], ['previous-app-id']]) {
    const result = await f.invoke('unused', { argv }); assert.equal(result.status, 1); assert.ok(!result.errors.includes(secret)); assert.equal(result.result.ok, false);
  }
  await f.invoke('plan');
  await chmod(f.directory, 0o755); const insecure = await f.invoke('status'); assert.equal(insecure.result.error.code, 'cloud-setup-input-or-private-state-error'); await chmod(f.directory, 0o700);
  await writeFile(join(f.platform, 'infra/edge/game-assets.mjs'), 'export default { changed: true };');
  const changed = await f.invoke('resume'); assert.equal(changed.result.error.code, 'journal-inputs-changed');
});

test('TLS choice must precede planning, and explicit private runtime credential correction keeps the same instance', async t => {
  const f = await fixture(t), config = JSON.parse(await readFile(f.configPath));
  delete config.cloudflare.tls; await writeFile(f.configPath, JSON.stringify(config));
  const invalid = await f.invoke('plan'); assert.equal(invalid.result.error.code, 'invalid-cloud-config-file'); assert.match(invalid.result.error.hint, /tls must explicitly/);
  config.cloudflare.tls = 'existing'; await writeFile(f.configPath, JSON.stringify(config));
  const planned = await f.invoke('plan'), runtimeToken = 'corrected-private-runtime-token-'.repeat(3); let reads = 0;
  const corrected = await f.invoke('replace-runtime-credential', { env: { INK_CLOUD_RUNTIME_FLY_TOKEN: runtimeToken }, fetch: async (url, options) => {
    reads++; assert.equal(url, 'https://api.machines.dev/v1/apps?org_slug=proof-org'); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, `Bearer ${runtimeToken}`);
    return Response.json({ apps: [] });
  } });
  assert.equal(corrected.status, 0); assert.equal(reads, 1); assert.equal(corrected.result.deployment.instanceId, planned.result.deployment.instanceId);
  assert.equal(corrected.result.deployment.acceptance.runtimeCredential.capability, 'inventory-read'); assert.equal(corrected.result.deployment.acceptance.pooledBackendCanary, 'pending');
  assert.ok(!corrected.output.includes(runtimeToken)); assert.equal(JSON.parse(await readFile(join(f.directory, 'secrets.json'))).runtimeFlyToken, runtimeToken);
});

test('verify requires an explicit phase/selected source and never accepts passed JSON or credentials in argv', async t => {
  const f = await fixture(t); await f.invoke('plan');
  for (const extra of [[], ['--phase', 'passed'], ['--phase', 'run', '--proof', 'passed.json'], ['--phase', 'run', '--token', 'never-serialize-this-private-value']]) {
    const result = await f.invoke('verify', { argv: ['verify', ...f.args, ...extra] }); assert.equal(result.status, 1); assert.ok(!result.errors.includes('never-serialize-this-private-value'));
  }
  const premature = await f.invoke('verify', { argv: ['verify', ...f.args, '--phase', 'run'], fetch: () => assert.fail('unprovisioned verifier must be offline') });
  assert.equal(premature.result.error.code, 'provision-cloud-before-hosted-verification');
  const journal = JSON.parse(await readFile(join(f.directory, 'journal.json')));
  for (const step of journal.plan.steps) journal.steps[step] = { status: 'done', attempt: '0'.repeat(32), receipt: { id: step } };
  journal.storageProof = { stage: 'complete' }; journal.status = 'acceptance-pending';
  await writeFile(join(f.directory, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  for (const command of ['apply', 'resume']) {
    const result = await f.invoke(command, { fetch: () => assert.fail('completed provisioning is offline') });
    assert.equal(result.status, 0); assert.equal(result.result.deployment.status, 'acceptance-pending'); assert.equal(result.result.deployment.provisioning.status, 'complete');
  }
  const changed = await f.invoke('apply', { env: { INK_CLOUD_RUNTIME_FLY_TOKEN: 'different-private-runtime-token-'.repeat(3) }, fetch: () => assert.fail('credential comparison is offline') });
  assert.equal(changed.result.error.code, 'runtime-token-change-requires-explicit-correction');
  assert.equal((await f.invoke('status')).result.deployment.status, 'acceptance-pending');
});

test('package commands and documented cloud JSON execute the actual offline CLI without changing Compose entry points', async t => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url))), readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(metadata.bin['ink-os-cloud'], 'cli/cloud.mjs');
  assert.equal(metadata.scripts.cloud, 'node cli/cloud.mjs'); assert.equal(metadata.scripts['check:cloud'], 'node --test tests/cloud-*.test.mjs');
  assert.equal(metadata.scripts.test, 'node --test tests/*.test.mjs');
  assert.equal(metadata.scripts.up, 'docker compose up --build -d --wait'); assert.equal(metadata.scripts.down, 'docker compose down');
  assert.equal(metadata.scripts.status, 'docker compose ps'); assert.equal(metadata.scripts.logs, 'docker compose logs -f'); assert.equal(metadata.scripts.check, 'node scripts/check.mjs');
  const example = readme.match(/```json\n([\s\S]*?)\n```/); assert.ok(example, 'README has a runnable JSON configuration example');
  const f = await fixture(t); await writeFile(f.configPath, example[1]);
  const result = await f.invoke('plan', { fetch() { throw Error('documented plan must be offline'); } });
  assert.equal(result.status, 0); assert.equal(result.result.deployment.status, 'planned'); assert.equal(result.result.deployment.tls.mode, JSON.parse(example[1]).cloudflare.tls);
  assert.ok(result.result.deployment.acceptanceRequired.includes('pooled-backend-canary-and-cleanup')); assert.match(readme, /acceptance-pending/);
  const cli = fileURLToPath(new URL('../' + metadata.bin['ink-os-cloud'], import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { env: {}, encoding: 'utf8' }); assert.equal(help.status, 0, help.stderr);
  const contract = JSON.parse(help.stdout); for (const command of ['plan', 'apply', 'resume', 'status', 'replace-runtime-credential', 'verify', 'prepare-restart', '--restart-receipt']) assert.ok(contract.usage.includes(command));
  assert.deepEqual(contract.upgradeActions, ['plan', 'run', 'resume', 'status', 'verify', 'cancel', 'abandon']);
  if (process.platform !== 'win32') assert.equal((await stat(cli)).mode & 0o111, 0o111);
});
