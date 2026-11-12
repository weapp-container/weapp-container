import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container/weapp_container.dart';
import 'package:weapp_container_platform_interface/weapp_container_platform_interface.dart';
import 'package:weapp_container_dev_player/src/host_services.dart';
import 'package:weapp_container_dev_player/src/pack_store.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';

import 'protocol_test.dart' as fixtures;

class HostBoundary extends WeappContainerPlatform {
  final source = StreamController<Map<String, Object?>>.broadcast();
  final calls = <(String, Map<String, Object?>)>[];
  bool supported = true;
  @override
  Stream<Map<String, Object?>> get events => source.stream;
  @override
  Future<void> initialize() async {}
  @override
  Future<T?> invoke<T>(String method, Map<String, Object?> arguments) async {
    calls.add((method, arguments));
    if (method == 'create') return {'id': 1} as T;
    if (method == 'capabilities')
      return {
        if (supported) 'hostServices': {'protocolVersion': '1.0'},
      } as T;
    return null;
  }
}

void main() {
  final pairing = DeviceCredentials(
    endpoint: Uri.parse('https://localhost:5180'),
    fingerprint: '1' * 64,
    deviceToken: 'private-pairing-token',
    projectId: 'project',
    serverId: 'server',
  );
  InstalledGeneration pack({String? project}) {
    final fixture = fixtures.fixture();
    final descriptor = Map<String, Object?>.from(fixture.descriptor);
    if (project != null) descriptor['projectId'] = project;
    return InstalledGeneration(
      ProjectGeneration.fromJson(descriptor),
      Directory('/unused/verified-pack'),
      jsonDecode(utf8.decode(fixture.bytes)) as Map<String, Object?>,
      0,
      'paired-project-key',
    );
  }

  test(
    'development services reject cross-project and altered pack identities',
    () {
      const services = DevelopmentDeviceServices();
      expect(
        () => services.application(pack(project: 'other'), pairing),
        throwsA(isA<PlayerError>()),
      );
      final altered = pack();
      altered.manifest['integrity'] = {'root': '0' * 64};
      expect(
        () => services.application(altered, pairing),
        throwsA(isA<PlayerError>()),
      );
      final trusted = services.application(pack(), pairing);
      expect(trusted['environment'], 'develop');
      expect(jsonEncode(trusted), isNot(contains(pairing.deviceToken)));
      expect(trusted.containsKey('principalId'), isFalse);
    },
  );
  test(
    'old runtime is rejected before any host service registration',
    () async {
      final native = HostBoundary()..supported = false;
      WeappContainerPlatform.instance = native;
      final controller = await WeappContainerController.create(
        storageKey: null,
      );
      await expectLater(
        const DevelopmentDeviceServices().prepare(
          controller,
          pack(),
          pairing,
          newOwner: true,
        ),
        throwsA(isA<PlayerError>()),
      );
      expect(native.calls.map((call) => call.$1), ['create', 'capabilities']);
      await controller.close();
      await native.source.close();
    },
  );
  test('new owners install scoped devices and updates only authorize verified packages', () async {
    final native = HostBoundary();
    WeappContainerPlatform.instance = native;
    final controller = await WeappContainerController.create(storageKey: null);
    const services = DevelopmentDeviceServices();
    await services.prepare(controller, pack(), pairing, newOwner: true);
    expect(native.calls.map((call) => call.$1), [
      'create',
      'capabilities',
      'configureHostServices',
      'installNativeDeviceApis',
    ]);
    final configuration = native.calls[2].$2;
    expect(configuration['account'], {'principalId': null, 'epoch': '1'});
    expect(configuration['apis'], isEmpty);
    expect(
      jsonEncode(native.calls.map((call) => call.$2).toList()),
      isNot(contains(pairing.deviceToken)),
    );
    await services.prepare(controller, pack(), pairing, newOwner: false);
    expect(native.calls.last.$1, 'authorizeInstalledPack');
    await controller.close();
    await native.source.close();
  });
}
