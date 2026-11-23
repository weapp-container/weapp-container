export function nativeSourcePathFlags(sourcePathMappings) {
  return sourcePathMappings.flatMap(([source, destination]) => {
    const variants = new Set([source.replaceAll('\\', '/')]);
    if (source.includes('\\')) variants.add(source);
    return [...variants].flatMap(path => [
      `-ffile-prefix-map=${path}=${destination}`,
      `-fmacro-prefix-map=${path}=${destination}`,
    ]);
  });
}

export function msvcSourcePathFlags(sourcePathMappings) {
  return sourcePathMappings.flatMap(([source, destination]) => {
    const variants = new Set([source, source.replaceAll('\\', '/')]);
    return [...variants].map(path => `/pathmap:${path}=${destination}`);
  });
}

export function clangClSourcePathFlags(sourcePathMappings) {
  return sourcePathMappings.flatMap(([source, destination]) => {
    const variants = new Set([source.replaceAll('\\', '/'), source]);
    return [...variants].flatMap(path => [
      `/clang:-ffile-prefix-map=${path}=${destination}`,
      `/clang:-fmacro-prefix-map=${path}=${destination}`,
    ]);
  });
}

export function skiaPathMappingGnArgs(pathFlags) {
  return `extra_cflags += ${JSON.stringify(pathFlags)}`
}
