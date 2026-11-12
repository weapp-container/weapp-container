import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

import 'protocol.dart';

String canonicalJson(Object? value) {
  if (value is List) return '[${value.map(canonicalJson).join(',')}]';
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${canonicalJson(value[key])}').join(',')}}';
  }
  return jsonEncode(value);
}

Set<String> manifestBlobHashes(Map<String, Object?> manifest) {
  final hashes = <String>{};
  void add(Object? value, {bool pointer = false}) {
    if (value is! String)
      throw const PlayerError(
        'ERR_INVALID_MANIFEST',
        'Missing blob reference.',
      );
    final hash = pointer && value.startsWith('sha256:')
        ? value.substring(7)
        : value;
    if (!digestPattern.hasMatch(hash) ||
        (pointer && !value.startsWith('sha256:'))) {
      throw const PlayerError(
        'ERR_INVALID_MANIFEST',
        'Invalid blob reference.',
      );
    }
    hashes.add(hash);
  }

  List<Map> list(Object? value) =>
      (value as List? ?? const []).map((v) => v as Map).toList();
  for (final name in ['modules', 'viewScripts', 'assets']) {
    for (final item in list(manifest[name])) {
      add(item['sha256']);
    }
  }
  for (final item in list(manifest['templates'])) {
    add(item['wxmlAst'], pointer: true);
  }
  for (final item in list(manifest['styles'])) {
    add(item['wxssIr'], pointer: true);
  }
  final compiled = manifest['viewCompilation'] as Map?;
  if (compiled != null) {
    for (final module in list(compiled['modules'])) {
      add(module['executableSha256']);
    }
    for (final document in list(compiled['documents'])) {
      for (final expression in list(document['expressions'])) {
        add(expression['executableSha256']);
      }
    }
  }
  final modern = manifest['modernView'] as Map?;
  if (modern != null) {
    for (final unit in list(modern['units'])) {
      add(unit['executableSha256']);
      add(unit['sourceMapSha256']);
      for (final source in list(unit['sources'])) {
        add(source['sha256']);
      }
    }
  }
  return hashes;
}

Map<String, Object?> verifyManifest(
  Uint8List bytes,
  ProjectGeneration descriptor,
) {
  if (sha256.convert(bytes).toString() != descriptor.manifestSha256) {
    throw const PlayerError(
      'ERR_INVALID_MANIFEST',
      'Manifest byte hash does not match the published generation.',
    );
  }
  try {
    final manifest = Map<String, Object?>.from(
      jsonDecode(utf8.decode(bytes)) as Map,
    );
    if (![1, 2, 3].contains(manifest['schemaVersion']) ||
        manifest['protocolVersion'] != '1.0') {
      throw const PlayerError(
        'ERR_PROTOCOL_VERSION',
        'Manifest or bridge version is unsupported.',
      );
    }
    final integrity = manifest['integrity'] as Map;
    if (integrity['algorithm'] != 'sha256' ||
        integrity['root'] != descriptor.integrityRoot) {
      throw const PlayerError(
        'ERR_INVALID_MANIFEST',
        'Manifest integrity declaration is inconsistent.',
      );
    }
    final canonical = {
      ...manifest,
      'integrity': {'algorithm': 'sha256', 'root': ''},
    };
    if (sha256.convert(utf8.encode(canonicalJson(canonical))).toString() !=
        descriptor.integrityRoot) {
      throw const PlayerError(
        'ERR_INVALID_MANIFEST',
        'Manifest integrity root is invalid.',
      );
    }
    final rendering = manifest['rendering'] as Map?;
    if (rendering != null) {
      final profiles = [
        rendering['default'],
        ...(rendering['pages'] as Map).values,
      ];
      if (rendering['version'] != '1.0' ||
          profiles.any((profile) => profile != 'skia')) {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'This Player supports the Skia profile; this pack requires a different renderer.',
        );
      }
    }
    final references = manifestBlobHashes(manifest);
    if (references.length != descriptor.blobs.length ||
        !references.every(descriptor.blobs.containsKey)) {
      throw const PlayerError(
        'ERR_INVALID_MANIFEST',
        'Published blob inventory differs from manifest references.',
      );
    }
    for (final asset in (manifest['assets'] as List? ?? const [])) {
      if (descriptor.blobs[(asset as Map)['sha256']] != asset['size']) {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'Asset size differs from blob inventory.',
        );
      }
    }
    return manifest;
  } on PlayerError {
    rethrow;
  } catch (_) {
    throw const PlayerError('ERR_INVALID_MANIFEST', 'Manifest is malformed.');
  }
}

// Keep isolate closures outside install's context. That context owns the pinned
// HttpClient, which is unsendable even when a closure mentions only its bytes.
Future<Map<String, Object?>> _verifyInBackground(
  Uint8List bytes,
  ProjectGeneration descriptor,
) => Isolate.run(() => verifyManifest(bytes, descriptor));

Future<String> _hashBytesInBackground(Uint8List bytes) =>
    Isolate.run(() => sha256.convert(bytes).toString());

Future<String> _hashFileInBackground(String path) => Isolate.run(
  () async => (await sha256.bind(File(path).openRead()).first).toString(),
);

class InstalledGeneration {
  const InstalledGeneration(
    this.descriptor,
    this.directory,
    this.manifest,
    this.downloadedBytes,
    this.projectKey,
  );
  final ProjectGeneration descriptor;
  final Directory directory;
  final Map<String, Object?> manifest;
  final int downloadedBytes;
  final String projectKey;
}

/// Staging is never given to the runtime. Only an immutable, complete directory
/// is eligible for applyDevPack. Native SDK validation is still mandatory.
class PackStore {
  PackStore(this.root);
  final Directory root;
  String projectKey(String server, String project) =>
      sha256.convert(utf8.encode('$server\u0000$project')).toString();

  Future<InstalledGeneration> install(
    ProjectGeneration descriptor,
    PackTransport transport, {
    required String serverId,
    required bool Function() isCurrent,
    void Function(String phase)? onPhase,
  }) async {
    void check() {
      if (!isCurrent())
        throw const PlayerError(
          'ERR_CANCELLED',
          'A newer generation superseded this download.',
        );
    }

    check();
    final key = projectKey(serverId, descriptor.projectId);
    final projectRoot = Directory(p.join(root.path, key));
    final cache = Directory(p.join(projectRoot.path, 'cas'));
    await cache.create(recursive: true);
    var diskBytes = 0;
    if (await root.exists()) {
      await for (final entity in root.list(
        recursive: true,
        followLinks: false,
      )) {
        if (entity is File) diskBytes += await entity.length();
      }
    }
    final upperBound =
        descriptor.blobs.values.fold<int>(0, (sum, size) => sum + size) * 2;
    if (diskBytes + upperBound > 1024 * 1024 * 1024) {
      throw const PlayerError(
        'ERR_DEV_CACHE_BUDGET',
        'Pack cache would exceed 1 GiB. Clear downloaded project files before retrying.',
      );
    }
    await Directory(p.join(projectRoot.path, 'staging'))
        .create(recursive: true);
    final staging = await Directory(p.join(projectRoot.path, 'staging'))
        .createTemp('g-');
    final finalDirectory = Directory(
      p.join(
        projectRoot.path,
        'generations',
        '${descriptor.runId}-${descriptor.generation}-${descriptor.manifestSha256}',
      ),
    );
    var published = false;
    var downloadedBytes = 0;
    try {
      onPhase?.call('downloading');
      final bytes = await transport.bytes(
        descriptor.manifestPath,
        maxBytes: 8 * 1024 * 1024,
      );
      check();
      if (bytes.length + descriptor.blobs.values.fold<int>(0, (a, b) => a + b) >
          256 * 1024 * 1024) {
        throw const PlayerError(
          'ERR_DEV_BUDGET',
          'Manifest and blobs exceed the 256 MiB project budget.',
        );
      }
      final manifest = await _verifyInBackground(bytes, descriptor);
      check();
      await File(p.join(staging.path, 'manifest.json'))
          .writeAsBytes(bytes, flush: true);
      final blobsDirectory = Directory(p.join(staging.path, 'blobs', 'sha256'));
      await blobsDirectory.create(recursive: true);
      final pending = descriptor.blobs.entries.toList();
      var cursor = 0;
      Future<void> worker() async {
        while (cursor < pending.length) {
          final item = pending[cursor++];
          check();
          final cached = File(p.join(cache.path, item.key));
          var valid = false;
          if (await cached.exists() && await cached.length() == item.value) {
            valid = await _hashFileInBackground(cached.path) == item.key;
          }
          check();
          if (!valid) {
            final data = await transport.bytes(
              '${descriptor.blobsPath}${item.key}',
              maxBytes: item.value,
            );
            check();
            if (data.length != item.value ||
                await _hashBytesInBackground(data) != item.key) {
              throw const PlayerError(
                'ERR_INVALID_MANIFEST',
                'Downloaded blob failed its size or SHA-256 check.',
              );
            }
            check();
            final temporary = File(p.join(staging.path, '${item.key}.part'));
            await temporary.writeAsBytes(data, flush: true);
            if (await cached.exists()) await cached.delete();
            await temporary.rename(cached.path);
            downloadedBytes += data.length;
          }
          check();
          await cached.copy(p.join(blobsDirectory.path, item.key));
        }
      }

      // Both workers settle before staging is removed on failure.
      final results = await Future.wait([
        worker(),
        worker(),
      ], eagerError: false);
      assert(results.length == 2);
      check();
      onPhase?.call('verified');
      await finalDirectory.parent.create(recursive: true);
      if (await finalDirectory.exists()) {
        // Revalidate immutable cached files; never trust directory existence.
        final existingManifest = await File(
          p.join(finalDirectory.path, 'manifest.json'),
        ).readAsBytes();
        verifyManifest(existingManifest, descriptor);
        for (final entry in descriptor.blobs.entries) {
          final existing = File(
            p.join(finalDirectory.path, 'blobs', 'sha256', entry.key),
          );
          if (!await existing.exists() ||
              await existing.length() != entry.value ||
              (await sha256.bind(existing.openRead()).first).toString() !=
                  entry.key) {
            throw const PlayerError(
              'ERR_INVALID_MANIFEST',
              'Previously installed generation was modified.',
            );
          }
        }
      } else {
        await staging.rename(finalDirectory.path);
        published = true;
      }
      check();
      return InstalledGeneration(
        descriptor,
        finalDirectory,
        manifest,
        downloadedBytes,
        key,
      );
    } finally {
      if (!published && await staging.exists())
        await staging.delete(recursive: true);
    }
  }

  Future<void> clear(String serverId, String projectId) async {
    final directory = Directory(
      p.join(root.path, projectKey(serverId, projectId)),
    );
    if (await directory.exists()) await directory.delete(recursive: true);
  }
}
