import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:weapp_container/weapp_container.dart';

import 'pack_store.dart';
import 'player_failure.dart';
import 'development_connection.dart';
import 'protocol.dart';
import 'tab_icons.dart';
import 'host_services.dart';

class _ShellObservationRequest {
  _ShellObservationRequest(
    this.controller,
    this.previous,
    this.sessionId,
    this.pageId,
  );
  final WeappContainerController controller;
  final Map<String, Object?> previous;
  final Object? sessionId;
  final Object? pageId;
  final observed = Completer<void>();
  final retired = Completer<void>();
}

class _ShellInputLease {
  _ShellInputLease(this.controller);
  final WeappContainerController controller;
  final retired = Completer<void>();
  Future<void>? restoring;
}

class _DirtyShellGeometry {
  _DirtyShellGeometry(
    this.controller,
    this.geometry,
    this.sessionId,
    this.pageId,
  );
  final WeappContainerController controller;
  final Map<String, Object?> geometry;
  final Object? sessionId;
  final Object? pageId;
  bool needsObservation = true;
}

class PlayerModel extends ChangeNotifier {
  PlayerModel({
    this.nativeCoordinationTimeout = const Duration(seconds: 15),
    FlutterSecureStorage? secureStorage,
    this.hostServices,
  }) : _secure =
           secureStorage ??
           const FlutterSecureStorage(
             iOptions: IOSOptions(
               accessibility: KeychainAccessibility.first_unlock_this_device,
             ),
             mOptions: MacOsOptions(
               accessibility: KeychainAccessibility.first_unlock_this_device,
             ),
           );

  /// Bounds transport coordination, never the guest's execution budget. A
  /// missing reply leaves the attempt unknown; timeout cannot reject a pack.
  @visibleForTesting
  final Duration nativeCoordinationTimeout;
  final FlutterSecureStorage _secure;
  final PlayerHostServices? hostServices;
  final logs = <String>[];
  // A separate typed journal makes native View failures observable to paired
  // inspectors without exporting free-form UI logs or guest data.
  final _previewDiagnostics = <Map<String, Object?>>[];
  BigInt _previewDiagnosticSequence = BigInt.zero;
  BigInt _previewDiagnosticsDropped = BigInt.zero;
  final history = <String>[];
  WeappContainerController? controller;

  /// A real measured view is staged beside the accepted one before native load.
  WeappContainerController? candidateController;
  DeviceCredentials? credentials;
  DeviceTransport? _transport;
  late final _eventConnection = DevelopmentConnectionOwner<WebSocket>(
    diagnostic: (event) => _log('DEV_CONNECTION ${jsonEncode(event.toJson())}'),
  );
  final _lifecycle = DevelopmentLifecycleCoordinator();
  WebSocket? get _socket => _eventConnection.current?.value;
  StreamSubscription? _nativeEvents;
  Timer? _retry;
  Timer? _poll;
  Directory? _support;
  PackStore? _store;
  String _deviceId = '';
  int _connectionEpoch = 0;
  int _connectionCommandEpoch = 0;
  int _retryEpoch = 0;
  Future<void> _credentialPersistence = Future.value();
  bool _closing = false;
  Future<void>? _closeTask;
  int _updateEpoch = 0;
  bool _disposed = false;
  bool _notifierDisposed = false;
  int _fetchEpoch = 0;
  bool _foreground = true;
  bool get appForeground => _foreground;
  bool autoUpdate = true;
  bool connected = false;
  bool busy = false;
  bool visible = true;
  bool previewPaused = false;
  bool appRequested = false;
  bool previewOccluded = false;
  bool closingMiniProgram = false;
  Map<String, Object?> candidateChrome = {};
  TabIconCatalog tabIcons = const TabIconCatalog();
  TabIconCatalog candidateTabIcons = const TabIconCatalog();
  WeappContainerController? prospectiveController;
  Map<String, Object?> prospectiveChrome = {};
  TabIconCatalog prospectiveTabIcons = const TabIconCatalog();
  Completer<Map<String, Object?>>? _prospectiveGeometry;
  Map<String, Object?>? _prospectiveRestartAttempt;
  Future<void>? _navigationPreparation;
  String? _navigationTicket;
  InstalledGeneration? availablePack;
  VoidCallback? onNativeMore;
  VoidCallback? onNativeClose;
  VoidCallback? onNativeBack;
  ValueChanged<String>? onNativeSwitchTab;
  final _chromeGeometryReady = <int, Completer<void>>{};
  final _initialHostLayouts = <int, Map<String, Object?>>{};
  final _chromeGeometryRevision = <int, int>{};
  final _chromeIssuedRevision = <int, int>{};
  final _shellObservations = <int, _ShellObservationRequest>{};
  final _shellRectangles = <int, Map<String, Object?>>{};
  final _dirtyShellGeometry = <int, _DirtyShellGeometry>{};
  final _shellNativeObservations = <int, Map<String, Object?>>{};
  final _shellNativeOwners = <int, String>{};
  final _heldShellInput = <int, _ShellInputLease>{};
  final _prospectiveShellGeometry = <int, Map<String, Object?>>{};
  int hostChromeRevision(WeappContainerController current) =>
      _chromeGeometryRevision[current.id] ?? 0;
  int initialChromeRevision(WeappContainerController current) =>
      max(hostChromeRevision(current), _chromeIssuedRevision[current.id] ?? 0);
  Future<void>? _closeMiniProgramTask;
  String presentationStage = 'awaiting-native-ack';
  String phase = 'disconnected';
  String? _error;
  String? get error => _error;
  final _playerFailures = PlayerFailureJournal();
  final _playerRetirements = PlayerRetirementJournal();

  void _adoptFailure(
    String message, {
    required PlayerFailurePhase phase,
    required String? code,
    WeappContainerController? source,
    WeappViewFailure? viewFailure,
  }) {
    _error = message;
    final role = source == null
        ? 'none'
        : identical(source, controller)
        ? 'accepted'
        : identical(source, candidateController)
        ? 'candidate'
        : identical(source, prospectiveController)
        ? 'prospective'
        : 'retired';
    _playerFailures.adopt(
      phase: phase,
      code: code,
      controllerRole: role,
      controllerId: source?.id,
      acceptedControllerId: controller?.id,
      acceptedState: nativeState,
      viewFailure: viewFailure,
    );
  }

  void _clearFailure() {
    _error = null;
    _playerFailures.clearCurrent();
  }

  String? route;
  Map<String, Object?> nativeState = {};
  Map<String, Object?> capabilities = {};
  Map<String, Object?> inspectorData = {};
  Map<String, num> timings = {};
  ProjectGeneration? _latest;
  InstalledGeneration? activePack;
  InstalledGeneration? previousPack;

  /// A verified attempt whose native outcome could not be established. It is
  /// retained for an explicit restart; it is never advertised as an active pack.
  InstalledGeneration? failedPack;
  bool _nativeStateUnknown = false;
  Map<String, Object?>? _acceptedPackIdentity;
  Map<String, Object?>? _unresolvedAttempt;
  Map<String, Object?>? _developmentAttempt;
  InstalledGeneration? _developmentAttemptPack;
  Map<String, Object?>? _developmentAttemptPrepared;
  int? _developmentAttemptController;
  Map<String, Object?>? get developmentAttempt => _developmentAttempt == null
      ? null
      : Map.unmodifiable(_developmentAttempt!);
  String? _activeProjectKey;
  BigInt _latestOrdinal = BigInt.from(-1);
  String? _latestRunId;
  Future<void> _applyQueue = Future.value();
  final _activationWaits = <Completer<void>>{};

  Future<T> _awaitActivation<T>(
    Future<T> operation,
    Completer<void> cancelled,
  ) => Future.any<T>([
    operation,
    cancelled.future.then<T>(
      (_) => throw const PlayerError(
        'ERR_CANCELLED',
        'Native view preparation was cancelled.',
      ),
    ),
  ]);

  Future<T> _awaitCoordination<T>(
    Future<T> operation,
    Completer<void> cancelled,
  ) => _awaitActivation(operation, cancelled).timeout(
    nativeCoordinationTimeout,
    onTimeout: () => throw const PlayerError(
      'ERR_TIMEOUT',
      'Native development coordination did not reply. Pack acceptance is unknown until reconciled.',
    ),
  );

  void _cancelActivationWaits() {
    for (final wait in _activationWaits) {
      if (!wait.isCompleted) wait.complete();
    }
    _cancelProspectiveChrome();
  }

  Object? _expectedNativeGeneration;
  int? _expectedFrameRevision;
  bool _reportedPresented = false;
  bool _polling = false;
  bool _remoteInspectBusy = false;
  Object? _pausedNativeGeneration;
  int? _pausedFrameRevision;
  WeappContainerController? _capturingNativeController;
  List<WeappContainerEvent>? _capturedNativeEvents;
  List<Object>? _capturedNativeErrors;

  void _changed() {
    if (!_disposed && !_notifierDisposed) notifyListeners();
  }

  void _log(String message) {
    logs.add('${DateTime.now().toIso8601String().substring(11, 19)}  $message');
    if (logs.length > 300) logs.removeRange(0, logs.length - 300);
    _changed();
  }

  void fail(
    Object exception, {
    PlayerFailurePhase phase = PlayerFailurePhase.player,
    WeappContainerController? source,
    WeappViewFailure? viewFailure,
  }) {
    // Never stringify raw sockets, pairing responses or credential-bearing URLs.
    _adoptFailure(
      exception is PlayerError
          ? exception.toString()
          : '${_stableNativeCode(exception) ?? 'ERR_PLAYER'}: Native or filesystem operation failed. See platform diagnostics.',
      phase: phase,
      code: _stableNativeCode(exception) ?? 'ERR_PLAYER',
      source: source,
      viewFailure: viewFailure,
    );
    _log(error!);
  }

  static String? _stableNativeCode(Object exception) {
    try {
      final code = exception is PlatformException
          ? exception.code
          : exception is WeappHostError
          ? exception.code
          : exception is PlayerError
          ? exception.code
          : null;
      return code != null && RegExp(r'^ERR_[A-Z0-9_]+$').hasMatch(code)
          ? code
          : null;
    } catch (_) {
      // Error projection is observational, including unusual platform wrappers.
      // Its getter must not replace the operation failure or prevent adoption.
      return null;
    }
  }

  static bool _isGpuError(String? code) =>
      code != null &&
      (const {
            'ERR_RENDER',
            'ERR_TEXTURE',
            'ERR_METAL_UNAVAILABLE',
            'ERR_CONTEXT_LOST',
            'ERR_VIEW_DESTROYED',
            'ERR_WIN32',
            'ERR_SURFACE_LOST',
            'ERR_SURFACE_DETACHED',
          }.contains(code) ||
          RegExp(r'^ERR_(METAL|GPU|GL|GLES|EGL|WGL)(_|$)').hasMatch(code));

  /// Controlled diagnostics remain visible across View retirement without
  /// changing current preview health, input authority, or recovery.
  void recordPreviewDiagnostic(
    WeappViewDiagnostic diagnostic, {
    required WeappContainerController source,
  }) {
    if (_disposed) return;
    // Typed SDK values serialize only controlled operation/lease/code fields.
    // Diagnostics never clear errors, authorize input, or infer recovery.
    final role = identical(source, controller)
        ? 'accepted'
        : identical(source, candidateController)
        ? 'candidate'
        : identical(source, prospectiveController)
        ? 'prospective'
        : 'retired';
    _previewDiagnosticSequence += BigInt.one;
    final entry = Map<String, Object?>.unmodifiable({
      ...diagnostic.toMap(),
      'controllerRole': role,
      'sequence': _previewDiagnosticSequence.toString(),
    });
    _previewDiagnostics.add(entry);
    if (_previewDiagnostics.length > 16) {
      _previewDiagnostics.removeAt(0);
      _previewDiagnosticsDropped += BigInt.one;
    }
    _log('NATIVE_VIEW_OPERATION ${jsonEncode(entry)}');
  }

  /// Only a failure from the currently mounted native preview may pause it.
  /// Download and uncommitted candidate errors keep the accepted app running.
  void handlePreviewError(
    Object exception, {
    WeappContainerController? source,
  }) {
    final current = source ?? controller;
    final viewFailure = exception is WeappViewFailure ? exception : null;
    if (viewFailure?.diagnostic.retired == true) return;
    final original = viewFailure?.error ?? exception;
    if (current == null || !identical(current, controller) || _disposed) return;
    if (identical(_capturingNativeController, current)) {
      final pending = _capturedNativeErrors;
      if (pending != null) {
        if (pending.length == 10) pending.removeAt(0);
        pending.add(exception);
        return;
      }
    }
    final code = _stableNativeCode(original);
    if (_isGpuError(code)) _pausePreview(current);
    _adoptFailure(
      code == null
          ? 'ERR_PREVIEW: Native preview failed.'
          : '${_safeText(code, limit: 80)}: Native preview failed. Retry the preview or load the previous pack.',
      phase: PlayerFailurePhase.preview,
      code: code ?? 'ERR_PREVIEW',
      source: current,
      viewFailure: viewFailure,
    );
    _log(error!);
  }

  void _pausePreview(
    WeappContainerController current, {
    bool nativeCoverRequested = false,
  }) {
    if (!identical(current, controller) || previewPaused) return;
    _retireShellObservation(current);
    _holdShellInput(current);
    previewPaused = true;
    visible = false;
    phase = 'preview-paused';
    presentationStage = 'failed';
    _reportedPresented = false;
    _pausedNativeGeneration = nativeState['generation'];
    _pausedFrameRevision = (nativeState['frameRevision'] as num?)?.toInt();
    // Fault isolation suspends presentation/input, not App/Page lifecycle.
    // Keep the laid-out native owner mounted so recovery can obtain real
    // observations even while its input-disabled surface is hidden natively.
    if (!nativeCoverRequested) {
      unawaited(
        current
            .setPreviewOccluded(true)
            .catchError((Object exception) => fail(exception)),
      );
    }
    _changed();
  }

  Future<void> retryPreview() async {
    final current = controller;
    if (!previewPaused || current == null || busy) return;
    if (_nativeStateUnknown) {
      final attempted = failedPack;
      if (attempted != null) await _restartPack(attempted);
      return;
    }
    if (activePack == null) return;
    try {
      final state = await current.state();
      if (!identical(current, controller) || busy) return;
      nativeState = state;
      if (_requiresExecutionRestart(state)) {
        await _restartPack(activePack!);
        return;
      }
      _expectedNativeGeneration = state['generation'];
      _expectedFrameRevision = (state['frameRevision'] as num?)?.toInt();
    } catch (exception) {
      fail(exception);
      return;
    }
    previewPaused = false;
    visible = _foreground;
    phase = 'started';
    presentationStage = 'awaiting-native-ack';
    _reportedPresented = false;
    _clearFailure();
    _changed();
    try {
      _holdShellInput(current);
      await _flushDirtyShellGeometry(current);
      await inspect();
    } catch (exception) {
      if (identical(current, controller)) {
        _pausePreview(current);
        handlePreviewError(exception, source: current);
      }
    }
  }

  Future<void> initialize() async {
    _support = await getApplicationSupportDirectory();
    await _support!.create(recursive: true);
    _store = PackStore(Directory('${_support!.path}/packs'));
    final identity = File('${_support!.path}/device-id');
    if (await identity.exists()) {
      _deviceId = (await identity.readAsString()).trim();
    }
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(_deviceId)) {
      final random = Random.secure();
      _deviceId = List.generate(
        16,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      await identity.writeAsString(_deviceId, flush: true);
    }
    final metadata = File('${_support!.path}/history.json');
    if (await metadata.exists()) {
      try {
        history.addAll(
          (jsonDecode(await metadata.readAsString()) as List)
              .cast<String>()
              .take(10),
        );
      } catch (_) {
        _log('Connection history could not be read.');
      }
    }
    _poll = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => unawaited(inspect()),
    );
    _changed();
  }

  Future<void> connect(String connectionLink) async {
    final ticket = ConnectionTicket.parse(connectionLink);
    final command = ++_connectionCommandEpoch;
    if (_store == null) await initialize();
    if (_disposed || _closing || command != _connectionCommandEpoch) return;
    final cleanup = _disconnectCurrent();
    final epoch = _connectionEpoch;
    await cleanup;
    if (_disposed ||
        _closing ||
        command != _connectionCommandEpoch ||
        epoch != _connectionEpoch)
      return;
    appRequested = true;
    previewOccluded = false;
    phase = 'pairing';
    _clearFailure();
    _changed();
    final transport = DeviceTransport(ticket.endpoint, ticket.fingerprint);
    _transport = transport;
    try {
      final paired = await transport.pair(ticket, _deviceId);
      if (_disposed || epoch != _connectionEpoch) {
        transport.close();
        return;
      }
      credentials = paired;
      _latest = null;
      _latestOrdinal = BigInt.from(-1);
      _latestRunId = null;
      await _persistPairing(paired, transport, epoch);
      if (_disposed ||
          _closing ||
          epoch != _connectionEpoch ||
          !identical(transport, _transport))
        return;
      await _openEvents(epoch);
    } catch (exception) {
      if (epoch == _connectionEpoch) {
        connected = false;
        phase = 'disconnected';
        fail(exception);
      }
    }
  }

  Future<void> _persistPairing(
    DeviceCredentials paired,
    DeviceTransport transport,
    int epoch,
  ) {
    bool current() =>
        !_disposed &&
        !_closing &&
        epoch == _connectionEpoch &&
        identical(transport, _transport);
    // Platform keychain writes cannot be cancelled. Serialize them so a late
    // retired write finishes before the replacement's write, never after it.
    final pending = _credentialPersistence.then((_) async {
      if (!current()) return;
      try {
        await _secure.write(
          key: 'weapp-dev-player.last-device',
          value: jsonEncode(paired.toJson()),
        );
      } catch (_) {
        if (current()) {
          _log(
            'Secure credential storage is unavailable; this connection will remain session-only.',
          );
        }
      }
      if (!current()) return;
      final nextHistory = [
        paired.endpoint.origin,
        ...history.where((origin) => origin != paired.endpoint.origin),
      ].take(10).toList();
      await File('${_support!.path}/history.json')
          .writeAsString(jsonEncode(nextHistory), flush: true);
      if (!current()) return;
      history
        ..clear()
        ..addAll(nextHistory);
    });
    // An I/O failure is returned to its connection, without poisoning the next
    // pairing's persistence operation.
    _credentialPersistence = pending.catchError((Object _) {});
    return pending;
  }

  Future<void> reconnectSaved() async {
    final command = ++_connectionCommandEpoch;
    if (_store == null) await initialize();
    if (_disposed || _closing || command != _connectionCommandEpoch) return;
    final cleanup = _disconnectCurrent();
    final epoch = _connectionEpoch;
    await cleanup;
    if (_disposed ||
        _closing ||
        command != _connectionCommandEpoch ||
        epoch != _connectionEpoch)
      return;
    appRequested = true;
    previewOccluded = false;
    try {
      await _credentialPersistence;
      if (_disposed ||
          _closing ||
          command != _connectionCommandEpoch ||
          epoch != _connectionEpoch)
        return;
      final value = await _secure.read(key: 'weapp-dev-player.last-device');
      if (_disposed ||
          _closing ||
          command != _connectionCommandEpoch ||
          epoch != _connectionEpoch)
        return;
      if (value == null)
        throw const PlayerError(
          'ERR_DEVICE_AUTH',
          'No saved device connection. Pair using a new link.',
        );
      credentials = DeviceCredentials.fromJson(
        Map<String, Object?>.from(jsonDecode(value) as Map),
      );
      _latest = null;
      final saved = credentials!;
      _transport = DeviceTransport(saved.endpoint, saved.fingerprint)
        ..authenticate(saved.deviceToken);
      _latestOrdinal = BigInt.from(-1);
      _latestRunId = null;
      await _openEvents(epoch);
    } catch (exception) {
      if (command == _connectionCommandEpoch &&
          epoch == _connectionEpoch &&
          !_disposed &&
          !_closing)
        fail(exception);
    }
  }

  Future<void> _openEvents(int epoch) async {
    if (_disposed ||
        _closing ||
        !_eventConnection.enabled ||
        epoch != _connectionEpoch)
      return;
    final transport = _transport;
    if (transport == null) return;
    _cancelConnectionRetry();
    await _eventConnection.open(
      connectionEpoch: epoch,
      dial: (isCurrent) async {
        // Authorize before WSS; retired HTTP results cannot initiate a new
        // handshake or replace a newer server peer.
        await transport.json('GET', '/v1/project');
        if (!isCurrent() ||
            _disposed ||
            _closing ||
            epoch != _connectionEpoch ||
            !identical(transport, _transport)) {
          throw const PlayerError(
            'ERR_CANCELLED',
            'Development connection attempt was retired.',
          );
        }
        return transport.events();
      },
      close: (socket) async {
        await socket.close();
      },
      opened: (lease) {
        final socket = lease.value;
        connected = true;
        phase = activePack == null ? 'connected' : phase;
        _log('Secure device connection established.');
        final subscription = socket.listen(
          (message) {
            if (!_eventConnection.owns(lease) || epoch != _connectionEpoch)
              return;
            try {
              if (message is! String ||
                  utf8.encode(message).length > 60 * 1024) {
                throw const PlayerError(
                  'ERR_DEV_MESSAGE',
                  'Event exceeds its wire budget.',
                );
              }
              final event = Map<String, Object?>.from(
                jsonDecode(message) as Map,
              );
              if (event['protocolVersion'] != deviceProtocolVersion) {
                throw const PlayerError(
                  'ERR_PROTOCOL_VERSION',
                  'Device event protocol is unsupported.',
                );
              }
              if (event['type'] == 'heartbeat') {
                if (socket.readyState == WebSocket.open) {
                  socket.add(
                    jsonEncode({
                      'protocolVersion': deviceProtocolVersion,
                      'type': 'heartbeat',
                    }),
                  );
                }
              } else if (event['type'] == 'ready') {
                final accepted = activePack?.descriptor;
                // A reconnected WSS gets its own peer identity. Re-advertise only
                // the locally accepted pack for this exact service incarnation.
                if (!busy &&
                    controller != null &&
                    accepted != null &&
                    accepted.projectId == event['projectId'] &&
                    accepted.runId == event['runId']) {
                  _report('started', accepted, {'reattached': true});
                }
              } else if (event['type'] == 'pack') {
                unawaited(_fetchLatest(epoch, lease));
              } else if (event['type'] == 'diagnostic') {
                // Diagnostics are server-authored, bounded data; never include raw connection URIs.
                final details = event['diagnostic'];
                _adoptFailure(
                  details is Map && details['message'] is String
                      ? 'Build: ${(details['message'] as String).replaceAll(RegExp(r'weapp-container://\S+'), '[redacted]')}'
                      : 'Development build failed. The accepted app remains available.',
                  phase: PlayerFailurePhase.build,
                  code: details is Map && details['code'] is String
                      ? details['code'] as String
                      : null,
                );
                _log(error!);
              } else if (event['type'] == 'inspect-request') {
                unawaited(_inspectRemote(event, socket, epoch));
              } else if (event['type'] == 'command') {
                if (event['name'] == 'reload') unawaited(reload());
                if (event['name'] == 'rollback') unawaited(rollback());
              } else if (event['type'] == 'shutdown') {
                _lost(lease, DevelopmentConnectionEvent.remoteClosed);
              }
            } catch (exception) {
              fail(exception);
            }
          },
          onDone: () => _lost(lease, DevelopmentConnectionEvent.remoteClosed),
          onError: (_) => _lost(lease, DevelopmentConnectionEvent.socketError),
          cancelOnError: true,
        );
        lease.unsubscribe = subscription.cancel;
      },
      failed: (exception) {
        if (_disposed ||
            _closing ||
            epoch != _connectionEpoch ||
            !identical(transport, _transport))
          return;
        if (exception is PlayerError && exception.code == 'ERR_DEVICE_AUTH') {
          connected = false;
          fail(exception);
          return;
        }
        _scheduleConnectionRetry(epoch);
      },
    );
    final lease = _eventConnection.current;
    if (lease != null &&
        lease.connectionEpoch == epoch &&
        _eventConnection.owns(lease)) {
      await _fetchLatest(epoch, lease);
      _changed();
    }
  }

  Future<void> _fetchLatest(
    int epoch,
    DevelopmentConnectionLease<WebSocket> lease,
  ) async {
    final fetch = ++_fetchEpoch;
    final transport = _transport;
    try {
      final current = await transport?.json('GET', '/v1/project');
      if (_eventConnection.owns(lease) &&
          identical(transport, _transport) &&
          fetch == _fetchEpoch &&
          epoch == _connectionEpoch &&
          current != null)
        _observe(ProjectGeneration.fromJson(current));
    } catch (exception) {
      if (_eventConnection.owns(lease) && epoch == _connectionEpoch)
        fail(exception);
    }
  }

  void _lost(
    DevelopmentConnectionLease<WebSocket> lease,
    DevelopmentConnectionEvent event,
  ) {
    if (_disposed ||
        _closing ||
        lease.connectionEpoch != _connectionEpoch ||
        !_eventConnection.owns(lease))
      return;
    _eventConnection.observe(lease, event, closeCode: lease.value.closeCode);
    unawaited(_eventConnection.retire(lease));
    connected = false;
    if (activePack == null) phase = 'disconnected';
    _scheduleConnectionRetry(lease.connectionEpoch);
    _changed();
  }

  void _cancelConnectionRetry() {
    _retryEpoch++;
    _retry?.cancel();
    _retry = null;
  }

  void _scheduleConnectionRetry(int epoch) {
    _cancelConnectionRetry();
    if (!_disposed &&
        !_closing &&
        _eventConnection.enabled &&
        _transport != null &&
        epoch == _connectionEpoch &&
        _eventConnection.current == null) {
      final retry = _retryEpoch;
      _retry = Timer(const Duration(seconds: 3), () {
        if (retry == _retryEpoch &&
            epoch == _connectionEpoch &&
            _eventConnection.enabled &&
            !_disposed &&
            !_closing) {
          unawaited(_openEvents(epoch));
        }
      });
    }
    _changed();
  }

  void _observe(ProjectGeneration descriptor) {
    if (descriptor.projectId != credentials?.projectId) {
      throw const PlayerError(
        'ERR_DEV_PROJECT',
        'Server sent an update for a different project.',
      );
    }
    if (_latestRunId != descriptor.runId) {
      _latestRunId = descriptor.runId;
      _latestOrdinal = BigInt.from(-1);
    }
    if (descriptor.ordinal < _latestOrdinal) return;
    if (descriptor.ordinal == _latestOrdinal) {
      if (_latest?.manifestSha256 != descriptor.manifestSha256) {
        throw const PlayerError(
          'ERR_DEV_GENERATION',
          'A generation identity was reused with different bytes.',
        );
      }
      final accepted = appRequested && !previewOccluded
          ? activePack
          : availablePack;
      if (autoUpdate &&
          !busy &&
          (accepted?.descriptor.runId != descriptor.runId ||
              accepted?.descriptor.generation != descriptor.generation)) {
        _enqueue(descriptor, ++_updateEpoch);
      }
      return;
    }
    _latestOrdinal = descriptor.ordinal;
    _latest = descriptor;
    _updateEpoch++;
    _log('Generation ${descriptor.generation} available.');
    if (autoUpdate) _enqueue(descriptor, _updateEpoch);
  }

  void _enqueue(ProjectGeneration descriptor, int update) {
    final connection = _connectionEpoch;
    _applyQueue = _applyQueue
        .then((_) async {
          if (update != _updateEpoch ||
              connection != _connectionEpoch ||
              _disposed)
            return;
          busy = true;
          _changed();
          try {
            final watch = Stopwatch()..start();
            final installed = await _store!.install(
              descriptor,
              _transport!,
              serverId: credentials!.serverId,
              isCurrent: () =>
                  !_disposed &&
                  update == _updateEpoch &&
                  connection == _connectionEpoch,
              onPhase: (value) {
                phase = value;
                _report(value, descriptor);
                _changed();
              },
            );
            timings = {
              ...timings,
              'transferAndVerifyMs': watch.elapsedMilliseconds,
              'downloadBytes': installed.downloadedBytes,
            };
            if (update != _updateEpoch || connection != _connectionEpoch)
              return;
            availablePack = installed;
            // Closing/covering a project does not stop downloads, but cannot
            // create a hidden runtime or silently reopen a closed mini-program.
            if (!appRequested || previewOccluded) {
              phase = appRequested ? 'update-ready' : 'project-ready';
              return;
            }
            await _activate(
              installed,
              isCurrent: () =>
                  !_disposed &&
                  update == _updateEpoch &&
                  connection == _connectionEpoch,
            );
          } catch (exception) {
            if (appRequested &&
                (exception is! PlayerError ||
                    exception.code != 'ERR_CANCELLED'))
              fail(exception);
          } finally {
            busy = false;
            _changed();
            final accepted = controller;
            if (accepted != null) unawaited(_flushDirtyShellGeometry(accepted));
          }
        })
        .catchError((Object exception) {
          fail(exception);
        });
  }

  Future<void> _activate(
    InstalledGeneration pack, {
    bool restart = false,
    bool Function()? isCurrent,
  }) async {
    bool valid() =>
        !_disposed &&
        appRequested &&
        !previewOccluded &&
        (isCurrent?.call() ?? true);
    if (!valid()) return;
    final saved = credentials!;
    final key = _store!.projectKey(saved.serverId, saved.projectId);
    if (pack.projectKey != key ||
        pack.descriptor.projectId != saved.projectId) {
      throw const PlayerError(
        'ERR_DEV_PROJECT',
        'This downloaded pack belongs to a different paired project. Reconnect that project before running or rolling it back.',
      );
    }
    if (_navigationPreparation != null) {
      _cancelProspectiveChrome();
      await _navigationPreparation;
      if (!valid()) return;
    }
    final old = controller;
    if (old != null) {
      _holdShellInput(old);
      _retireShellObservation(old);
    }
    final replacing = old == null || _controllerKey != key;
    if (replacing && _pendingRetirement.length >= 2) {
      throw const PlayerError(
        'ERR_BUSY',
        'Previous native sessions still need cleanup. Close the Player before switching projects again.',
      );
    }
    final cancellation = Completer<void>();
    _activationWaits.add(cancellation);
    final creation = replacing
        ? WeappContainerController.create(
            storageKey: 'dev-player:$key',
            gpuRequired: true,
            devDiagnostics: true,
            systemTabBar: true,
            atomicHostLayout: true,
          )
        : null;
    final WeappContainerController current;
    try {
      current = creation == null
          ? old!
          : await _awaitCoordination(creation, cancellation);
    } catch (_) {
      _activationWaits.remove(cancellation);
      if (creation != null) {
        // A transport timeout cannot cancel native owner allocation. Retire
        // this exact late owner when its reply arrives; never leak or adopt it.
        unawaited(creation.then<void>(_retire, onError: (Object _) {}));
      }
      rethrow;
    }
    var committed = false;
    Map<String, Object?>? issuedAttempt;
    var attemptSubmitted = false;
    final bufferedEvents = <WeappContainerEvent>[];
    final bufferedErrors = <Object>[];
    final candidateEvents = replacing
        ? current.events.listen(
            (event) {
              if (committed) {
                _consumeNativeEvent(current, event);
              } else if (event.type == 'hostLayoutObservation' ||
                  event.type == 'hostLayoutAccepted') {
                _changed();
              } else {
                _observeDevelopmentAttemptEvent(current, event);
                if (bufferedEvents.length == 100) bufferedEvents.removeAt(0);
                bufferedEvents.add(event);
              }
            },
            onError: (Object exception) {
              if (committed && identical(current, controller)) {
                handlePreviewError(exception, source: current);
              } else {
                if (bufferedErrors.length == 10) bufferedErrors.removeAt(0);
                bufferedErrors.add(exception);
              }
            },
          )
        : null;
    try {
      if (!valid()) return;
      if (hostServices case final services?) {
        await services.prepare(current, pack, saved, newOwner: replacing);
        if (!valid()) return;
      }
      final desiredRoute =
          route ??
          (!replacing && nativeState['page'] is Map
              ? (nativeState['page'] as Map)['route'] as String?
              : null);
      final routes = pack.manifest['routes'];
      final targetRoute =
          desiredRoute != null &&
              routes is List &&
              routes.whereType<Map>().any(
                (entry) => entry['path'] == desiredRoute,
              )
          ? desiredRoute
          : null;
      final inspectedChrome = await _awaitCoordination(
        current.inspectPackChrome(pack.directory.path, route: targetRoute),
        cancellation,
      );
      final preparedIcons = await TabIconCatalog.fromPack(
        pack,
        inspectedChrome,
      );
      if (!valid()) return;
      Map<String, Object?>? expectedAccepted = replacing
          ? null
          : _acceptedPackIdentity;
      if (!replacing && _nativeStateUnknown) {
        // This queries SDK metadata, not the damaged guest/renderer. A new
        // replacement must bind the actual accepted owner even after a lost
        // reply; no frame counter can establish that ownership.
        final unresolved = _unresolvedAttempt;
        if (unresolved != null) {
          try {
            await _awaitCoordination(
              current.queryDevPackAttempt(unresolved),
              cancellation,
            );
          } catch (_) {}
        }
        expectedAccepted = await _awaitCoordination(
          current.command('acceptedPackIdentity'),
          cancellation,
        );
      }
      final operation = restart || replacing || _nativeStateUnknown
          ? 'load'
          : 'applyDevPack';
      final existingCapabilities = replacing
          ? null
          : await _awaitCoordination(current.capabilities(), cancellation);
      if (existingCapabilities != null)
        _requirePreparedRestartMeasurement(existingCapabilities);
      if (!replacing) {
        issuedAttempt = await _awaitCoordination<Map<String, Object?>>(
          current.beginDevPackAttempt(
            pack.directory.path,
            operation: operation,
            expectedAccepted: expectedAccepted,
            route: targetRoute,
          ),
          cancellation,
        );
        _validateAttempt(issuedAttempt, pack);
        _observeDevelopmentAttempt(
          current,
          pack,
          issuedAttempt,
          source: 'begin',
        );
      }
      Map<String, Object?>? initialHostLayout;
      if (!replacing && issuedAttempt?['reloadKind'] == 'restart') {
        if (issuedAttempt!['status'] != 'prepared' ||
            !mapEquals(
              issuedAttempt['expectedAccepted'] as Map?,
              expectedAccepted,
            )) {
          throw const PlayerError(
            'ERR_PROTOCOL_VERSION',
            'Restart measurement requires a current prepared pack attempt.',
          );
        }
        _prospectiveRestartAttempt = _layoutSnapshot({
          for (final key in [
            'schemaVersion',
            'ownerId',
            'attemptId',
            'targetRoot',
            'expectedAccepted',
          ])
            key: issuedAttempt[key],
        });
        prospectiveController = current;
        prospectiveChrome = inspectedChrome;
        prospectiveTabIcons = preparedIcons;
        final measurement = Completer<Map<String, Object?>>();
        _prospectiveGeometry = measurement;
        measurement.future.ignore();
        _changed();
        if (current.atomicHostLayout) {
          unawaited(
            current.requestHostLayoutObservation().catchError((
              Object exception,
            ) {
              if (!measurement.isCompleted)
                measurement.completeError(exception);
            }),
          );
        }
        initialHostLayout =
            await _awaitActivation(measurement.future, cancellation).timeout(
              const Duration(seconds: 15),
              onTimeout: () => throw const PlayerError(
                'ERR_TIMEOUT',
                'Prospective mini-program layout did not provide measured geometry.',
              ),
            );
      }
      if (!valid()) return;
      if (replacing) {
        candidateChrome = inspectedChrome;
        candidateTabIcons = preparedIcons;
        if (!valid()) return;
        _chromeGeometryReady[current.id] = Completer<void>();
        _chromeGeometryReady[current.id]!.future.ignore();
        candidateController = current;
        _changed();
      }
      // The widget supplies actual platform metrics. No default/fake viewport
      // and no App/Page execution may precede this measured-view preflight.
      final candidateCapabilities = replacing
          ? await _awaitActivation(current.prepareView(), cancellation).timeout(
              const Duration(seconds: 15),
              onTimeout: () => throw const PlayerError(
                'ERR_TIMEOUT',
                'Native preview did not provide measured viewport metrics. Keep the Player window open and retry.',
              ),
            )
          : existingCapabilities!;
      if (!valid()) return;
      _requirePreparedRestartMeasurement(candidateCapabilities);
      if (replacing) {
        await _awaitActivation(
          _chromeGeometryReady[current.id]!.future,
          cancellation,
        ).timeout(
          const Duration(seconds: 15),
          onTimeout: () => throw const PlayerError(
            'ERR_TIMEOUT',
            'Mini-program chrome did not provide measured geometry.',
          ),
        );
      }
      if (!valid()) return;
      if (replacing) initialHostLayout = _initialHostLayouts[current.id];
      final devReload = (candidateCapabilities['pack'] as Map?)?['devReload'];
      if (devReload is! Map || devReload['protocolVersion'] != '1.0') {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'This runtime has no native dev reload support. Prepare the preview.5 runtime; older libraries are not substituted.',
        );
      }
      if ((candidateCapabilities['chrome'] as Map?)?['protocolVersion'] !=
          '1.0') {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'This Player requires preview.5 host chrome support. Older runtime libraries are not substituted.',
        );
      }
      if (initialHostLayout != null &&
          (candidateCapabilities['chrome'] as Map?)?['transactionalRestart'] !=
              true) {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'This runtime cannot stage measured restart reloads without mutating the accepted session.',
        );
      }
      if ((devReload['attemptJournal'] as Map?)?['protocolVersion'] != '1.0' ||
          ((candidateCapabilities['chrome'] as Map?)?['atomicLayout']
                  as Map?)?['enabled'] !=
              true) {
        throw const PlayerError(
          'ERR_UNSUPPORTED_CAPABILITY',
          'This Player requires preview.5 atomic host layout and durable pack attempts.',
        );
      }
      final build = candidateCapabilities['build'] as Map? ?? {};
      final gpuAvailable = Platform.isIOS || Platform.isMacOS
          ? build['metal'] == true
          : build['gles'] == true;
      if (!gpuAvailable)
        throw const PlayerError(
          'ERR_RENDER',
          'This runtime does not provide the required native GPU backend.',
        );
      // Eligibility cancels work before submission. Once this accepted native
      // controller commits, a newer desired epoch cannot undo its JS mutation.
      // Recovery must not depend on querying the damaged session again. A
      // forced load has its own publication result; if that also fails without
      // a baseline, retain unknown ownership rather than guessing a pack.
      if (!valid()) return;
      if (!replacing) {
        _capturingNativeController = current;
        _capturedNativeEvents = bufferedEvents;
        _capturedNativeErrors = bufferedErrors;
      }
      phase = 'starting';
      _report('starting', pack.descriptor);
      _changed();
      final watch = Stopwatch()..start();
      final preparedAttempt = issuedAttempt ??=
          await _awaitCoordination<Map<String, Object?>>(
            current.beginDevPackAttempt(
              pack.directory.path,
              operation: operation,
              expectedAccepted: expectedAccepted,
              route: targetRoute,
            ),
            cancellation,
          );
      _validateAttempt(preparedAttempt, pack);
      _observeDevelopmentAttempt(
        current,
        pack,
        preparedAttempt,
        source: 'begin',
      );
      if (!valid()) {
        await _awaitCoordination(
          _cancelDevelopmentAttempt(current, pack, preparedAttempt),
          cancellation,
        );
        return;
      }
      Map<String, Object?> outcome;
      var outcomeSource = 'apply';
      Object? postCommitError;
      try {
        attemptSubmitted = true;
        // A submitted mutation must first settle (or lose its bounded reply).
        // Closing may cancel passive reconciliation, never infer rollback of
        // App/Page work that could already have committed on the owner thread.
        outcome = await current
            .applyDevPackAttempt(
              preparedAttempt,
              expectedAccepted: expectedAccepted,
              initialHostLayout: current.atomicHostLayout
                  ? initialHostLayout
                  : null,
            )
            .timeout(nativeCoordinationTimeout);
      } catch (exception) {
        postCommitError = exception;
        Map<String, Object?>? queried;
        try {
          queried = await _awaitCoordination(
            current.queryDevPackAttempt(preparedAttempt),
            cancellation,
          );
        } catch (_) {}
        if (queried == null) {
          // An exactly matching durable receipt emitted before a wrapper lost
          // its response is also authoritative. Unrelated ready/frame events
          // are deliberately ignored.
          for (final event in bufferedEvents.reversed) {
            final receipt = event.fields['receipt'];
            if (event.type == 'devPackAttempt' &&
                receipt is Map &&
                receipt['ownerId'] == preparedAttempt['ownerId'] &&
                receipt['attemptId'] == preparedAttempt['attemptId'] &&
                const {
                  'accepted',
                  'rejected',
                  'cancelled',
                }.contains(receipt['status'])) {
              queried = Map<String, Object?>.from(receipt);
              outcomeSource = 'event';
              break;
            }
          }
        }
        if (outcomeSource != 'event') outcomeSource = 'query';
        if (queried == null ||
            !const {
              'accepted',
              'rejected',
              'cancelled',
            }.contains(queried['status'])) {
          if (queried?['status'] == 'prepared') {
            await _awaitCoordination(
              _cancelDevelopmentAttempt(current, pack, preparedAttempt),
              cancellation,
            );
            rethrow;
          }
          if (replacing) rethrow;
          _unresolvedAttempt = preparedAttempt;
          _markDevelopmentAttemptUnknown(
            preparedAttempt,
            queryStatus: queried?['status'],
          );
          _retainUnknownAttempt(pack, key, null, candidateCapabilities);
          return;
        }
        outcome = queried;
      }
      Map<String, Object?>? identity;
      try {
        _validateAttempt(outcome, pack, prepared: preparedAttempt);
        if (outcome['status'] == 'accepted') {
          identity = _verifiedAcceptedIdentity(outcome, expectedAccepted);
        } else if (!mapEquals(
          outcome['acceptedPackIdentity'] as Map?,
          expectedAccepted,
        )) {
          throw const PlayerError(
            'ERR_PROTOCOL_VERSION',
            'Rejected attempt changed the accepted pack identity.',
          );
        }
      } catch (_) {
        if (replacing) rethrow;
        _unresolvedAttempt = preparedAttempt;
        _markDevelopmentAttemptUnknown(preparedAttempt);
        _retainUnknownAttempt(pack, key, null, candidateCapabilities);
        return;
      }
      _observeDevelopmentAttempt(current, pack, outcome, source: outcomeSource);
      if (outcome['status'] != 'accepted') {
        _capturingNativeController = null;
        _capturedNativeEvents = null;
        _capturedNativeErrors = null;
        for (final error in bufferedErrors) {
          handlePreviewError(error, source: current);
        }
        if (postCommitError != null)
          handlePreviewError(postCommitError, source: current);
        final failure = outcome['error'] as Map?;
        throw PlayerError(
          failure?['code'] as String? ?? 'ERR_ENGINE',
          'Native development attempt did not accept the pack.',
        );
      }
      _unresolvedAttempt = null;
      final state = outcome['state'] is Map
          ? Map<String, Object?>.from(outcome['state'] as Map)
          : <String, Object?>{'chrome': inspectedChrome};
      final reloadKind = outcome['reloadKind'] as String;
      // A detached candidate can safely be discarded. A successful mutation of
      // the accepted controller must be reconciled even after auto-update was
      // disabled, backgrounding, disconnection or a later generation arrived.
      if (replacing && !valid()) return;
      _acceptedPackIdentity = identity;
      final oldEvents = replacing ? _nativeEvents : null;
      if (replacing) {
        // Commit the controller and its already-listening event stream together.
        // Candidate startup events are buffered until the accepted pack is known.
        if (old != null) _forgetShellGeometry(old);
        controller = current;
        _controllerKey = key;
        _nativeEvents = candidateEvents;
        candidateController = null;
        candidateChrome = {};
        candidateTabIcons = const TabIconCatalog();
      }
      committed = true;
      final committedRevision = current.atomicHostLayout
          ? (initialHostLayout?['layoutRevision'])
          : (initialHostLayout?['revision']);
      if (committedRevision != null)
        _chromeGeometryRevision[current.id] = int.parse(
          committedRevision.toString(),
        );
      capabilities = candidateCapabilities;
      if (activePack != null &&
          activePack?.directory.path != pack.directory.path) {
        previousPack = _activeProjectKey == key ? activePack : null;
      }
      activePack = pack;
      tabIcons = preparedIcons;
      availablePack = pack;
      failedPack = null;
      _nativeStateUnknown = false;
      _activeProjectKey = key;
      nativeState = state;
      if (initialHostLayout?['chrome'] case final Map measured) {
        final rectangles = _shellRectanglesOf(
          Map<String, Object?>.from(measured),
        );
        if (rectangles != null) _shellRectangles[current.id] = rectangles;
      }
      _retainLateProspectiveShell(current, initialHostLayout);
      _expectedNativeGeneration = state['generation'];
      _expectedFrameRevision = (state['frameRevision'] as num?)?.toInt();
      _reportedPresented = false;
      previewPaused = false;
      presentationStage = 'awaiting-native-ack';
      _pausedNativeGeneration = null;
      _pausedFrameRevision = null;
      visible = _foreground && appRequested && !previewOccluded;
      _clearFailure();
      timings = {...timings, 'applyMs': watch.elapsedMilliseconds};
      phase = 'started';
      _report('started', pack.descriptor, {'reloadKind': reloadKind});
      _log(
        'Generation ${pack.descriptor.generation}: $reloadKind; waiting for native presentation.',
      );
      _capturingNativeController = null;
      _capturedNativeEvents = null;
      _capturedNativeErrors = null;
      for (final event in bufferedEvents) {
        _consumeNativeEvent(current, event);
      }
      for (final exception in bufferedErrors) {
        handlePreviewError(exception, source: current);
      }
      if (postCommitError != null) {
        _pausePreview(current);
        handlePreviewError(postCommitError, source: current);
      }
      _changed();
      await oldEvents?.cancel();
      if (replacing && old != null) await _retire(old);
      try {
        await current
            .setForeground(_foreground)
            .timeout(nativeCoordinationTimeout);
        final shellBarrier = _shellNeedsInputBarrier(current);
        if (shellBarrier) _holdShellInput(current);
        await current
            .setPreviewOccluded(
              previewPaused || previewOccluded || !appRequested || shellBarrier,
            )
            .timeout(nativeCoordinationTimeout);
        await inspect().timeout(nativeCoordinationTimeout);
      } catch (exception) {
        _pausePreview(current);
        handlePreviewError(exception, source: current);
      }
    } finally {
      if (issuedAttempt != null && !attemptSubmitted && !current.isClosed) {
        try {
          await _awaitCoordination(
            _cancelDevelopmentAttempt(current, pack, issuedAttempt),
            cancellation,
          );
        } catch (_) {}
      }
      _initialHostLayouts.remove(current.id);
      _activationWaits.remove(cancellation);
      if (identical(prospectiveController, current)) {
        _prospectiveShellGeometry.remove(current.id);
        prospectiveController = null;
        prospectiveChrome = {};
        prospectiveTabIcons = const TabIconCatalog();
        _prospectiveGeometry = null;
        _prospectiveRestartAttempt = null;
        _changed();
      }
      if (identical(_capturingNativeController, current)) {
        _capturingNativeController = null;
        _capturedNativeEvents = null;
        _capturedNativeErrors = null;
      }
      if (replacing && !committed) {
        if (identical(candidateController, current)) {
          candidateController = null;
          candidateChrome = {};
          candidateTabIcons = const TabIconCatalog();
          _changed();
        }
        await candidateEvents?.cancel();
        await _retire(current);
      }
      _chromeGeometryReady.remove(current.id);
    }
  }

  void _observeDevelopmentAttempt(
    WeappContainerController current,
    InstalledGeneration pack,
    Map<String, Object?> receipt, {
    required String source,
  }) {
    if (_disposed) return;
    try {
      final prepared = source == 'begin' ? null : _developmentAttemptPrepared;
      if (source != 'begin' &&
          (_developmentAttemptController != current.id || prepared == null))
        return;
      _validateAttempt(receipt, pack, prepared: prepared);
      const terminal = {'accepted', 'rejected', 'cancelled'};
      final status = receipt['status'];
      if (!const {'prepared', 'applying', ...terminal}.contains(status)) return;
      Map<String, Object?>? identity(Object? value) {
        if (value == null) return null;
        if (value is! Map ||
            value['root'] is! String ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['root'] as String) ||
            value['sessionId'] is! String ||
            (value['sessionId'] as String).isEmpty ||
            (value['sessionId'] as String).length > 2048 ||
            value['acceptedPackRevision'] is! String ||
            !RegExp(r'^[1-9][0-9]*$')
                .hasMatch(value['acceptedPackRevision'] as String))
          throw const FormatException('Invalid observed pack identity');
        return {
          'root': value['root'],
          'sessionId': value['sessionId'],
          'acceptedPackRevision': value['acceptedPackRevision'],
        };
      }

      final previous = _developmentAttempt?['receipt'] as Map?;
      if (previous?['ownerId'] == receipt['ownerId'] &&
          previous?['attemptId'] == receipt['attemptId']) {
        // A delayed prepared/applying callback cannot overwrite a durable
        // terminal observation or change its final result.
        if (terminal.contains(previous?['status']) &&
            previous?['status'] != status)
          return;
        if (previous?['status'] == 'applying' && status == 'prepared') return;
      }
      final safeReceipt = <String, Object?>{
        for (final key in [
          'schemaVersion',
          'ownerId',
          'attemptId',
          'status',
          'operation',
          'targetRoot',
          'reloadKind',
        ])
          key: receipt[key],
        'expectedAccepted': identity(receipt['expectedAccepted']),
        'acceptedPackIdentity': identity(receipt['acceptedPackIdentity']),
      };
      final error = receipt['error'];
      if (error is Map) {
        final code = error['code'];
        if (code is! String || !RegExp(r'^ERR_[A-Z0-9_]+$').hasMatch(code))
          return;
        safeReceipt['error'] = {
          'code': code,
          if (error['message'] is String)
            'message': _safeText(error['message'] as String, limit: 2048)
                .replaceAll(
                  RegExp(
                    r'Bearer\s+\S+|(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+',
                    caseSensitive: false,
                  ),
                  '[redacted]',
                ),
        };
      }
      final observations = receipt['observationErrors'];
      if (observations is List) {
        safeReceipt['observationErrors'] = observations
            .whereType<Map>()
            .take(16)
            .where(
              (item) =>
                  item['phase'] is String &&
                  (item['phase'] as String).length <= 64 &&
                  item['code'] is String &&
                  RegExp(r'^ERR_[A-Z0-9_]+$').hasMatch(item['code'] as String),
            )
            .map((item) => {'phase': item['phase'], 'code': item['code']})
            .toList();
      }
      if (source == 'begin') {
        _developmentAttemptPrepared = Map.from(receipt);
        _developmentAttemptController = current.id;
        _developmentAttemptPack = pack;
      }
      _developmentAttempt = {
        'schemaVersion': 1,
        'projectId': pack.descriptor.projectId,
        'generation': pack.descriptor.generation,
        'runId': pack.descriptor.runId,
        'targetRoot': (pack.manifest['integrity'] as Map)['root'],
        'resolution': terminal.contains(status) ? 'terminal' : 'pending',
        'source': source,
        'observedAt': DateTime.now().toUtc().toIso8601String(),
        'receipt': safeReceipt,
      };
      _changed();
    } catch (_) {
      // Invalid native metadata cannot become evidence or change ownership.
    }
  }

  Future<Map<String, Object?>> _cancelDevelopmentAttempt(
    WeappContainerController current,
    InstalledGeneration pack,
    Map<String, Object?> prepared,
  ) async {
    final receipt = await current.cancelDevPackAttempt(prepared);
    _observeDevelopmentAttempt(current, pack, receipt, source: 'cancel');
    return receipt;
  }

  void _observeDevelopmentAttemptEvent(
    WeappContainerController current,
    WeappContainerEvent event,
  ) {
    final pack = _developmentAttemptPack;
    final receipt = event.fields['receipt'];
    if (event.type == 'devPackAttempt' && pack != null && receipt is Map) {
      _observeDevelopmentAttempt(
        current,
        pack,
        Map<String, Object?>.from(receipt),
        source: 'event',
      );
    }
  }

  void _markDevelopmentAttemptUnknown(
    Map<String, Object?> prepared, {
    Object? queryStatus,
  }) {
    final receipt = _developmentAttempt?['receipt'] as Map?;
    if (receipt?['ownerId'] != prepared['ownerId'] ||
        receipt?['attemptId'] != prepared['attemptId'])
      return;
    _developmentAttempt = {
      ..._developmentAttempt!,
      'resolution': 'unknown',
      'observedAt': DateTime.now().toUtc().toIso8601String(),
      if (const {'notRetained', 'notSeen'}.contains(queryStatus))
        'queryStatus': queryStatus,
    };
    _changed();
  }

  static void _validateAttempt(
    Map<String, Object?> receipt,
    InstalledGeneration pack, {
    Map<String, Object?>? prepared,
  }) {
    final root = (pack.manifest['integrity'] as Map)['root'];
    final validDecimal = RegExp(r'^[1-9][0-9]*$');
    if (receipt['schemaVersion'] != 1 ||
        receipt['targetRoot'] != root ||
        receipt['ownerId'] is! String ||
        !validDecimal.hasMatch(receipt['ownerId'] as String) ||
        receipt['attemptId'] is! String ||
        !validDecimal.hasMatch(receipt['attemptId'] as String) ||
        !const {'inPlace', 'restart'}.contains(receipt['reloadKind']) ||
        !const {'load', 'applyDevPack'}.contains(receipt['operation']) ||
        (prepared != null &&
            (receipt['ownerId'] != prepared['ownerId'] ||
                receipt['attemptId'] != prepared['attemptId'] ||
                receipt['operation'] != prepared['operation'] ||
                !mapEquals(
                  receipt['expectedAccepted'] as Map?,
                  prepared['expectedAccepted'] as Map?,
                )))) {
      throw const PlayerError(
        'ERR_PROTOCOL_VERSION',
        'Native attempt receipt identity is invalid.',
      );
    }
  }

  static void _requirePreparedRestartMeasurement(
    Map<String, Object?> capabilities,
  ) {
    final chrome = capabilities['chrome'];
    final layout = chrome is Map ? chrome['atomicLayout'] : null;
    if (layout is! Map || layout['preparedRestartMeasurement'] != '1.0') {
      throw const PlayerError(
        'ERR_UNSUPPORTED_CAPABILITY',
        'This Player requires native prepared-restart layout measurement 1.0. Older adapters are not substituted.',
      );
    }
  }

  static Map<String, Object?> _verifiedAcceptedIdentity(
    Map<String, Object?> receipt,
    Map<String, Object?>? previous,
  ) {
    final value = receipt['acceptedPackIdentity'];
    if (value is! Map ||
        value['root'] != receipt['targetRoot'] ||
        value['sessionId'] is! String ||
        (value['sessionId'] as String).isEmpty ||
        value['acceptedPackRevision'] is! String ||
        !RegExp(r'^[1-9][0-9]*$')
            .hasMatch(value['acceptedPackRevision'] as String) ||
        (previous != null &&
            BigInt.parse(value['acceptedPackRevision'] as String) <=
                BigInt.parse(previous['acceptedPackRevision'] as String))) {
      throw const PlayerError(
        'ERR_PROTOCOL_VERSION',
        'Accepted pack identity is missing or stale.',
      );
    }
    return Map<String, Object?>.from(value);
  }

  void _retainUnknownAttempt(
    InstalledGeneration pack,
    String key,
    Map<String, Object?>? observed,
    Map<String, Object?> candidateCapabilities,
  ) {
    // A frame revision can advance because of old JS timers. Without a success
    // result or a native publication receipt it does not identify this pack.
    if (activePack != null)
      previousPack = _activeProjectKey == key ? activePack : null;
    activePack = null;
    failedPack = pack;
    _nativeStateUnknown = true;
    _activeProjectKey = key;
    nativeState = observed ?? {};
    capabilities = candidateCapabilities;
    _expectedNativeGeneration = null;
    _expectedFrameRevision = null;
    _reportedPresented = false;
    _pausePreview(controller!);
    phase = 'native-state-unknown';
    _adoptFailure(
      'ERR_DEV_OUTCOME_UNKNOWN: Native pack state could not be established. Preview input is paused. Retry restarts the attempted pack; loading the previous pack starts a fresh session.',
      phase: PlayerFailurePhase.development,
      code: 'ERR_DEV_OUTCOME_UNKNOWN',
      source: controller,
    );
    _report('error', pack.descriptor, {
      'error': {'code': 'ERR_DEV_OUTCOME_UNKNOWN', 'message': error},
    });
    _log(error!);
  }

  void _consumeNativeEvent(
    WeappContainerController current,
    WeappContainerEvent event,
  ) {
    if (!identical(current, controller) || _disposed) return;
    _observeDevelopmentAttemptEvent(current, event);
    if (event.type == 'hostLayoutObservation' ||
        event.type == 'hostLayoutAccepted') {
      if (event.type == 'hostLayoutObservation') {
        final observation = event.fields['observation'];
        if (observation is! Map ||
            !_rememberShellObservation(current, observation))
          return;
        final request = _shellObservations[current.id];
        if (request != null &&
            identical(request.controller, current) &&
            !request.observed.isCompleted) {
          final old = request.previous;
          final next = _shellSequence(observation['observationId']);
          final previous = _shellSequence(old['observationId']);
          final nextSurface = _shellSequence(observation['surfaceGeneration']);
          final previousSurface = _shellSequence(old['surfaceGeneration']);
          if (observation['schemaVersion'] == 1 &&
              _shellObservationPageMatches(
                observation,
                request.sessionId,
                request.pageId,
              ) &&
              observation['ownerId'] == old['ownerId'] &&
              _shellSequence(observation['ownerId']) != null &&
              next != null &&
              previous != null &&
              nextSurface != null &&
              previousSurface != null) {
            if (nextSurface > previousSurface) {
              // A new native surface retires the old lease. Its pending
              // observation must be measured by its own widget operation.
              _retireShellObservation(current);
              _holdShellInput(current);
              _dirtyShellGeometry[current.id]?.needsObservation = false;
            } else if (nextSurface == previousSurface && next > previous) {
              request.observed.complete();
              _dirtyShellGeometry[current.id]?.needsObservation = false;
            }
          }
        }
      }
      _changed();
      return;
    }
    if (identical(_capturingNativeController, current)) {
      final pending = _capturedNativeEvents;
      if (pending != null) {
        if (pending.length == 100) pending.removeAt(0);
        pending.add(event);
        return;
      }
    }
    if (event.type == 'navigationLayout') {
      final request = event.fields['request'];
      if (request is Map)
        _stageNavigation(current, Map<String, Object?>.from(request));
      return;
    }
    if (event.type == 'chrome') {
      final value = event.fields['chrome'];
      if (value is Map) {
        if (value['sessionId'] != null &&
            nativeState['sessionId'] != null &&
            value['sessionId'] != nativeState['sessionId'])
          return;
        final accepted = nativeState['chrome'];
        if (accepted is Map && _olderChrome(value, accepted)) return;
        nativeState = {
          ...nativeState,
          'chrome': Map<String, Object?>.from(value),
        };
        _changed();
      }
    } else if (event.type == 'chromeAction') {
      if (previewOccluded || !appRequested) return;
      final revision = event.fields['revision'];
      if (revision is num && revision.toInt() != hostChromeRevision(current))
        return;
      switch (event.fields['action']) {
        case 'more':
          onNativeMore?.call();
        case 'close':
          onNativeClose?.call();
        case 'back':
          onNativeBack?.call();
        case 'switchTab':
          final route = event.fields['route'];
          if (route is String) onNativeSwitchTab?.call(route);
      }
    } else if (event.type == 'console') {
      final fields = event.fields;
      final level =
          const {
            'log',
            'warn',
            'error',
            'info',
            'debug',
          }.contains(fields['level'])
          ? fields['level'] as String
          : 'info';
      final message = fields['message'];
      if (message is! String) return;
      final text = _safeText(message, limit: 4096);
      _log('[$level] $text');
      final stack = fields['stack'];
      final safeStack = stack is String && stack.isNotEmpty
          ? _safeText(stack, limit: 4096)
          : null;
      if (stack is String && stack.isNotEmpty) {
        _log(safeStack!);
      }
      final pack = activePack;
      if (pack != null) {
        _report('log', pack.descriptor, {
          'level': level,
          'message': text,
          if (safeStack != null) 'stack': safeStack,
        });
      }
    } else if (event.type == 'error') {
      final details = event.fields['error'] is Map
          ? event.fields['error']
          : event.fields;
      final retirement = RuntimeRetirementOrigin.tryParse(
        event.fields['origin'],
      );
      if (event.fields['error'] is Map &&
          retirement != null &&
          _playerRetirements.record(
            origin: retirement,
            code: details is Map && details['code'] is String
                ? details['code'] as String
                : null,
            controllerId: current.id,
            acceptedState: nativeState,
          )) {
        final message = _safeText(
          'Retired session ${retirement.sessionId} '
          '(${retirement.fields['operation']}): ${_safeJson(details)}',
          limit: 4096,
        );
        _log(message);
        final pack = activePack;
        if (pack != null) {
          _report('log', pack.descriptor, {
            'level': 'warn',
            'message': message,
          });
        }
        _changed();
        return;
      }
      if (details is Map &&
          _isGpuError(
            details['code'] is String ? details['code'] as String : null,
          ))
        _pausePreview(current);
      _adoptFailure(
        'Native runtime error: ${_safeJson(details)}',
        phase: PlayerFailurePhase.runtime,
        code: details is Map && details['code'] is String
            ? details['code'] as String
            : null,
        source: current,
      );
      _log(error!);
      final pack = activePack;
      if (pack != null) {
        final structured = <String, Object?>{};
        if (details is Map) {
          for (final name in ['code', 'message', 'stack', 'file']) {
            final value = details[name];
            if (value is String) {
              structured[name] = _safeText(value, limit: 4096);
            }
          }
          for (final name in ['line', 'column']) {
            final value = details[name];
            if (value is int && value >= 0) structured[name] = value;
          }
        }
        if (structured.isEmpty) {
          structured['message'] = _safeJson(details);
        }
        _report('error', pack.descriptor, {'error': structured});
      }
    } else if (event.type == 'message') {
      _log('App message: ${_safeJson(event.message)}');
    }
  }

  final _pendingRetirement = <WeappContainerController>[];
  Future<void> _retire(WeappContainerController current) async {
    _forgetShellGeometry(current);
    try {
      await current.close().timeout(nativeCoordinationTimeout);
      _pendingRetirement.remove(current);
    } catch (_) {
      if (!_pendingRetirement.contains(current))
        _pendingRetirement.add(current);
      _adoptFailure(
        'ERR_CLEANUP: Previous native session could not close. Its resources are retained for an exit retry.',
        phase: PlayerFailurePhase.cleanup,
        code: 'ERR_CLEANUP',
        source: current,
      );
      _log(error!);
    }
  }

  String? _controllerKey;

  String _safeJson(Object? value) {
    return _safeText(jsonEncode(value), limit: 2000);
  }

  String _safeText(String value, {required int limit}) {
    var text = value.replaceAll(
      RegExp(r'weapp-container://\S+'),
      '[redacted connection]',
    );
    final token = credentials?.deviceToken;
    if (token != null && token.isNotEmpty)
      text = text.replaceAll(token, '[redacted]');
    return text.length > limit ? '${text.substring(0, limit)}…' : text;
  }

  void _report(
    String phase,
    ProjectGeneration descriptor, [
    Map<String, Object?> details = const {},
  ]) {
    final socket = _socket;
    if (socket == null ||
        socket.readyState != WebSocket.open ||
        descriptor.projectId != credentials?.projectId ||
        descriptor.runId != _latestRunId)
      return;
    socket.add(
      jsonEncode({
        'protocolVersion': deviceProtocolVersion,
        'type': 'report',
        'projectId': descriptor.projectId,
        'generation': descriptor.generation,
        'runId': descriptor.runId,
        'phase': phase,
        'details': details,
      }),
    );
  }

  static bool _requiresExecutionRestart(Map state) {
    final health = state['executionHealth'];
    return health is Map &&
        health['schemaVersion'] == 1 &&
        health['requiresRestart'] == true;
  }

  Future<void> inspect() async {
    if (_disposed ||
        controller == null ||
        _polling ||
        _nativeStateUnknown ||
        _capturingNativeController != null)
      return;
    _polling = true;
    try {
      final current = controller!;
      final acceptedPack = activePack;
      final state = await current.state();
      if (state['pendingNavigation'] is Map) {
        _stageNavigation(
          current,
          Map<String, Object?>.from(state['pendingNavigation'] as Map),
        );
      }
      final caps = await current.capabilities();
      if (!identical(current, controller) ||
          !identical(acceptedPack, activePack) ||
          _capturingNativeController != null ||
          _nativeStateUnknown ||
          _disposed)
        return;
      final acceptedChrome = nativeState['chrome'];
      final observedChrome = state['chrome'];
      nativeState = {
        ...state,
        if (acceptedChrome is Map &&
            observedChrome is Map &&
            _olderChrome(observedChrome, acceptedChrome))
          'chrome': Map<String, Object?>.from(acceptedChrome),
      };
      capabilities = caps;
      if ((_expectedNativeGeneration == null ||
              _expectedFrameRevision == null) &&
          state['acceptedPackIdentity'] is Map &&
          mapEquals(
            state['acceptedPackIdentity'] as Map,
            _acceptedPackIdentity,
          )) {
        // The durable receipt can accept a pack even when its optional state
        // observation failed. Recover presentation metadata passively, bound
        // to the accepted identity; never execute startup a second time.
        _expectedNativeGeneration = state['generation'];
        _expectedFrameRevision = (state['frameRevision'] as num?)?.toInt();
      }
      if (_requiresExecutionRestart(state) && !previewPaused) {
        _pausePreview(current);
        _adoptFailure(
          'ERR_EXECUTION_RESTART_REQUIRED: Runtime execution health requires a fresh session.',
          phase: PlayerFailurePhase.executionHealth,
          code: 'ERR_EXECUTION_RESTART_REQUIRED',
          source: current,
        );
        _log(error!);
      }
      final revision = (state['frameRevision'] as num?)?.toInt();
      final rendered =
          !previewPaused &&
          visible &&
          state['generation'] == _expectedNativeGeneration &&
          _expectedFrameRevision != null &&
          revision != null &&
          revision >= _expectedFrameRevision! &&
          (state['generation'] != _pausedNativeGeneration ||
              _pausedFrameRevision == null ||
              revision > _pausedFrameRevision!) &&
          state['inputEnabled'] == true &&
          (caps['runtime'] as Map?)?['gpuSurface'] == true;
      if (rendered && !_reportedPresented && activePack != null) {
        _reportedPresented = true;
        // macOS ACK proves Flutter consumed the GPU-backed pixel buffer.
        // Other adapters currently expose a native ACK without uniform screen
        // timestamps. Neither boundary establishes physical display/FPS.
        presentationStage = Platform.isMacOS
            ? 'flutter-texture-consumed'
            : 'native-frame-acknowledged';
        phase = 'native-acknowledged';
        _report('diagnostic', activePack!.descriptor, {
          'code': 'NATIVE_FRAME_ACKNOWLEDGED',
          'presentationStage': presentationStage,
          'screenPresented': false,
          'nativeGeneration': state['generation'],
          'frameRevision': revision,
          'gpuSurface': true,
        });
        _log(
          'Generation ${activePack!.descriptor.generation}: $presentationStage; screen presentation and FPS are not measured.',
        );
      }
      _changed();
    } catch (_) {
      /* Native operation errors are reported by the operation owner. */
    } finally {
      _polling = false;
    }
  }

  static bool _olderChrome(Map observed, Map accepted) {
    if (observed['sessionId'] != accepted['sessionId']) return false;
    final before = accepted['chromeRevision'];
    final after = observed['chromeRevision'];
    return before is num && after is num && after < before;
  }

  void _stageNavigation(
    WeappContainerController current,
    Map<String, Object?> request,
  ) {
    final ticket = request['ticket'];
    final root = (activePack?.manifest['integrity'] as Map?)?['root'];
    if (ticket is! String ||
        request['root'] != root ||
        request['sessionId'] != _acceptedPackIdentity?['sessionId'] ||
        !appRequested ||
        !identical(current, controller) ||
        _disposed)
      return;
    if (_navigationTicket == ticket) return;
    if (_navigationPreparation != null || prospectiveController != null) {
      unawaited(
        current
            .command('cancelNavigation', {'ticket': ticket})
            .catchError((_) => <String, Object?>{}),
      );
      return;
    }
    _holdShellInput(current);
    _retireShellObservation(current);
    _navigationTicket = ticket;
    _navigationPreparation = _prepareNavigation(current, request).whenComplete(
      () {
        if (_navigationTicket == ticket) {
          _navigationTicket = null;
          _navigationPreparation = null;
          unawaited(_flushDirtyShellGeometry(current));
        }
      },
    );
    unawaited(_navigationPreparation);
  }

  Future<void> _prepareNavigation(
    WeappContainerController current,
    Map<String, Object?> request,
  ) async {
    final ticket = request['ticket'] as String;
    final cancellation = Completer<void>();
    _activationWaits.add(cancellation);
    var completed = false;
    try {
      if (request['chrome'] is! Map)
        throw const PlayerError(
          'ERR_PROTOCOL_VERSION',
          'Navigation has no prospective host chrome.',
        );
      prospectiveController = current;
      prospectiveChrome = Map<String, Object?>.from(request['chrome'] as Map);
      _prospectiveRestartAttempt = null;
      prospectiveTabIcons = tabIcons;
      final measurement = Completer<Map<String, Object?>>();
      _prospectiveGeometry = measurement;
      measurement.future.ignore();
      _changed();
      await _awaitCoordination(
        current.requestHostLayoutObservation(),
        cancellation,
      );
      final layout = await _awaitActivation(
        measurement.future,
        cancellation,
      ).timeout(const Duration(seconds: 15));
      if (!appRequested || !identical(current, controller) || _disposed) return;
      final state = await _awaitCoordination(
        current.command('completeNavigationLayout', {
          'ticket': ticket,
          'layout': layout,
        }),
        cancellation,
      );
      completed = true;
      _chromeGeometryRevision[current.id] = int.parse(
        layout['layoutRevision'] as String,
      );
      nativeState = state;
      if (layout['chrome'] case final Map measured) {
        final rectangles = _shellRectanglesOf(
          Map<String, Object?>.from(measured),
        );
        if (rectangles != null) _shellRectangles[current.id] = rectangles;
      }
      _retainLateProspectiveShell(current, layout);
      _expectedNativeGeneration = state['generation'];
      _expectedFrameRevision = (state['frameRevision'] as num?)?.toInt();
      _reportedPresented = false;
      presentationStage = 'awaiting-native-ack';
    } catch (exception) {
      if (appRequested &&
          !_disposed &&
          (exception is! PlayerError || exception.code != 'ERR_CANCELLED'))
        fail(exception);
    } finally {
      if (!completed && !current.isClosed) {
        try {
          await _awaitCoordination(
            current.command('cancelNavigation', {'ticket': ticket}),
            cancellation,
          );
        } catch (_) {}
      }
      _activationWaits.remove(cancellation);
      if (identical(prospectiveController, current)) {
        _prospectiveShellGeometry.remove(current.id);
        prospectiveController = null;
        prospectiveChrome = {};
        prospectiveTabIcons = const TabIconCatalog();
        _prospectiveGeometry = null;
        _prospectiveRestartAttempt = null;
        _changed();
      }
      if (completed) await inspect().timeout(nativeCoordinationTimeout);
    }
  }

  Future<void> reload() async {
    final latest = _latest;
    if (latest != null) {
      _enqueue(latest, ++_updateEpoch);
    }
  }

  /// Keep actual shell changes even while its preview cannot measure them.
  /// Chrome metadata and retries never create a new native observation lease.
  Future<void> observeActiveShellGeometry(
    WeappContainerController current,
    Map<String, Object?> geometry,
  ) async {
    if (!_ownsHostMeasurement(current) || !identical(current, controller)) {
      return;
    }
    final snapshot = _layoutSnapshot(geometry);
    final rectangles = _shellRectanglesOf(snapshot);
    if (rectangles == null) return;
    final sessionId = snapshot['sessionId'] ?? nativeState['sessionId'];
    final pageId = snapshot['pageId'] ?? _shellPageId;
    if (sessionId != nativeState['sessionId'] || pageId != _shellPageId) {
      return;
    }
    final before = _shellRectangles[current.id];
    final changed = before == null || !_sameShellValue(before, rectangles);
    _shellRectangles[current.id] = rectangles;
    recordHostChrome(current, snapshot);
    if (changed) {
      _dirtyShellGeometry[current.id] = _DirtyShellGeometry(
        current,
        snapshot,
        sessionId,
        pageId,
      );
    }
    await _flushDirtyShellGeometry(current);
  }

  Object? get _shellPageId => (nativeState['page'] as Map?)?['id'];

  Map<String, Object?>? _shellRectanglesOf(Map<String, Object?> geometry) {
    if (geometry['contentRect'] is! Map || geometry['menuButtonRect'] is! Map) {
      return null;
    }
    return _layoutSnapshot({
      'contentRect': geometry['contentRect'],
      'menuButtonRect': geometry['menuButtonRect'],
    });
  }

  bool _sameShellValue(Object? left, Object? right) {
    if (left is Map && right is Map) {
      return left.length == right.length &&
          left.keys.every(
            (key) =>
                right.containsKey(key) &&
                _sameShellValue(left[key], right[key]),
          );
    }
    if (left is List && right is List) {
      return left.length == right.length &&
          List.generate(
            left.length,
            (index) => index,
          ).every((index) => _sameShellValue(left[index], right[index]));
    }
    return left == right;
  }

  BigInt? _shellSequence(Object? value) {
    if (value is! String || !RegExp(r'^[1-9][0-9]{0,19}$').hasMatch(value)) {
      return null;
    }
    final parsed = BigInt.tryParse(value);
    return parsed != null && parsed <= BigInt.parse('18446744073709551615')
        ? parsed
        : null;
  }

  bool _rememberShellObservation(
    WeappContainerController current,
    Map observation,
  ) {
    final surface = _shellSequence(observation['surfaceGeneration']);
    final sequence = _shellSequence(observation['observationId']);
    final owner = _shellNativeOwners[current.id];
    if (owner == null ||
        observation['schemaVersion'] != 1 ||
        observation['ownerId'] != owner ||
        _shellSequence(observation['ownerId']) == null ||
        surface == null ||
        sequence == null ||
        observation['windowMetrics'] is! Map) {
      return false;
    }
    final previous = _shellNativeObservations[current.id];
    if (previous != null) {
      final oldSurface = _shellSequence(previous['surfaceGeneration'])!;
      final oldSequence = _shellSequence(previous['observationId'])!;
      if (surface < oldSurface ||
          surface == oldSurface && sequence < oldSequence ||
          surface == oldSurface &&
              sequence == oldSequence &&
              !_sameShellValue(previous, observation)) {
        return false;
      }
    }
    _shellNativeObservations[current.id] = _layoutSnapshot(observation);
    return true;
  }

  void _retireShellObservation(WeappContainerController current) {
    final request = _shellObservations.remove(current.id);
    if (request == null || !identical(request.controller, current)) return;
    _dirtyShellGeometry[current.id]?.needsObservation = true;
    if (!request.retired.isCompleted) request.retired.complete();
  }

  void _forgetShellGeometry(WeappContainerController current) {
    _retireShellObservation(current);
    _shellRectangles.remove(current.id);
    _dirtyShellGeometry.remove(current.id);
    _shellNativeObservations.remove(current.id);
    _shellNativeOwners.remove(current.id);
    _retireShellInput(current);
    _prospectiveShellGeometry.remove(current.id);
  }

  void _retainLateProspectiveShell(
    WeappContainerController current,
    Map<String, Object?>? acceptedLayout,
  ) {
    final latest = _prospectiveShellGeometry.remove(current.id);
    if (latest == null || acceptedLayout == null) return;
    if ((latest['sessionId'] != null &&
            latest['sessionId'] != nativeState['sessionId']) ||
        (latest['pageId'] != null && latest['pageId'] != _shellPageId))
      return;
    final rectangles = _shellRectanglesOf(latest);
    final accepted = acceptedLayout['chrome'];
    final measured = accepted is Map
        ? _shellRectanglesOf(Map<String, Object?>.from(accepted))
        : _shellRectanglesOf(acceptedLayout);
    if (rectangles == null || _sameShellValue(rectangles, measured)) return;
    _shellRectangles[current.id] = rectangles;
    _dirtyShellGeometry[current.id] = _DirtyShellGeometry(
      current,
      latest,
      nativeState['sessionId'],
      _shellPageId,
    );
  }

  bool _shellObservationPageMatches(
    Map observation,
    Object? sessionId,
    Object? pageId,
  ) =>
      (sessionId == null || observation['sessionId'] == sessionId) &&
      (pageId == null || observation['pageId'] == pageId);

  bool _validPendingShell(
    WeappContainerController current,
    _DirtyShellGeometry dirty,
  ) {
    final pending = current.pendingHostLayout;
    return pending != null &&
        _shellObservationPageMatches(pending, dirty.sessionId, dirty.pageId) &&
        _rememberShellObservation(current, pending);
  }

  bool _shellNeedsInputBarrier(WeappContainerController current) {
    final dirty = _dirtyShellGeometry[current.id];
    return dirty != null &&
        identical(dirty.controller, current) &&
        dirty.sessionId == nativeState['sessionId'] &&
        dirty.pageId == _shellPageId &&
        dirty.needsObservation &&
        !_validPendingShell(current, dirty);
  }

  void _retireShellInput(WeappContainerController current) {
    final lease = _heldShellInput.remove(current.id);
    if (lease != null && !lease.retired.isCompleted) lease.retired.complete();
  }

  void _holdShellInput(WeappContainerController current) {
    _retireShellInput(current);
    _heldShellInput[current.id] = _ShellInputLease(current);
  }

  Future<void> _restoreShellInput(WeappContainerController current) async {
    final lease = _heldShellInput[current.id];
    if (lease == null ||
        !identical(lease.controller, current) ||
        lease.retired.isCompleted ||
        !identical(current, controller) ||
        !_ownsHostMeasurement(current))
      return;
    final covered =
        previewOccluded ||
        previewPaused ||
        !_foreground ||
        busy ||
        identical(current, prospectiveController) ||
        _navigationPreparation != null ||
        _shellObservations.containsKey(current.id) ||
        _shellNeedsInputBarrier(current);
    if (covered) return;
    // A pending native observation may already gate input, but it does not
    // finish the Dart transaction that covered the surface. Only that owner's
    // final flush may consume this restore lease. Otherwise a concurrent flush
    // can unocclude early, then leave a later cover with no remaining restore.
    // Multiple flushes share the same operation and deadline. A new barrier
    // retires this exact lease before it may send a different restore.
    await (lease.restoring ??= _restoreShellInputLease(current, lease));
  }

  Future<void> _restoreShellInputLease(
    WeappContainerController current,
    _ShellInputLease lease,
  ) async {
    bool ownsLease() =>
        !lease.retired.isCompleted &&
        identical(_heldShellInput[current.id], lease) &&
        _ownsHostMeasurement(current) &&
        identical(current, controller);
    _activationWaits.add(lease.retired);
    try {
      await _awaitCoordination(
        current.setPreviewOccluded(false),
        lease.retired,
      );
      if (ownsLease()) _heldShellInput.remove(current.id);
    } catch (exception) {
      if (ownsLease()) {
        _pausePreview(current);
        fail(exception);
      }
      // Retired restore receipts/errors belong to their old barrier. They
      // cannot change a new lease, pause its owner or issue a compensating
      // unocclude after close, navigation or another dirty observation.
    } finally {
      _activationWaits.remove(lease.retired);
    }
  }

  Future<void> _flushDirtyShellGeometry(
    WeappContainerController current,
  ) async {
    try {
      await _prepareDirtyShellGeometry(current);
    } finally {
      // A deferred measurement must keep native input covered until a genuine
      // pending observation or accepted layout provides its own authority gate.
      await _restoreShellInput(current);
    }
  }

  Future<void> _prepareDirtyShellGeometry(
    WeappContainerController current,
  ) async {
    final dirty = _dirtyShellGeometry[current.id];
    if (dirty == null || !identical(dirty.controller, current)) return;
    if (dirty.sessionId != nativeState['sessionId'] ||
        dirty.pageId != _shellPageId) {
      // A measurement of the previous page cannot resize its successor. Its
      // native navigation barrier owns the successor's independent geometry.
      _dirtyShellGeometry.remove(current.id);
      return;
    }
    if (!_ownsHostMeasurement(current) ||
        !identical(current, controller) ||
        closingMiniProgram ||
        !_foreground ||
        previewPaused ||
        previewOccluded ||
        busy ||
        identical(current, prospectiveController) ||
        _navigationPreparation != null ||
        !current.atomicHostLayout ||
        !dirty.needsObservation ||
        _shellObservations.containsKey(current.id)) {
      return;
    }
    recordHostChrome(current, dirty.geometry);
    if (_validPendingShell(current, dirty)) {
      // A real current pending observation already gates native input. The
      // Shell must answer it; requesting another would invalidate its lease.
      dirty.needsObservation = false;
      _changed();
      return;
    }
    final last = current.lastHostLayoutObservation;
    if (last != null) _rememberShellObservation(current, last);
    final previous = _shellNativeObservations[current.id];
    if (previous == null) {
      _pausePreview(current);
      fail(const PlayerError('ERR_NOT_READY', 'No native shell observation.'));
      return;
    }
    final request = _ShellObservationRequest(
      current,
      _layoutSnapshot(previous),
      dirty.sessionId,
      dirty.pageId,
    );
    _shellObservations[current.id] = request;
    _activationWaits.add(request.retired);
    _holdShellInput(current);
    try {
      // Cover the accepted frame before requesting new geometry: native
      // observation tasks do not revoke old input when merely enqueued. Cover,
      // transport and the real event share one deadline and retirement token.
      await _awaitCoordination(() async {
        await current.setPreviewOccluded(true);
        if (request.retired.isCompleted ||
            !_ownsHostMeasurement(current) ||
            !identical(current, controller) ||
            !identical(_shellObservations[current.id], request))
          return;
        await Future.wait<void>([
          current.requestHostLayoutObservation(),
          request.observed.future,
        ]);
      }(), request.retired);
    } catch (exception) {
      if (!request.retired.isCompleted &&
          _ownsHostMeasurement(current) &&
          identical(current, controller)) {
        _pausePreview(current, nativeCoverRequested: true);
        fail(exception);
      }
    } finally {
      if (identical(_shellObservations[current.id], request)) {
        _shellObservations.remove(current.id);
      }
      _activationWaits.remove(request.retired);
    }
  }

  Map<String, Object?> _layoutSnapshot(Map value) =>
      Map<String, Object?>.from(jsonDecode(jsonEncode(value)) as Map);

  bool _ownsHostMeasurement(WeappContainerController current) =>
      !_disposed &&
      appRequested &&
      !current.isClosed &&
      (identical(current, controller) ||
          identical(current, candidateController));

  bool _samePendingObservation(
    WeappContainerController current,
    Map<String, Object?>? submitted,
  ) {
    if (!current.atomicHostLayout) return true;
    final pending = current.pendingHostLayout;
    if (submitted == null || pending == null) return false;
    for (final field in const [
      'schemaVersion',
      'ownerId',
      'surfaceGeneration',
      'observationId',
      'sessionId',
      'pageId',
    ]) {
      if (pending[field] != submitted[field]) return false;
    }
    return jsonEncode(pending['windowMetrics']) ==
        jsonEncode(submitted['windowMetrics']);
  }

  Future<bool> _supersededMeasurement(
    WeappContainerController current,
    Object exception,
    Map<String, Object?>? observation,
    String revision,
    Stopwatch elapsed,
  ) async {
    if (!current.atomicHostLayout ||
        observation == null ||
        _stableNativeCode(exception) != 'ERR_CANCELLED') {
      return false;
    }
    final remaining = nativeCoordinationTimeout - elapsed.elapsed;
    if (remaining <= Duration.zero) return false;
    final cancellation = Completer<void>();
    _activationWaits.add(cancellation);
    try {
      return await _awaitActivation(
        current.wasHostLayoutSuperseded(
          observation: observation,
          layoutRevision: revision,
        ),
        cancellation,
      ).timeout(remaining);
    } catch (_) {
      // An unavailable outcome is not supersession. Keep the original error.
      return false;
    } finally {
      _activationWaits.remove(cancellation);
    }
  }

  Future<void> observeHostChrome(
    WeappContainerController current,
    Map<String, Object?> geometry,
  ) async {
    final elapsed = Stopwatch()..start();
    if (_disposed ||
        !appRequested ||
        !identical(current, controller) &&
            !identical(current, candidateController))
      return;
    geometry = _layoutSnapshot(geometry);
    final pending = current.pendingHostLayout;
    final observation = pending == null ? null : _layoutSnapshot(pending);
    if (current.atomicHostLayout &&
        (observation == null ||
            geometry['observationId'] != observation['observationId']))
      return;
    recordHostChrome(current, geometry);
    final revision = (geometry['revision'] as num).toInt();
    try {
      if (current.atomicHostLayout) {
        if (identical(current, candidateController)) {
          final prepared = await current.prepareHostLayout(
            observation: observation!,
            chrome: geometry,
            layoutRevision: geometry['revision'].toString(),
          );
          if (!_ownsHostMeasurement(current) ||
              !_samePendingObservation(current, observation) ||
              _chromeGeometryRevision[current.id] != revision) {
            return;
          }
          _initialHostLayouts[current.id] = prepared;
        } else {
          await current.updateHostLayout(
            observation: observation!,
            chrome: geometry,
            layoutRevision: geometry['revision'].toString(),
          );
        }
      } else {
        await current.updateHostChrome(geometry);
      }
      if (_ownsHostMeasurement(current) &&
          _chromeGeometryRevision[current.id] == revision) {
        hostChromeApplied(current, revision);
      }
    } catch (exception) {
      if (!_ownsHostMeasurement(current)) return;
      if (await _supersededMeasurement(
        current,
        exception,
        observation,
        revision.toString(),
        elapsed,
      )) {
        // The replacement must finish its own measurement. Do not release
        // startup or consume its geometry using this old operation's result.
        return;
      }
      if (!_ownsHostMeasurement(current)) return;
      final ready = _chromeGeometryReady[current.id];
      if (ready != null && !ready.isCompleted) ready.completeError(exception);
      if (appRequested) fail(exception);
    }
  }

  void recordHostChrome(
    WeappContainerController current,
    Map<String, Object?> geometry,
  ) {
    if (_disposed ||
        !appRequested ||
        !identical(current, controller) &&
            !identical(current, candidateController))
      return;
    final rectangles = _shellRectanglesOf(geometry);
    if (rectangles != null)
      _shellRectangles.putIfAbsent(current.id, () => rectangles);
    final observation = current.lastHostLayoutObservation;
    if (observation != null) {
      final owner = observation['ownerId'];
      if (_shellSequence(owner) != null) {
        _shellNativeOwners.putIfAbsent(current.id, () => owner as String);
      }
      _rememberShellObservation(current, observation);
    }
    final revision = (geometry['revision'] as num?)?.toInt();
    if (revision != null)
      _chromeGeometryRevision[current.id] = max(
        revision,
        _chromeGeometryRevision[current.id] ?? 0,
      );
    if (revision != null)
      _chromeIssuedRevision[current.id] = max(
        revision,
        _chromeIssuedRevision[current.id] ?? 0,
      );
  }

  /// Called after the SDK View has translated and committed real host geometry.
  /// A Flutter layout notification alone cannot unblock guest startup.
  void hostChromeApplied(WeappContainerController current, int revision) {
    if (_disposed ||
        !appRequested ||
        revision != hostChromeRevision(current) ||
        !identical(current, controller) &&
            !identical(current, candidateController))
      return;
    final ready = _chromeGeometryReady[current.id];
    if (ready != null && !ready.isCompleted) ready.complete();
  }

  Future<void> observeProspectiveChrome(
    WeappContainerController current,
    Map<String, Object?> geometry,
  ) async {
    final elapsed = Stopwatch()..start();
    final measurement = _prospectiveGeometry;
    final restartAttempt = _prospectiveRestartAttempt;
    if (measurement == null ||
        !identical(current, prospectiveController) ||
        !appRequested ||
        previewOccluded)
      return;
    geometry = _layoutSnapshot(geometry);
    final latest = _prospectiveShellGeometry[current.id];
    final revisionBefore = (latest?['revision'] as num?)?.toInt() ?? -1;
    final measuredRevision = (geometry['revision'] as num?)?.toInt() ?? -1;
    if (measuredRevision >= revisionBefore) {
      _prospectiveShellGeometry[current.id] = geometry;
    }
    if (measurement.isCompleted) return;
    final pending = current.pendingHostLayout;
    final observation = pending == null ? null : _layoutSnapshot(pending);
    if (current.atomicHostLayout &&
        (observation == null ||
            geometry['observationId'] != observation['observationId']))
      return;
    final revision = max(
      (geometry['revision'] as num).toInt(),
      initialChromeRevision(current) + 1,
    );
    _chromeIssuedRevision[current.id] = revision;
    _changed();
    try {
      final Map<String, Object?> prepared;
      if (current.atomicHostLayout) {
        final content = geometry['contentRect'] as Map;
        final metrics = observation!['windowMetrics'] as Map;
        if (((content['width'] as num) - (metrics['windowWidth'] as num))
                    .abs() >
                1 ||
            ((content['height'] as num) - (metrics['windowHeight'] as num))
                    .abs() >
                1)
          return;
        prepared = await current.prepareHostLayout(
          observation: observation,
          chrome: {...geometry, 'revision': revision},
          layoutRevision: revision.toString(),
          restartAttempt: restartAttempt,
        );
      } else {
        prepared = await current.prepareHostChrome(
          {...geometry, 'revision': revision}
            ..remove('sessionId')
            ..remove('pageId'),
        );
      }
      if (identical(measurement, _prospectiveGeometry) &&
          !measurement.isCompleted &&
          appRequested &&
          !previewOccluded &&
          identical(current, prospectiveController) &&
          _samePendingObservation(current, observation) &&
          _chromeIssuedRevision[current.id] == revision)
        measurement.complete(prepared);
    } catch (exception) {
      if (!identical(measurement, _prospectiveGeometry) ||
          measurement.isCompleted ||
          !identical(current, prospectiveController) ||
          !appRequested) {
        return;
      }
      if (await _supersededMeasurement(
        current,
        exception,
        observation,
        revision.toString(),
        elapsed,
      )) {
        return;
      }
      if (identical(measurement, _prospectiveGeometry) &&
          !measurement.isCompleted)
        measurement.completeError(exception);
    }
  }

  void _cancelProspectiveChrome() {
    final prospective = prospectiveController;
    if (prospective != null) _prospectiveShellGeometry.remove(prospective.id);
    final measurement = _prospectiveGeometry;
    if (measurement != null && !measurement.isCompleted)
      measurement.completeError(
        const PlayerError('ERR_CANCELLED', 'Prospective view was cancelled.'),
      );
    prospectiveController = null;
    prospectiveChrome = {};
    prospectiveTabIcons = const TabIconCatalog();
    _prospectiveGeometry = null;
    _prospectiveRestartAttempt = null;
  }

  Future<void> setPreviewOccluded(bool occluded) async {
    if (previewOccluded == occluded) return;
    previewOccluded = occluded;
    visible = _foreground && appRequested && !previewPaused && !occluded;
    if (occluded) {
      final accepted = controller;
      if (accepted != null) {
        _holdShellInput(accepted);
        _retireShellObservation(accepted);
      }
      _updateEpoch++;
      _cancelProspectiveChrome();
      final candidate = candidateController;
      candidateController = null;
      candidateChrome = {};
      candidateTabIcons = const TabIconCatalog();
      final ready = _chromeGeometryReady[candidate?.id];
      if (ready != null && !ready.isCompleted) ready.complete();
      if (candidate != null) unawaited(_retire(candidate));
    }
    _changed();
    final accepted = controller;
    if (!occluded && accepted != null) {
      // Layout remains possible while native input stays covered. Establish a
      // real pending observation before exposing a changed shell to input.
      _holdShellInput(accepted);
      await _flushDirtyShellGeometry(accepted);
    } else {
      await controller?.setPreviewOccluded(true);
    }
    if (!occluded &&
        appRequested &&
        autoUpdate &&
        !busy &&
        availablePack != null &&
        availablePack != activePack) {
      await _restartPack(availablePack!, restart: false);
    }
    final resumed = controller;
    if (!occluded && resumed != null) await _flushDirtyShellGeometry(resumed);
  }

  Future<void> openMiniProgram() async {
    if (closingMiniProgram || _disposed) return;
    appRequested = true;
    previewOccluded = false;
    visible = _foreground && !previewPaused;
    _changed();
    final pack = availablePack;
    if (controller == null && pack != null) {
      await _restartPack(pack);
    } else if (controller == null) {
      await reload();
    }
  }

  Future<void> closeMiniProgram() =>
      _closeMiniProgramTask ??= _closeMiniProgram();

  Future<void> _closeMiniProgram() async {
    appRequested = false;
    previewOccluded = false;
    closingMiniProgram = true;
    visible = false;
    _updateEpoch++;
    _cancelActivationWaits();
    final candidate = candidateController;
    candidateController = null;
    candidateChrome = {};
    candidateTabIcons = const TabIconCatalog();
    _changed(); // Unmount surfaces before retiring the owner-thread sessions.
    try {
      // Signal every geometry/prepare barrier before joining the queue. The
      // activation owner retires its uncommitted candidate in its finally block.
      await _navigationPreparation;
      await _applyQueue;
      if (candidate != null && !candidate.isClosed) await _retire(candidate);
      final accepted = controller;
      controller = null;
      await _nativeEvents?.cancel();
      _nativeEvents = null;
      if (accepted != null) await _retire(accepted);
      _chromeGeometryRevision.clear();
      _chromeIssuedRevision.clear();
      activePack = null;
      tabIcons = const TabIconCatalog();
      failedPack = null;
      nativeState = {};
      inspectorData = {};
      capabilities = {};
      _controllerKey = null;
      _nativeStateUnknown = false;
      previewPaused = false;
      presentationStage = 'closed';
      phase = connected ? 'project-ready' : 'disconnected';
      _log(
        'Mini-program closed. Connection, verified packs and persistent storage retained.',
      );
    } finally {
      closingMiniProgram = false;
      _closeMiniProgramTask = null;
      _changed();
    }
  }

  Future<void> rollback() async {
    final previous = previousPack;
    if (previous == null || busy) return;
    final saved = credentials;
    if (saved == null ||
        previous.projectKey !=
            _store?.projectKey(saved.serverId, saved.projectId)) {
      fail(
        const PlayerError(
          'ERR_DEV_PROJECT',
          'Reconnect the accepted project before rolling it back. Its current session remains available.',
        ),
      );
      return;
    }
    await _restartPack(previous);
  }

  Future<void> _restartPack(
    InstalledGeneration pack, {
    bool restart = true,
  }) async {
    final saved = credentials;
    if (saved == null ||
        pack.projectKey !=
            _store?.projectKey(saved.serverId, saved.projectId)) {
      fail(
        const PlayerError(
          'ERR_DEV_PROJECT',
          'Reconnect this project before restarting its downloaded pack.',
        ),
      );
      return;
    }
    final update = ++_updateEpoch;
    final connection = _connectionEpoch;
    _applyQueue = _applyQueue
        .then((_) async {
          bool current() =>
              !_disposed &&
              appRequested &&
              !previewOccluded &&
              update == _updateEpoch &&
              connection == _connectionEpoch;
          if (!current()) return;
          busy = true;
          _changed();
          try {
            await _activate(pack, restart: restart, isCurrent: current);
          } catch (exception) {
            fail(exception);
          } finally {
            busy = false;
            _changed();
            final accepted = controller;
            if (accepted != null) unawaited(_flushDirtyShellGeometry(accepted));
          }
        })
        .catchError((Object exception) {
          fail(exception);
        });
    await _applyQueue;
  }

  void setAutoUpdate(bool value) {
    autoUpdate = value;
    if (!value) _updateEpoch++;
    if (value &&
        _latest != null &&
        (activePack?.descriptor.generation != _latest!.generation ||
            activePack?.descriptor.runId != _latest!.runId)) {
      _enqueue(_latest!, ++_updateEpoch);
    }
    _changed();
  }

  /// Focus-only inactive keeps the development connection, while the guest's
  /// existing native foreground mapping remains unchanged.
  Future<void> setAppLifecycle(AppLifecycleState state) {
    if (_disposed || _closing) return Future.value();
    final foregroundOwner = controller;
    late DevelopmentLifecycleIntent transition;
    final applied = _lifecycle.request(
      state,
      desktop: Platform.isMacOS || Platform.isWindows || Platform.isLinux,
      requested: (intent) {
        transition = intent;
        _foreground = intent.foreground;
        visible =
            _foreground && appRequested && !previewPaused && !previewOccluded;
        _log(
          'DEV_LIFECYCLE ${jsonEncode({'schemaVersion': 1, 'state': intent.state.name, 'lifecycleEpoch': intent.epoch, 'nativeForeground': intent.foreground, 'transportEnabled': intent.transportEnabled})}',
        );
        if (!intent.foreground) {
          _updateEpoch++;
          if (foregroundOwner != null) {
            _holdShellInput(foregroundOwner);
            _retireShellObservation(foregroundOwner);
          }
        }
        if (intent.transportEnabled) {
          _eventConnection.resume();
        } else {
          _cancelConnectionRetry();
          unawaited(_eventConnection.suspend());
          connected = false;
        }
        _changed();
      },
      apply: (intent) async {
        if (_disposed || _closing) return;
        if (foregroundOwner != null && identical(foregroundOwner, controller)) {
          if (intent.foreground && _shellNeedsInputBarrier(foregroundOwner)) {
            _holdShellInput(foregroundOwner);
            await foregroundOwner.setPreviewOccluded(true);
          }
          await foregroundOwner.setForeground(intent.foreground);
        }
      },
    );
    // Only native lifecycle edges belong to the serial queue. A slow network
    // handshake or layout observation must not delay the next background edge.
    return applied.then((_) async {
      final intent = transition;
      if (!_lifecycle.isCurrent(intent) || _disposed || _closing) return;
      if (intent.transportEnabled && !connected && _transport != null) {
        await _applyQueue;
        if (!_lifecycle.isCurrent(intent) || _disposed || _closing) return;
        await _openEvents(_connectionEpoch);
      }
      if (!_lifecycle.isCurrent(intent) || _disposed || _closing) return;
      _changed();
      final accepted = controller;
      if (intent.foreground && accepted != null) {
        await _flushDirtyShellGeometry(accepted);
      }
    });
  }

  Future<void> setForeground(bool foreground) => setAppLifecycle(
    foreground ? AppLifecycleState.resumed : AppLifecycleState.paused,
  );

  Future<void> navigate(String path) async {
    await controller?.navigate(path);
    await inspect();
  }

  Future<void> back() async {
    final chrome = nativeState['chrome'];
    if (chrome is Map && chrome['canGoBack'] == true) {
      await controller?.back();
      await inspect();
    } else {
      await closeMiniProgram();
    }
  }

  Future<void> switchTab(String path) async {
    await controller?.switchTab(path);
    await inspect();
  }

  Future<void> inspectData() async {
    final current = controller;
    if (current == null) return;
    final snapshot = await current.devState();
    if (identical(current, controller)) {
      inspectorData = _inspectorSnapshot(snapshot);
      _changed();
    }
  }

  // One native command returns the page batch. Never evaluate source or permit
  // mutations through the paired device inspector.
  Future<void> _inspectRemote(
    Map<String, Object?> request,
    WebSocket socket,
    int connectionEpoch,
  ) async {
    final requestId = request['requestId'];
    if (requestId is! String || !RegExp(r'^[a-f0-9]{32}$').hasMatch(requestId))
      return;
    final pack = activePack;
    final current = controller;
    final updateEpoch = _updateEpoch;
    final requestedAttemptPack = _developmentAttemptPack;
    bool matchesRequest(InstalledGeneration? value) =>
        value != null &&
        value.descriptor.projectId == credentials?.projectId &&
        value.descriptor.runId == _latestRunId &&
        request['projectId'] == value.descriptor.projectId &&
        request['runId'] == value.descriptor.runId &&
        request['generation'] == value.descriptor.generation;
    final targetsAttempt =
        matchesRequest(requestedAttemptPack) &&
        _developmentAttemptController == current?.id &&
        _developmentAttempt?['targetRoot'] ==
            (requestedAttemptPack!.manifest['integrity'] as Map)['root'];
    final metadataOnly =
        _nativeStateUnknown ||
        busy &&
            targetsAttempt &&
            _developmentAttempt?['resolution'] == 'pending';
    bool accepted() =>
        !_disposed &&
        connectionEpoch == _connectionEpoch &&
        identical(socket, _socket) &&
        identical(current, controller) &&
        identical(pack, activePack) &&
        updateEpoch == _updateEpoch &&
        (!busy || metadataOnly && targetsAttempt) &&
        (matchesRequest(pack) && !_nativeStateUnknown ||
            targetsAttempt &&
                identical(requestedAttemptPack, _developmentAttemptPack) &&
                (_nativeStateUnknown ||
                    pack != null &&
                        pack.descriptor.projectId == credentials?.projectId &&
                        pack.descriptor.runId == _latestRunId));
    void respond(
      String status, {
      Map<String, Object?>? snapshot,
      String? code,
    }) {
      if (socket.readyState != WebSocket.open ||
          !identical(socket, _socket) ||
          connectionEpoch != _connectionEpoch)
        return;
      socket.add(
        jsonEncode({
          'protocolVersion': deviceProtocolVersion,
          'type': 'inspect-result',
          'requestId': requestId,
          'projectId': request['projectId'],
          'runId': request['runId'],
          'generation': request['generation'],
          'status': status,
          if (snapshot != null) 'snapshot': snapshot,
          if (code != null) 'error': code,
        }),
      );
    }

    if (request['op'] != 'pages.read' || current == null || !accepted()) {
      respond('error', code: 'ERR_DEV_STALE_INSPECTION');
      return;
    }
    if (_remoteInspectBusy) {
      respond('error', code: 'ERR_DEV_INSPECT_BUSY');
      return;
    }
    _remoteInspectBusy = true;
    try {
      // Unknown ownership exposes only the verified native attempt journal.
      // It never queries or labels guest pages as belonging to a candidate.
      final snapshot = _inspectorSnapshot(
        metadataOnly
            ? <String, Object?>{'pages': <Object?>[]}
            : await current.devState(),
      );
      if (metadataOnly) snapshot['acceptedPack'] = null;
      final observedIdentity =
          (snapshot['state'] as Map?)?['acceptedPackIdentity'];
      if (!accepted() ||
          (targetsAttempt &&
              !metadataOnly &&
              !matchesRequest(pack) &&
              !_nativeStateUnknown &&
              observedIdentity is! Map) ||
          (observedIdentity != null &&
              (observedIdentity is! Map ||
                  !mapEquals(observedIdentity, _acceptedPackIdentity)))) {
        respond('error', code: 'ERR_DEV_STALE_INSPECTION');
      } else {
        respond('ok', snapshot: snapshot);
      }
    } catch (exception) {
      respond(
        'error',
        code:
            exception is PlayerError &&
                exception.code == 'ERR_DEV_INSPECT_LIMIT'
            ? 'ERR_DEV_INSPECT_LIMIT'
            : 'ERR_DEV_INSPECT_DATA',
      );
    } finally {
      _remoteInspectBusy = false;
    }
  }

  Map<String, Object?> _inspectorSnapshot(Map<String, Object?> raw) {
    final pages = raw['pages'];
    const limitError = PlayerError(
      'ERR_DEV_INSPECT_LIMIT',
      'Read-only page data exceeds the inspection budget.',
    );
    if (pages is! List || pages.length > 32) throw limitError;
    var nodes = 0;
    Object? copy(Object? value, [int depth = 0]) {
      if (++nodes > 2048 || depth > 12) throw limitError;
      if (value == null || value is bool || value is num && value.isFinite)
        return value;
      if (value is String) {
        if (value.length > 2048) throw limitError;
        var text = _safeText(value, limit: 2048).replaceAll(
          RegExp(
            r'Bearer\s+\S+|(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+',
            caseSensitive: false,
          ),
          '[redacted]',
        );
        return text;
      }
      if (value is List) return value.map((v) => copy(v, depth + 1)).toList();
      if (value is Map)
        return value.map((key, item) {
          if (key is! String || key.length > 256) throw limitError;
          return MapEntry(
            key,
            RegExp(
                  r'token|password|secret|authorization|cookie|credential|private.?key|session.?key',
                  caseSensitive: false,
                ).hasMatch(key)
                ? '[redacted]'
                : copy(item, depth + 1),
          );
        });
      throw const PlayerError('ERR_DEV_INSPECT_DATA', 'Page data is not JSON.');
    }

    final result = <String, Object?>{
      'acceptedPack': activePack == null
          ? null
          : copy({
              'projectId': activePack!.descriptor.projectId,
              'generation': activePack!.descriptor.generation,
              'runId': activePack!.descriptor.runId,
              'root': (activePack!.manifest['integrity'] as Map)['root'],
            }),
      'developmentAttempt': copy(
        _developmentAttempt?['projectId'] == credentials?.projectId &&
                _developmentAttempt?['runId'] == _latestRunId
            ? _developmentAttempt
            : null,
      ),
      'pages': pages.map((page) {
        if (page is! Map ||
            page['id'] is! num && page['id'] is! String ||
            page['route'] is! String) {
          throw const PlayerError(
            'ERR_DEV_INSPECT_DATA',
            'Page identity is invalid.',
          );
        }
        return {
          'id': copy(page['id']),
          'route': copy(page['route']),
          'data': copy(page['data']),
        };
      }).toList(),
    };
    // Passive native state and guest traces share the single devState read.
    // Do not expose arbitrary commands or internal implementation objects.
    final state = raw['state'];
    if (state is Map) {
      const allowed = <String>{
        'schemaVersion',
        'status',
        'engine',
        'sessionId',
        'ownerId',
        'page',
        'acceptedPackIdentity',
        'executionHealth',
        'viewExecutionMetrics',
        'hostSurface',
        'acceptedLayout',
        'pendingHostLayout',
        'pendingNavigation',
        'frameId',
        'frameRevision',
        'generation',
        'foreground',
        'inputEnabled',
        'presentationEnabled',
        'presentationRequired',
        'presented',
        'surface',
        'previewOccluded',
        'chromeGeometryReady',
        'observedViewport',
        'viewport',
        'hostChrome',
        'chrome',
      };
      final metadata = <String, Object?>{
        for (final key in allowed)
          if (state.containsKey(key)) key: copy(state[key]),
      };
      if (metadata.isNotEmpty) result['state'] = metadata;
    }
    if (utf8.encode(jsonEncode(result)).length > 48 * 1024) throw limitError;
    {
      // Always expose the Player-owned operation-failure journal, including
      // its initial explicit zero state. Legacy absence cannot prove zero
      // observations. Trim only this response's entries, retaining the envelope
      // and original journal. If even that envelope exceeds the fixed total
      // budget, fail explicitly rather than silently losing coverage metadata.
      final entries = _previewDiagnostics
          .map((entry) => Map<String, Object?>.of(entry))
          .toList();
      final journal = <String, Object?>{
        'schemaVersion': 1,
        'lastSequence': _previewDiagnosticSequence.toString(),
        'droppedCount': _previewDiagnosticsDropped.toString(),
        'responseTruncated': false,
        'entries': entries,
      };
      result['playerViewDiagnostics'] = journal;
      final failures = _playerFailures.snapshot();
      result['playerFailures'] = failures;
      final failureEntries = failures['entries'] as List;
      final retirements = _playerRetirements.snapshot();
      result['playerRetirementDiagnostics'] = retirements;
      final retirementEntries = retirements['entries'] as List;
      while (utf8.encode(jsonEncode(result)).length > 48 * 1024) {
        if (retirementEntries.isNotEmpty) {
          retirementEntries.removeAt(0);
          retirements['responseTruncated'] = true;
        } else if (entries.isNotEmpty) {
          entries.removeAt(0);
          journal['responseTruncated'] = true;
        } else if (failureEntries.isNotEmpty) {
          failureEntries.removeAt(0);
          failures['responseTruncated'] = true;
        } else {
          throw limitError;
        }
      }
    }
    return result;
  }

  Future<void> clearStorage() async {
    final current = controller;
    if (current == null || busy) return;
    await current.clearDevStorage();
    _log(
      'Project wx storage cleared and flushed. Page memory remains until the next restart.',
    );
  }

  Future<void> clearProject() async {
    await closeMiniProgram();
    await disconnect();
    final old = controller;
    controller = null;
    _changed();
    await _nativeEvents?.cancel();
    if (old != null) await old.close();
    // This action only clears verified downloads; durable wx storage belongs
    // to the native SDK and is deliberately not represented as deleted here.
    if (credentials != null)
      await _store?.clear(credentials!.serverId, credentials!.projectId);
    activePack = null;
    availablePack = null;
    previousPack = null;
    failedPack = null;
    _nativeStateUnknown = false;
    _activeProjectKey = null;
    nativeState = {};
    capabilities = {};
    _controllerKey = null;
    phase = 'disconnected';
    _changed();
  }

  Future<void> disconnect() {
    _connectionCommandEpoch++;
    return _disconnectCurrent();
  }

  Future<void> _disconnectCurrent() async {
    final epoch = ++_connectionEpoch;
    _updateEpoch++;
    _cancelConnectionRetry();
    final transport = _transport;
    _transport = null;
    final cleanup = _eventConnection.reset();
    // Invalidate/detach before awaiting cleanup. Old work can only close its
    // captured transport/socket, never a new pairing's resources.
    connected = false;
    transport?.close();
    _cancelActivationWaits();
    await cleanup;
    await _navigationPreparation;
    await _applyQueue;
    if (epoch != _connectionEpoch) return;
    connected = false;
    if (activePack == null) phase = 'disconnected';
    _changed();
  }

  Future<void> close() => _closeTask ??= _close();

  Future<void> _close() async {
    if (_disposed) return;
    _closing = true;
    await closeMiniProgram();
    await disconnect();
    await _eventConnection.close();
    await _lifecycle.settled;
    await _credentialPersistence;
    _poll?.cancel();
    await _applyQueue;
    await _nativeEvents?.cancel();
    await controller?.close();
    for (final retired in List<WeappContainerController>.from(
      _pendingRetirement,
    )) {
      await retired.close();
      _pendingRetirement.remove(retired);
    }
    controller = null;
    _disposed = true;
  }

  @override
  void dispose() {
    _notifierDisposed = true;
    unawaited(close());
    super.dispose();
  }
}
