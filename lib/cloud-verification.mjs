import{verifierSources}from './verifier-sources.mjs';
import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { fingerprint } from './cloud-config.mjs';
import { privateDirectory, readPrivateJSON, writePrivateJSON, acquireCloudLock } from './cloud-private.mjs';
import { CloudSetupError } from './cloud-providers.mjs';
import { describeCloudSetup } from './cloud-setup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hex = (value, length = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const fail = code => { throw new CloudSetupError(code); };
const check = (value, code) => { if (!value) fail(code); };
const sources = ['scripts/verify-cloud-host.mjs', 'sdk/src/server.js', 'sdk/src/projects.js', 'sdk/src/workflows.js', 'sdk/src/commands.js', 'sdk/src/live-query.js', 'sdk/src/app-api.js'];
const loaded = new Map();
const complete = journal => journal.plan.steps.every(name => journal.steps[name]?.status === 'done');
const binding = (journal, sourcesHash) => ({ format: 'ink-cloud-verifier-binding-v1', instanceId: journal.identity.id, originSha256: sha(journal.plan.origin), configHash: journal.configHash, artifactHash: journal.artifactHash, planHash: fingerprint(journal.plan), sourcesHash });
const same = (a, b) => fingerprint(a) === fingerprint(b);
const edgeOrigin = (journal, releaseId) => `https://${releaseId}-${journal.identity.appHostSuffix || 'inkos'}.${journal.identity.appDomain}`;

function validateProof(journal, proof) {
  check(proof?.format === 'ink-os-cloud-host-proof-v1' && proof.status === 'passed' && proof.instanceId === journal.identity.id && proof.hostOriginSha256 === sha(journal.plan.origin) && hex(proof.canaryId, 32) && hex(proof.releaseId, 32) && hex(proof.bundleSha256) && proof.edgeOriginSha256 === sha(edgeOrigin(journal, proof.releaseId)), 'hosted-proof-identity-mismatch');
  check(['backendVerified', 'edgeVerified', 'sourcePrivacyVerified', 'quiescentCleanup'].every(name => proof[name] === true) && (proof.appsIncludingArchived === 0 || proof.appsIncludingArchived === 3 && proof.defaultAppsPreserved === 3 && proof.userAppsIncludingArchived === 0) && proof.sourceAssetsRemaining === 0, 'hosted-proof-acceptance-incomplete');
  check(typeof proof.sourceDeletionAcknowledged === 'boolean' && Number.isSafeInteger(proof.removedBlobs) && proof.removedBlobs >= 0 && typeof proof.restartExternallyAttested === 'boolean' && proof.persistenceAfterRestartHookVerified === proof.restartExternallyAttested && (proof.restartExternallyAttested ? hex(proof.restartAttestationSha256) : proof.restartAttestationSha256 === null), 'hosted-proof-flags-invalid');
  return proof;
}

/** Historical acceptance only: status never replays empty-host mutations on an installed computer. */
export function cloudVerificationSummary(journal) {
  const receipt = journal.verification;
  if (!receipt) return null;
  check(complete(journal) && journal.storageProof?.stage === 'complete', 'invalid-hosted-verification-receipt');
  check(receipt.format === 'ink-cloud-verification-receipt-v1' && hex(receipt.binding?.sourcesHash) && same(receipt.binding, binding(journal, receipt.binding.sourcesHash)) && receipt.proofHash === fingerprint(receipt.proof) && receipt.receiptHash === fingerprint({ binding: receipt.binding, proofHash: receipt.proofHash, recordedAt: receipt.recordedAt }) && Number.isFinite(Date.parse(receipt.recordedAt)) && new Date(receipt.recordedAt).toISOString() === receipt.recordedAt, 'invalid-hosted-verification-receipt');
  const proof = validateProof(journal, receipt.proof);
  check(proof.sourceDeletionAcknowledged && proof.removedBlobs >= 1, 'hosted-proof-storage-acknowledgement-pending');
  return { pooledBackendCanary: 'passed', edgeOrigins: 'passed', sourcePrivacy: 'passed', sourceCleanup: 'passed', installedCanaryApps: 'zero-after-cleanup', restartPersistence: proof.restartExternallyAttested ? 'passed-with-external-attestation' : 'pending', proofSha256: receipt.proofHash, verifierSourcesSha256: receipt.binding.sourcesHash, recordedAt: receipt.recordedAt };
}

async function selectedVerifier(platformRoot) {
  check(typeof platformRoot === 'string' && platformRoot.length > 0, 'explicit-selected-platform-root-required');
  const root = resolve(platformRoot);
  check(await realpath(root) === root, 'selected-platform-verifier-path-invalid');
  const {hashes}=await verifierSources(root,sources[0]);
  const sourcesHash = fingerprint(hashes), previous = loaded.get(root);
  check(!previous || previous.sourcesHash === sourcesHash, 'selected-verifier-sources-changed-restart-process');
  if (previous) return previous;
  // The selected checkout is executable trusted input, not an upload of a purported proof.
  const module = await import(pathToFileURL(join(root, sources[0])).href + '?ink_cloud_verifier=' + sourcesHash);
  check(typeof module.verifyCloudHost === 'function', 'selected-platform-verifier-export-required');
  const result = { sourcesHash, verify: module.verifyCloudHost }; loaded.set(root, result); return result;
}

async function optionalJSON(path) { try { return await readPrivateJSON(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function health(fetcher, origin, instanceId) {
  const response = await fetcher(new URL('/api/health', origin), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  check(response.ok, 'hosted-verification-health-not-ready');
  let size = 0; const chunks = [];
  for await (const bytes of response.body || []) { size += bytes.length; check(size <= 65536, 'hosted-verification-health-response-limit'); chunks.push(Buffer.from(bytes)); }
  let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { fail('hosted-verification-health-invalid'); }
  check(value.ok === true && value.draining !== true && value.instanceId === instanceId, 'hosted-verification-instance-mismatch');
}

/** Calls the selected platform's actual owner-SDK verifier. Never restarts or calls provider APIs.
 * New canaries require the verifier's initial EMPTY catalog guard, including archived apps.
 * Completed historical proofs are read by status; reruns cannot erase readiness or touch user apps.
 */
export async function verifyCloudSetup({ directory, config, artifacts, platformRoot, phase, restartReceipt, fetch: transport = globalThis.fetch } = {}) {
  check(['run', 'prepare-restart', 'resume', 'cleanup'].includes(phase), 'explicit-hosted-verification-phase-required');
  check((phase === 'resume') === (typeof restartReceipt === 'string' && restartReceipt.length > 0), 'restart-receipt-only-for-explicit-resume');
  const root = await privateDirectory(directory), unlock = await acquireCloudLock(root);
  let journal;
  try {
    const setup = await describeCloudSetup({ directory: root, config, artifacts });
    check(setup.generation === 0 && !setup.activeUpgrade, 'hosted-verification-original-generation-only');
    journal = await readPrivateJSON(join(root, 'journal.json'));
    check(complete(journal) && journal.steps.health?.status === 'done' && journal.storageProof?.stage === 'complete', 'provision-cloud-before-hosted-verification');
    const prior = cloudVerificationSummary(journal);
    check(prior?.restartPersistence !== 'passed-with-external-attestation', 'hosted-verification-already-recorded-use-status');
    const selected = await selectedVerifier(platformRoot), wantedBinding = binding(journal, selected.sourcesHash);
    let attempt = journal.verificationAttempt;
    if (attempt) check(hex(attempt.id, 32) && ['running', 'awaiting-restart', 'complete'].includes(attempt.status) && (attempt.status === 'complete' || same(attempt.binding, wantedBinding)), 'hosted-verification-inputs-changed');
    if (!attempt || attempt.status === 'complete') {
      check(phase === 'run' || phase === 'prepare-restart', 'hosted-verification-active-attempt-required');
      check(!prior || phase === 'prepare-restart', 'hosted-verification-already-recorded-use-status');
      const parent = await privateDirectory(join(root, 'hosted-verification')), id = randomBytes(16).toString('hex');
      await mkdir(join(parent, id), { mode: 0o700 });
      attempt = { id, binding: wantedBinding, status: 'running', phase, startedAt: new Date().toISOString() };
      journal.verificationAttempt = attempt; await writePrivateJSON(join(root, 'journal.json'), journal);
    }
    const path = await privateDirectory(join(root, 'hosted-verification', attempt.id)), journalFile = join(path, 'journal.json'), output = join(path, 'proof.json');
    const saved = await optionalJSON(journalFile);
    if (saved) check(saved.format === 'ink-os-cloud-host-journal-v1' && saved.host === journal.plan.origin && saved.instanceId === journal.identity.id, 'hosted-verification-journal-identity-mismatch');
    if (phase === 'resume') check(attempt.status === 'awaiting-restart' && (saved?.phase === 'awaiting-restart' || saved?.phase === 'complete' && saved.proof?.persistenceAfterRestartHookVerified === true), 'hosted-verification-restart-not-prepared');
    if (attempt.status === 'awaiting-restart' && phase !== 'resume' && phase !== 'cleanup') fail('hosted-verification-restart-receipt-required');
    const secrets = await readPrivateJSON(join(root, 'secrets.json'));
    check(secrets.format === 'ink-cloud-secrets-v1' && same(secrets.identity, journal.identity) && secrets.configHash === journal.configHash && secrets.artifactHash === journal.artifactHash && typeof secrets.ownerToken === 'string' && secrets.ownerToken.length >= 32 && !/[\r\n]/.test(secrets.ownerToken), 'private-state-inputs-mismatch');
    let receipt, receiptPath;
    if (phase === 'resume') {
      receipt = await readPrivateJSON(resolve(restartReceipt));
      check(receipt?.format === 'ink-os-cloud-restart-receipt-v1' && Object.keys(receipt).sort().join(',') === 'challenge,completedAt,evidenceSha256,format,instanceId' && receipt.instanceId === journal.identity.id && receipt.challenge === saved.restartChallenge && hex(receipt.evidenceSha256) && Number.isFinite(Date.parse(receipt.completedAt)) && Date.parse(receipt.completedAt) >= Date.parse(saved.restartPreparedAt) && Date.parse(receipt.completedAt) <= Date.now() + 60000, 'hosted-verification-restart-receipt-invalid');
      receiptPath = join(path, 'restart-receipt.json'); await writePrivateJSON(receiptPath, receipt);
    }
    const scopedFetch = async (input, init = {}) => {
      const url = new URL(input), authorization = new Headers(init.headers).get('authorization');
      check(!url.username && !url.password && url.protocol === 'https:', 'hosted-verification-origin-refused');
      if (url.origin === journal.plan.origin) check(!authorization || authorization === 'Bearer ' + secrets.ownerToken, 'hosted-verification-credential-refused');
      else {
        const current = await readPrivateJSON(journalFile);
        check(hex(current.releaseId, 32) && url.origin === edgeOrigin(journal, current.releaseId) && !authorization, 'hosted-verification-origin-refused');
      }
      return transport(input, { ...init, redirect: 'manual' });
    };
    // Check saved deployment identity without owner credentials before any authenticated request.
    await health(scopedFetch, journal.plan.origin, journal.identity.id);
    const proof = await selected.verify({ url: journal.plan.origin, token: secrets.ownerToken, journal: journalFile, output, phase, ...(receiptPath ? { restartReceipt: receiptPath } : {}), fetch: scopedFetch });
    check(same(proof, await readPrivateJSON(output)), 'hosted-verifier-output-mismatch');
    const completed = await readPrivateJSON(journalFile);
    check(completed.instanceId === journal.identity.id && completed.host === journal.plan.origin && completed.initialCatalogVerified === true && proof.canaryId === completed.appId, 'hosted-verification-journal-identity-mismatch');
    if (proof.status === 'awaiting-restart') {
      check(phase === 'prepare-restart' && completed.phase === 'awaiting-restart' && proof.instanceId === journal.identity.id && hex(proof.challenge) && proof.challenge === completed.restartChallenge && proof.backendVerified === true && proof.edgeVerified === true && proof.quiescent === true && proof.restartVerified === false, 'hosted-verification-restart-challenge-invalid');
      Object.assign(attempt, { status: 'awaiting-restart', phase, challenge: proof.challenge });
      await writePrivateJSON(join(root, 'journal.json'), journal);
      return { status: 'awaiting-restart', instanceId: journal.identity.id, challenge: proof.challenge, restartPersistence: 'pending', canaryCleanup: 'pending', externalRestartRequired: true };
    }
    check(completed.phase === 'complete' && same(completed.proof, proof), 'hosted-verification-journal-incomplete');
    Object.assign(attempt, { status: 'complete', phase, completedAt: new Date().toISOString() });
    if (proof.status === 'cleaned' && phase === 'cleanup') {
      await writePrivateJSON(join(root, 'journal.json'), journal); return { status: 'cleaned', instanceId: journal.identity.id, acceptance: 'pending' };
    }
    try { validateProof(journal, proof); }
    catch (error) { await writePrivateJSON(join(root, 'journal.json'), journal); throw error; }
    check(!receipt || proof.restartExternallyAttested && proof.restartAttestationSha256 === fingerprint(receipt), 'hosted-verification-restart-proof-mismatch');
    if (!proof.sourceDeletionAcknowledged || proof.removedBlobs < 1) {
      await writePrivateJSON(join(root, 'journal.json'), journal); fail('hosted-proof-storage-acknowledgement-pending');
    }
    const recordedAt = new Date().toISOString(), proofHash = fingerprint(proof);
    // Close the attempt and publish its receipt in ONE atomic journal write. A crash before
    // this write can re-enter the actual verifier's completed journal on the same attempt.
    journal.verification = { format: 'ink-cloud-verification-receipt-v1', binding: wantedBinding, proof, proofHash, recordedAt, receiptHash: fingerprint({ binding: wantedBinding, proofHash, recordedAt }) };
    journal.status = proof.restartExternallyAttested ? 'ready' : 'acceptance-pending';
    await writePrivateJSON(join(root, 'journal.json'), journal);
    return { status: journal.status, instanceId: journal.identity.id, acceptance: cloudVerificationSummary(journal) };
  } catch (error) {
    if (error instanceof CloudSetupError) throw error;
    // Verifier errors are allowlisted codes; source paths, requests, tokens and raw causes never escape.
    if (/^INK_CLOUD_PROOF_[A-Z0-9_]+$/.test(error.code || '')) throw new CloudSetupError('hosted-verifier-' + error.code.toLowerCase().replaceAll('_', '-'));
    throw new CloudSetupError('hosted-verification-failed-resume-same-state');
  } finally { await unlock(); }
}
