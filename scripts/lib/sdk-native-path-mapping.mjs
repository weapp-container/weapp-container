export function nativeSourcePathFlags(sourcePathMappings, target) {
  if (target.endsWith('-msvc')) {
    return sourcePathMappings.map(([source, destination]) =>
      `/pathmap:${source.replaceAll('\\', '/')}=${destination}`)
  }
  return sourcePathMappings.map(([source, destination]) =>
    `-ffile-prefix-map=${source}=${destination}`)
}

export function skiaPathMappingGnArgs(pathFlags) {
  return `extra_cflags += ${JSON.stringify(pathFlags)}`
}
