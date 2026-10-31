import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CloudSetupError } from './cloud-providers.mjs';

/** Hash the complete bounded SDK graph before importing the selected verifier. */
export async function verifierSources(root, entry) {
  const check = (value, code = 'selected-verifier-import-closure-unsupported') => { if (!value) throw new CloudSetupError(code); };
  const allowed = path => path === entry || path === 'shared/continuation.mjs' || path === 'shared/distribution-apps.mjs' || path.startsWith('sdk/src/') && /\.(?:js|mjs)$/.test(path);
  const hashes = {}, imports = new Map(), pending = [entry]; let total = 0;
  while (pending.length) {
    const path = pending.pop(); if (Object.hasOwn(hashes, path)) continue;
    check(allowed(path)); check(Object.keys(hashes).length < 33, 'selected-platform-verifier-source-limit');
    const file = join(root, path), info = await lstat(file);
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024 && await realpath(file) === file, 'selected-platform-verifier-path-invalid');
    const bytes = await readFile(file); total += bytes.length; check(total <= 4 * 1024 * 1024, 'selected-platform-verifier-source-limit');
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    // Only the backup client's exact Node checksum import is lazy. Other
    // dynamic resolution remains outside this selected-source contract.
    const text = bytes.toString('utf8'), staticText = path === 'sdk/src/backups.js' ? text.replace(/\bimport\s*\(\s*(['"])node:crypto\1\s*\)/g, 'undefined') : text;
    check(!/\bimport\s*\(/.test(staticText));
    const dependencies = [];
    for (const match of staticText.matchAll(/(?:^|[;\n])\s*(?:import|export)\s*(?:[^;'"\n]*?\bfrom\s*)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) { check(path === entry && ['node:assert/strict','node:crypto','node:fs','node:fs/promises','node:path','node:url'].includes(specifier) || path === 'shared/distribution-apps.mjs' && specifier === 'node:crypto'); continue; }
      check(specifier.startsWith('./') || specifier.startsWith('../'));
      const dependency = relative(root, resolve(dirname(file), specifier)); check(allowed(dependency) && dependency !== entry);
      dependencies.push(dependency); pending.push(dependency);
    }
    imports.set(path, dependencies);
  }
  check(imports.get(entry)?.includes('sdk/src/server.js'));
  return { hashes, imports };
}
