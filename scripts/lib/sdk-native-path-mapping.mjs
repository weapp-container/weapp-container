export function nativeSourcePathFlags(sourcePathMappings) {
  return sourcePathMappings.map(([source, destination]) =>
    `-ffile-prefix-map=${source.replaceAll('\\', '/')}=${destination}`)
}

export function skiaPathMappingGnArgs(pathFlags) {
  return `extra_cflags += ${JSON.stringify(pathFlags)}`
}
