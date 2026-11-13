import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const meta = JSON.parse(await readFile(new URL('./runtime.json', import.meta.url), 'utf8'));
const binary = await readFile(new URL('./bin/weapp-test-host', import.meta.url));
if (meta.sha256 !== createHash('sha256').update(binary).digest('hex') || meta.engine !== 'quickjs' || !meta.testing) throw new Error('Run pnpm testing:package before packing the runtime');
if (!((await stat(new URL('./bin/weapp-test-host', import.meta.url))).mode & 0o111)) throw new Error('Test host must be executable');
await readFile(new URL('./THIRD_PARTY_NOTICES/licenses.json', import.meta.url));
