import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/pack_store.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';

import 'protocol_test.dart' as fixtures;

class FakeTransport implements PackTransport {
  FakeTransport(this.resources);
  final Map<String, Uint8List> resources;
  final requests = <String>[];
  void Function(String path)? onRequest;
  @override
  Future<Uint8List> bytes(String path, {required int maxBytes}) async {
    requests.add(path);
    onRequest?.call(path);
    final data = resources[path]!;
    if (data.length > maxBytes)
      throw const PlayerError(
        'ERR_DEV_BUDGET',
        'Test response exceeds the requested bound.',
      );
    return data;
  }
}

void main() {
  late Directory root;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('weapp-player-pack-test-');
  });
  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });
  test('fresh install publishes complete directory, then reuses verified CAS bytes', () async {
    final data = Uint8List.fromList(utf8.encode('module.exports = {}'));
    final hash = sha256.convert(data).toString();
    final f = fixtures.fixture(blobs: {'app.js': data});
    final descriptor = ProjectGeneration.fromJson(f.descriptor);
    final wire = FakeTransport({
      descriptor.manifestPath: f.bytes,
      '/v1/blobs/$hash': data,
    });
    final store = PackStore(root);
    final first = await store.install(
      descriptor,
      wire,
      serverId: 'server',
      isCurrent: () => true,
    );
    expect(
      await File('${first.directory.path}/manifest.json').readAsBytes(),
      f.bytes,
    );
    expect(
      await File('${first.directory.path}/blobs/sha256/$hash').readAsBytes(),
      data,
    );
    expect(first.downloadedBytes, data.length);
    final second = await store.install(
      descriptor,
      wire,
      serverId: 'server',
      isCurrent: () => true,
    );
    expect(second.downloadedBytes, 0);
    expect(
      wire.requests.where((p) => p.startsWith('/v1/blobs/')),
      hasLength(1),
    );
  });
  test(
    'manifest above 2 MiB remains within the declared 8 MiB wire limit',
    () async {
      final small = fixtures.fixture();
      final value = Map<String, Object?>.from(
        jsonDecode(utf8.decode(small.bytes)) as Map,
      );
      value['fixturePadding'] = 'x' * (2 * 1024 * 1024);
      value['integrity'] = {'algorithm': 'sha256', 'root': ''};
      final rootHash = sha256
          .convert(utf8.encode(canonicalJson(value)))
          .toString();
      value['integrity'] = {'algorithm': 'sha256', 'root': rootHash};
      final bytes = Uint8List.fromList(utf8.encode(canonicalJson(value)));
      final descriptor = ProjectGeneration.fromJson({
        ...small.descriptor,
        'manifestSha256': sha256.convert(bytes).toString(),
        'integrityRoot': rootHash,
      });
      final installed = await PackStore(root).install(
        descriptor,
        FakeTransport({descriptor.manifestPath: bytes}),
        serverId: 'server',
        isCurrent: () => true,
      );
      expect(
        await File('${installed.directory.path}/manifest.json').length(),
        bytes.length,
      );
    },
  );
  test(
    'corrupt new blob leaves the previous complete generation byte-for-byte',
    () async {
      final old = fixtures.fixture();
      final store = PackStore(root);
      final first = await store.install(
        ProjectGeneration.fromJson(old.descriptor),
        FakeTransport({'/v1/generations/1/manifest.json': old.bytes}),
        serverId: 'server',
        isCurrent: () => true,
      );
      final data = Uint8List.fromList([1, 2, 3]);
      final next = fixtures.fixture(generation: '2', blobs: {'app.js': data});
      final hash = sha256.convert(data).toString();
      await expectLater(
        store.install(
          ProjectGeneration.fromJson(next.descriptor),
          FakeTransport({
            '/v1/generations/2/manifest.json': next.bytes,
            '/v1/blobs/$hash': Uint8List.fromList([3, 2, 1]),
          }),
          serverId: 'server',
          isCurrent: () => true,
        ),
        throwsA(isA<PlayerError>()),
      );
      expect(
        await File('${first.directory.path}/manifest.json').readAsBytes(),
        old.bytes,
      );
      final staging = Directory(
        '${first.directory.parent.parent.path}/staging',
      );
      expect(await staging.list().toList(), isEmpty);
    },
  );
  test(
    'superseded download never publishes and owned staging is removed',
    () async {
      final f = fixtures.fixture();
      var current = true;
      final wire = FakeTransport({'/v1/generations/1/manifest.json': f.bytes})
        ..onRequest = (_) => current = false;
      await expectLater(
        PackStore(root).install(
          ProjectGeneration.fromJson(f.descriptor),
          wire,
          serverId: 'server',
          isCurrent: () => current,
        ),
        throwsA(
          isA<PlayerError>().having((e) => e.code, 'code', 'ERR_CANCELLED'),
        ),
      );
      expect(
        await root.list(recursive: true).where((file) => file is File).toList(),
        isEmpty,
      );
    },
  );
  test('same numeric generation from a restarted server has a distinct immutable path', () async {
    final a = fixtures.fixture();
    final b = fixtures.fixture(run: '1122334455667788');
    final store = PackStore(root);
    final installedA = await store.install(
      ProjectGeneration.fromJson(a.descriptor),
      FakeTransport({'/v1/generations/1/manifest.json': a.bytes}),
      serverId: 'server',
      isCurrent: () => true,
    );
    final installedB = await store.install(
      ProjectGeneration.fromJson(b.descriptor),
      FakeTransport({'/v1/generations/1/manifest.json': b.bytes}),
      serverId: 'server',
      isCurrent: () => true,
    );
    expect(installedA.directory.path, isNot(installedB.directory.path));
    expect(await installedA.directory.exists(), isTrue);
  });
  test('tampered installed generation is rejected rather than trusted on reconnect', () async {
    final f = fixtures.fixture();
    final store = PackStore(root);
    final wire = FakeTransport({'/v1/generations/1/manifest.json': f.bytes});
    final installed = await store.install(
      ProjectGeneration.fromJson(f.descriptor),
      wire,
      serverId: 'server',
      isCurrent: () => true,
    );
    await File('${installed.directory.path}/manifest.json').writeAsString('{}');
    await expectLater(
      store.install(
        ProjectGeneration.fromJson(f.descriptor),
        wire,
        serverId: 'server',
        isCurrent: () => true,
      ),
      throwsA(isA<PlayerError>()),
    );
  });
}
