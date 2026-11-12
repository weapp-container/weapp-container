#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { packContainer } from '../src/index.mjs';

function usage() {
  console.error(`Usage: container-pack <weapp-output> --out <directory> [options]

Options:
  --out <dir>                 Output manifest and blobs directory (required)
  --compiler-commit <sha>     weapp-vite commit recorded in compiler.commit
  --capabilities <file>       JSON capability overrides or a capability matrix
  --platform <platform>       Input platform (default: weapp)
  --project <dir>             Source project containing container.config.json
  --config <file>             Project-relative container config path
  --resolve-root <dir>        Installed npm dependency root for a source snapshot
  --diagnostic-json <file>    Write structured errors for development tooling
  --watch-dependencies-json <file>  Write resolved source paths for dev watching
  --help                      Show this message`);
}

function parseArgs(argv) {
  const args = { platform: 'weapp' };
  const positional = [];
  const next = (flag, index) => {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--compiler-commit') args.compilerCommit = argv[++i];
    else if (arg === '--capabilities') args.capabilitiesFile = argv[++i];
    else if (arg === '--platform') args.platform = argv[++i];
    else if (arg === '--project') args.project = next(arg, ++i);
    else if (arg === '--config') args.configFile = next(arg, ++i);
    else if (arg === '--resolve-root') args.resolveRoot = next(arg, ++i);
    else if (arg === '--diagnostic-json') args.diagnosticJson = next(arg, ++i);
    else if (arg === '--watch-dependencies-json') args.watchDependenciesJson = next(arg, ++i);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  args.input = positional[0];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.input || !args.out) {
  usage();
  process.exitCode = 2;
} else {
  try {
    let capabilities;
    if (args.capabilitiesFile) capabilities = JSON.parse(await readFile(path.resolve(args.capabilitiesFile), 'utf8'));
    const result = await packContainer(args.input, args.out, {
      compilerCommit: args.compilerCommit ?? 'unknown',
      platform: args.platform,
      capabilities,
      project: args.project,
      configFile: args.configFile,
      resolveRoot: args.resolveRoot,
    });
    const warnings = result.diagnostics.filter((entry) => entry.severity === 'warning');
    if (args.watchDependenciesJson) await writeFile(path.resolve(args.watchDependenciesJson),
      `${JSON.stringify({ schemaVersion: 1, sources: result.watchDependencies ?? [] })}\n`, 'utf8');
    console.log(`Wrote ${result.manifestPath} (${result.blobCount} content-addressed blobs)`);
    if (warnings.length) console.error(`${warnings.length} warning(s); see diagnostics.json`);
  } catch (error) {
    if (args.diagnosticJson) {
      try {
        await writeFile(path.resolve(args.diagnosticJson), `${JSON.stringify({ code: error.code ?? 'ERR_INVALID_MANIFEST',
          message: error.message, stack: error.stack, diagnostics: error.diagnostics ?? [] })}\n`, 'utf8');
      } catch (reportError) { console.error(`Cannot write diagnostic report: ${reportError.message}`); }
    }
    if (error.diagnostics) {
      for (const item of error.diagnostics) console.error(`${item.severity}: ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`);
    } else console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

