import { createHash } from 'node:crypto';

const slugs = ['finder', 'preview', 'ink-environment'];
export function distributionApps(apps) {
  if (!Array.isArray(apps)) throw Error('Invalid app catalog');
  const selected = apps.filter(app => {
    let meta;
    try { meta = JSON.parse(app.body); } catch { return false; }
    return slugs.includes(meta.slug) && !app.archived && app.kind === 'app'
      && app.id === createHash('sha256').update('ink-os-app:' + meta.slug).digest('hex').slice(0, 32)
      && meta.repository === 'https://github.com/siliconjungle/ink-app-' + meta.slug
      && /^[a-f0-9]{40}$/.test(meta.sourceCommit || '') && /^[a-f0-9]{32}$/.test(meta.releaseId || '');
  });
  if (selected.length && (selected.length !== 3 || new Set(selected.map(app => JSON.parse(app.body).slug)).size !== 3)) throw Error('Incomplete default app catalog');
  return selected;
}
