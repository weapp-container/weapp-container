#!/usr/bin/env node
// Local-only packaging. No compiler, network, registry or GitHub operation.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./package_artifacts.py', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) { console.error(`Packager failed: ${result.error.message}`); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
