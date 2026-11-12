import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/pack_store.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';

Map<String, Object?> descriptor({
  String generation = '1',
  String run = 'aabbccddeeff0011',
  required String manifestHash,
  required String root,
  List<Map<String, Object?>> blobs = const [],
}) => {
  'protocolVersion': '1.0',
  'projectId': 'project',
  'runId': run,
  'generation': generation,
  'manifestSha256': manifestHash,
  'integrityRoot': root,
  'manifestPath': '/v1/generations/$generation/manifest.json',
  'blobsPath': '/v1/blobs/',
  'blobs': blobs,
};

({Uint8List bytes, Map<String, Object?> descriptor}) fixture({
  String generation = '1',
  String run = 'aabbccddeeff0011',
  Map<String, Uint8List> blobs = const {},
  Map<String, Object?>? rendering,
}) {
  final value = <String, Object?>{
    'schemaVersion': rendering == null ? 1 : 3,
    'protocolVersion': '1.0',
    'compiler': {'name': 'fixture', 'commit': 'fixture', 'platform': 'weapp'},
    'app': {'appJson': 'app.json', 'entryModule': 'app.js'},
    'routes': [],
    'modules': [
      for (final blob in blobs.entries)
        {
          'id': blob.key,
          'sha256': sha256.convert(blob.value).toString(),
          'format': 'commonjs',
          'scope': 'app',
        },
    ],
    'templates': [],
    'styles': [],
    'assets': [],
    'capabilities': {},
    if (rendering != null) 'rendering': rendering,
    'integrity': {'algorithm': 'sha256', 'root': ''},
  };
  final root = sha256.convert(utf8.encode(canonicalJson(value))).toString();
  value['integrity'] = {'algorithm': 'sha256', 'root': root};
  final bytes = Uint8List.fromList(utf8.encode('${canonicalJson(value)}\n'));
  return (
    bytes: bytes,
    descriptor: descriptor(
      generation: generation,
      run: run,
      manifestHash: sha256.convert(bytes).toString(),
      root: root,
      blobs: [
        for (final blob in blobs.values)
          {'sha256': sha256.convert(blob).toString(), 'size': blob.length},
      ],
    ),
  );
}

void main() {
  final pin = '1' * 64;
  test('pairing URI validates origin and never reveals code in toString', () {
    final link = Uri(
      scheme: 'weapp-container',
      host: 'connect',
      queryParameters: {
        'endpoint': 'https://127.0.0.1:5180',
        'fingerprint': pin,
        'code': 'sensitive-pair-code',
        'project': 'project',
      },
    );
    final ticket = ConnectionTicket.parse(link.toString());
    expect(ticket.endpoint.origin, 'https://127.0.0.1:5180');
    expect(ticket.toString(), isNot(contains('sensitive-pair-code')));
  });
  test('pairing refuses cleartext and embedded basic-auth credentials', () {
    for (final endpoint in [
      'http://127.0.0.1:5180',
      'https://user:secret@host:5180',
      'https://host:5180/api',
    ]) {
      final link = Uri(
        scheme: 'weapp-container',
        host: 'connect',
        queryParameters: {
          'endpoint': endpoint,
          'fingerprint': pin,
          'code': 'code',
          'project': 'project',
        },
      );
      expect(
        () => ConnectionTicket.parse(link.toString()),
        throwsA(isA<PlayerError>()),
      );
    }
  });
  test(
    'generation uses exact decimal strings and explicit server run identity',
    () {
      final value = fixture().descriptor;
      expect(ProjectGeneration.fromJson(value).ordinal, BigInt.one);
      expect(
        () => ProjectGeneration.fromJson({...value, 'generation': '01'}),
        throwsA(isA<PlayerError>()),
      );
      expect(
        () => ProjectGeneration.fromJson({...value, 'generation': 1}),
        throwsA(isA<PlayerError>()),
      );
      expect(
        () => ProjectGeneration.fromJson({...value, 'runId': null}),
        throwsA(isA<PlayerError>()),
      );
    },
  );
  test(
    'generation refuses resource redirects and duplicated blob identities',
    () {
      final value = fixture().descriptor;
      expect(
        () => ProjectGeneration.fromJson({
          ...value,
          'manifestPath': 'https://other/manifest',
        }),
        throwsA(isA<PlayerError>()),
      );
      expect(
        () => ProjectGeneration.fromJson({
          ...value,
          'blobs': [
            {'sha256': pin, 'size': 1},
            {'sha256': pin, 'size': 1},
          ],
        }),
        throwsA(isA<PlayerError>()),
      );
    },
  );
  test(
    'generation enforces blob count, per-blob size and aggregate budget',
    () {
      final value = fixture().descriptor;
      expect(
        () => ProjectGeneration.fromJson({
          ...value,
          'blobs': [
            {'sha256': pin, 'size': 268435457},
          ],
        }),
        throwsA(isA<PlayerError>()),
      );
      expect(
        () => ProjectGeneration.fromJson({
          ...value,
          'blobs': List.generate(
            5,
            (i) => {'sha256': '$i' * 64, 'size': 64 * 1024 * 1024},
          ),
        }),
        throwsA(isA<PlayerError>()),
      );
      expect(
        () => ProjectGeneration.fromJson({
          ...value,
          'blobs': List.filled(10001, {'sha256': pin, 'size': 0}),
        }),
        throwsA(isA<PlayerError>()),
      );
    },
  );
  test('single blob may use the server project budget but aggregate remains bounded', () {
    final value = fixture().descriptor;
    final descriptor = ProjectGeneration.fromJson({
      ...value,
      'blobs': [
        {'sha256': pin, 'size': 128 * 1024 * 1024},
      ],
    });
    expect(descriptor.blobs[pin], 128 * 1024 * 1024);
  });

  test('manifest validates both original bytes and canonical integrity with blank root', () {
    final f = fixture();
    expect(
      verifyManifest(
        f.bytes,
        ProjectGeneration.fromJson(f.descriptor),
      )['schemaVersion'],
      1,
    );
    final tampered = Uint8List.fromList([...f.bytes, 32]);
    expect(
      () => verifyManifest(tampered, ProjectGeneration.fromJson(f.descriptor)),
      throwsA(isA<PlayerError>()),
    );
  });
  test(
    'manifest independently verifies root even with a matching raw byte hash',
    () {
      final f = fixture();
      final value = jsonDecode(utf8.decode(f.bytes)) as Map;
      value['app'] = {'appJson': 'other.json', 'entryModule': 'app.js'};
      final modified = Uint8List.fromList(utf8.encode(jsonEncode(value)));
      final changed = {
        ...f.descriptor,
        'manifestSha256': sha256.convert(modified).toString(),
      };
      expect(
        () => verifyManifest(modified, ProjectGeneration.fromJson(changed)),
        throwsA(isA<PlayerError>()),
      );
    },
  );
  test('manifest does not silently replace WebView or Skyline profiles', () {
    for (final profile in ['webview', 'skyline-compat']) {
      final f = fixture(
        rendering: {'version': '1.0', 'default': profile, 'pages': {}},
      );
      expect(
        () => verifyManifest(f.bytes, ProjectGeneration.fromJson(f.descriptor)),
        throwsA(
          isA<PlayerError>().having(
            (e) => e.code,
            'code',
            'ERR_UNSUPPORTED_CAPABILITY',
          ),
        ),
      );
    }
  });
  test(
    'manifest inventory must match executable, template and modern references',
    () {
      final data = Uint8List.fromList(utf8.encode('module.exports = {}'));
      final f = fixture(blobs: {'app.js': data});
      expect(
        verifyManifest(
          f.bytes,
          ProjectGeneration.fromJson(f.descriptor),
        )['modules'],
        hasLength(1),
      );
      expect(
        () => verifyManifest(
          f.bytes,
          ProjectGeneration.fromJson({...f.descriptor, 'blobs': []}),
        ),
        throwsA(isA<PlayerError>()),
      );
      final references = manifestBlobHashes({
        'modernView': {
          'units': [
            {
              'executableSha256': '1' * 64,
              'sourceMapSha256': '2' * 64,
              'sources': [
                {'sha256': '3' * 64},
              ],
            },
          ],
        },
      });
      expect(references, {'1' * 64, '2' * 64, '3' * 64});
    },
  );
}
