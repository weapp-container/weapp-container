import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyNativeProducerFiles } from './sdk-current-release.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const headers = ['weapp_container_sdk.h', 'weapp_container_sdk_gl.h'];

/** Stage the complete reviewed C ABI closure from one exact native producer. */
export function stageCConsumerNativeInput({ nativeDirectory, contractDirectory, target, destination }) {
  const receiptBytes = readFileSync(resolve(nativeDirectory, 'build.json'));
  const receipt = verifyNativeProducerFiles(nativeDirectory, JSON.parse(receiptBytes), target);
  const library = target.endsWith('apple-darwin') ? 'libweapp_container_sdk.dylib' : 'libweapp_container_sdk.so';
  const selected = [library, ...headers].map(file => {
    const record = receipt.artifacts.find(value => value.file === file);
    if (!record) throw Error(`C consumer requires an inventoried native input: ${file}`);
    const bytes = readFileSync(resolve(nativeDirectory, file));
    if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw Error(`Native artifact hash/size mismatch: ${file}`);
    if (headers.includes(file) && sha(readFileSync(resolve(contractDirectory, file))) !== record.sha256) throw Error(`Native public header differs from the reviewed C contract: ${file}`);
    return { ...record, bytes };
  });
  for (const { file, bytes } of selected) {
    const parent = resolve(destination, headers.includes(file) ? 'include' : 'lib');
    mkdirSync(parent, { recursive: true });
    writeFileSync(resolve(parent, file), bytes, { flag: 'wx' });
  }
  return { receipt, library, receiptSha256: sha(receiptBytes), files: selected.map(({ file, bytes, sha256 }) => ({ file, bytes: bytes.length, sha256 })) };
}

export function cConsumerCompileArguments({ directory, target, sdkVersion }) {
  const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', `-DWEAPP_TEST_SDK_VERSION="${sdkVersion}"`,
    '-I', resolve(directory, 'include'), resolve(directory, 'consumer.c'),
    '-L', resolve(directory, 'lib'), '-lweapp_container_sdk', '-o', resolve(directory, 'bin/consumer')];
  if (target.endsWith('apple-darwin')) args.push('-arch', target.startsWith('aarch64') ? 'arm64' : 'x86_64', '-mmacosx-version-min=12.0', '-Wl,-rpath,@executable_path/../lib');
  else args.push('-Wl,-rpath,$ORIGIN/../lib');
  return args;
}
