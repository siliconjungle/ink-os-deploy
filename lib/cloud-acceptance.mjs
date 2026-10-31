import { createHash } from 'node:crypto';

// These routes are the actual platform-router/files/deletion contracts. A deterministic, journaled
// file record permits lost-acknowledgement recovery without installing any application.
export function cloudStorageProof({ fetch: fetcher, identity: n, ownerToken, storageToken, error }) {
  const origin = `https://${n.osApp}.fly.dev`, storageOrigin = `https://${n.storageDomain}`;
  const objectId = createHash('sha256').update(`ink-cloud-storage-proof:${n.id}`).digest('hex').slice(0, 32);
  const title = `Ink cloud storage proof ${n.id}`, text = `${title}\n\0\u00ff\u{1f58b}\r\n`;
  const bytes = Buffer.from(text), digest = createHash('sha256').update(bytes).digest('hex');
  const location = `r2://${n.bucket}/objects/${digest}`;
  const fail = code => { throw error(code); };
  async function request(path, { method = 'GET', body, storage = false, missing = false, raw = false, publicHealth = false } = {}) {
    let response;
    try {
      response = await fetcher((storage ? storageOrigin : origin) + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(publicHealth ? {} : { Authorization: `Bearer ${storage ? storageToken : ownerToken}` }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail('os-storage-proof-transport-failed'); }
    if (missing && response.status === 404) { try { await response.body?.cancel(); } catch {} return null; }
    if (!response.ok) { try { await response.body?.cancel(); } catch {} fail('os-storage-proof-request-failed'); }
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 65536) { await reader.cancel(); fail('os-storage-proof-response-too-large'); } chunks.push(value);
      }
      const buffer = Buffer.concat(chunks); return raw ? buffer : JSON.parse(buffer.toString('utf8'));
    } catch { fail('os-storage-proof-invalid-response'); }
  }
  async function identity() {
    const value = await request('/api/health', { publicHealth: true });
    if (value.ok !== true || value.instanceId !== n.id) fail('os-health-instance-mismatch');
  }
  function owned(object) {
    if (!object || object.id !== objectId || object.kind !== 'file' || object.namespace !== 'os' || object.title !== title || !object.tags?.includes('ink-cloud-storage-proof') || !Number.isInteger(object.revision) || object.revision < 1 || object.location && object.location !== location) fail('os-storage-proof-ownership-conflict');
    return object;
  }
  async function absent() {
    if (await request(`/api/v1/data/${objectId}`, { missing: true }) !== null) fail('os-storage-proof-record-cleanup-incomplete');
    if (await request(`/objects/${digest}`, { storage: true, missing: true, raw: true }) !== null) fail('os-storage-proof-r2-cleanup-incomplete');
  }
  return {
    repeatPending: true,
    async probe(journal) {
      if (journal.storageProof?.stage !== 'complete') return null;
      await identity(); await absent(); return { id: objectId, ready: true };
    },
    async create(journal, checkpoint) {
      await identity();
      if (!journal.storageProof) { journal.storageProof = { objectId, digest, stage: 'prepared' }; await checkpoint(); }
      if (journal.storageProof.objectId !== objectId || journal.storageProof.digest !== digest || !['prepared', 'written', 'verified', 'cleanup', 'complete'].includes(journal.storageProof.stage)) fail('invalid-os-storage-proof-journal');
      let object = await request(`/api/v1/data/${objectId}`, { missing: true });
      if (!['verified', 'cleanup', 'complete'].includes(journal.storageProof.stage)) {
        if (!object) object = await request('/api/v1/data', { method: 'POST', body: { id: objectId, kind: 'file', title, body: JSON.stringify({ mime: 'text/plain', originalName: `${objectId}.txt`, bytes: 0 }), tags: ['ink-cloud-storage-proof'] } });
        owned(object); if (object.archived) fail('os-storage-proof-unexpected-archive');
        object = await request(`/api/v1/files/${objectId}/content`, { method: 'PUT', body: { text, expected: object.revision } });
        owned(object); if (object.location !== location) fail('os-storage-proof-managed-r2-required');
        journal.storageProof.stage = 'written'; await checkpoint();
        const viaOS = await request(`/api/v1/files/${objectId}/content`, { raw: true });
        const viaR2 = await request(`/objects/${digest}`, { storage: true, raw: true });
        if (!viaOS.equals(bytes) || !viaR2.equals(bytes)) fail('os-storage-proof-byte-mismatch');
        journal.storageProof.stage = 'verified'; await checkpoint();
      }
      // Persist verified bytes before cleanup so a lost permanent-delete acknowledgement is recoverable.
      journal.storageProof.stage = 'cleanup'; await checkpoint();
      if (object) {
        owned(object);
        if (!object.archived) await request(`/api/v1/files/${objectId}`, { method: 'DELETE' });
        await request(`/api/v1/files/${objectId}?permanent=true`, { method: 'DELETE', missing: true });
      }
      await absent();
      const apps = await request('/api/v1/apps?archived=true');
      if (!Array.isArray(apps) || apps.length) fail('fresh-owner-catalog-not-empty');
      journal.storageProof.stage = 'complete'; await checkpoint();
    },
  };
}
