import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export async function privateDirectory(directory) {
  const path = resolve(directory);
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) throw Error('Cloud state directory must be private (0700), owned, and have no symbolic links');
  return path;
}

export async function readPrivateJSON(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1024 * 1024) throw Error('Cloud state file must be private (0600), owned, and regular');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle?.close(); }
}

export async function writePrivateJSON(path, value, { exclusive = false } = {}) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.next`;
  let handle;
  try {
    handle = await open(exclusive ? path : temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    if (!exclusive) await rename(temporary, path);
    const directory = await open(resolve(path, '..'), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    if (!exclusive) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function acquireCloudLock(directory) {
  const path = join(directory, 'operation.lock'), nonce = randomBytes(16).toString('hex');
  const record = { nonce, pid: process.pid, host: hostname() };
  try { await writePrivateJSON(path, record, { exclusive: true }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Cloud setup is locked; inspect the lock and use recoverCloudLock only after its owner has exited'); throw error; }
  return async () => { const current = await readPrivateJSON(path); if (current.nonce !== nonce) throw Error('Cloud setup lock ownership changed'); await unlink(path); };
}

// Explicit crash recovery. A live process, remote host, or mismatched nonce is never unlocked.
export async function recoverCloudLock(directory, expectedNonce) {
  const root = await privateDirectory(directory), path = join(root, 'operation.lock'), guard = join(root, 'recovery.lock');
  // Serialize explicit reapers: two stale-lock observers must never unlink a newly acquired live lock.
  await writePrivateJSON(guard, { pid: process.pid, host: hostname() }, { exclusive: true });
  try {
    const record = await readPrivateJSON(path);
    if (!/^[a-f0-9]{32}$/.test(expectedNonce || '') || record.nonce !== expectedNonce || record.host !== hostname() || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw Error('Cloud lock recovery identity mismatch');
    try { process.kill(record.pid, 0); throw Error('Cloud setup lock owner is still running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if ((await readPrivateJSON(path)).nonce !== expectedNonce) throw Error('Cloud setup lock ownership changed');
    await unlink(path);
  } finally { await unlink(guard); }
}
