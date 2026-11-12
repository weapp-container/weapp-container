import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/pack_store.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';
import 'package:weapp_container_dev_player/src/tab_icons.dart';

import 'protocol_test.dart' as fixtures;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory owned;
  final png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  );
  late InstalledGeneration pack;
  late File blob;
  final chrome = <String, Object?>{
    'tabBar': {
      'visible': true,
      'list': [
        {
          'pagePath': 'pages/home',
          'text': 'Home',
          'iconPath': 'icons/home.png',
          'selectedIconPath': '/icons/home.png',
        },
      ],
    },
  };
  setUp(() async {
    owned = await Directory.systemTemp.createTemp('weapp-player-tab-icon-');
    final digest = sha256.convert(png).toString();
    blob = File('${owned.path}/blobs/sha256/$digest');
    await blob.parent.create(recursive: true);
    await blob.writeAsBytes(png);
    final fixture = fixtures.fixture(blobs: {'icons/home.png': png});
    pack = InstalledGeneration(
      ProjectGeneration.fromJson(fixture.descriptor),
      owned,
      {
        'assets': [
          {
            'path': 'icons/home.png',
            'sha256': digest,
            'size': png.length,
            'mime': 'image/png',
          },
        ],
      },
      0,
      'test-project',
    );
  });
  tearDown(() => owned.delete(recursive: true));

  test('tab icon uses only verified CAS bytes and exports a bounded native reference', () async {
    final catalog = await TabIconCatalog.fromPack(pack, chrome);
    final icon = catalog.resolve('/icons/home.png')!;
    expect(icon.bytes, png);
    expect(icon.path, blob.path);
    final enriched = catalog.enrich(chrome);
    final entry = ((enriched['tabBar'] as Map)['list'] as List).single as Map;
    expect(
      (entry['iconFile'] as Map)['sha256'],
      sha256.convert(png).toString(),
    );
    expect((entry['selectedIconFile'] as Map)['path'], blob.path);
    expect(
      ((chrome['tabBar'] as Map)['list'] as List).single,
      isNot(contains('iconFile')),
    );
  });
  test(
    'changed icon bytes are rejected before a native file path is exported',
    () async {
      await blob.writeAsBytes(List.filled(png.length, 0));
      await expectLater(
        TabIconCatalog.fromPack(pack, chrome),
        throwsA(
          isA<PlayerError>().having(
            (error) => error.code,
            'code',
            'ERR_INVALID_MANIFEST',
          ),
        ),
      );
    },
  );
  test('missing configured paths cannot read arbitrary host files', () async {
    await expectLater(
      TabIconCatalog.fromPack(pack, {
        'tabBar': {
          'list': [
            {'iconPath': '../../outside.png'},
          ],
        },
      }),
      throwsA(
        isA<PlayerError>().having(
          (error) => error.code,
          'code',
          'ERR_INVALID_MANIFEST',
        ),
      ),
    );
  });
  test('unsupported image format is an explicit capability error', () async {
    ((pack.manifest['assets'] as List).single as Map)['mime'] = 'image/svg+xml';
    await expectLater(
      TabIconCatalog.fromPack(pack, chrome),
      throwsA(
        isA<PlayerError>().having(
          (error) => error.code,
          'code',
          'ERR_UNSUPPORTED_CAPABILITY',
        ),
      ),
    );
  });
}
