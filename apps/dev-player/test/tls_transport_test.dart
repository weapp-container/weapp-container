import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';

void main() {
  late Directory owned;
  late HttpServer server;
  late Uri endpoint;
  late String fingerprint;
  final sockets = <WebSocket>[];
  final transports = <DeviceTransport>[];
  final requests = <String>[];

  setUpAll(() async {
    owned = await Directory.systemTemp.createTemp('weapp-player-tls-test-');
    final key = '${owned.path}/test-key.pem';
    final cert = '${owned.path}/test-certificate.pem';
    final generated = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    if (generated.exitCode != 0)
      throw StateError('Could not generate an ephemeral TLS test certificate.');
    final pem = await File(cert).readAsString();
    final der = base64.decode(
      pem.split('\n').where((line) => !line.startsWith('---')).join(),
    );
    fingerprint = sha256.convert(der).toString();
    final context = SecurityContext()
      ..useCertificateChain(cert)
      ..usePrivateKey(key);
    server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context,
    );
    endpoint = Uri(scheme: 'https', host: '127.0.0.1', port: server.port);
    server.listen((request) async {
      requests.add(request.uri.path);
      if (request.uri.path == '/v1/pair') {
        final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map;
        expect(body['protocolVersion'], '1.0');
        expect(body['code'], 'ephemeral-pairing-code');
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'protocolVersion': '1.0',
            'deviceToken': 'test-device-token',
            'projectId': 'test-project',
            'serverId': 'test-server',
          }),
        );
      } else if (request.uri.path == '/v1/events') {
        expect(
          request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer test-device-token',
        );
        final socket = await WebSocketTransformer.upgrade(request);
        sockets.add(socket);
        socket.add(jsonEncode({'protocolVersion': '1.0', 'type': 'ready'}));
        return;
      } else if (request.uri.path == '/v1/project') {
        expect(
          request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer test-device-token',
        );
        request.response.statusCode = 204;
      } else if (request.uri.path == '/v1/redirect') {
        request.response.statusCode = 302;
        request.response.headers.set(
          HttpHeaders.locationHeader,
          '${endpoint.origin}/v1/should-not-follow',
        );
      } else if (request.uri.path == '/v1/revoked') {
        request.response.statusCode = 401;
      } else {
        request.response.add(List.filled(32, 7));
      }
      await request.response.close();
    });
  });
  tearDown(() {
    for (final transport in transports) {
      transport.close();
    }
    transports.clear();
  });
  tearDownAll(() async {
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
    await owned.delete(recursive: true);
  });
  DeviceTransport transport([String? pin]) {
    final value = DeviceTransport(endpoint, pin ?? fingerprint);
    transports.add(value);
    return value;
  }

  test('real TLS pairing and HTTPS use exact pin and scoped bearer', () async {
    final connection = transport();
    final credentials = await connection.pair(
      ConnectionTicket(
        endpoint,
        fingerprint,
        'ephemeral-pairing-code',
        'test-project',
      ),
      'test-device',
    );
    expect(credentials.projectId, 'test-project');
    expect(credentials.toString(), isNot(contains('test-device-token')));
    expect(await connection.json('GET', '/v1/project'), isNull);
    final bytes = await connection.bytes('/v1/blob', maxBytes: 32);
    expect(bytes, List.filled(32, 7));
  });
  test('real WSS handshake uses the same pin and authorization', () async {
    final connection = transport()..authenticate('test-device-token');
    final socket = await connection.events();
    final event = jsonDecode(await socket.first as String) as Map;
    expect(event['type'], 'ready');
    await socket.close();
  });
  test('wrong pin fails before bearer reaches the server', () async {
    final before = requests.length;
    final connection = transport('0' * 64)..authenticate('test-device-token');
    await expectLater(
      connection.json('GET', '/v1/project'),
      throwsA(
        isA<PlayerError>().having((e) => e.code, 'code', 'ERR_DEV_NETWORK'),
      ),
    );
    expect(requests.length, before);
  });
  test(
    'redirect responses are rejected without forwarding authorization',
    () async {
      final connection = transport()..authenticate('test-device-token');
      await expectLater(
        connection.bytes('/v1/redirect', maxBytes: 64),
        throwsA(isA<PlayerError>()),
      );
      expect(requests, isNot(contains('/v1/should-not-follow')));
    },
  );
  test('revoked authorization has a stable re-pair error', () async {
    await expectLater(
      transport().json('GET', '/v1/revoked'),
      throwsA(
        isA<PlayerError>().having((e) => e.code, 'code', 'ERR_DEVICE_AUTH'),
      ),
    );
  });
  test(
    'oversized responses are rejected before entering the pack store',
    () async {
      await expectLater(
        transport().bytes('/v1/blob', maxBytes: 8),
        throwsA(
          isA<PlayerError>().having((e) => e.code, 'code', 'ERR_DEV_BUDGET'),
        ),
      );
    },
  );
}
