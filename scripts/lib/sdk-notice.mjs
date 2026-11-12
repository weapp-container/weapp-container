import nativePath from 'node:path';

// Filesystem paths belong to the producer OS; receipt paths are always POSIX.
// Normalize only these trusted, generated relative paths, never reader input.
export function portableNoticePath(root, file, path = nativePath) {
  const relative = path.relative(root, file), parts = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Notice path must remain inside its source directory');
  }
  return parts.join('/');
}

// Notice prefixes alone are insufficient: COPYING.rs is implementation source.
// Keep legal qualifiers such as LICENSE-MIT and COPYING.LIB, but reject known
// source, build, archive, credential and compiled-file suffixes.
const nonNoticeExtensions = new Set(`
  rs c h cc hh cpp hpp cxx hxx c++ h++ m mm s asm inc
  js mjs cjs jsx ts mts cts tsx py pyi pyw rb go java kt kts swift cs
  fs fsx vb scala sc dart vue svelte css scss sass less
  json jsonl toml yaml yml xml sh bash zsh fish ps1 bat cmd cmake mak mk
  gradle sql r lua pl pm php ex exs erl ex beam clj cljs cljc edn
  a so dylib lib dll o obj exe rlib rmeta wasm jar zip tar gz tgz xz bz2
  zst 7z class pyc pyo p12 p8 pem key mobileprovision
`.trim().split(/\s+/));

export function isNoticeFileName(name) {
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name) || !/^(?:licen[cs]e|copying|notice|copyright)(?:[._-][A-Za-z0-9._+-]+)?$/i.test(name)) return false;
  // COPYING.LIB is an established LGPL notice name, not a Windows .lib archive.
  if (/^copying\.lib$/i.test(name)) return true;
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return !nonNoticeExtensions.has(extension);
}
