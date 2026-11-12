import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const deviceProtocolVersion = '1.0';
final digestPattern = RegExp(r'^[a-f0-9]{64}$');

class PlayerError implements Exception {
  const PlayerError(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => '$code: $message';
}

/// The pairing code is deliberately absent from diagnostics and persistence.
class ConnectionTicket {
  const ConnectionTicket(
    this.endpoint,
    this.fingerprint,
    this.code,
    this.projectId,
  );
  final Uri endpoint;
  final String fingerprint;
  final String code;
  final String projectId;

  factory ConnectionTicket.parse(String text) {
    final uri = Uri.tryParse(text.trim());
    if (uri == null ||
        uri.scheme != 'weapp-container' ||
        uri.host != 'connect') {
      throw const PlayerError(
        'ERR_PAIRING_URI',
        'Paste the complete development connection link.',
      );
    }
    final endpoint = Uri.tryParse(uri.queryParameters['endpoint'] ?? '');
    final pin = uri.queryParameters['fingerprint'] ?? '';
    final code = uri.queryParameters['code'] ?? '';
    final project = uri.queryParameters['project'] ?? '';
    if (endpoint == null ||
        endpoint.scheme != 'https' ||
        endpoint.host.isEmpty ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery ||
        endpoint.hasFragment ||
        (endpoint.path.isNotEmpty && endpoint.path != '/') ||
        !digestPattern.hasMatch(pin) ||
        code.isEmpty ||
        code.length > 256 ||
        project.isEmpty ||
        project.length > 256) {
      throw const PlayerError(
        'ERR_PAIRING_URI',
        'Connection link has an invalid endpoint, fingerprint or pairing code.',
      );
    }
    return ConnectionTicket(endpoint.replace(path: ''), pin, code, project);
  }
  @override
  String toString() => 'ConnectionTicket(${endpoint.origin}, [redacted])';
}

class DeviceCredentials {
  const DeviceCredentials({
    required this.endpoint,
    required this.fingerprint,
    required this.deviceToken,
    required this.projectId,
    required this.serverId,
  });
  final Uri endpoint;
  final String fingerprint;
  final String deviceToken;
  final String projectId;
  final String serverId;
  Map<String, Object?> toJson() => {
    'endpoint': endpoint.toString(),
    'fingerprint': fingerprint,
    'deviceToken': deviceToken,
    'projectId': projectId,
    'serverId': serverId,
  };
  factory DeviceCredentials.fromJson(Map<String, Object?> value) {
    final uri = Uri.parse(value['endpoint'] as String);
    final pin = value['fingerprint'] as String;
    final token = value['deviceToken'] as String;
    if (uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        !digestPattern.hasMatch(pin) ||
        token.isEmpty ||
        token.length > 512) {
      throw const PlayerError(
        'ERR_CREDENTIALS',
        'Saved device credentials are invalid.',
      );
    }
    return DeviceCredentials(
      endpoint: uri,
      fingerprint: pin,
      deviceToken: token,
      projectId: value['projectId'] as String,
      serverId: value['serverId'] as String,
    );
  }
  @override
  String toString() => 'DeviceCredentials(${endpoint.origin}, [redacted])';
}

class ProjectGeneration {
  ProjectGeneration._(
    this.projectId,
    this.runId,
    this.generation,
    this.manifestSha256,
    this.integrityRoot,
    this.manifestPath,
    this.blobsPath,
    this.blobs,
  );
  final String projectId;
  final String runId;
  final String generation;
  final String manifestSha256;
  final String integrityRoot;
  final String manifestPath;
  final String blobsPath;
  final Map<String, int> blobs;
  BigInt get ordinal => BigInt.parse(generation);

  factory ProjectGeneration.fromJson(Map<String, Object?> value) {
    if (value['protocolVersion'] != deviceProtocolVersion) {
      throw const PlayerError(
        'ERR_PROTOCOL_VERSION',
        'Device protocol version is not supported.',
      );
    }
    final generation = value['generation'];
    final run = value['runId'];
    final project = value['projectId'];
    final manifest = value['manifestSha256'];
    final root = value['integrityRoot'];
    if (generation is! String ||
        !RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(generation) ||
        run is! String ||
        !RegExp(r'^[a-f0-9]{16,64}$').hasMatch(run) ||
        project is! String ||
        project.isEmpty ||
        project.length > 256 ||
        manifest is! String ||
        !digestPattern.hasMatch(manifest) ||
        root is! String ||
        !digestPattern.hasMatch(root)) {
      throw const PlayerError(
        'ERR_DEV_GENERATION',
        'Malformed generation descriptor.',
      );
    }
    final manifestPath = '/v1/generations/$generation/manifest.json';
    if (value['manifestPath'] != manifestPath ||
        value['blobsPath'] != '/v1/blobs/') {
      throw const PlayerError(
        'ERR_DEV_GENERATION',
        'Unexpected resource endpoint.',
      );
    }
    final entries = value['blobs'];
    if (entries is! List || entries.length > 10000) {
      throw const PlayerError(
        'ERR_DEV_GENERATION',
        'Missing or excessive blob inventory.',
      );
    }
    final blobs = <String, int>{};
    var total = 0;
    for (final raw in entries) {
      if (raw is! Map || raw['sha256'] is! String || raw['size'] is! int) {
        throw const PlayerError('ERR_DEV_GENERATION', 'Malformed blob entry.');
      }
      final hash = raw['sha256'] as String;
      final size = raw['size'] as int;
      if (!digestPattern.hasMatch(hash) ||
          size < 0 ||
          size > 256 * 1024 * 1024 ||
          blobs.containsKey(hash)) {
        throw const PlayerError(
          'ERR_DEV_GENERATION',
          'Invalid or duplicate blob entry.',
        );
      }
      total += size;
      if (total > 256 * 1024 * 1024) {
        throw const PlayerError(
          'ERR_DEV_BUDGET',
          'Project exceeds the 256 MiB download budget.',
        );
      }
      blobs[hash] = size;
    }
    return ProjectGeneration._(
      project,
      run,
      generation,
      manifest,
      root,
      manifestPath,
      '/v1/blobs/',
      Map.unmodifiable(blobs),
    );
  }
}

abstract interface class PackTransport {
  Future<Uint8List> bytes(String path, {required int maxBytes});
}

/// Every TLS socket uses the same exact certificate pin. There is no global
/// certificate override, redirect following or fallback to cleartext HTTP.
class DeviceTransport implements PackTransport {
  DeviceTransport(this.endpoint, this.fingerprint) {
    if (endpoint.scheme != 'https' || !digestPattern.hasMatch(fingerprint)) {
      throw const PlayerError(
        'ERR_TLS_PIN',
        'A HTTPS origin and exact certificate fingerprint are required.',
      );
    }
    _http = HttpClient(context: SecurityContext(withTrustedRoots: false))
      ..connectionTimeout = const Duration(seconds: 10)
      ..idleTimeout = const Duration(seconds: 20)
      ..badCertificateCallback = (certificate, host, port) =>
          host == endpoint.host &&
          port == endpoint.port &&
          sha256.convert(certificate.der).toString() == fingerprint;
  }
  final Uri endpoint;
  final String fingerprint;
  late final HttpClient _http;
  String? _token;
  bool _closed = false;

  void authenticate(String token) {
    _token = token;
  }

  Uri _uri(String path) {
    if (!path.startsWith('/v1/') ||
        path.contains('..') ||
        path.contains('\\') ||
        path.contains('?')) {
      throw const PlayerError(
        'ERR_DEV_PATH',
        'Resource path is not permitted.',
      );
    }
    return endpoint.replace(path: path);
  }

  Future<HttpClientResponse> _request(
    String method,
    String path, [
    Object? body,
  ]) async {
    if (_closed)
      throw const PlayerError(
        'ERR_CANCELLED',
        'Development connection is closed.',
      );
    try {
      final request = await _http.openUrl(method, _uri(path));
      request.followRedirects = false;
      final token = _token;
      if (token != null)
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.add(utf8.encode(jsonEncode(body)));
      }
      final response = await request.close().timeout(
        const Duration(seconds: 30),
      );
      if (response.statusCode == 401 || response.statusCode == 403) {
        await response.drain<void>();
        throw const PlayerError(
          'ERR_DEVICE_AUTH',
          'Device authorization expired or was revoked. Pair again.',
        );
      }
      if (response.statusCode != 200 && response.statusCode != 204) {
        await response.drain<void>();
        throw PlayerError(
          'ERR_DEV_HTTP',
          'Development server returned HTTP ${response.statusCode}.',
        );
      }
      return response;
    } on PlayerError {
      rethrow;
    } catch (_) {
      throw const PlayerError(
        'ERR_DEV_NETWORK',
        'Secure connection failed. Check the network and certificate fingerprint.',
      );
    }
  }

  Future<Uint8List> _read(HttpClientResponse response, int maxBytes) async {
    if (response.contentLength > maxBytes) {
      _http.close(force: true);
      throw const PlayerError(
        'ERR_DEV_BUDGET',
        'Response exceeds its byte budget.',
      );
    }
    final data = BytesBuilder(copy: false);
    try {
      await for (final chunk in response.timeout(const Duration(seconds: 30))) {
        if (data.length + chunk.length > maxBytes) {
          throw const PlayerError(
            'ERR_DEV_BUDGET',
            'Response exceeds its byte budget.',
          );
        }
        data.add(chunk);
      }
      return data.takeBytes();
    } on PlayerError {
      rethrow;
    } catch (_) {
      throw const PlayerError(
        'ERR_DEV_NETWORK',
        'Resource transfer was interrupted.',
      );
    }
  }

  Future<Map<String, Object?>?> json(
    String method,
    String path, [
    Object? body,
  ]) async {
    final response = await _request(method, path, body);
    if (response.statusCode == 204) {
      await response.drain<void>();
      return null;
    }
    try {
      return Map<String, Object?>.from(
        jsonDecode(utf8.decode(await _read(response, 2 * 1024 * 1024))) as Map,
      );
    } on PlayerError {
      rethrow;
    } catch (_) {
      throw const PlayerError(
        'ERR_DEV_JSON',
        'Development server returned invalid JSON.',
      );
    }
  }

  Future<DeviceCredentials> pair(
    ConnectionTicket ticket,
    String deviceId,
  ) async {
    final result = await json('POST', '/v1/pair', {
      'protocolVersion': deviceProtocolVersion,
      'code': ticket.code,
      'deviceId': deviceId,
      'name': Platform.localHostname,
      'platform': Platform.operatingSystem,
    });
    if (result == null ||
        result['protocolVersion'] != deviceProtocolVersion ||
        result['projectId'] != ticket.projectId ||
        result['deviceToken'] is! String ||
        result['serverId'] is! String) {
      throw const PlayerError(
        'ERR_PAIRING_RESPONSE',
        'Pairing response does not match this project.',
      );
    }
    final credentials = DeviceCredentials(
      endpoint: endpoint,
      fingerprint: fingerprint,
      deviceToken: result['deviceToken'] as String,
      projectId: result['projectId'] as String,
      serverId: result['serverId'] as String,
    );
    authenticate(credentials.deviceToken);
    return credentials;
  }

  @override
  Future<Uint8List> bytes(String path, {required int maxBytes}) async =>
      _read(await _request('GET', path), maxBytes);

  Future<WebSocket> events() async {
    try {
      final socket = await WebSocket.connect(
        endpoint.replace(scheme: 'wss', path: '/v1/events').toString(),
        customClient: _http,
        headers: {HttpHeaders.authorizationHeader: 'Bearer ${_token ?? ''}'},
      ).timeout(const Duration(seconds: 15));
      socket.pingInterval = const Duration(seconds: 20);
      return socket;
    } catch (_) {
      throw const PlayerError(
        'ERR_DEV_NETWORK',
        'Could not open the authenticated device event connection.',
      );
    }
  }

  void close() {
    _closed = true;
    _http.close(force: true);
  }
}
