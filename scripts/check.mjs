import { readFile } from 'node:fs/promises';
const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
if (!compose.includes('ink-data:/data') || !compose.includes('127.0.0.1') || !compose.includes('healthcheck:')) throw Error('Container persistence, local bind, and health check are required.');
console.log('Container source configuration checks passed. Run docker compose config and a real container smoke test before release.');
