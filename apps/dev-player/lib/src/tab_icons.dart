import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

import 'pack_store.dart';
import 'protocol.dart';

class VerifiedTabIcon {
  const VerifiedTabIcon(this.path, this.digest, this.mime, this.bytes);
  final String path;
  final String digest;
  final String mime;
  final Uint8List bytes;
  Map<String, Object?> get nativeReference => {
    'path': path,
    'sha256': digest,
    'mime': mime,
    'size': bytes.length,
  };
}

/// Only content-addressed assets from an installed, verified generation may
/// become host chrome images. This never reads or interprets app/page config.
class TabIconCatalog {
  const TabIconCatalog([this.entries = const {}]);
  final Map<String, VerifiedTabIcon> entries;

  static Future<TabIconCatalog> fromPack(
    InstalledGeneration pack,
    Map<String, Object?> chrome,
  ) async {
    final tabBar = chrome['tabBar'];
    final list = tabBar is Map ? tabBar['list'] : null;
    if (list is! List) return const TabIconCatalog();
    final paths = <String>{};
    for (final item in list.whereType<Map>()) {
      for (final name in ['iconPath', 'selectedIconPath']) {
        final value = item[name];
        if (value is String && value.isNotEmpty)
          paths.add(value.replaceFirst(RegExp(r'^/+'), ''));
      }
    }
    final assets = pack.manifest['assets'];
    final records = <String, Map>{};
    if (assets is List) {
      for (final asset in assets.whereType<Map>()) {
        if (asset['path'] is String) records[asset['path'] as String] = asset;
      }
    }
    final result = <String, VerifiedTabIcon>{};
    for (final path in paths) {
      final asset = records[path];
      final digest = asset?['sha256'];
      final length = asset?['size'];
      final mime = asset?['mime'];
      if (digest is! String ||
          !digestPattern.hasMatch(digest) ||
          length is! int ||
          length <= 0 ||
          length > 1024 * 1024 ||
          pack.descriptor.blobs[digest] != length) {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'A configured tab icon is missing or exceeds the host chrome image budget.',
        );
      }
      if (mime != 'image/png' && mime != 'image/jpeg') {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'Host tab icons currently require PNG or JPEG assets.',
        );
      }
      final file = File(p.join(pack.directory.path, 'blobs', 'sha256', digest));
      final Uint8List bytes;
      try {
        final handle = await file.open();
        try {
          bytes = await handle.read(length + 1);
        } finally {
          await handle.close();
        }
      } on FileSystemException {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'A configured tab icon blob is unavailable.',
        );
      }
      if (bytes.length != length ||
          sha256.convert(bytes).toString() != digest) {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'A configured tab icon failed content integrity verification.',
        );
      }
      final png =
          bytes.length >= 8 &&
          bytes[0] == 0x89 &&
          bytes[1] == 0x50 &&
          bytes[2] == 0x4e &&
          bytes[3] == 0x47;
      final jpeg =
          bytes.length >= 3 &&
          bytes[0] == 0xff &&
          bytes[1] == 0xd8 &&
          bytes[2] == 0xff;
      if (mime == 'image/png' && !png || mime == 'image/jpeg' && !jpeg) {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'A configured tab icon does not match its declared image format.',
        );
      }
      final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      ui.ImageDescriptor? descriptor;
      ui.Codec? codec;
      try {
        descriptor = await ui.ImageDescriptor.encoded(buffer);
        if (descriptor.width > 1024 || descriptor.height > 1024) {
          throw const PlayerError(
            'ERR_UNSUPPORTED_CAPABILITY',
            'Host tab icons cannot exceed 1024 pixels per side.',
          );
        }
        codec = await descriptor.instantiateCodec(
          targetWidth: 22,
          targetHeight: 22,
        );
        final frame = await codec.getNextFrame();
        frame.image.dispose();
      } on PlayerError {
        rethrow;
      } catch (_) {
        throw const PlayerError(
          'ERR_INVALID_MANIFEST',
          'A configured tab icon cannot be decoded.',
        );
      } finally {
        codec?.dispose();
        descriptor?.dispose();
        buffer.dispose();
      }
      result[path] = VerifiedTabIcon(file.path, digest, mime as String, bytes);
    }
    return TabIconCatalog(Map.unmodifiable(result));
  }

  VerifiedTabIcon? resolve(Object? path) =>
      path is String ? entries[path.replaceFirst(RegExp(r'^/+'), '')] : null;

  Map<String, Object?> enrich(Map<String, Object?> snapshot) {
    final tabBar = snapshot['tabBar'];
    if (tabBar is! Map || tabBar['list'] is! List) return snapshot;
    return {
      ...snapshot,
      'tabBar': {
        ...tabBar,
        'list': [
          for (final item in (tabBar['list'] as List).whereType<Map>())
            {
              ...item,
              if (resolve(item['iconPath']) case final icon?)
                'iconFile': icon.nativeReference,
              if (resolve(item['selectedIconPath']) case final icon?)
                'selectedIconFile': icon.nativeReference,
            },
        ],
      },
    };
  }
}
