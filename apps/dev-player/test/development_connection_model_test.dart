import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:weapp_container_dev_player/src/player_model.dart';

import 'protocol_test.dart' as fixtures;

class _OwnedSupport extends PathProviderPlatform {
  _OwnedSupport(this.path);
  final String path;
  @override
  Future<String?> getApplicationSupportPath() async => path;
}

class _GatedSecureStorage extends FlutterSecureStorage {
  final values = <String, String>{};
  Completer<void>? nextWrite;
  Completer<void>? writeEntered;

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    final gate = nextWrite;
    nextWrite = null;
    if (gate != null) {
      writeEntered?.complete();
      await gate.future;
    }
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => values[key];
}

void main() {
  late Directory owned;
  late PathProviderPlatform priorPaths;
  late PlayerModel model;
  late HttpServer service;
  late HttpServer alternateService;
  late String ticket;
  late String alternateTicket;
  late _GatedSecureStorage secureStorage;
  final sockets = <WebSocket>[];
  final received = <Map>[];
  var pairs = 0;
  Completer<void>? nextAuthorization;
  Completer<void>? authorizationEntered;

  Future<void> until(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!condition()) {
      if (DateTime.now().isAfter(deadline))
        fail('Loopback connection condition timed out');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  setUp(() async {
    owned = await Directory.systemTemp.createTemp('weapp-connection-test-');
    final certificate = File('${owned.path}/certificate.pem');
    final key = File('${owned.path}/key.pem');
    final generated = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key.path,
      '-out',
      certificate.path,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    expect(generated.exitCode, 0);
    final tls = SecurityContext()
      ..useCertificateChain(certificate.path)
      ..usePrivateKey(key.path);
    final fingerprint = sha256
        .convert(
          base64.decode(
            (await certificate.readAsLines())
                .where((line) => !line.startsWith('---'))
                .join(),
          ),
        )
        .toString();
    service = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, tls);
    alternateService = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      tls,
    );
    final endpoint = Uri(
      scheme: 'https',
      host: '127.0.0.1',
      port: service.port,
    );
    ticket = Uri(
      scheme: 'weapp-container',
      host: 'connect',
      queryParameters: {
        'endpoint': endpoint.toString(),
        'fingerprint': fingerprint,
        'code': 'local-test-only',
        'project': 'project',
      },
    ).toString();
    alternateTicket = Uri.parse(ticket)
        .replace(
          queryParameters: {
            ...Uri.parse(ticket).queryParameters,
            'endpoint': endpoint
                .replace(port: alternateService.port)
                .toString(),
          },
        )
        .toString();
    pairs = 0;
    nextAuthorization = null;
    authorizationEntered = null;
    sockets.clear();
    received.clear();
    final project = fixtures.fixture().descriptor;
    Future<void> handleRequest(HttpRequest request) async {
      if (request.uri.path == '/v1/events') {
        final socket = await WebSocketTransformer.upgrade(request);
        sockets.add(socket);
        socket.listen(
          (message) => received.add(jsonDecode(message as String) as Map),
        );
        return;
      }
      if (request.uri.path == '/v1/pair') {
        pairs++;
        await request.drain<void>();
        request.response.write(
          jsonEncode({
            'protocolVersion': '1.0',
            'deviceToken': 'test-local-device-token-never-log',
            'projectId': 'project',
            'serverId': 'test-local-server',
          }),
        );
      } else if (request.uri.path == '/v1/project') {
        final gate = nextAuthorization;
        nextAuthorization = null;
        if (gate != null) {
          authorizationEntered?.complete();
          await gate.future;
        }
        request.response.write(
          jsonEncode({...project, 'projectId': 'project'}),
        );
      } else {
        request.response.statusCode = 404;
      }
      await request.response.close();
    }

    service.listen(handleRequest);
    alternateService.listen(handleRequest);
    priorPaths = PathProviderPlatform.instance;
    PathProviderPlatform.instance = _OwnedSupport('${owned.path}/support');
    secureStorage = _GatedSecureStorage();
    model = PlayerModel(secureStorage: secureStorage)..autoUpdate = false;
  });

  tearDown(() async {
    await model.close();
    model.dispose();
    for (final socket in sockets) {
      await socket.close();
    }
    await service.close(force: true);
    await alternateService.close(force: true);
    PathProviderPlatform.instance = priorPaths;
    await owned.delete(recursive: true);
  });

  test('focus-only inactive retains paired WSS; real background suspends until resumed', () async {
    await model.connect(ticket);
    expect(model.connected, true);
    expect(sockets, hasLength(1));
    await model.setAppLifecycle(AppLifecycleState.inactive);
    expect(model.connected, true);
    sockets.single.add(
      jsonEncode({'protocolVersion': '1.0', 'type': 'heartbeat'}),
    );
    await until(() => received.any((value) => value['type'] == 'heartbeat'));
    await model.setAppLifecycle(AppLifecycleState.resumed);
    expect(sockets, hasLength(1));
    await model.setAppLifecycle(AppLifecycleState.paused);
    expect(model.connected, false);
    await model.setAppLifecycle(AppLifecycleState.inactive);
    expect(model.connected, false);
    expect(sockets, hasLength(1));
    await model.setAppLifecycle(AppLifecycleState.resumed);
    expect(model.connected, true);
    expect(sockets, hasLength(2));
    expect(pairs, 1);
    expect(
      model.controller,
      isNull,
      reason: 'Connection validation does not create a guest/native session.',
    );
  });

  test('overlapping background/resume and disconnect cannot corrupt the next pairing', () async {
    await model.connect(ticket);
    final transitions = [
      model.setAppLifecycle(AppLifecycleState.paused),
      model.setAppLifecycle(AppLifecycleState.resumed),
      model.setAppLifecycle(AppLifecycleState.paused),
    ];
    await Future.wait(transitions);
    expect(model.connected, false);
    await model.setAppLifecycle(AppLifecycleState.resumed);
    expect(model.connected, true);
    final disconnect = model.disconnect();
    final reconnect = model.connect(ticket);
    await Future.wait([disconnect, reconnect]);
    expect(model.connected, true);
    expect(pairs, 2);
    sockets.last.add(
      jsonEncode({'protocolVersion': '1.0', 'type': 'heartbeat'}),
    );
    await until(() => received.any((value) => value['type'] == 'heartbeat'));
  });

  test('client lifecycle/connection diagnostics are bounded and contain no credentials', () async {
    await model.connect(ticket);
    for (var index = 0; index < 310; index++) {
      await model.setAppLifecycle(
        index.isEven ? AppLifecycleState.inactive : AppLifecycleState.resumed,
      );
    }
    expect(model.logs, hasLength(300));
    final text = model.logs.join('\n');
    expect(text, contains('DEV_LIFECYCLE'));
    expect(text, isNot(contains(ticket)));
    expect(text, isNot(contains('test-local-device-token-never-log')));
    expect(text, isNot(contains('://')));
    expect(sockets, hasLength(1));
  });

  test(
    'an in-flight reconnect cannot block the next native lifecycle transition',
    () async {
      await model.connect(ticket);
      await model.setAppLifecycle(AppLifecycleState.paused);
      final gate = Completer<void>();
      nextAuthorization = gate;
      authorizationEntered = Completer<void>();
      final resume = model.setAppLifecycle(AppLifecycleState.resumed);
      await authorizationEntered!.future;
      final background = model.setAppLifecycle(AppLifecycleState.paused);
      try {
        await background.timeout(const Duration(milliseconds: 200));
        expect(model.connected, false);
      } finally {
        gate.complete();
        await Future.wait([resume, background]);
      }
      expect(sockets, hasLength(1));
      expect(model.connected, false);
    },
  );

  test(
    'a retired pairing cannot overwrite newer saved credentials or history',
    () async {
      final gate = Completer<void>();
      secureStorage.nextWrite = gate;
      secureStorage.writeEntered = Completer<void>();
      final first = model.connect(ticket);
      await secureStorage.writeEntered!.future;
      final replacement = model.connect(alternateTicket);
      final expectedEndpoint = Uri.parse(
        Uri.parse(alternateTicket).queryParameters['endpoint']!,
      );
      try {
        await until(() => model.credentials?.endpoint == expectedEndpoint);
      } finally {
        gate.complete();
        await Future.wait([first, replacement]);
      }
      final saved = jsonDecode(
        secureStorage.values['weapp-dev-player.last-device']!,
      ) as Map;
      expect(saved['endpoint'], expectedEndpoint.toString());
      expect(model.history, [expectedEndpoint.origin]);
      expect(
        jsonDecode(
          await File('${owned.path}/support/history.json').readAsString(),
        ),
        [expectedEndpoint.origin],
      );
      expect(model.connected, true);
      expect(sockets, hasLength(1));
      await model.reconnectSaved();
      expect(model.credentials?.endpoint, expectedEndpoint);
      expect(model.connected, true);
      expect(pairs, 2);
    },
  );
}
