/**
 * Helpers for classifying platform runtime logs.
 *
 * Harmony's `hilog -x` command returns the complete device log.  Callers must
 * filter crash markers to the app process before applying a runtime gate;
 * otherwise unrelated system lines such as `OnDemandReason:` can invalidate
 * a successful WEAPP_CONTAINER_SMOKE run.
 */

export function hasHarmonyRuntimeCrash(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => /(?:WEAPP_CONTAINER_SMOKE|JSAPP|ArkTS|com\.sonofmagic\.weapp\.container)/.test(line))
    .some(line => /\b(?:TypeError|ReferenceError|Error name:|Reason:)/.test(line))
}

