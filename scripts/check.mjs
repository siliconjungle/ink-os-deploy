import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync('docker', ['compose', '-f', fileURLToPath(new URL('../compose.yaml', import.meta.url)), 'config', '--quiet'], { stdio: 'inherit' });
if (result.error) throw Error('Install Docker Engine with the Compose plugin to validate this deployment.');
process.exitCode = result.status || 0;
