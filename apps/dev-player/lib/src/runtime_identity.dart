/// This value comes from the loaded native library, never the pack, pubspec,
/// wrapper source label or a developer-selected engine configuration.
String nativeSdkVersionLabel(
  Map<String, Object?> capabilities, {
  String unknownLabel = 'Unknown',
}) {
  final version = capabilities['sdkVersion'];
  if (version is! String ||
      version.trim().isEmpty ||
      version.length > 100 ||
      RegExp(r'[\x00-\x1f]').hasMatch(version))
    return unknownLabel;
  return version;
}
