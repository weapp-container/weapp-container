import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:weapp_container_dev_player/src/player_model.dart';
import 'package:weapp_container_dev_player/src/player_failure.dart';
import 'package:weapp_container_dev_player/src/protocol.dart';
import 'package:weapp_container_platform_interface/weapp_container_platform_interface.dart';
import 'package:weapp_container/weapp_container.dart';

import 'protocol_test.dart' as fixtures;

class OwnedSupport extends PathProviderPlatform {
  OwnedSupport(this.path);
  final String path;
  @override
  Future<String?> getApplicationSupportPath() async => path;
}

class ObservedModel extends PlayerModel {
  ObservedModel({super.nativeCoordinationTimeout});
  Duration? coordinationTimeout;
  @override
  Duration get nativeCoordinationTimeout =>
      coordinationTimeout ?? super.nativeCoordinationTimeout;
  Object? lastFailure;
  @override
  void fail(
    Object exception, {
    PlayerFailurePhase phase = PlayerFailurePhase.player,
    WeappContainerController? source,
    WeappViewFailure? viewFailure,
  }) {
    lastFailure = exception;
    super.fail(
      exception,
      phase: phase,
      source: source,
      viewFailure: viewFailure,
    );
  }
}

/// This is an injected native boundary. Tests below validate Player coordination,
/// and deliberately do not grant native runtime, presentation or GPU evidence.
class NativeBoundary extends WeappContainerPlatform {
  final stream = StreamController<Map<String, Object?>>.broadcast();
  final sessionErrorStreams = <int, StreamController<Object>>{};
  Object? candidateStreamError;
  int nextId = 0;
  int ownerOffset = 0;
  String ownerId(int id) => (id + ownerOffset).toString();
  bool presented = false;
  bool failCandidate = false;
  bool unrelatedFrameOnRejected = false;
  bool wrongAttemptReceipt = false;
  bool omitAcceptedState = false;
  Map<String, Object?> attemptError = {'code': 'ERR_ENGINE'};
  bool automaticMeasuredView = true;
  bool rejectPreparation = false;
  final preparedIds = <int>{};
  final preparations = <int, Completer<void>>{};
  final calls = <String>[];
  int applyCalls = 0;
  int loadCalls = 0;
  Completer<void>? creationGate;
  Completer<void>? observationGate;
  Completer<void>? nextOcclusionGate;
  Completer<void>? nextUnocclusionReply;
  Completer<void>? nextForegroundReply;
  int observationCalls = 0;
  bool emitObservationOnRequest = true;
  Completer<void>? mutationGate;
  Completer<void>? navigationCommitGate;
  Completer<void>? postMutationStateGate;
  Completer<void>? _stateGate;
  Completer<void>? stateGateEntered;
  Object? postCommitFailure;
  bool emitCommitReceipt = true;
  bool journalUnavailable = false;
  bool preparedRestartMeasurement = true;
  bool enforceRestartMeasurement = false;
  final restartMeasurements = <Map<String, Object?>>[];
  Completer<void>? journalGate;
  int journalQueries = 0;
  int _attemptSequence = 0;
  int _observationSequence = 0;
  int _acceptedRevision = 0;
  final attempts = <String, Map<String, Object?>>{};
  final navigationCompletions = <Map<String, Object?>>[];
  final latestObservations = <int, Map<String, Object?>>{};
  final navigationCancellations = <String>[];
  final acceptedIdentities = <int, Map<String, Object?>>{};
  Future<void> Function(int id)? onObservation;
  Future<void> Function(int id, Map<String, Object?> request)?
  beforeLayoutPrepare;

  void enableLayoutProof(int id) {
    final state = states[id]!;
    state.addAll({
      'schemaVersion': 1,
      'ownerId': ownerId(id),
      'sessionId': state['sessionId'],
      'hostSurface': {'ownerId': ownerId(id), 'surfaceGeneration': '1'},
      'page': state['status'] == 'ready' ? {'id': 1} : null,
      'acceptedLayout': null,
      'acceptedPackIdentity': acceptedIdentities[id],
      'pendingHostLayout': latestObservations[id],
      'executionHealth': state['status'] == 'empty'
          ? null
          : {
              'schemaVersion': 1,
              'requiresRestart': false,
              'appServiceFault': null,
              'viewFault': null,
              'navigationFault': null,
            },
    });
  }

  Map<String, Object?> observation(int id) => {
    'schemaVersion': 1,
    'ownerId': ownerId(id),
    'surfaceGeneration': '1',
    'observationId': (++_observationSequence).toString(),
    'windowMetrics': {
      'windowWidth': 375,
      'windowHeight': proposedChrome == null ? 589 : 637,
      'pixelRatio': 2.0,
      'screenWidth': 375,
      'screenHeight': 667,
      'statusBarHeight': 30.0,
      'screenTop': 78.0,
      'deviceOrientation': 'portrait',
    },
    if (states[id]?['sessionId'] != null) 'sessionId': states[id]!['sessionId'],
    if (states[id]?['status'] == 'ready')
      'pageId': (states[id]?['page'] as Map?)?['id'] ?? 1,
  };
  void emitObservation(int id) => emitObservationValue(id, observation(id));

  void emitObservationValue(int id, Map<String, Object?> value) {
    latestObservations[id] = value;
    if (states[id]!.containsKey('hostSurface')) {
      states[id]!['pendingHostLayout'] = value;
    }
    stream.add({
      'id': id,
      'event': {'type': 'hostLayoutObservation', 'observation': value},
    });
  }

  bool inPlace = false;
  int failStateAfterMutation = 0;
  int _failedStateQueries = 0;
  bool stateUnavailable = false;
  bool restoreStateOnLoad = false;
  final packPaths = <int, String>{};
  Completer<Map<String, Object?>>? devStateGate;
  Map<String, Object?> devSnapshot = {
    'state': {'privateInternal': 'not exported'},
    'pages': [
      {
        'id': 1,
        'route': 'pages/home/index',
        'data': {'count': 9, 'accessToken': 'secret'},
      },
    ],
  };
  final closedIds = <int>[];
  final foregroundCalls = <(int, bool)>[];
  final occlusionCalls = <(int, bool)>[];
  final chromeGeometries = <Map<String, Object?>>[];
  final preparedChromeGeometries = <Map<String, Object?>>[];
  final transactionalChromeGeometries = <Map<String, Object?>>[];
  Map<String, Object?>? proposedChrome;
  Future<void> Function(int id)? onPrepared;
  final chrome = <String, Object?>{
    'schemaVersion': 1,
    'title': 'Injected page',
    'navigationStyle': 'default',
    'backgroundColor': '#ffffff',
    'frontColor': '#000000',
    'canGoBack': false,
    'stack': [
      {'id': 1, 'route': 'pages/home/index'},
    ],
  };
  final states = <int, Map<String, Object?>>{};
  @override
  Stream<Map<String, Object?>> get events {
    final id = nextId;
    final errors = sessionErrorStreams.putIfAbsent(
      id,
      () => StreamController<Object>.broadcast(),
    );
    return Stream<Map<String, Object?>>.multi((sink) {
      final values = stream.stream.listen(sink.add, onError: sink.addError);
      final failures = errors.stream.listen((_) {}, onError: sink.addError);
      sink.onCancel = () async {
        await values.cancel();
        await failures.cancel();
      };
    });
  }

  @override
  Future<void> initialize() async {}
  @override
  Future<T?> invoke<T>(String method, Map<String, Object?> arguments) async {
    Object? result;
    final id = arguments['id'] as int?;
    calls.add('$method:$id');
    if (method == 'command') {
      final operation = arguments['operation'];
      final body = Map<String, Object?>.from(arguments['payload'] as Map);
      if (operation == 'completeNavigationLayout') {
        navigationCompletions.add(body);
        await navigationCommitGate?.future;
        stream.add({
          'id': id,
          'event': {
            'type': 'hostLayoutAccepted',
            'acceptedLayout': body['layout'],
          },
        });
        if (proposedChrome != null) {
          final next = proposedChrome!;
          proposedChrome = null;
          chrome
            ..clear()
            ..addAll(next);
        }
        states[id]!['chrome'] = {...chrome};
        states[id]!['pendingNavigation'] = null;
        states[id]!['frameRevision'] =
            (states[id]!['frameRevision'] as int) + 1;
        return {
          ...states[id]!,
          'chrome': {...chrome},
        } as T;
      }
      if (operation == 'cancelNavigation') {
        navigationCancellations.add(body['ticket'] as String);
        return {...states[id]!} as T;
      }
      if (operation == 'acceptedPackIdentity')
        return acceptedIdentities[id] as T;
      if (operation == 'beginDevPackAttempt') {
        final manifest = jsonDecode(
          await File('${body['packPath']}/manifest.json').readAsString(),
        ) as Map;
        expect(body['expectedAccepted'], acceptedIdentities[id]);
        final attempt = <String, Object?>{
          'schemaVersion': 1,
          'ownerId': ownerId(id!),
          'attemptId': (++_attemptSequence).toString(),
          'operation': body['operation'],
          'packPath': body['packPath'],
          'route': body['route'],
          'targetRoot': (manifest['integrity'] as Map)['root'],
          'expectedAccepted': body['expectedAccepted'],
          'status': 'prepared',
          'reloadKind': body['operation'] == 'load' || !inPlace
              ? 'restart'
              : 'inPlace',
        };
        attempts[attempt['attemptId'] as String] = attempt;
        return Map<String, Object?>.from(attempt) as T;
      }
      final attempt = attempts[body['attemptId']]!;
      if (operation == 'queryDevPackAttempt') {
        journalQueries++;
        await journalGate?.future;
        if (journalUnavailable)
          throw PlatformException(code: 'ERR_JOURNAL_UNAVAILABLE');
        return {...attempt, if (wrongAttemptReceipt) 'attemptId': '999999'}
            as T;
      }
      if (operation == 'cancelDevPackAttempt') {
        attempt['status'] = 'cancelled';
        return Map<String, Object?>.from(attempt) as T;
      }
      if (operation == 'applyDevPackAttempt') {
        Object? failure;
        final previous = acceptedIdentities[id];
        try {
          await invoke<Object?>(attempt['operation'] as String, {
            'id': id,
            'packPath': attempt['packPath'],
            'route': attempt['route'],
            if (body['initialHostLayout'] != null)
              'initialHostLayout': body['initialHostLayout'],
          });
          await invoke<Map>('state', {'id': id});
        } catch (error) {
          failure = error;
        }
        final accepted = !identical(previous, acceptedIdentities[id]);
        states[id]!['acceptedPackIdentity'] = acceptedIdentities[id];
        attempt.addAll({
          'status': accepted ? 'accepted' : 'rejected',
          'acceptedPackIdentity': acceptedIdentities[id],
          if (!omitAcceptedState) 'state': {...states[id]!},
          if (omitAcceptedState)
            'observationErrors': [
              {'phase': 'state', 'code': 'ERR_OBSERVATION'},
            ],
          if (!accepted) 'error': {...attemptError},
        });
        if (emitCommitReceipt)
          stream.add({
            'id': id,
            'event': {
              'type': 'devPackAttempt',
              'receipt': Map<String, Object?>.from(attempt),
            },
          });
        if (failure != null) throw failure;
        return {...attempt, if (wrongAttemptReceipt) 'attemptId': '999999'}
            as T;
      }
      throw StateError('Unexpected native command $operation');
    } else if (method == 'create') {
      expect(arguments['gpuRequired'], true);
      expect(arguments['devDiagnostics'], true);
      final next = ++nextId;
      states[next] = {'generation': 1, 'frameRevision': 2, 'status': 'empty'};
      await creationGate?.future;
      result = {'id': next};
    } else if (method == 'capabilities' || method == 'prepareView') {
      if (method == 'prepareView') {
        final measured = Completer<void>();
        preparations[id!] = measured;
        if (automaticMeasuredView) measured.complete();
        await measured.future;
        if (rejectPreparation)
          throw PlatformException(code: 'ERR_UNSUPPORTED_CAPABILITY');
        preparedIds.add(id);
        emitObservation(id);
        await Future<void>.delayed(Duration.zero);
        await onPrepared?.call(id);
      }
      if (!preparedIds.contains(id))
        throw StateError('No measured native view');
      result = {
        'build': {'gles': true, 'metal': true},
        'pack': {
          'devReload': {
            'protocolVersion': '1.0',
            'attemptJournal': {'protocolVersion': '1.0'},
          },
        },
        'runtime': {
          'gpuSurface': presented,
          'renderer': 'injected-test-boundary',
        },
        'chrome': {
          'protocolVersion': '1.0',
          'geometry': true,
          'inspectPack': true,
          'transactionalRestart': true,
          'atomicLayout': {
            'protocolVersion': '1.0',
            'enabled': true,
            if (preparedRestartMeasurement) 'preparedRestartMeasurement': '1.0',
          },
        },
      };
    } else if (method == 'inspectPackChrome') {
      result = {...proposedChrome ?? chrome};
    } else if (method == 'observeHostLayout') {
      observationCalls++;
      await observationGate?.future;
      if (emitObservationOnRequest) emitObservation(id!);
      await Future<void>.delayed(Duration.zero);
      await onObservation?.call(id!);
    } else if (method == 'hostLayout') {
      chromeGeometries.add(
        Map<String, Object?>.from(arguments['chrome'] as Map),
      );
      stream.add({
        'id': id,
        'event': {
          'type': 'hostLayoutAccepted',
          'acceptedLayout': arguments['observation'],
        },
      });
    } else if (method == 'prepareHostLayout') {
      if (arguments.containsKey('restartAttempt')) {
        restartMeasurements.add(Map<String, Object?>.from(arguments));
      }
      if (enforceRestartMeasurement &&
          (states[id]!['executionHealth'] as Map?)?['viewFault'] is Map) {
        final proof = arguments['restartAttempt'];
        if (proof is! Map ||
            proof['schemaVersion'] != 1 ||
            proof['ownerId'] != ownerId(id!) ||
            attempts[proof['attemptId']]?['status'] != 'prepared' ||
            attempts[proof['attemptId']]?['reloadKind'] != 'restart' ||
            proof['targetRoot'] !=
                attempts[proof['attemptId']]?['targetRoot'] ||
            !mapEquals(
              proof['expectedAccepted'] as Map?,
              acceptedIdentities[id],
            )) {
          throw PlatformException(code: 'ERR_NOT_READY');
        }
      }
      await beforeLayoutPrepare?.call(id!, arguments);
      final observed = arguments['observation'] as Map;
      final geometry = Map<String, Object?>.from(arguments['chrome'] as Map)
        ..remove('observationId');
      if (states[id]!['status'] == 'ready')
        preparedChromeGeometries.add(geometry);
      result = {
        'schemaVersion': 1,
        'ownerId': observed['ownerId'],
        'surfaceGeneration': observed['surfaceGeneration'],
        'observationId': observed['observationId'],
        'layoutRevision': arguments['layoutRevision'],
        'windowMetrics': observed['windowMetrics'],
        'chrome': geometry,
      };
    } else if (method == 'hostChrome') {
      chromeGeometries.add(Map<String, Object?>.from(arguments));
    } else if (method == 'prepareHostChrome') {
      final geometry = Map<String, Object?>.from(arguments)
        ..remove('id')
        ..remove('coordinateSpace');
      preparedChromeGeometries.add(geometry);
      result = geometry;
    } else if (method == 'setPreviewOccluded') {
      occlusionCalls.add((id!, arguments['occluded'] as bool));
      final gate = nextOcclusionGate;
      nextOcclusionGate = null;
      await gate?.future;
      states[id]!['occluded'] = arguments['occluded'];
      if (arguments['occluded'] == false) {
        final reply = nextUnocclusionReply;
        nextUnocclusionReply = null;
        await reply?.future;
      }
    } else if (method == 'state') {
      final gate = _stateGate;
      _stateGate = null;
      if (gate != null) {
        if (stateGateEntered?.isCompleted == false)
          stateGateEntered!.complete();
        await gate.future;
      }
      if (stateUnavailable || _failedStateQueries > 0) {
        if (_failedStateQueries > 0) _failedStateQueries--;
        throw PlatformException(code: 'ERR_STATE_UNAVAILABLE');
      }
      result = {
        ...states[id]!,
        'chrome': {...chrome},
        'inputEnabled':
            presented &&
            states[id]!['foreground'] != false &&
            states[id]!['occluded'] != true,
      };
    } else if (method == 'applyDevPack' || method == 'load') {
      expect(preparedIds.contains(id), true);
      if (method == 'load' || !inPlace) {
        expect(
          arguments['initialHostLayout'],
          isA<Map>(),
          reason: 'Every restart requires a fresh measured complete layout.',
        );
        expect(
          (arguments['initialHostLayout'] as Map)['observationId'],
          latestObservations[id]!['observationId'],
        );
      } else {
        expect(arguments['initialHostLayout'], isNull);
      }

      if (method == 'applyDevPack') {
        expect(
          states[id]!['status'],
          'ready',
          reason: 'First app must load after empty-runtime preflight',
        );
        applyCalls++;
      } else {
        loadCalls++;
      }
      final gate = mutationGate;
      mutationGate = null;
      stream.add({
        'id': id,
        'event': {
          'type': 'console',
          'level': 'info',
          'message': 'Injected launch console $id/${applyCalls + loadCalls}',
          'stack': 'at startup (app.js:3:2)',
        },
      });
      if (candidateStreamError != null)
        sessionErrorStreams[id]!.addError(candidateStreamError!);
      if (gate != null) await gate.future;
      await Future<void>.delayed(Duration.zero);
      if (failCandidate) {
        if (unrelatedFrameOnRejected) {
          states[id]!['frameRevision'] =
              (states[id]!['frameRevision'] as int) + 1;
          states[id]!['generation'] = (states[id]!['generation'] as int) + 1;
          stream.add({
            'id': id,
            'event': {
              'type': 'ready',
              'state': {...states[id]!},
            },
          });
        }
        throw StateError('Injected startup failure');
      }
      final transactionChrome =
          arguments['initialHostChrome'] ??
          (arguments['initialHostLayout'] as Map?)?['chrome'];
      if (transactionChrome case final Map geometry) {
        if (states[id]!['status'] == 'ready')
          transactionalChromeGeometries.add(
            Map<String, Object?>.from(geometry),
          );
        if (proposedChrome != null) {
          final accepted = proposedChrome!;
          proposedChrome = null;
          chrome
            ..clear()
            ..addAll(accepted);
        }
      }
      expect(
        await File('${arguments['packPath']}/manifest.json').exists(),
        true,
      );
      if (arguments['initialHostLayout'] is Map)
        stream.add({
          'id': id,
          'event': {
            'type': 'hostLayoutAccepted',
            'acceptedLayout': arguments['initialHostLayout'],
          },
        });
      states[id]!['status'] = 'ready';
      states[id]!['executionHealth'] = {
        'schemaVersion': 1,
        'requiresRestart': false,
      };
      if (method == 'load' && restoreStateOnLoad) stateUnavailable = false;
      if (method == 'load' || !inPlace)
        states[id]!['generation'] = (states[id]!['generation'] as int) + 1;
      states[id]!['frameRevision'] = (states[id]!['frameRevision'] as int) + 1;
      packPaths[id!] = arguments['packPath'] as String;
      final manifest = jsonDecode(
        await File('${arguments['packPath']}/manifest.json').readAsString(),
      ) as Map;
      states[id]!['sessionId'] = 'injected-$id-${states[id]!['generation']}';
      acceptedIdentities[id] = {
        'root': (manifest['integrity'] as Map)['root'],
        'acceptedPackRevision': (++_acceptedRevision).toString(),
        'sessionId': states[id]!['sessionId'],
      };
      states[id]!['acceptedPackIdentity'] = acceptedIdentities[id];
      _stateGate = postMutationStateGate;
      postMutationStateGate = null;
      _failedStateQueries = failStateAfterMutation;
      failStateAfterMutation = 0;
      if (emitCommitReceipt) {
        stream.add({
          'id': id,
          'event': {
            'type': method == 'load' || !inPlace ? 'ready' : 'devReload',
            'state': {...states[id]!},
          },
        });
      }
      final failure = postCommitFailure;
      postCommitFailure = null;
      if (failure != null) {
        stream.add({
          'id': id,
          'event': {
            'type': 'error',
            'code': 'ERR_RENDER',
            'message': 'Injected post-commit surface failure',
          },
        });
        await Future<void>.delayed(Duration.zero);
        throw failure;
      }
      result = method == 'load'
          ? null
          : {
              'reloadKind': inPlace ? 'inPlace' : 'restart',
              'state': {...states[id]!},
            };
    } else if (method == 'devState') {
      result = devStateGate == null ? devSnapshot : await devStateGate!.future;
    } else if (method == 'close') {
      closedIds.add(id!);
      final preparation = preparations[id];
      if (preparation != null && !preparation.isCompleted)
        preparation.completeError(StateError('Closed before measured view'));
    } else if (method == 'setForeground') {
      foregroundCalls.add((id!, arguments['foreground'] as bool));
      states[id]!['foreground'] = arguments['foreground'];
      final reply = nextForegroundReply;
      nextForegroundReply = null;
      await reply?.future;
    }
    return result as T?;
  }
}

class UnreadableFailureCode extends PlatformException {
  UnreadableFailureCode() : super(code: 'ERR_ENGINE');
  @override
  String get code => throw StateError('private code getter');
}

void main() {
  late Directory owned;
  late HttpServer server;
  late Uri endpoint;
  late String fingerprint;
  late NativeBoundary native;
  late ObservedModel model;
  late PathProviderPlatform priorPaths;
  late WeappContainerPlatform priorNative;
  final sockets = <WebSocket>[];
  final reports = <Map>[];
  String project = 'project';
  var fixture = fixtures.fixture();
  final fixtureBlob = Uint8List.fromList(utf8.encode('module.exports={};'));
  final servedBlobs = <String, Uint8List>{};

  Future<void> until(bool Function() predicate) async {
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (!predicate()) {
      if (DateTime.now().isAfter(deadline))
        throw StateError(
          'Player condition timed out: ${model.phase} ${model.error}; boundary=${model.lastFailure}',
        );
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  Map<String, Object?> measuredShell(
    WeappContainerController current,
    int revision,
  ) {
    final observation = current.pendingHostLayout!;
    final metrics = observation['windowMetrics'] as Map;
    return {
      'schemaVersion': 1,
      'revision': revision,
      'observationId': observation['observationId'],
      'contentRect': {
        'left': 0,
        'top': metrics['screenTop'],
        'width': metrics['windowWidth'],
        'height': metrics['windowHeight'],
      },
      'menuButtonRect': {
        'left': 279,
        'right': 367,
        'top': 38,
        'bottom': 70,
        'width': 88,
        'height': 32,
      },
    };
  }

  Map<String, Object?> dirtyShell(
    WeappContainerController current,
    int revision,
  ) => {
    'schemaVersion': 1,
    'revision': revision,
    'observationId': current.lastHostLayoutObservation!['observationId'],
    'contentRect': {'left': 0, 'top': 78, 'width': 375, 'height': 589},
    'menuButtonRect': {
      'left': 278 + revision,
      'right': 366 + revision,
      'top': 38,
      'bottom': 70,
      'width': 88,
      'height': 32,
    },
  };

  String ticket() => Uri(
    scheme: 'weapp-container',
    host: 'connect',
    queryParameters: {
      'endpoint': endpoint.toString(),
      'fingerprint': fingerprint,
      'code': 'test-only',
      'project': project,
    },
  ).toString();

  Future<WeappContainerController> acceptActiveShell() async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'hostLayoutAccepted',
        'acceptedLayout': current.pendingHostLayout,
      },
    });
    await until(() => current.pendingHostLayout == null);
    return current;
  }

  void publish(String generation, {bool extraModule = false}) {
    final candidate = Uint8List.fromList(
      utf8.encode('throw new Error("P0_CANDIDATE_STARTUP_FAILURE");'),
    );
    if (extraModule)
      servedBlobs[sha256.convert(candidate).toString()] = candidate;
    fixture = fixtures.fixture(
      generation: generation,
      blobs: {
        'app.js': fixtureBlob,
        if (extraModule) 'candidate.js': candidate,
      },
    );
    sockets.last.add(jsonEncode({'protocolVersion': '1.0', 'type': 'pack'}));
  }

  Future<Map> remoteInspection(String id, {String? runId}) async {
    final requestId = List.filled(32, id).join();
    sockets.single.add(
      jsonEncode({
        'protocolVersion': '1.0',
        'type': 'inspect-request',
        'op': 'pages.read',
        'requestId': requestId,
        'projectId': project,
        'runId': runId ?? fixture.descriptor['runId'],
        'generation': fixture.descriptor['generation'],
      }),
    );
    await until(
      () => reports.any(
        (r) => r['type'] == 'inspect-result' && r['requestId'] == requestId,
      ),
    );
    return reports.lastWhere(
      (r) => r['type'] == 'inspect-result' && r['requestId'] == requestId,
    );
  }

  Future<Completer<void>> holdUpdate(String generation) async {
    final gate = Completer<void>();
    final expected = native.applyCalls + 1;
    native.mutationGate = gate;
    publish(generation);
    await until(() => native.applyCalls == expected);
    return gate;
  }

  setUp(() async {
    owned = await Directory.systemTemp.createTemp('weapp-player-model-test-');
    final cert = '${owned.path}/cert.pem';
    final key = '${owned.path}/key.pem';
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
      throw StateError('Ephemeral TLS certificate generation failed');
    fingerprint = sha256
        .convert(
          base64.decode(
            (await File(
              cert,
            ).readAsLines()).where((line) => !line.startsWith('---')).join(),
          ),
        )
        .toString();
    final tls = SecurityContext()
      ..useCertificateChain(cert)
      ..usePrivateKey(key);
    server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, tls);
    endpoint = Uri(scheme: 'https', host: '127.0.0.1', port: server.port);
    fixture = fixtures.fixture(blobs: {'app.js': fixtureBlob});
    servedBlobs
      ..clear()
      ..[sha256.convert(fixtureBlob).toString()] = fixtureBlob;
    project = 'project';
    reports.clear();
    sockets.clear();
    server.listen((request) async {
      if (request.uri.path == '/v1/pair') {
        await request.drain<void>();
        request.response.write(
          jsonEncode({
            'protocolVersion': '1.0',
            'deviceToken': 'local-test-token',
            'projectId': project,
            'serverId': 'local-test-server',
          }),
        );
      } else if (request.uri.path == '/v1/events') {
        final socket = await WebSocketTransformer.upgrade(request);
        sockets.add(socket);
        socket.listen(
          (message) => reports.add(jsonDecode(message as String) as Map),
        );
        return;
      } else if (request.uri.path == '/v1/project') {
        request.response.write(
          jsonEncode({...fixture.descriptor, 'projectId': project}),
        );
      } else if (request.uri.path.startsWith('/v1/blobs/')) {
        final blob = servedBlobs[request.uri.pathSegments.last];
        if (blob == null) {
          request.response.statusCode = 404;
        } else {
          request.response.add(blob);
        }
      } else {
        request.response.add(fixture.bytes);
      }
      await request.response.close();
    });
    priorPaths = PathProviderPlatform.instance;
    priorNative = WeappContainerPlatform.instance;
    PathProviderPlatform.instance = OwnedSupport('${owned.path}/support');
    native = NativeBoundary();
    WeappContainerPlatform.instance = native;
    model = ObservedModel();
    native.onPrepared = (id) async {
      final candidate = model.candidateController;
      if (candidate == null || candidate.id != id) return;
      await model.observeHostChrome(candidate, {
        'observationId': candidate.pendingHostLayout?['observationId'],
        'schemaVersion': 1,
        'revision': 1,
        'menuButtonRect': {
          'left': 279.0,
          'right': 367.0,
          'top': 38.0,
          'bottom': 70.0,
          'width': 88.0,
          'height': 32.0,
        },
        'contentRect': {
          'left': 0.0,
          'top': 78.0,
          'width': 375.0,
          'height': 589.0,
        },
      });
    };
    native.onObservation = (id) async {
      if (native.proposedChrome != null) return;
      final current = model.prospectiveController;
      if (current == null || current.id != id) return;
      await model.observeProspectiveChrome(current, {
        'observationId': current.pendingHostLayout?['observationId'],
        'schemaVersion': 1,
        'revision': model.initialChromeRevision(current) + 1,
        'menuButtonRect': {
          'left': 279,
          'right': 367,
          'top': 38,
          'bottom': 70,
          'width': 88,
          'height': 32,
        },
        'contentRect': {'left': 0, 'top': 78, 'width': 375, 'height': 589},
      });
    };
    await model.initialize();
  });
  tearDown(() async {
    await model.close();
    model.dispose();
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
    await native.stream.close();
    for (final errors in native.sessionErrorStreams.values) {
      await errors.close();
    }
    PathProviderPlatform.instance = priorPaths;
    WeappContainerPlatform.instance = priorNative;
    await owned.delete(recursive: true);
  });

  test(
    'close cancels owner allocation and retires only its late native owner',
    () async {
      final created = native.creationGate = Completer<void>();
      await model.connect(ticket());
      await until(() => native.nextId == 1);
      await model.closeMiniProgram().timeout(const Duration(seconds: 1));
      expect(model.controller, isNull);
      expect(model.candidateController, isNull);
      expect(native.closedIds, isEmpty);
      created.complete();
      await until(() => native.closedIds.contains(1));
      expect(native.loadCalls, 0);
      expect(model.activePack, isNull);
    },
  );

  test('capsule close releases runtime and keeps connection, cache and updates closed', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final old = model.controller!;
    final pack = model.activePack!;
    final credentials = model.credentials;
    await model.closeMiniProgram();
    expect(model.controller, isNull);
    expect(native.closedIds, contains(old.id));
    expect(model.connected, true);
    expect(model.credentials, same(credentials));
    expect(await pack.directory.exists(), true);
    expect(model.availablePack, same(pack));
    publish('2');
    await until(
      () => model.availablePack?.descriptor.generation == '2' && !model.busy,
    );
    expect(model.appRequested, false);
    expect(model.controller, isNull);
    expect(native.nextId, 1);
    await model.openMiniProgram();
    await until(
      () => model.activePack?.descriptor.generation == '2' && !model.busy,
    );
    expect(model.controller!.id, isNot(old.id));
    expect(model.connected, true);
  });

  test('close reconciles an already submitted update before retiring and cannot reopen', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final gate = await holdUpdate('2');
    var closed = false;
    final closing = model.closeMiniProgram().then((_) => closed = true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(model.appRequested, false);
    expect(closed, false);
    gate.complete();
    await closing;
    expect(model.controller, isNull);
    expect(model.activePack, isNull);
    expect(native.closedIds, contains(1));
    expect(model.availablePack?.descriptor.generation, '2');
    expect(model.connected, true);
  });

  test('tool occlusion retains runtime lifecycle and defers verified update activation', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final accepted = model.controller;
    final loads = native.loadCalls;
    final lifecycle = List.of(native.foregroundCalls);
    native.inPlace = true;
    await model.setPreviewOccluded(true);
    publish('2');
    await until(
      () => model.availablePack?.descriptor.generation == '2' && !model.busy,
    );
    expect(native.applyCalls, 0);
    expect(model.controller, same(accepted));
    expect(model.activePack?.descriptor.generation, '1');
    expect(native.foregroundCalls, lifecycle);
    expect(native.occlusionCalls, contains((accepted!.id, true)));
    await model.setPreviewOccluded(false);
    await until(
      () => model.activePack?.descriptor.generation == '2' && !model.busy,
    );
    expect(model.controller, same(accepted));
    expect(native.loadCalls, loads);
    expect(native.applyCalls, 1);
    expect(native.foregroundCalls.every((entry) => entry.$2), true);
  });

  test('initial App/Page execution waits for measured host chrome', () async {
    native.onPrepared = null;
    await model.connect(ticket());
    await until(() => native.preparedIds.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(native.loadCalls, 0);
    final current = model.candidateController!;
    await model.observeHostChrome(current, {
      'observationId': current.pendingHostLayout?['observationId'],
      'schemaVersion': 1,
      'revision': 9,
      'menuButtonRect': {
        'left': 279,
        'right': 367,
        'top': 38,
        'bottom': 70,
        'width': 88,
        'height': 32,
      },
      'contentRect': {'left': 0, 'top': 78, 'width': 375, 'height': 589},
    });
    await until(() => model.activePack != null && !model.busy);
    expect(native.loadCalls, 1);
    expect(
      native.calls.indexOf('prepareHostLayout:${current.id}'),
      lessThan(native.calls.indexOf('load:${current.id}')),
    );
    expect(
      native.calls.indexOf('prepareHostLayout:${current.id}'),
      greaterThanOrEqualTo(0),
    );
  });

  test('closing a candidate waiting for its measured native view cancels startup promptly', () async {
    native.automaticMeasuredView = false;
    await model.connect(ticket());
    await until(() => native.preparations.isNotEmpty);
    await model.closeMiniProgram().timeout(const Duration(seconds: 2));
    expect(model.candidateController, isNull);
    expect(model.controller, isNull);
    expect(native.loadCalls, 0);
    expect(native.closedIds, contains(1));
    expect(model.connected, true);
  });

  test('config-changing reload measures prospective chrome without resizing accepted runtime', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final accepted = model.controller!;
    final geometryCount = native.chromeGeometries.length;
    native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
    publish('2');
    await until(() => model.prospectiveController != null);
    expect(model.controller, same(accepted));
    expect(native.applyCalls, 0);
    expect(native.chromeGeometries.length, geometryCount);
    expect((model.nativeState['chrome'] as Map)['navigationStyle'], 'default');
    await until(
      () =>
          (accepted.pendingHostLayout?['windowMetrics']
              as Map?)?['windowHeight'] ==
          637,
    );
    await model.observeProspectiveChrome(accepted, {
      'observationId': accepted.pendingHostLayout?['observationId'],
      'schemaVersion': 1,
      'revision': 2,
      'menuButtonRect': {
        'left': 279,
        'right': 367,
        'top': 38,
        'bottom': 70,
        'width': 88,
        'height': 32,
      },
      'contentRect': {'left': 0, 'top': 30, 'width': 375, 'height': 637},
    });
    await until(
      () => model.activePack?.descriptor.generation == '2' && !model.busy,
    );
    expect(model.controller, same(accepted));
    expect(
      native.nextId,
      1,
      reason: 'Storage owner is retained across the transactional candidate.',
    );
    expect(native.preparedChromeGeometries.length, 1);
    expect(
      (native.transactionalChromeGeometries.single['contentRect']
          as Map)['height'],
      637,
    );
    expect(native.chromeGeometries.length, geometryCount);
    expect((model.nativeState['chrome'] as Map)['navigationStyle'], 'custom');
  });

  test(
    'failed config-changing startup preserves accepted chrome and geometry',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final accepted = model.controller!;
      final geometryCount = native.chromeGeometries.length;
      native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
      native.failCandidate = true;
      publish('2');
      await until(() => model.prospectiveController != null);
      await until(
        () =>
            (accepted.pendingHostLayout?['windowMetrics']
                as Map?)?['windowHeight'] ==
            637,
      );
      await model.observeProspectiveChrome(accepted, {
        'observationId': accepted.pendingHostLayout?['observationId'],
        'schemaVersion': 1,
        'revision': 2,
        'menuButtonRect': {
          'left': 279,
          'right': 367,
          'top': 38,
          'bottom': 70,
          'width': 88,
          'height': 32,
        },
        'contentRect': {'left': 0, 'top': 30, 'width': 375, 'height': 637},
      });
      await until(() => !model.busy);
      expect(model.activePack?.descriptor.generation, '1');
      expect(model.controller, same(accepted));
      expect(native.chromeGeometries.length, geometryCount);
      expect(native.transactionalChromeGeometries, isEmpty);
      expect(
        (model.nativeState['chrome'] as Map)['navigationStyle'],
        'default',
      );
      expect(model.prospectiveController, isNull);
    },
  );

  test(
    'close cancels pending prospective layout while retaining verified update',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
      publish('2');
      await until(() => model.prospectiveController != null);
      await model.closeMiniProgram().timeout(const Duration(seconds: 2));
      expect(model.controller, isNull);
      expect(model.prospectiveController, isNull);
      expect(model.availablePack?.descriptor.generation, '2');
      expect(native.applyCalls, 0);
      expect(model.connected, true);
    },
  );

  test(
    'paired inspector batches accepted page data and redacts secrets',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      native.devSnapshot['pages'] = [
        {
          'id': 1,
          'route': 'pages/home/index',
          'data': {
            'count': 9,
            'password': 'not for dashboard',
            'text': 'local-test-token',
          },
        },
      ];
      reports.clear();
      sockets.single.add(
        jsonEncode({
          'protocolVersion': '1.0',
          'type': 'ready',
          'projectId': project,
          'runId': fixture.descriptor['runId'],
        }),
      );
      await until(() => reports.any((r) => r['phase'] == 'started'));
      expect((reports.last['details'] as Map)['reattached'], true);
      sockets.single.add(
        jsonEncode({
          'protocolVersion': '1.0',
          'type': 'inspect-request',
          'op': 'pages.read',
          'requestId': List.filled(32, 'a').join(),
          'projectId': project,
          'runId': fixture.descriptor['runId'],
          'generation': fixture.descriptor['generation'],
        }),
      );
      await until(() => reports.any((r) => r['type'] == 'inspect-result'));
      final response = reports.singleWhere(
        (r) => r['type'] == 'inspect-result',
      );
      expect(response['status'], 'ok');
      expect((response['snapshot'] as Map).keys, [
        'acceptedPack',
        'developmentAttempt',
        'pages',
        'playerViewDiagnostics',
        'playerFailures',
        'playerRetirementDiagnostics',
      ]);
      expect((response['snapshot'] as Map)['playerViewDiagnostics'], {
        'schemaVersion': 1,
        'lastSequence': '0',
        'droppedCount': '0',
        'responseTruncated': false,
        'entries': <Object?>[],
      });
      final data =
          ((response['snapshot'] as Map)['pages'] as List).single['data'];
      expect(data, {
        'count': 9,
        'password': '[redacted]',
        'text': '[redacted]',
      });
      expect(
        native.calls.where((c) => c.startsWith('devState:')),
        hasLength(1),
      );
      expect(response['generation'], fixture.descriptor['generation']);
      await model.inspectData();
      expect(model.inspectorData, response['snapshot']);
    },
  );

  test('rejected g2 inspection exports its real receipt beside accepted g1 pages without guessing from frames', () async {
    native.presented = true;
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final first = model.activePack!, current = model.controller!;
    final accepted = Map.of(native.acceptedIdentities[current.id]!);
    native.failCandidate = true;
    native.unrelatedFrameOnRejected = true;
    native.attemptError = {
      'code': 'ERR_ENGINE',
      'message': 'P0_CANDIDATE_STARTUP_FAILURE local-test-token Bearer private-value github_pat_example',
      'stack': 'private stack',
      'packPath': '/private/candidate',
    };
    publish('2', extraModule: true);
    await until(() => native.applyCalls == 1 && !model.busy);
    expect(model.activePack, same(first));
    expect(native.acceptedIdentities[current.id], accepted);
    native.devSnapshot = {
      'state': {...native.states[current.id]!},
      'pages': [
        {
          'id': 1,
          'route': 'pages/home/index',
          'data': {'count': 9, 'ticks': 42},
        },
      ],
    };
    final response = await remoteInspection('a');
    expect(response['status'], 'ok');
    final snapshot = response['snapshot'] as Map;
    expect((snapshot['acceptedPack'] as Map)['generation'], '1');
    expect((snapshot['acceptedPack'] as Map)['root'], accepted['root']);
    expect((snapshot['state'] as Map)['acceptedPackIdentity'], accepted);
    expect((snapshot['pages'] as List).single['data'], {
      'count': 9,
      'ticks': 42,
    });
    final observed = snapshot['developmentAttempt'] as Map;
    final receipt = observed['receipt'] as Map;
    expect(observed['generation'], '2');
    expect(observed['targetRoot'], isNot(accepted['root']));
    expect(observed['resolution'], 'terminal');
    expect(receipt['status'], 'rejected');
    expect(receipt['expectedAccepted'], accepted);
    expect(receipt['acceptedPackIdentity'], accepted);
    expect(receipt.containsKey('state'), false);
    expect(receipt.containsKey('packPath'), false);
    expect(receipt['error'], {
      'code': 'ERR_ENGINE',
      'message':
          'P0_CANDIDATE_STARTUP_FAILURE [redacted] [redacted] [redacted]',
    });
    final raw = Map<String, Object?>.from(native.attempts.values.last);
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'devPackAttempt',
        'receipt': {...raw, 'status': 'prepared'},
      },
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect((model.developmentAttempt!['receipt'] as Map)['status'], 'rejected');
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'devPackAttempt',
        'receipt': {...raw, 'targetRoot': 'f' * 64},
      },
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(model.developmentAttempt!['targetRoot'], observed['targetRoot']);
    expect(
      (await remoteInspection('b', runId: 'ffffffffffffffff'))['error'],
      'ERR_DEV_STALE_INSPECTION',
    );
    (native.devSnapshot['state'] as Map)['acceptedPackIdentity'] = {
      ...accepted,
      'root': 'f' * 64,
    };
    expect((await remoteInspection('c'))['error'], 'ERR_DEV_STALE_INSPECTION');
  });

  test('prepared attempt can be inspected without reading a mutating guest and records actual cancellation', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    native.onObservation = null;
    publish('2', extraModule: true);
    await until(
      () =>
          model.prospectiveController != null &&
          model.developmentAttempt?['generation'] == '2',
    );
    final calls = native.calls.where((c) => c.startsWith('devState:')).length;
    final response = await remoteInspection('a');
    expect(response['status'], 'ok');
    final snapshot = response['snapshot'] as Map;
    expect(snapshot['acceptedPack'], isNull);
    expect(snapshot['pages'], isEmpty);
    expect(snapshot.containsKey('state'), false);
    expect((snapshot['developmentAttempt'] as Map)['resolution'], 'pending');
    expect(
      ((snapshot['developmentAttempt'] as Map)['receipt'] as Map)['status'],
      'prepared',
    );
    expect(
      native.calls.where((c) => c.startsWith('devState:')),
      hasLength(calls),
    );
    await model.closeMiniProgram();
    await until(
      () =>
          (model.developmentAttempt?['receipt'] as Map?)?['status'] ==
          'cancelled',
    );
    expect(model.developmentAttempt?['source'], 'cancel');
  });

  test('unknown attempt inspection exposes only real receipt metadata and never queries guest pages', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    native.emitCommitReceipt = false;
    native.journalUnavailable = true;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    publish('2', extraModule: true);
    await until(() => native.applyCalls == 1 && !model.busy);
    expect(model.phase, 'native-state-unknown');
    final calls = native.calls.where((c) => c.startsWith('devState:')).length;
    final response = await remoteInspection('a');
    expect(response['status'], 'ok');
    final snapshot = response['snapshot'] as Map;
    expect(snapshot['acceptedPack'], isNull);
    expect(snapshot['pages'], isEmpty);
    expect(snapshot.containsKey('state'), false);
    expect((snapshot['developmentAttempt'] as Map)['resolution'], 'unknown');
    expect(
      ((snapshot['developmentAttempt'] as Map)['receipt'] as Map)['status'],
      'prepared',
    );
    expect(
      native.calls.where((c) => c.startsWith('devState:')),
      hasLength(calls),
    );
  });

  test('read-only inspection binds guest geometry traces to whitelisted native identities', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!,
        identity = native.acceptedIdentities[model.controller!.id]!;
    native.devSnapshot = {
      'state': {
        'schemaVersion': 1,
        'acceptedPackIdentity': identity,
        'executionHealth': {'schemaVersion': 1, 'requiresRestart': false},
        'viewExecutionMetrics': {'batches': 7, 'executions': 11},
        'acceptedLayout': {
          'ownerId': current.id.toString(),
          'observationId': '9007199254740993',
          'layoutRevision': '3',
        },
        'hostSurface': {
          'ownerId': current.id.toString(),
          'surfaceGeneration': '1',
        },
        'pendingNavigation': null,
        'inputEnabled': true,
        'presentationRequired': true,
        'frameId': 'frame-1',
        'privateInternal': {'command': 'must not escape'},
      },
      'pages': [
        {
          'id': 1,
          'route': 'pages/home/index',
          'data': {
            'geometryTrace': [
              {'hook': 'onReady', 'windowHeight': 589, 'menuTop': 38},
            ],
          },
        },
      ],
    };
    sockets.single.add(
      jsonEncode({
        'protocolVersion': '1.0',
        'type': 'inspect-request',
        'op': 'pages.read',
        'requestId': List.filled(32, 'a').join(),
        'projectId': project,
        'runId': fixture.descriptor['runId'],
        'generation': fixture.descriptor['generation'],
      }),
    );
    await until(() => reports.any((r) => r['type'] == 'inspect-result'));
    final response = reports.singleWhere((r) => r['type'] == 'inspect-result');
    expect(response['status'], 'ok');
    final snapshot = response['snapshot'] as Map,
        state = (response['snapshot'] as Map)['state'] as Map;
    expect(state['acceptedPackIdentity'], identity);
    expect(
      (state['acceptedLayout'] as Map)['observationId'],
      '9007199254740993',
    );
    expect(state['executionHealth'], {
      'schemaVersion': 1,
      'requiresRestart': false,
    });
    expect(state['viewExecutionMetrics'], {'batches': 7, 'executions': 11});
    expect(state.containsKey('privateInternal'), false);
    expect((snapshot['pages'] as List).single['data']['geometryTrace'], [
      {'hook': 'onReady', 'windowHeight': 589, 'menuTop': 38},
    ]);
    expect(
      native.calls.where((call) => call.startsWith('devState:')),
      hasLength(1),
    );
  });

  test('first inspection explicitly exposes an empty Player-owned operation-failure journal', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    native.devSnapshot = {
      'pages': <Object?>[],
      'playerViewDiagnostics': {'injected': 'must-not-escape'},
    };
    await model.inspectData();
    const empty = {
      'schemaVersion': 1,
      'lastSequence': '0',
      'droppedCount': '0',
      'responseTruncated': false,
      'entries': <Object?>[],
    };
    expect(model.inspectorData['playerViewDiagnostics'], empty);
    sockets.single.add(
      jsonEncode({
        'protocolVersion': '1.0',
        'type': 'inspect-request',
        'op': 'pages.read',
        'requestId': List.filled(32, 'a').join(),
        'projectId': project,
        'runId': fixture.descriptor['runId'],
        'generation': fixture.descriptor['generation'],
      }),
    );
    await until(() => reports.any((r) => r['type'] == 'inspect-result'));
    final response = reports.singleWhere((r) => r['type'] == 'inspect-result');
    expect(response['status'], 'ok');
    expect((response['snapshot'] as Map)['playerViewDiagnostics'], empty);
    expect(model.error, isNull);
    expect(model.previewPaused, false);
  });

  test(
    'minimum journal envelope participates in the fixed total byte budget',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final accepted = model.controller;
      final data = {for (var i = 0; i < 25; i++) 'value$i': 'x' * 1890};
      native.devSnapshot = {
        'pages': [
          {'id': 1, 'route': 'pages/home/index', 'data': data},
        ],
      };
      await model.inspectData();
      final baseBytes = utf8.encode(jsonEncode(model.inspectorData)).length;
      final padding =
          48 * 1024 - baseBytes - utf8.encode(',"padding":""').length;
      expect(padding, inInclusiveRange(1, 2047));
      data['padding'] = 'p' * padding;
      await model.inspectData();
      final full = model.inspectorData;
      expect(utf8.encode(jsonEncode(full)).length, 48 * 1024);
      expect(full.containsKey('playerViewDiagnostics'), true);
      data['padding'] = 'p' * (padding + 1);
      await expectLater(
        model.inspectData(),
        throwsA(
          isA<PlayerError>().having(
            (error) => error.code,
            'code',
            'ERR_DEV_INSPECT_LIMIT',
          ),
        ),
      );
      expect(model.inspectorData, same(full));
      expect(model.controller, same(accepted));
      expect(model.error, isNull);
      expect(model.previewPaused, false);
    },
  );

  for (final largePages in [false, true]) {
    test(
      'paired inspection exposes bounded typed View diagnostics (large pages: $largePages)',
      () async {
        await model.connect(ticket());
        await until(() => model.activePack != null && !model.busy);
        final accepted = model.controller!;
        native.devSnapshot = {
          // Guest/native input cannot supply the Player-owned journal.
          'playerViewDiagnostics': {'injected': 'must-not-escape'},
          'pages': [
            {
              'id': 1,
              'route': 'pages/home/index',
              'data': largePages
                  // Reserve the new explicit failure envelope while still
                  // forcing partial journal trimming below48KiB.
                  ? {for (var i = 0; i < 25; i++) 'value$i': 'x' * 1890}
                  : {'count': 7},
            },
          ],
        };
        for (var i = 1; i <= 23; i++) {
          model.recordPreviewDiagnostic(
            WeappViewDiagnostic(
              operation: WeappViewOperation.resizeTexture,
              viewLease: 3,
              operationSequence: i,
              retired: false,
              error: PlatformException(
                code: 'ERR_CANCELLED',
                message: 'Bearer must-not-escape',
                details: {'privateKey': 'must-not-escape'},
              ),
            ),
            source: accepted,
          );
        }
        expect(model.controller, same(accepted));
        expect(model.error, isNull);
        expect(model.previewPaused, false);
        sockets.single.add(
          jsonEncode({
            'protocolVersion': '1.0',
            'type': 'inspect-request',
            'op': 'pages.read',
            'requestId': List.filled(32, 'a').join(),
            'projectId': project,
            'runId': fixture.descriptor['runId'],
            'generation': fixture.descriptor['generation'],
          }),
        );
        await until(() => reports.any((r) => r['type'] == 'inspect-result'));
        final response = reports.singleWhere(
          (r) => r['type'] == 'inspect-result',
        );
        expect(response['status'], 'ok');
        final snapshot = response['snapshot'] as Map;
        expect(
          utf8.encode(jsonEncode(snapshot)).length,
          lessThanOrEqualTo(48 * 1024),
        );
        expect(jsonEncode(snapshot), isNot(contains('must-not-escape')));
        final journal = snapshot['playerViewDiagnostics'] as Map;
        expect(journal.keys.toSet(), {
          'schemaVersion',
          'lastSequence',
          'droppedCount',
          'responseTruncated',
          'entries',
        });
        expect(journal['schemaVersion'], 1);
        expect(journal['lastSequence'], '23');
        expect(journal['droppedCount'], '7');
        expect(journal['responseTruncated'], largePages);
        final entries = journal['entries'] as List;
        if (largePages) {
          expect(entries.length, greaterThan(0));
          expect(entries.length, lessThan(16));
        } else {
          expect(entries, hasLength(16));
        }
        expect((entries.last as Map)['sequence'], '23');
        if (!largePages) expect((entries.first as Map)['sequence'], '8');
        for (final entry in entries.cast<Map>()) {
          expect(entry.keys.toSet(), {
            'schemaVersion',
            'operation',
            'viewLease',
            'operationSequence',
            'retired',
            'code',
            'nativeReason',
            'controllerRole',
            'sequence',
          });
          expect(entry['code'], 'ERR_CANCELLED');
          expect(entry['nativeReason'], 'unclassified');
          expect(entry['controllerRole'], 'accepted');
          expect(entry['retired'], false);
          expect(entry['viewLease'], '3');
          expect(entry['operation'], 'resizeTexture');
        }
        // A large reply trims its own copy. Editing that reply and later
        // inspecting fewer pages cannot alter or truncate the retained journal.
        (entries.last as Map)['code'] = 'ERR_CHANGED_REPLY';
        native.devSnapshot['pages'] = [];
        await model.inspectData();
        final retained = model.inspectorData['playerViewDiagnostics'] as Map;
        expect(retained['responseTruncated'], false);
        expect(retained['droppedCount'], '7');
        expect(retained['lastSequence'], '23');
        expect(retained['entries'], hasLength(16));
        expect(((retained['entries'] as List).first as Map)['sequence'], '8');
        expect(
          ((retained['entries'] as List).last as Map)['code'],
          'ERR_CANCELLED',
        );
        expect(model.controller, same(accepted));
        expect(model.error, isNull);
        expect(model.previewPaused, false);
      },
    );
  }

  test('diagnostic entries trim to an explicit envelope within the fixed byte limit', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final data = {for (var i = 0; i < 25; i++) 'value$i': 'x' * 1890};
    native.devSnapshot = {
      'pages': [
        {'id': 1, 'route': 'pages/home/index', 'data': data},
      ],
    };
    await model.inspectData();
    final baseBytes = utf8.encode(jsonEncode(model.inspectorData)).length;
    final padding =
        48 * 1024 - 8 - baseBytes - utf8.encode(',"padding":""').length;
    expect(padding, inInclusiveRange(1, 2048));
    data['padding'] = 'p' * padding;
    await model.inspectData();
    expect(utf8.encode(jsonEncode(model.inspectorData)).length, 48 * 1024 - 8);

    model.recordPreviewDiagnostic(
      WeappViewDiagnostic(
        operation: WeappViewOperation.attachTexture,
        viewLease: 4,
        operationSequence: 1,
        retired: false,
        error: PlatformException(code: 'ERR_RENDER'),
      ),
      source: model.controller!,
    );
    await model.inspectData();
    expect(model.error, isNull);
    final trimmed = model.inspectorData['playerViewDiagnostics'] as Map;
    expect(trimmed['lastSequence'], '1');
    expect(trimmed['droppedCount'], '0');
    expect(trimmed['responseTruncated'], true);
    expect(trimmed['entries'], isEmpty);
    expect(
      utf8.encode(jsonEncode(model.inspectorData)).length,
      lessThanOrEqualTo(48 * 1024),
    );

    native.devSnapshot['pages'] = [];
    await model.inspectData();
    final journal = model.inspectorData['playerViewDiagnostics'] as Map;
    expect(journal['lastSequence'], '1');
    expect(journal['droppedCount'], '0');
    expect(journal['responseTruncated'], false);
    expect(journal['entries'], hasLength(1));
  });

  test(
    'inspector rejects stale identities, mutations and reload races',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      Map<String, Object?> request(String id) => {
        'protocolVersion': '1.0',
        'type': 'inspect-request',
        'op': 'pages.read',
        'requestId': List.filled(32, id).join(),
        'projectId': project,
        'runId': fixture.descriptor['runId'],
        'generation': fixture.descriptor['generation'],
      };
      sockets.single.add(jsonEncode({...request('a'), 'generation': '999'}));
      await until(() => reports.any((r) => r['type'] == 'inspect-result'));
      expect(reports.last['error'], 'ERR_DEV_STALE_INSPECTION');
      expect(native.calls.where((c) => c.startsWith('devState:')), isEmpty);
      reports.clear();
      sockets.single.add(jsonEncode({...request('b'), 'op': 'pages.write'}));
      await until(() => reports.any((r) => r['type'] == 'inspect-result'));
      expect(reports.last['status'], 'error');
      expect(native.calls.where((c) => c.startsWith('devState:')), isEmpty);
      reports.clear();
      native.devStateGate = Completer<Map<String, Object?>>();
      sockets.single.add(jsonEncode(request('c')));
      await until(() => native.calls.any((c) => c.startsWith('devState:')));
      model.busy = true;
      native.devStateGate!.complete(native.devSnapshot);
      await until(() => reports.any((r) => r['type'] == 'inspect-result'));
      expect(reports.last['error'], 'ERR_DEV_STALE_INSPECTION');
      expect(reports.last.containsKey('snapshot'), false);
      model.busy = false;
    },
  );

  test(
    'inspector rejects oversized page data without partial success',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      native.devSnapshot['pages'] = [
        {
          'id': 1,
          'route': 'pages/home/index',
          'data': {'large': List.filled(2049, 'x').join()},
        },
      ];
      sockets.single.add(
        jsonEncode({
          'protocolVersion': '1.0',
          'type': 'inspect-request',
          'op': 'pages.read',
          'requestId': List.filled(32, 'a').join(),
          'projectId': project,
          'runId': fixture.descriptor['runId'],
          'generation': fixture.descriptor['generation'],
        }),
      );
      await until(() => reports.any((r) => r['type'] == 'inspect-result'));
      expect(reports.last['error'], 'ERR_DEV_INSPECT_LIMIT');
      expect(reports.last.containsKey('snapshot'), false);
    },
  );

  test('first activation waits for measured native-view preparation before running app code', () async {
    native.automaticMeasuredView = false;
    await model.connect(ticket());
    await until(
      () => model.candidateController != null && native.preparations.isNotEmpty,
    );
    final candidate = model.candidateController!;
    expect(model.controller, isNull);
    expect(model.activePack, isNull);
    expect(native.loadCalls, 0);
    expect(native.applyCalls, 0);
    expect(native.calls, isNot(contains('capabilities:${candidate.id}')));
    native.preparations[candidate.id]!.complete();
    await until(() => model.activePack != null && !model.busy);
    expect(model.controller, same(candidate));
    expect(model.candidateController, isNull);
    expect(native.loadCalls, 1);
    expect(native.applyCalls, 0);
    expect(
      native.calls.indexOf('prepareView:${candidate.id}'),
      lessThan(native.calls.indexOf('load:${candidate.id}')),
    );
  });
  test('unsupported measured-view preflight never executes candidate JS or retires accepted view', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final accepted = model.controller, acceptedPack = model.activePack;
    final loads = native.loadCalls, applies = native.applyCalls;
    native.rejectPreparation = true;
    project = 'different-project';
    await model.connect(ticket());
    await until(() => model.error != null && !model.busy);
    expect(model.controller, same(accepted));
    expect(model.activePack, same(acceptedPack));
    expect(model.candidateController, isNull);
    expect(native.loadCalls, loads);
    expect(native.applyCalls, applies);
    expect(native.closedIds, contains(2));
    expect(native.closedIds, isNot(contains(1)));
  });

  test('native ACK has an explicit conservative stage and never claims screen presentation', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    expect(model.phase, 'started');
    expect(reports.any((event) => event['phase'] == 'presented'), false);
    expect(
      model.logs.any((line) => line.contains('Injected launch console 1')),
      true,
    );
    await until(() => reports.any((event) => event['phase'] == 'log'));
    native.presented = true;
    await model.inspect();
    await until(
      () => reports.any(
        (event) =>
            (event['details'] as Map?)?['code'] == 'NATIVE_FRAME_ACKNOWLEDGED',
      ),
    );
    final report = reports.firstWhere(
      (event) =>
          (event['details'] as Map?)?['code'] == 'NATIVE_FRAME_ACKNOWLEDGED',
    );
    expect(report['runId'], fixture.descriptor['runId']);
    expect(model.phase, 'native-acknowledged');
    expect((report['details'] as Map)['screenPresented'], false);
    expect(
      (report['details'] as Map)['presentationStage'],
      Platform.isMacOS
          ? 'flutter-texture-consumed'
          : 'native-frame-acknowledged',
    );
    expect(reports.any((event) => event['phase'] == 'presented'), false);
  });
  test('active Metal/texture failures pause native input; retry requires a new frame ACK', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    native.presented = true;
    await model.inspect();
    final pausedRevision = native.states[current.id]!['frameRevision'] as int;
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'error',
        'code': 'ERR_METAL',
        'message': 'GPU command failed',
      },
    });
    await until(
      () =>
          model.previewPaused &&
          native.occlusionCalls.contains((current.id, true)),
    );
    expect(model.visible, false);
    expect(model.phase, 'preview-paused');
    expect(model.presentationStage, 'failed');
    await model.setForeground(true);
    expect(native.foregroundCalls.last, (current.id, true));
    await model.retryPreview();
    expect(model.visible, true);
    expect(model.previewPaused, false);
    expect(model.phase, 'started');
    expect(model.presentationStage, 'awaiting-native-ack');
    native.states[current.id]!['frameRevision'] = pausedRevision + 1;
    await model.inspect();
    expect(model.phase, 'native-acknowledged');
    model.handlePreviewError(
      PlatformException(code: 'ERR_TEXTURE'),
      source: current,
    );
    await until(() => model.previewPaused);
    expect(model.visible, false);
  });
  test('committed native stream errors pause the active preview while failed candidate stream errors do not', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final accepted = model.controller!;
    native.failCandidate = true;
    native.candidateStreamError = PlatformException(
      code: 'ERR_METAL',
      message: 'candidate private details',
    );
    project = 'new-project';
    await model.connect(ticket());
    await until(() => !model.busy && native.closedIds.contains(2));
    expect(model.controller, same(accepted));
    expect(model.previewPaused, false);
    expect(model.visible, true);
    expect(
      native.foregroundCalls.where(
        (call) => call.$1 == accepted.id && !call.$2,
      ),
      isEmpty,
    );
    native.sessionErrorStreams[accepted.id]!.addError(
      PlatformException(code: 'ERR_METAL', message: 'active private details'),
    );
    await until(
      () =>
          model.previewPaused &&
          native.occlusionCalls.contains((accepted.id, true)),
    );
    expect(model.phase, 'preview-paused');
    expect(model.error, startsWith('ERR_METAL:'));
    expect(model.logs.any((line) => line.contains('private details')), false);
  });
  test('failure diagnostics retain only strict native codes without exception details', () {
    model.fail(
      PlatformException(
        code: 'ERR_NOT_READY',
        message: 'weapp-container://secret',
        details: {'token': 'private-token'},
      ),
    );
    expect(model.error, startsWith('ERR_NOT_READY:'));
    model.fail(const WeappHostError('ERR_METAL', 'private-token'));
    expect(model.error, startsWith('ERR_METAL:'));
    model.fail(
      PlatformException(
        code: 'ERR_BAD\nprivate-token',
        message: 'private-token',
      ),
    );
    expect(model.error, startsWith('ERR_PLAYER:'));
    model.fail(StateError('private-token'));
    expect(model.error, startsWith('ERR_PLAYER:'));
    model.fail(const PlayerError('ERR_DEV_PROJECT', 'Known safe diagnostic.'));
    expect(model.error, 'ERR_DEV_PROJECT: Known safe diagnostic.');
    expect(
      model.logs.any(
        (line) =>
            line.contains('private-token') ||
            line.contains('weapp-container://'),
      ),
      false,
    );
  });
  test('download, failed candidate and stale preview errors keep the accepted app running', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    model.fail(const PlayerError('ERR_RENDER', 'candidate could not start'));
    expect(model.previewPaused, false);
    expect(model.visible, true);
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'error',
        'error': {'code': 'ERR_ENGINE', 'message': 'business exception'},
      },
    });
    await until(() => model.error?.contains('ERR_ENGINE') == true);
    expect(model.previewPaused, false);
    final other = await WeappContainerController.create(
      storageKey: null,
      gpuRequired: true,
      devDiagnostics: true,
    );
    model.handlePreviewError(
      PlatformException(code: 'ERR_METAL'),
      source: other,
    );
    expect(model.previewPaused, false);
    expect(model.visible, true);
    await other.close();
    expect(model.controller, same(current));
  });
  test('View operation diagnostics preserve retired leases and never alter current preview health', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final accepted = model.controller!;
    final visible = model.visible;
    final phase = model.phase;
    final diagnostic = WeappViewDiagnostic(
      operation: WeappViewOperation.uncover,
      viewLease: 1,
      operationSequence: 2,
      retired: true,
      error: PlatformException(
        code: 'ERR_CANCELLED',
        message: 'private://credential',
        details: {'secret': 'private-data'},
      ),
    );
    model.recordPreviewDiagnostic(diagnostic, source: accepted);
    final other = await WeappContainerController.create(
      storageKey: null,
      gpuRequired: true,
      devDiagnostics: true,
    );
    model.candidateController = other;
    model.recordPreviewDiagnostic(diagnostic, source: other);
    model.candidateController = null;
    model.prospectiveController = other;
    model.recordPreviewDiagnostic(diagnostic, source: other);
    model.prospectiveController = null;
    model.recordPreviewDiagnostic(diagnostic, source: other);
    await other.close();
    final records = model.logs
        .where((line) => line.contains('NATIVE_VIEW_OPERATION '))
        .toList();
    expect(records, hasLength(4));
    for (final role in ['accepted', 'candidate', 'prospective', 'retired']) {
      expect(
        records.any((line) => line.contains('"controllerRole":"$role"')),
        isTrue,
      );
    }
    expect(records.join(), isNot(contains('credential')));
    expect(records.join(), isNot(contains('private-data')));
    expect(model.previewPaused, false);
    expect(model.visible, visible);
    expect(model.phase, phase);
    expect(model.controller, same(accepted));
  });
  test('failed cross-project candidate never destroys the accepted project controller', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final old = model.controller;
    final accepted = model.activePack;
    native.failCandidate = true;
    project = 'different-project';
    await model.connect(ticket());
    await until(
      () => model.error?.startsWith('ERR_ENGINE:') == true && !model.busy,
    );
    expect(model.controller, same(old));
    expect(model.activePack, same(accepted));
    expect(native.closedIds, contains(2));
    expect(native.closedIds, isNot(contains(1)));
    expect(
      model.logs.any((line) => line.contains('Injected launch console 2')),
      false,
    );
  });

  test(
    'application heartbeat is acknowledged without fabricated runtime reports',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      sockets.last.add(
        jsonEncode({'protocolVersion': '1.0', 'type': 'heartbeat'}),
      );
      await until(() => reports.any((event) => event['type'] == 'heartbeat'));
      final heartbeat = reports.firstWhere(
        (event) => event['type'] == 'heartbeat',
      );
      expect(heartbeat, {'protocolVersion': '1.0', 'type': 'heartbeat'});
    },
  );

  test('accepted native logs and errors retain source-map coordinates and generation identity', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    await until(() => reports.any((event) => event['phase'] == 'log'));
    final log = reports.firstWhere((event) => event['phase'] == 'log');
    expect((log['details'] as Map)['stack'], 'at startup (app.js:3:2)');
    expect(log['projectId'], project);
    expect(log['runId'], fixture.descriptor['runId']);
    expect(log['generation'], fixture.descriptor['generation']);
    native.stream.add({
      'id': model.controller!.id,
      'event': {
        'type': 'error',
        'error': {
          'code': 'ERR_ENGINE',
          'message': 'App evaluation failed',
          'stack': 'at broken (pages/index.js:7:11)',
          'file': 'pages/index.js',
          'line': 7,
          'column': 11,
        },
      },
    });
    await until(() => reports.any((event) => event['phase'] == 'error'));
    final failure = reports.firstWhere((event) => event['phase'] == 'error');
    expect(failure['projectId'], project);
    expect(failure['runId'], fixture.descriptor['runId']);
    expect(failure['generation'], fixture.descriptor['generation']);
    expect((failure['details'] as Map)['error'], {
      'code': 'ERR_ENGINE',
      'message': 'App evaluation failed',
      'stack': 'at broken (pages/index.js:7:11)',
      'file': 'pages/index.js',
      'line': 7,
      'column': 11,
    });
  });

  test(
    'disabling auto-update cannot discard an already submitted native commit',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final first = model.activePack;
      final gate = await holdUpdate('2');
      model.setAutoUpdate(false);
      gate.complete();
      await until(() => !model.busy);
      expect(model.activePack?.descriptor.generation, '2');
      expect(model.previousPack, same(first));
      expect(native.packPaths[current.id], model.activePack!.directory.path);
      expect(model.visible, true);
      expect(model.previewPaused, false);
      await until(
        () => reports.any((r) => r['phase'] == 'log' && r['generation'] == '2'),
      );
      publish('3');
      await until(
        () => model.logs.any((line) => line.contains('Generation 3 available')),
      );
      expect(native.applyCalls, 1);
      model.setAutoUpdate(true);
      await until(
        () => model.activePack?.descriptor.generation == '3' && !model.busy,
      );
      expect(native.packPaths[current.id], model.activePack!.directory.path);
    },
  );

  test('newer queued generations follow the committed intermediate pack without identity drift', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final secondGate = await holdUpdate('2');
    final thirdGate = Completer<void>();
    native.mutationGate = thirdGate;
    publish('3');
    await until(
      () => model.logs.any((line) => line.contains('Generation 3 available')),
    );
    secondGate.complete();
    await until(() => native.applyCalls == 2);
    expect(model.activePack?.descriptor.generation, '2');
    expect(native.packPaths[current.id], model.activePack!.directory.path);
    thirdGate.complete();
    await until(
      () => model.activePack?.descriptor.generation == '3' && !model.busy,
    );
    expect(model.previousPack?.descriptor.generation, '2');
    expect(native.packPaths[current.id], model.activePack!.directory.path);
    expect(model.visible, true);
  });

  test('backgrounding during native mutation reconciles the pack while preserving suspension', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final gate = await holdUpdate('2');
    await model.setForeground(false);
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack?.descriptor.generation, '2');
    expect(native.packPaths[current.id], model.activePack!.directory.path);
    expect(model.visible, false);
    expect(native.states[current.id]!['foreground'], false);
    await model.setForeground(true);
    expect(model.visible, true);
    expect(native.states[current.id]!['foreground'], true);
    expect(native.applyCalls, 1);
  });

  test('disconnect waits for an in-flight native commit and retains its offline identity', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final gate = await holdUpdate('2');
    final disconnected = model.disconnect();
    gate.complete();
    await disconnected;
    expect(model.activePack?.descriptor.generation, '2');
    expect(native.packPaths[current.id], model.activePack!.directory.path);
    expect(model.connected, false);
    expect(model.visible, true);
    expect(native.closedIds, isNot(contains(current.id)));
  });

  test('post-commit surface exceptions accept the new pack, pause input and allow explicit rollback', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final first = model.activePack;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    final gate = await holdUpdate('2');
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack?.descriptor.generation, '2');
    expect(native.packPaths[current.id], model.activePack!.directory.path);
    expect(model.previousPack, same(first));
    expect(model.previewPaused, true);
    expect(model.visible, false);
    expect(model.error, startsWith('ERR_RENDER:'));
    expect(native.states[current.id]!['foreground'], true);
    expect(native.states[current.id]!['occluded'], true);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
    await until(
      () => reports.any((r) => r['phase'] == 'error' && r['generation'] == '2'),
    );
    final failedNativeGeneration = native.states[current.id]!['generation'];
    await model.rollback();
    expect(model.activePack, same(first));
    expect(model.previewPaused, false);
    expect(native.packPaths[current.id], first!.directory.path);
    expect(
      native.states[current.id]!['generation'],
      isNot(failedNativeGeneration),
    );
    expect(
      model.logs.any((line) => line.contains('Generation 1: restart')),
      true,
    );
  });

  test('successful load followed by unavailable state is committed and presentation can retry', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final first = model.activePack;
    publish('2');
    await until(
      () => model.activePack?.descriptor.generation == '2' && !model.busy,
    );
    native.emitCommitReceipt = false;
    native.failStateAfterMutation = 2;
    await model.rollback();
    expect(model.activePack, same(first));
    expect(native.packPaths[current.id], first!.directory.path);
    expect(model.previewPaused, true);
    expect(model.failedPack, isNull);
    native.presented = true;
    native.states[current.id]!['frameRevision'] =
        (native.states[current.id]!['frameRevision'] as int) + 1;
    await model.retryPreview();
    expect(model.previewPaused, false);
    expect(model.visible, true);
    expect(
      model.nativeState['generation'],
      native.states[current.id]!['generation'],
    );
    expect(model.phase, 'native-acknowledged');
  });

  test('unprobeable mutation pauses unknown state and rollback reloads the known pack', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final first = model.activePack;
    native.emitCommitReceipt = false;
    native.journalUnavailable = true;
    native.failStateAfterMutation = 1;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    final gate = await holdUpdate('2');
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack, isNull);
    expect(model.failedPack?.descriptor.generation, '2');
    expect(model.previousPack, same(first));
    expect(model.phase, 'native-state-unknown');
    expect(model.previewPaused, true);
    expect(model.visible, false);
    expect(model.error, startsWith('ERR_DEV_OUTCOME_UNKNOWN:'));
    expect(native.states[current.id]!['foreground'], true);
    expect(native.states[current.id]!['occluded'], true);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
    await model.rollback();
    expect(model.activePack, same(first));
    expect(native.packPaths[current.id], first!.directory.path);
    expect(model.failedPack, isNull);
    expect(model.previewPaused, false);
  });

  test('accepted receipt without optional state recovers ACK metadata without a second launch', () async {
    native.omitAcceptedState = true;
    native.presented = true;
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    await model.inspect();
    expect(model.activePack?.descriptor.generation, '1');
    expect(model.failedPack, isNull);
    expect(native.loadCalls, 1);
    expect(native.applyCalls, 0);
    expect(model.phase, 'native-acknowledged');
    expect(model.previewPaused, false);
  });

  test(
    'a lost journal query reply expires as unknown without replaying startup',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      model.coordinationTimeout = const Duration(milliseconds: 75);
      native.emitCommitReceipt = false;
      native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
      final query = native.journalGate = Completer<void>();
      publish('2');
      await until(() => native.journalQueries == 1);
      await until(() => !model.busy);
      expect(model.phase, 'native-state-unknown');
      expect(model.activePack, isNull);
      expect(model.failedPack?.descriptor.generation, '2');
      expect(model.previewPaused, true);
      final loads = native.loadCalls;
      query.complete();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(model.phase, 'native-state-unknown');
      expect(native.loadCalls, loads);
    },
  );

  for (final action in ['close', 'disconnect']) {
    test(
      '$action cancels a passive journal query with no native reply',
      () async {
        await model.connect(ticket());
        await until(() => model.activePack != null && !model.busy);
        native.emitCommitReceipt = false;
        native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
        final query = native.journalGate = Completer<void>();
        publish('2');
        await until(() => native.journalQueries == 1);
        await (action == 'close'
                ? model.closeMiniProgram()
                : model.disconnect())
            .timeout(const Duration(seconds: 1));
        expect(model.busy, false);
        if (action == 'close') {
          expect(model.controller, isNull);
          expect(model.activePack, isNull);
        } else {
          expect(model.activePack, isNull);
          expect(model.failedPack?.descriptor.generation, '2');
          expect(model.previewPaused, true);
        }
        query.complete();
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(model.activePack, isNull);
      },
    );
  }

  test('a changed frame revision alone is not proof that a failed in-place attempt committed', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final first = model.activePack;
    native.emitCommitReceipt = false;
    native.journalUnavailable = true;
    native.inPlace = true;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    final gate = await holdUpdate('2');
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack, isNull);
    expect(model.previousPack, same(first));
    expect(model.failedPack?.descriptor.generation, '2');
    final loads = native.loadCalls;
    await model.retryPreview();
    expect(
      native.loadCalls,
      loads + 1,
      reason: 'Unknown state retries by loading a fresh session',
    );
    expect(model.activePack?.descriptor.generation, '2');
    expect(model.failedPack, isNull);
    expect(model.previewPaused, false);
  });

  test(
    'a rollback load remains committed when its state reply is superseded',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final first = model.activePack;
      publish('2');
      await until(
        () => model.activePack?.descriptor.generation == '2' && !model.busy,
      );
      final stateGate = Completer<void>();
      native.postMutationStateGate = stateGate;
      final rollback = model.rollback();
      await until(() => native.loadCalls == 2);
      model.setAutoUpdate(false);
      stateGate.complete();
      await rollback;
      expect(model.activePack, same(first));
      expect(native.packPaths[current.id], first!.directory.path);
      expect(model.visible, true);
      expect(model.previewPaused, false);
    },
  );

  test('same-shape restarts require fresh observations while safe in-place updates do not', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final first = native.latestObservations[current.id]!['observationId'];
    publish('2');
    await until(
      () => model.activePack?.descriptor.generation == '2' && !model.busy,
    );
    final second = native.latestObservations[current.id]!['observationId'];
    expect(second, isNot(first));
    expect(native.transactionalChromeGeometries, hasLength(1));
    native.inPlace = true;
    publish('3');
    await until(
      () => model.activePack?.descriptor.generation == '3' && !model.busy,
    );
    expect(native.latestObservations[current.id]!['observationId'], second);
    expect(native.transactionalChromeGeometries, hasLength(1));
  });

  test(
    'late same-size shell measurement cannot consume a newer observation',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final initialObservation =
          current.lastHostLayoutObservation!['observationId'];
      native.onObservation = null;
      publish('2');
      await until(
        () =>
            model.prospectiveController != null &&
            current.pendingHostLayout?['observationId'] != initialObservation,
      );
      final stale = current.pendingHostLayout!['observationId'];
      native.emitObservation(current.id);
      await until(() => current.pendingHostLayout?['observationId'] != stale);
      final issued = model.initialChromeRevision(current);
      final prepared = native.preparedChromeGeometries.length;
      Map<String, Object?> geometry(Object? observation) => {
        'schemaVersion': 1,
        'revision': issued + 1,
        'observationId': observation,
        'contentRect': {'left': 0, 'top': 78, 'width': 375, 'height': 589},
        'menuButtonRect': {
          'left': 279,
          'right': 367,
          'top': 38,
          'bottom': 70,
          'width': 88,
          'height': 32,
        },
      };
      await model.observeProspectiveChrome(current, geometry(stale));
      expect(native.preparedChromeGeometries, hasLength(prepared));
      expect(model.initialChromeRevision(current), issued);
      expect(native.applyCalls, 0);
      await model.observeProspectiveChrome(
        current,
        geometry(current.pendingHostLayout!['observationId']),
      );
      await until(
        () => model.activePack?.descriptor.generation == '2' && !model.busy,
      );
      expect(native.applyCalls, 1);
    },
  );

  for (final cancelled in [true, false]) {
    test(
      'startup measurement ${cancelled ? 'cancellation' : 'late success'} cannot release a newer observation barrier',
      () async {
        final release = Completer<void>();
        final entered = Completer<void>();
        String? stale;
        native.beforeLayoutPrepare = (id, request) async {
          if ((request['observation'] as Map)['observationId'] != stale) return;
          entered.complete();
          await release.future;
          if (cancelled) {
            throw PlatformException(code: 'ERR_CANCELLED');
          }
        };
        native.onPrepared = (id) async {
          native.enableLayoutProof(id);
          final candidate = model.candidateController!;
          stale = candidate.pendingHostLayout!['observationId'] as String;
          await model.observeHostChrome(candidate, measuredShell(candidate, 1));
        };
        try {
          await model.connect(ticket());
          await entered.future;
          final candidate = model.candidateController!;
          native.emitObservation(candidate.id);
          await until(
            () => candidate.pendingHostLayout?['observationId'] != stale,
          );
          release.complete();
          await Future<void>.delayed(const Duration(milliseconds: 30));
          expect(model.error, isNull);
          expect(native.loadCalls, 0);
          expect(model.activePack, isNull);
          expect(model.candidateController, same(candidate));
          await model.observeHostChrome(candidate, measuredShell(candidate, 2));
          await until(() => model.activePack != null && !model.busy);
          expect(native.loadCalls, 1);
          expect(model.lastFailure, isNull);
        } finally {
          if (!release.isCompleted) release.complete();
        }
      },
    );
  }

  for (final unavailable in [false, true]) {
    test(
      'startup cancellation with ${unavailable ? 'unavailable' : 'unchanged'} native proof fails explicitly',
      () async {
        native.onPrepared = (id) async {
          native.enableLayoutProof(id);
          final candidate = model.candidateController!;
          await model.observeHostChrome(candidate, measuredShell(candidate, 1));
        };
        native.beforeLayoutPrepare = (id, request) async {
          native.stateUnavailable = unavailable;
          throw PlatformException(code: 'ERR_CANCELLED');
        };
        try {
          await model.connect(ticket());
          await until(() => model.error != null && !model.busy);
          expect(native.loadCalls, 0);
          expect(model.lastFailure, isA<PlatformException>());
          expect(
            (model.lastFailure as PlatformException).code,
            'ERR_CANCELLED',
          );
        } finally {
          native.stateUnavailable = false;
        }
      },
    );
  }

  test(
    'a newer observation cannot hide a startup error other than cancellation',
    () async {
      native.onPrepared = (id) async {
        native.enableLayoutProof(id);
        final candidate = model.candidateController!;
        await model.observeHostChrome(candidate, measuredShell(candidate, 1));
      };
      native.beforeLayoutPrepare = (id, request) async {
        native.emitObservation(id);
        await Future<void>.delayed(Duration.zero);
        throw PlatformException(code: 'ERR_INVALID_REQUEST');
      };
      await model.connect(ticket());
      await until(() => model.error != null && !model.busy);
      expect(native.loadCalls, 0);
      expect(model.lastFailure, isA<PlatformException>());
      expect(
        (model.lastFailure as PlatformException).code,
        'ERR_INVALID_REQUEST',
      );
    },
  );

  test(
    'close cancels a measurement reconciliation whose state reply is missing',
    () async {
      final reply = Completer<void>();
      final entered = Completer<void>();
      native.stateGateEntered = entered;
      native.onPrepared = (id) async {
        native.enableLayoutProof(id);
        final candidate = model.candidateController!;
        await model.observeHostChrome(candidate, measuredShell(candidate, 1));
      };
      native.beforeLayoutPrepare = (id, request) async {
        native._stateGate = reply;
        throw PlatformException(code: 'ERR_CANCELLED');
      };
      try {
        await model.connect(ticket());
        await entered.future;
        await model.close().timeout(const Duration(seconds: 2));
        expect(model.appRequested, false);
        expect(model.activePack, isNull);
        expect(native.loadCalls, 0);
        expect(model.lastFailure, isNull);
      } finally {
        reply.complete();
      }
    },
  );

  for (final cancelled in [true, false]) {
    test(
      'prospective measurement ${cancelled ? 'cancellation' : 'late success'} leaves the original activation waiting for fresh geometry',
      () async {
        await model.connect(ticket());
        await until(() => model.activePack != null && !model.busy);
        final current = model.controller!;
        native.enableLayoutProof(current.id);
        native.onObservation = null;
        final previousObservation =
            current.lastHostLayoutObservation?['observationId'];
        publish('2');
        await until(
          () =>
              identical(model.prospectiveController, current) &&
              current.pendingHostLayout != null &&
              current.pendingHostLayout?['observationId'] !=
                  previousObservation,
        );
        final release = Completer<void>();
        final entered = Completer<void>();
        final stale = current.pendingHostLayout!['observationId'];
        native.beforeLayoutPrepare = (id, request) async {
          if ((request['observation'] as Map)['observationId'] != stale) return;
          entered.complete();
          await release.future;
          if (cancelled) throw PlatformException(code: 'ERR_CANCELLED');
        };
        final issued = model.initialChromeRevision(current);
        final old = model.observeProspectiveChrome(
          current,
          measuredShell(current, issued + 1),
        );
        try {
          await entered.future;
          native.emitObservation(current.id);
          await until(
            () => current.pendingHostLayout?['observationId'] != stale,
          );
          release.complete();
          await old;
          await Future<void>.delayed(const Duration(milliseconds: 30));
          expect(model.error, isNull);
          expect(native.applyCalls, 0);
          expect(model.activePack!.descriptor.generation, '1');
          expect(model.prospectiveController, same(current));
          await model.observeProspectiveChrome(
            current,
            measuredShell(current, model.initialChromeRevision(current) + 1),
          );
          await until(
            () => model.activePack?.descriptor.generation == '2' && !model.busy,
          );
          expect(native.applyCalls, 1);
          expect(model.lastFailure, isNull);
        } finally {
          if (!release.isCompleted) release.complete();
        }
      },
    );
  }

  test('actual dirty shell coalesces changes into one native observation transaction', () async {
    final current = await acceptActiveShell();
    final previous = current.lastHostLayoutObservation!['observationId'];
    final issued = native.observationCalls;
    final gate = Completer<void>();
    native.observationGate = gate;
    final operation = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.observationCalls == issued + 1);
    try {
      for (var revision = 3; revision <= 12; revision++) {
        await model.observeActiveShellGeometry(
          current,
          dirtyShell(current, revision),
        );
      }
      expect(current.pendingHostLayout, isNull);
      expect(native.observationCalls, issued + 1);
      expect(model.hostChromeRevision(current), 12);
      gate.complete();
      await operation;
      expect(current.pendingHostLayout!['observationId'], isNot(previous));
      expect(native.observationCalls, issued + 1);
      expect(model.error, isNull);
    } finally {
      if (!gate.isCompleted) gate.complete();
    }
  });

  test('an observation request transport receipt does not complete shell measurement', () async {
    final current = await acceptActiveShell();
    native.emitObservationOnRequest = false;
    final count = native.observationCalls;
    var finished = false;
    final operation = model
        .observeActiveShellGeometry(current, dirtyShell(current, 2))
        .then((_) => finished = true);
    await until(() => native.observationCalls == count + 1);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(finished, false);
    expect(current.pendingHostLayout, isNull);
    native.emitObservation(current.id);
    await operation;
    expect(finished, true);
    expect(model.error, isNull);
  });

  test('missing native observation pauses the preview without renewing its deadline', () async {
    final current = await acceptActiveShell();
    model.coordinationTimeout = const Duration(milliseconds: 40);
    native.emitObservationOnRequest = false;
    final count = native.observationCalls;
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    expect(model.previewPaused, true);
    expect(model.error, contains('ERR_TIMEOUT'));
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    expect(native.observationCalls, count + 1);
    expect(native.foregroundCalls.where((item) => item.$2 == false), isEmpty);
  });

  test(
    'close cancels a dirty shell observation and rejects its late receipt',
    () async {
      final current = await acceptActiveShell();
      final gate = Completer<void>();
      native.observationGate = gate;
      final count = native.observationCalls;
      final operation = model.observeActiveShellGeometry(
        current,
        dirtyShell(current, 2),
      );
      await until(() => native.observationCalls == count + 1);
      await model.closeMiniProgram().timeout(const Duration(seconds: 2));
      await operation.timeout(const Duration(seconds: 2));
      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(model.appRequested, false);
      expect(model.controller, isNull);
      expect(model.lastFailure, isNull);
      expect(native.closedIds, contains(current.id));
      expect(native.observationCalls, count + 1);
    },
  );

  test('an existing pending shell is answered without requesting another observation', () async {
    final current = await acceptActiveShell();
    native.emitObservation(current.id);
    await until(() => current.pendingHostLayout != null);
    expect(current.pendingHostLayout, isNotNull);
    final count = native.observationCalls;
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    expect(native.observationCalls, count);
    expect(model.error, isNull);
  });

  test('unchanged shell rectangles ignore metadata, numeric representation and revision changes', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    final geometry = dirtyShell(current, 1);
    geometry.addAll({
      'revision': 50,
      'sessionId': model.nativeState['sessionId'],
      'observationId': 'metadata-only',
      'chromeRevision': 900,
      'title': 'A new title',
      'stack': [
        {'id': 1},
        {'id': 2},
      ],
    });
    await model.observeActiveShellGeometry(current, geometry);
    expect(native.observationCalls, issued);
    expect(model.hostChromeRevision(current), 50);
    expect(model.error, isNull);
  });

  test('covered dirty geometry retains the latest revision and establishes a pending barrier before uncovering native input', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    await model.setPreviewOccluded(true);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    expect(native.observationCalls, issued);
    native.emitObservationOnRequest = false;
    final resume = model.setPreviewOccluded(false);
    await until(() => native.observationCalls == issued + 1);
    expect(native.occlusionCalls.last, (current.id, true));
    expect(model.hostChromeRevision(current), 3);
    native.emitObservation(current.id);
    await resume;
    expect(current.pendingHostLayout, isNotNull);
    expect(native.occlusionCalls.last, (current.id, false));
    expect(native.observationCalls, issued + 1);
    expect(
      native.chromeGeometries,
      isEmpty,
      reason: 'Observation is not an invented layout acceptance.',
    );
    expect(model.error, isNull);
  });

  test('covering an in-flight shell observation retires it neutrally and a late receipt cannot fail the resumed owner', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    final oldGate = native.observationGate = Completer<void>();
    final oldRequest = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.observationCalls == issued + 1);
    await model.setPreviewOccluded(true);
    await oldRequest.timeout(const Duration(seconds: 1));
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    native.observationGate = null;
    await model.setPreviewOccluded(false);
    expect(native.observationCalls, issued + 2);
    expect(current.pendingHostLayout, isNotNull);
    native.emitObservationOnRequest = false;
    oldGate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(model.previewPaused, false);
    expect(model.lastFailure, isNull);
    expect(native.observationCalls, issued + 2);
  });

  test('uncovering reuses a valid native pending observation instead of renewing its lease', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    await model.setPreviewOccluded(true);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    native.emitObservation(current.id);
    await until(() => current.pendingHostLayout != null);
    final pending = current.pendingHostLayout;
    await model.setPreviewOccluded(false);
    expect(current.pendingHostLayout, pending);
    expect(native.observationCalls, issued);
    expect(model.error, isNull);
  });

  test('background retires an in-flight shell wait and foreground coalesces the latest geometry once', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    final oldGate = native.observationGate = Completer<void>();
    final oldRequest = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.observationCalls == issued + 1);
    await model.setForeground(false);
    await oldRequest.timeout(const Duration(seconds: 1));
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    await model.observeActiveShellGeometry(current, dirtyShell(current, 4));
    expect(native.observationCalls, issued + 1);
    native.observationGate = null;
    await model.setForeground(true);
    expect(native.observationCalls, issued + 2);
    expect(model.hostChromeRevision(current), 4);
    native.emitObservationOnRequest = false;
    oldGate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(model.previewPaused, false);
    expect(model.lastFailure, isNull);
    expect(model.controller, same(current));
  });

  test('a real higher surface retires only the old shell wait and its new pending observation measures independently', () async {
    final current = await acceptActiveShell();
    final issued = native.observationCalls;
    final gate = native.observationGate = Completer<void>();
    final waiting = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.observationCalls == issued + 1);
    native.emitObservationValue(current.id, {
      ...native.observation(current.id),
      'surfaceGeneration': '2',
    });
    await waiting.timeout(const Duration(seconds: 1));
    expect(current.pendingHostLayout!['surfaceGeneration'], '2');
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    expect(native.observationCalls, issued + 1);
    expect(native.chromeGeometries, isEmpty);
    native.emitObservationOnRequest = false;
    gate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(model.lastFailure, isNull);
    expect(model.previewPaused, false);
  });

  for (final invalid in <String, Map<String, Object?>>{
    'foreign owner': {'ownerId': '999'},
    'foreign session': {'sessionId': 'foreign-session'},
    'missing session': {'sessionId': null},
    'foreign page': {'pageId': 99},
    'missing page': {'pageId': null},
    'noncanonical owner': {'ownerId': '01'},
    'lower surface': {'surfaceGeneration': '1'},
    'noncanonical surface': {'surfaceGeneration': '02'},
    'equal observation': {'observationId': 'same'},
    'noncanonical observation': {'observationId': '01'},
    'overflow observation': {'observationId': '18446744073709551616'},
    'unknown schema': {'schemaVersion': 2},
  }.entries) {
    test(
      '${invalid.key} cannot retire or complete an active shell observation wait',
      () async {
        final current = await acceptActiveShell();
        native.enableLayoutProof(current.id);
        await model.inspect();
        native.emitObservationValue(current.id, {
          ...native.observation(current.id),
          'surfaceGeneration': '2',
        });
        await until(
          () => current.pendingHostLayout?['surfaceGeneration'] == '2',
        );
        native.stream.add({
          'id': current.id,
          'event': {
            'type': 'hostLayoutAccepted',
            'acceptedLayout': current.pendingHostLayout,
          },
        });
        await until(() => current.pendingHostLayout == null);
        final previous = current.lastHostLayoutObservation!;
        native.emitObservationOnRequest = false;
        model.coordinationTimeout = const Duration(milliseconds: 100);
        final issued = native.observationCalls;
        var finished = false;
        final waiting = model
            .observeActiveShellGeometry(current, dirtyShell(current, 2))
            .then((_) => finished = true);
        await until(() => native.observationCalls == issued + 1);
        final fields = {...invalid.value};
        if (fields['observationId'] == 'same')
          fields['observationId'] = previous['observationId'];
        final observed = <String, Object?>{
          ...native.observation(current.id),
          'surfaceGeneration': '2',
          ...fields,
        };
        for (final key in fields.keys) {
          if (fields[key] == null) observed.remove(key);
        }
        native.emitObservationValue(current.id, observed);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(finished, false);
        expect(model.lastFailure, isNull);
        expect(native.occlusionCalls.last, (current.id, true));
        await waiting;
        expect(model.previewPaused, true);
        expect(native.occlusionCalls.last, (current.id, true));
        expect(model.error, contains('ERR_TIMEOUT'));
        expect(native.observationCalls, issued + 1);
      },
    );
  }

  test('fault-paused dirty geometry never auto-resumes or renews observation on cover or foreground changes', () async {
    final current = await acceptActiveShell();
    model.coordinationTimeout = const Duration(milliseconds: 40);
    native.emitObservationOnRequest = false;
    final issued = native.observationCalls;
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    expect(model.previewPaused, true);
    final failure = model.lastFailure;
    await model.setPreviewOccluded(true);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    await model.setPreviewOccluded(false);
    await model.setForeground(false);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 4));
    await model.setForeground(true);
    expect(model.previewPaused, true);
    expect(model.visible, false);
    expect(model.lastFailure, same(failure));
    expect(native.observationCalls, issued + 1);
    expect(native.occlusionCalls.last, (current.id, true));
  });

  test('navigation retires old shell waits and discards dirty geometry bound to the previous page', () async {
    final current = await acceptActiveShell();
    native.enableLayoutProof(current.id);
    await model.inspect();
    final issued = native.observationCalls;
    final oldGate = native.observationGate = Completer<void>();
    final oldWait = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.observationCalls == issued + 1);
    native.observationGate = null;
    native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'navigationLayout',
        'request': {
          'schemaVersion': 1,
          'ticket': 'dirty-navigation',
          'root': (model.activePack!.manifest['integrity'] as Map)['root'],
          'sessionId': native.acceptedIdentities[current.id]!['sessionId'],
          'chrome': native.proposedChrome,
        },
      },
    });
    await until(
      () =>
          model.prospectiveController != null &&
          native.observationCalls == issued + 2,
    );
    await oldWait.timeout(const Duration(seconds: 1));
    await model.observeActiveShellGeometry(current, {
      ...dirtyShell(current, 3),
      'pageId': 1,
    });
    expect(native.observationCalls, issued + 2);
    native.states[current.id]!['page'] = {'id': 2};
    await model.observeProspectiveChrome(
      current,
      measuredShell(current, model.initialChromeRevision(current) + 1),
    );
    await until(() => model.prospectiveController == null);
    expect((model.nativeState['page'] as Map)['id'], 2);
    expect(
      native.observationCalls,
      issued + 2,
      reason: 'The old page cannot request layout after navigation commit.',
    );
    native.emitObservationOnRequest = false;
    oldGate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    native.emitObservationOnRequest = true;
    await model.observeActiveShellGeometry(current, {
      ...dirtyShell(current, 4),
      'pageId': 2,
    });
    expect(native.observationCalls, issued + 3);
    expect(model.lastFailure, isNull);
    expect(model.previewPaused, false);
  });

  test('native owner identity is bound to the initial observation instead of the unrelated Flutter handle', () async {
    native.ownerOffset = 700;
    final current = await acceptActiveShell();
    expect(
      current.lastHostLayoutObservation!['ownerId'],
      isNot(current.id.toString()),
    );
    final issued = native.observationCalls;
    native.emitObservationOnRequest = false;
    var finished = false;
    final waiting = model
        .observeActiveShellGeometry(current, dirtyShell(current, 2))
        .then((_) => finished = true);
    await until(() => native.observationCalls == issued + 1);
    native.emitObservationValue(current.id, {
      ...native.observation(current.id),
      'ownerId': current.id.toString(),
    });
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(finished, false);
    native.emitObservation(current.id);
    await waiting;
    expect(model.error, isNull);
    expect(model.previewPaused, false);
  });

  test('uncovering while native apply is busy keeps old input covered until its deferred shell observation exists', () async {
    final current = await acceptActiveShell();
    native.inPlace = true;
    final mutation = native.mutationGate = Completer<void>();
    publish('2');
    await until(() => model.busy && native.applyCalls == 1);
    await model.setPreviewOccluded(true);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
    final issued = native.observationCalls;
    native.emitObservationOnRequest = false;
    await model.setPreviewOccluded(false);
    expect(model.busy, true);
    expect(native.occlusionCalls.last, (current.id, true));
    expect(native.observationCalls, issued);
    mutation.complete();
    await until(() => !model.busy && native.observationCalls == issued + 1);
    expect(native.occlusionCalls.last, (current.id, true));
    native.emitObservation(current.id);
    await until(() => native.occlusionCalls.last == (current.id, false));
    expect(current.pendingHostLayout, isNotNull);
    expect(native.observationCalls, issued + 1);
    expect(model.lastFailure, isNull);
    expect(model.previewPaused, false);
  });

  test('a later real prospective rectangle is retained while the previous navigation measurement commits', () async {
    final current = await acceptActiveShell();
    native.enableLayoutProof(current.id);
    await model.inspect();
    native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
    final commit = native.navigationCommitGate = Completer<void>();
    final issued = native.observationCalls;
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'navigationLayout',
        'request': {
          'schemaVersion': 1,
          'ticket': 'late-rectangle',
          'root': (model.activePack!.manifest['integrity'] as Map)['root'],
          'sessionId': native.acceptedIdentities[current.id]!['sessionId'],
          'chrome': native.proposedChrome,
        },
      },
    });
    await until(
      () =>
          model.prospectiveController != null &&
          current.pendingHostLayout != null,
    );
    final first = measuredShell(
      current,
      model.initialChromeRevision(current) + 1,
    );
    await model.observeProspectiveChrome(current, first);
    await until(() => native.navigationCompletions.length == 1);
    final latest = measuredShell(
      current,
      model.initialChromeRevision(current) + 1,
    );
    latest['menuButtonRect'] = {
      ...(latest['menuButtonRect'] as Map<String, Object?>),
      'left': 280,
      'right': 368,
    };
    await model.observeProspectiveChrome(current, latest);
    expect(native.observationCalls, issued + 1);
    native.states[current.id]!['page'] = {'id': 2};
    commit.complete();
    await until(
      () =>
          model.prospectiveController == null &&
          native.observationCalls == issued + 2,
    );
    await model.observeActiveShellGeometry(current, {...latest, 'pageId': 2});
    expect(native.observationCalls, issued + 2);
    expect(model.hostChromeRevision(current), latest['revision']);
    expect(model.lastFailure, isNull);
  });

  test(
    'closing a held-input resume retires the owner without late unocclusion',
    () async {
      final current = await acceptActiveShell();
      await model.setPreviewOccluded(true);
      await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
      final gate = native.observationGate = Completer<void>();
      final issued = native.observationCalls;
      final uncoveredBefore = native.occlusionCalls
          .where((value) => !value.$2)
          .length;
      final resume = model.setPreviewOccluded(false);
      await until(() => native.observationCalls == issued + 1);
      await model.closeMiniProgram().timeout(const Duration(seconds: 1));
      await resume.timeout(const Duration(seconds: 1));
      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(model.controller, isNull);
      expect(model.appRequested, false);
      expect(
        native.occlusionCalls.where((value) => !value.$2).length,
        uncoveredBefore,
      );
      expect(model.lastFailure, isNull);
    },
  );

  test('active dirty geometry awaits native cover before enqueuing its only observation', () async {
    final current = await acceptActiveShell();
    final gate = native.nextOcclusionGate = Completer<void>();
    final issued = native.observationCalls;
    final covered = native.occlusionCalls.length;
    final waiting = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.occlusionCalls.length == covered + 1);
    expect(native.occlusionCalls.last, (current.id, true));
    expect(native.observationCalls, issued);
    await model.observeActiveShellGeometry(current, dirtyShell(current, 3));
    expect(native.observationCalls, issued);
    gate.complete();
    await waiting;
    expect(native.observationCalls, issued + 1);
    expect(current.pendingHostLayout, isNotNull);
    expect(native.occlusionCalls.last, (current.id, false));
    expect(model.hostChromeRevision(current), 3);
    expect(model.lastFailure, isNull);
  });

  test('a concurrent flush cannot consume the input lease while a native cover is pending', () async {
    final current = await acceptActiveShell();
    final gate = native.nextOcclusionGate = Completer<void>();
    final covered = native.occlusionCalls.length;
    final waiting = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.occlusionCalls.length == covered + 1);
    try {
      // An independent native resize can deliver a valid pending observation
      // before the cover transport replies. It does not settle that cover.
      native.emitObservation(current.id);
      await until(() => current.pendingHostLayout != null);
      await model.observeActiveShellGeometry(current, dirtyShell(current, 2));
      final prematureRestores = native.occlusionCalls
          .skip(covered)
          .where((value) => !value.$2)
          .length;
      gate.complete();
      await waiting;
      expect(
        native.states[current.id]!['occluded'],
        false,
        reason: 'The transaction must restore after its own cover settles.',
      );
      expect(
        prematureRestores,
        0,
        reason:
            'A pending observation cannot consume the in-flight cover lease.',
      );
      expect(model.previewPaused, false);
      expect(model.lastFailure, isNull);
    } finally {
      if (!gate.isCompleted) gate.complete();
      await waiting;
    }
  });

  test('a flush cannot uncover input before activation finishes its native coordination', () async {
    final current = await acceptActiveShell();
    native.inPlace = true;
    final foreground = native.nextForegroundReply = Completer<void>();
    final foregroundCalls = native.foregroundCalls.length;
    final uncovered = native.occlusionCalls.where((value) => !value.$2).length;
    publish('2');
    await until(() => native.foregroundCalls.length == foregroundCalls + 1);
    try {
      expect(model.busy, true);
      expect(model.activePack!.descriptor.generation, '2');
      // This rectangle is already accepted. Its no-op flush must not consume
      // activation's held-input lease while native foreground coordination
      // still awaits its reply. Native command application stays FIFO.
      await model.observeActiveShellGeometry(current, dirtyShell(current, 1));
      final prematureRestores =
          native.occlusionCalls.where((value) => !value.$2).length - uncovered;
      foreground.complete();
      await until(() => !model.busy);
      expect(
        prematureRestores,
        0,
        reason: 'Only activation may finish its own input coordination.',
      );
      expect(native.states[current.id]!['occluded'], false);
      expect(model.previewPaused, false);
      expect(model.lastFailure, isNull);
    } finally {
      if (!foreground.isCompleted) foreground.complete();
      await until(() => !model.busy);
    }
  });

  test('a missing cover receipt expires within the original observation deadline and never enqueues a late request', () async {
    final current = await acceptActiveShell();
    model.coordinationTimeout = const Duration(milliseconds: 50);
    final gate = native.nextOcclusionGate = Completer<void>();
    final issued = native.observationCalls;
    final covered = native.occlusionCalls.length;
    await model
        .observeActiveShellGeometry(current, dirtyShell(current, 2))
        .timeout(const Duration(seconds: 1));
    expect(model.previewPaused, true);
    expect(model.error, contains('ERR_TIMEOUT'));
    expect(native.observationCalls, issued);
    expect(
      native.occlusionCalls.length,
      covered + 1,
      reason: 'The timed-out transaction must not retry its cover.',
    );
    final failure = model.lastFailure;
    gate.completeError(PlatformException(code: 'ERR_RENDER'));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(native.observationCalls, issued);
    expect(model.lastFailure, same(failure));
    expect(native.occlusionCalls.last, (current.id, true));
  });

  test('closing while native cover is pending retires that exact wait and ignores its late error', () async {
    final current = await acceptActiveShell();
    final gate = native.nextOcclusionGate = Completer<void>();
    final issued = native.observationCalls;
    final covered = native.occlusionCalls.length;
    final waiting = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(() => native.occlusionCalls.length == covered + 1);
    await model.closeMiniProgram().timeout(const Duration(seconds: 1));
    await waiting.timeout(const Duration(seconds: 1));
    expect(model.controller, isNull);
    gate.completeError(PlatformException(code: 'ERR_RENDER'));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(native.observationCalls, issued);
    expect(model.lastFailure, isNull);
    expect(native.occlusionCalls.last, (current.id, true));
  });

  test('shell input restore lease: an old successful reply cannot remove a newer dirty barrier', () async {
    final current = await acceptActiveShell();
    final oldReply = native.nextUnocclusionReply = Completer<void>();
    final issued = native.observationCalls;
    final first = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(
      () =>
          native.states[current.id]!['occluded'] == false &&
          current.pendingHostLayout != null,
    );
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'hostLayoutAccepted',
        'acceptedLayout': current.pendingHostLayout,
      },
    });
    await until(() => current.pendingHostLayout == null);
    final gate = native.observationGate = Completer<void>();
    final next = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 3),
    );
    await until(() => native.observationCalls == issued + 2);
    try {
      expect(native.states[current.id]!['occluded'], true);
      oldReply.complete();
      await first;
      expect(native.states[current.id]!['occluded'], true);
      gate.complete();
      await next;
      expect(
        native.states[current.id]!['occluded'],
        false,
        reason: 'Only the new barrier may restore its own native input.',
      );
      expect(model.previewPaused, false);
      expect(model.lastFailure, isNull);
    } finally {
      if (!oldReply.isCompleted) oldReply.complete();
      if (!gate.isCompleted) gate.complete();
      await first;
      await next;
    }
  });

  test('shell input restore lease: an old error cannot fault or uncover a newer dirty barrier', () async {
    final current = await acceptActiveShell();
    final oldReply = native.nextUnocclusionReply = Completer<void>();
    final issued = native.observationCalls;
    final first = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(
      () =>
          native.states[current.id]!['occluded'] == false &&
          current.pendingHostLayout != null,
    );
    native.stream.add({
      'id': current.id,
      'event': {
        'type': 'hostLayoutAccepted',
        'acceptedLayout': current.pendingHostLayout,
      },
    });
    await until(() => current.pendingHostLayout == null);
    final gate = native.observationGate = Completer<void>();
    final next = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 3),
    );
    await until(() => native.observationCalls == issued + 2);
    try {
      oldReply.completeError(PlatformException(code: 'ERR_RENDER'));
      await first;
      expect(
        model.previewPaused,
        false,
        reason: 'The old restore no longer owns the active barrier.',
      );
      expect(model.lastFailure, isNull);
      expect(native.states[current.id]!['occluded'], true);
      gate.complete();
      await next;
      expect(native.states[current.id]!['occluded'], false);
    } finally {
      if (!oldReply.isCompleted) oldReply.complete();
      if (!gate.isCompleted) gate.complete();
      await first;
      await next;
    }
  });

  test('shell input restore lease: close cancels an unknown reply promptly and ignores its late error', () async {
    final current = await acceptActiveShell();
    final oldReply = native.nextUnocclusionReply = Completer<void>();
    final first = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(
      () =>
          native.states[current.id]!['occluded'] == false &&
          current.pendingHostLayout != null,
    );
    try {
      await model.closeMiniProgram().timeout(const Duration(seconds: 1));
      await first.timeout(const Duration(seconds: 1));
      oldReply.completeError(PlatformException(code: 'ERR_RENDER'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(model.controller, isNull);
      expect(model.lastFailure, isNull);
    } finally {
      if (!oldReply.isCompleted) oldReply.complete();
      await first;
    }
  });

  test('shell input restore lease: repeated flushes share one bounded unknown reply and never retry unocclude', () async {
    final current = await acceptActiveShell();
    model.coordinationTimeout = const Duration(milliseconds: 50);
    final oldReply = native.nextUnocclusionReply = Completer<void>();
    final uncovered = native.occlusionCalls.where((value) => !value.$2).length;
    final first = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    await until(
      () =>
          native.states[current.id]!['occluded'] == false &&
          current.pendingHostLayout != null,
    );
    final second = model.observeActiveShellGeometry(
      current,
      dirtyShell(current, 2),
    );
    try {
      await Future.wait([first, second]).timeout(const Duration(seconds: 1));
      expect(model.previewPaused, true);
      expect(model.error, contains('ERR_TIMEOUT'));
      expect(
        native.occlusionCalls.where((value) => !value.$2).length,
        uncovered + 1,
      );
      final failure = model.lastFailure;
      oldReply.completeError(PlatformException(code: 'ERR_RENDER'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(model.lastFailure, same(failure));
      expect(
        native.occlusionCalls.where((value) => !value.$2).length,
        uncovered + 1,
      );
    } finally {
      if (!oldReply.isCompleted) oldReply.complete();
      await first;
      await second;
    }
  });

  test('faulted restart measurement carries a prepared owner attempt before fresh startup', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final identity = Map.of(native.acceptedIdentities[current.id]!);
    native.enforceRestartMeasurement = true;
    native.states[current.id]!['inputEnabled'] = false;
    native.states[current.id]!['presentationEnabled'] = false;
    native.states[current.id]!['executionHealth'] = {
      'schemaVersion': 1,
      'requiresRestart': true,
      'appServiceFault': null,
      'navigationFault': null,
      'viewFault': {
        'domain': 'view',
        'code': 'ERR_TIMEOUT',
        'message': 'View frontier interrupted',
        'requiresRestart': true,
      },
    };
    await model.inspect();
    final loads = native.loadCalls;
    await model.retryPreview();
    expect(native.loadCalls, loads + 1);
    final prepared = native.restartMeasurements.single;
    final proof = prepared['restartAttempt'] as Map;
    expect(proof, {
      'schemaVersion': 1,
      'ownerId': native.ownerId(current.id),
      'attemptId': '2',
      'targetRoot': identity['root'],
      'expectedAccepted': identity,
    });
    expect(
      (prepared['observation'] as Map)['sessionId'],
      identity['sessionId'],
    );
    expect(
      native.acceptedIdentities[current.id]!['sessionId'],
      isNot(identity['sessionId']),
    );
    expect(model.previewPaused, false);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
  });

  test('Player rejects an adapter missing prepared restart measurement negotiation', () async {
    native.preparedRestartMeasurement = false;
    await model.connect(ticket());
    await until(() => !model.busy && model.error != null);
    expect(model.error, contains('ERR_UNSUPPORTED_CAPABILITY'));
    expect(native.loadCalls, 0);
    expect(native.applyCalls, 0);
    expect(model.activePack, isNull);
  });

  test('structured View execution health requires restart without synthetic background', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!, pack = model.activePack;
    native.states[current.id]!['executionHealth'] = {
      'schemaVersion': 1,
      'requiresRestart': true,
      'viewFault': {
        'domain': 'view',
        'code': 'ERR_TIMEOUT',
        'requiresRestart': true,
      },
    };
    await model.inspect();
    expect(model.previewPaused, true);
    expect(model.activePack, same(pack));
    final loads = native.loadCalls;
    await model.retryPreview();
    expect(native.loadCalls, loads + 1);
    expect(model.activePack, same(pack));
    expect(model.previewPaused, false);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
    expect(native.preparedChromeGeometries, isNotEmpty);
  });

  test(
    'navigation measures the prospective target shell before native commit',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!, pack = model.activePack!;
      final identity = Map.of(native.acceptedIdentities[current.id]!);
      native.proposedChrome = {...native.chrome, 'navigationStyle': 'custom'};
      native.stream.add({
        'id': current.id,
        'event': {
          'type': 'navigationLayout',
          'request': {
            'schemaVersion': 1,
            'ticket': 'nav-1',
            'root': (pack.manifest['integrity'] as Map)['root'],
            'sessionId': identity['sessionId'],
            'chrome': native.proposedChrome,
          },
        },
      });
      await until(() => model.prospectiveController != null);
      await until(
        () =>
            (current.pendingHostLayout?['windowMetrics']
                as Map?)?['windowHeight'] ==
            637,
      );
      expect(native.navigationCompletions, isEmpty);
      expect(
        (model.nativeState['chrome'] as Map)['navigationStyle'],
        'default',
      );
      await model.observeProspectiveChrome(current, {
        'observationId': current.pendingHostLayout?['observationId'],
        'schemaVersion': 1,
        'revision': 2,
        'menuButtonRect': {
          'left': 279,
          'right': 367,
          'top': 38,
          'bottom': 70,
          'width': 88,
          'height': 32,
        },
        'contentRect': {'left': 0, 'top': 30, 'width': 375, 'height': 637},
      });
      await until(() => model.prospectiveController == null);
      expect(native.navigationCompletions.single['ticket'], 'nav-1');
      final layout = native.navigationCompletions.single['layout'] as Map;
      expect(
        layout['observationId'],
        current.lastHostLayoutObservation!['observationId'],
      );
      expect((layout['windowMetrics'] as Map)['windowHeight'], 637);
      expect((model.nativeState['chrome'] as Map)['navigationStyle'], 'custom');
      expect(native.acceptedIdentities[current.id], identity);
      expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
    },
  );

  test(
    'close cancels a navigation observation whose native reply is missing',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!, pack = model.activePack!;
      final calls = native.observationCalls;
      final gate = native.observationGate = Completer<void>();
      native.stream.add({
        'id': current.id,
        'event': {
          'type': 'navigationLayout',
          'request': {
            'schemaVersion': 1,
            'ticket': 'missing-observation',
            'root': (pack.manifest['integrity'] as Map)['root'],
            'sessionId': native.acceptedIdentities[current.id]!['sessionId'],
            'chrome': {...native.chrome, 'navigationStyle': 'custom'},
          },
        },
      });
      await until(() => native.observationCalls > calls);
      await model.closeMiniProgram().timeout(const Duration(seconds: 1));
      expect(model.controller, isNull);
      expect(model.prospectiveController, isNull);
      expect(native.navigationCompletions, isEmpty);
      expect(native.navigationCancellations, contains('missing-observation'));
      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(model.controller, isNull);
    },
  );

  test('close cancels an unknown-state recovery awaiting measurable geometry promptly', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    native.emitCommitReceipt = false;
    native.journalUnavailable = true;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    publish('2');
    await until(() => !model.busy && native.applyCalls == 1);
    expect(model.phase, 'native-state-unknown');
    native.onObservation = null;
    final recovery = model.retryPreview();
    await until(() => model.prospectiveController != null);
    final loads = native.loadCalls;
    await model.closeMiniProgram().timeout(const Duration(seconds: 2));
    await recovery;
    expect(native.loadCalls, loads);
    expect(model.controller, isNull);
    expect(model.prospectiveController, isNull);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
  });

  test(
    'durable rejection wins over unrelated ready events and frame counters',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final first = model.activePack, current = model.controller!;
      final identity = Map.of(native.acceptedIdentities[current.id]!);
      native.failCandidate = true;
      native.unrelatedFrameOnRejected = true;
      publish('2');
      await until(() => !model.busy && native.applyCalls == 1);
      expect(model.activePack, same(first));
      expect(model.previewPaused, false);
      expect(native.acceptedIdentities[current.id], identity);
      expect(model.failedPack, isNull);
      expect(model.error, startsWith('ERR_ENGINE:'));
    },
  );

  test('a mismatched terminal attempt receipt pauses ownership instead of guessing', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final first = model.activePack;
    native.wrongAttemptReceipt = true;
    publish('2');
    await until(() => !model.busy && native.applyCalls == 1);
    expect(model.activePack, isNull);
    expect(model.previousPack, same(first));
    expect(model.failedPack?.descriptor.generation, '2');
    expect(model.phase, 'native-state-unknown');
    expect(model.previewPaused, true);
  });

  test('an in-place publication receipt reconciles a throwing wrapper without claiming a restart', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final generation = native.states[current.id]!['generation'];
    native.inPlace = true;
    native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
    final gate = await holdUpdate('2');
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack?.descriptor.generation, '2');
    expect(native.states[current.id]!['generation'], generation);
    expect(
      model.logs.any((line) => line.contains('Generation 2: inPlace')),
      true,
    );
    expect(model.previewPaused, true);
    expect(model.failedPack, isNull);
  });

  test('native stream and widget GPU failures during apply are replayed after pack acceptance', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller!;
    final gate = await holdUpdate('2');
    native.sessionErrorStreams[current.id]!.addError(
      PlatformException(code: 'ERR_TEXTURE'),
    );
    model.handlePreviewError(
      PlatformException(code: 'ERR_METAL'),
      source: current,
    );
    await Future<void>.delayed(Duration.zero);
    expect(
      model.previewPaused,
      false,
      reason: 'The native operation owns its outcome until commit',
    );
    gate.complete();
    await until(() => !model.busy);
    expect(model.activePack?.descriptor.generation, '2');
    expect(model.previewPaused, true);
    expect(model.visible, false);
    expect(native.states[current.id]!['foreground'], true);
    expect(native.states[current.id]!['occluded'], true);
    expect(native.foregroundCalls.where((call) => !call.$2), isEmpty);
    expect(model.error, startsWith('ERR_TEXTURE:'));
  });

  for (final recovery in ['retry', 'rollback']) {
    test(
      'unknown $recovery recovers without querying the persistently unavailable session before load',
      () async {
        await model.connect(ticket());
        await until(() => model.activePack != null && !model.busy);
        final current = model.controller!;
        final first = model.activePack;
        native.emitCommitReceipt = false;
        native.journalUnavailable = true;
        native.postCommitFailure = PlatformException(code: 'ERR_RENDER');
        final gate = await holdUpdate('2');
        native.stateUnavailable = true;
        native.restoreStateOnLoad = true;
        gate.complete();
        await until(() => !model.busy);
        expect(model.phase, 'native-state-unknown');
        expect(model.activePack, isNull);
        expect(model.previousPack, same(first));
        final beforeRecovery = native.calls.length;
        final loads = native.loadCalls;
        if (recovery == 'retry') {
          await model.retryPreview();
        } else {
          await model.rollback();
        }
        final recoveryCalls = native.calls.sublist(beforeRecovery);
        expect(native.loadCalls, loads + 1);
        expect(
          recoveryCalls.indexOf('load:${current.id}'),
          lessThan(recoveryCalls.indexOf('state:${current.id}')),
        );
        expect(
          model.activePack?.descriptor.generation,
          recovery == 'retry' ? '2' : '1',
        );
        expect(native.packPaths[current.id], model.activePack!.directory.path);
        expect(model.failedPack, isNull);
        expect(model.previewPaused, false);
        expect(model.visible, true);
      },
    );
  }

  test('failed same-controller reload never publishes candidate launch logs under the accepted pack', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    final current = model.controller;
    final accepted = model.activePack;
    // Native activation and the server's WebSocket receiver complete
    // independently. Drain the accepted startup report before isolating the
    // attempted reload's reports, rather than racing its network delivery.
    await until(
      () => reports.any(
        (event) =>
            event['phase'] == 'log' &&
            (event['details'] as Map?)?['message'] ==
                'Injected launch console 1/1',
      ),
    );
    final acceptedLog = reports.singleWhere(
      (event) =>
          event['phase'] == 'log' &&
          (event['details'] as Map?)?['message'] ==
              'Injected launch console 1/1',
    );
    expect(acceptedLog['generation'], accepted!.descriptor.generation);
    expect(acceptedLog['runId'], accepted.descriptor.runId);
    reports.clear();
    native.failCandidate = true;
    fixture = fixtures.fixture(generation: '2', blobs: {'app.js': fixtureBlob});
    sockets.last.add(jsonEncode({'protocolVersion': '1.0', 'type': 'pack'}));
    await until(
      () => model.error?.startsWith('ERR_ENGINE:') == true && !model.busy,
    );
    expect(model.controller, same(current));
    expect(model.activePack, same(accepted));
    expect(
      model.logs.any((line) => line.contains('Injected launch console 1/2')),
      false,
    );
    expect(
      reports.any(
        (event) =>
            event['phase'] == 'log' &&
            (event['details'] as Map?)?['message'] ==
                'Injected launch console 1/2',
      ),
      false,
    );
    expect(reports.where((event) => event['phase'] == 'log'), isEmpty);
  });

  test(
    'retained project cannot report or roll back through a different pairing',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final first = model.activePack;
      fixture = fixtures.fixture(
        generation: '2',
        blobs: {'app.js': fixtureBlob},
      );
      sockets.last.add(jsonEncode({'protocolVersion': '1.0', 'type': 'pack'}));
      await until(
        () => model.activePack?.descriptor.generation == '2' && !model.busy,
      );
      expect(model.previousPack, same(first));
      final old = model.controller;
      project = 'different-project';
      native.failCandidate = true;
      await model.connect(ticket());
      await until(
        () => model.error?.startsWith('ERR_ENGINE:') == true && !model.busy,
      );
      reports.clear();
      native.stream.add({
        'id': old!.id,
        'event': {
          'type': 'console',
          'level': 'log',
          'message': 'retained project console',
        },
      });
      await until(
        () =>
            model.logs.any((line) => line.contains('retained project console')),
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(reports.where((event) => event['phase'] == 'log'), isEmpty);
      final calls = native.applyCalls;
      final loads = native.loadCalls;
      await model.rollback();
      expect(model.error, startsWith('ERR_DEV_PROJECT:'));
      expect(native.applyCalls, calls);
      expect(native.loadCalls, loads);
      expect(model.controller, same(old));
      expect(model.activePack?.descriptor.generation, '2');
    },
  );
  test(
    'adopted View error binds original attempt, not the newest diagnostic',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final accepted = model.controller!;
      final original = PlatformException(code: 'ERR_CANCELLED');
      final diagnostic = WeappViewDiagnostic(
        operation: WeappViewOperation.hostLayout,
        viewLease: 9,
        operationSequence: 10,
        retired: false,
        error: original,
      );
      model.recordPreviewDiagnostic(
        WeappViewDiagnostic(
          operation: WeappViewOperation.uncover,
          viewLease: 99,
          operationSequence: 100,
          retired: false,
          error: original,
        ),
        source: accepted,
      );
      await model.inspectData();
      expect((model.inspectorData['playerFailures'] as Map)['current'], null);
      model.handlePreviewError(
        WeappViewFailure(
          error: original,
          stackTrace: StackTrace.empty,
          diagnostic: diagnostic,
          proofOutcome: WeappViewFailureProof.notSuperseded,
        ),
        source: accepted,
      );
      await model.inspectData();
      final failures = model.inspectorData['playerFailures'] as Map;
      final current = failures['current'] as Map;
      expect(current['phase'], 'preview');
      expect(current['code'], 'ERR_CANCELLED');
      final origin = current['origin'] as Map;
      expect(origin['controllerRole'], 'accepted');
      expect(origin['controllerId'], accepted.id.toString());
      expect((origin['view'] as Map)['viewLease'], '9');
      expect((origin['view'] as Map)['operationSequence'], '10');
      expect((origin['view'] as Map)['disposition'], 'active-error');
      expect((origin['view'] as Map)['proofOutcome'], 'notSuperseded');
      expect(model.previewPaused, false); // Existing cancellation UI behavior.
      final previous = jsonEncode(current);
      model.recordPreviewDiagnostic(
        WeappViewDiagnostic(
          operation: WeappViewOperation.input,
          viewLease: 999,
          operationSequence: 1000,
          retired: true,
          error: original,
        ),
        source: accepted,
      );
      await model.inspectData();
      expect(
        jsonEncode((model.inspectorData['playerFailures'] as Map)['current']),
        previous,
      );
      model.handlePreviewError(
        WeappViewFailure(
          error: original,
          stackTrace: StackTrace.empty,
          diagnostic: WeappViewDiagnostic(
            operation: WeappViewOperation.input,
            viewLease: 9,
            operationSequence: 11,
            retired: true,
            error: original,
          ),
        ),
        source: accepted,
      );
      await model.inspectData();
      expect(
        (model.inspectorData['playerFailures'] as Map)['lastSequence'],
        failures['lastSequence'],
      );
    },
  );

  test(
    'failed diagnostic projection cannot break adoption or input authority',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final accepted = model.controller!;
      final original = UnreadableFailureCode();
      final diagnostic = WeappViewDiagnostic(
        operation: WeappViewOperation.foreground,
        viewLease: 4,
        operationSequence: 7,
        retired: false,
        error: Object(),
      );
      final paused = model.previewPaused;
      final state = jsonEncode(model.nativeState);
      model.handlePreviewError(
        WeappViewFailure(
          error: original,
          stackTrace: StackTrace.empty,
          diagnostic: diagnostic,
        ),
        source: accepted,
      );
      expect(model.error, 'ERR_PREVIEW: Native preview failed.');
      expect(model.previewPaused, paused);
      expect(jsonEncode(model.nativeState), state);
      await model.inspectData();
      final current =
          (model.inspectorData['playerFailures'] as Map)['current'] as Map;
      expect(current['code'], 'ERR_UNKNOWN');
      expect(
        ((current['origin'] as Map)['view'] as Map)['code'],
        'ERR_UNKNOWN',
      );
      expect(
        ((current['origin'] as Map)['view'] as Map)['operationSequence'],
        '7',
      );
      expect(jsonEncode(current), isNot(contains('private')));
    },
  );

  test(
    'buffered old-session cleanup remains history after a same-root restart',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final old = Map<String, Object?>.from(
        model.nativeState['acceptedPackIdentity']! as Map,
      );
      final origin = <String, Object?>{
        'schemaVersion': 1,
        'phase': 'retirement',
        'operation': 'unload',
        'sessionId': old['sessionId'],
        'acceptedPackIdentity': old,
      };
      final gate = Completer<void>();
      native.postMutationStateGate = gate;
      publish('2');
      await until(() => native.applyCalls == 1);
      void emit(Map<String, Object?> fields) => native.stream.add({
        'id': current.id,
        'event': {'type': 'error', ...fields},
      });
      emit({
        'origin': origin,
        'error': {'code': 'ERR_ENGINE', 'message': 'old unload failed'},
      });
      await Future<void>.delayed(Duration.zero);
      gate.complete();
      await until(
        () => model.activePack?.descriptor.generation == '2' && !model.busy,
      );
      expect(model.controller, same(current));
      expect(model.nativeState['sessionId'], isNot(old['sessionId']));
      expect(
        (model.nativeState['acceptedPackIdentity'] as Map)['root'],
        old['root'],
      );
      expect(model.error, null);
      await model.inspectData();
      var history = model.inspectorData['playerRetirementDiagnostics'] as Map;
      final entry = (history['entries'] as List).single as Map;
      expect(entry['origin'], origin);
      expect(entry['code'], 'ERR_ENGINE');
      expect((model.inspectorData['playerFailures'] as Map)['current'], null);
      expect(
        model.logs.any((line) => line.contains('old unload failed')),
        true,
      );

      // The same code without proven old-session provenance is still active.
      emit({
        'error': {'code': 'ERR_ENGINE', 'message': 'new session failed'},
      });
      await until(() => model.error?.contains('new session failed') == true);
      final activeError = model.error;
      emit({
        'origin': origin,
        'error': {'code': 'ERR_ENGINE', 'message': 'another retired failure'},
      });
      await until(
        () =>
            model.logs.any((line) => line.contains('another retired failure')),
      );
      expect(model.error, activeError);
      await model.inspectData();
      history = model.inspectorData['playerRetirementDiagnostics'] as Map;
      expect(history['entries'] as List, hasLength(2));
      final active =
          (model.inspectorData['playerFailures'] as Map)['current'] as Map;
      expect(active['code'], 'ERR_ENGINE');
      expect(active['phase'], 'runtime');
    },
  );

  test(
    'retirement response trimming preserves history and the active failure',
    () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final old = Map<String, Object?>.from(
        model.nativeState['acceptedPackIdentity']! as Map,
      );
      publish('2');
      await until(
        () => model.activePack?.descriptor.generation == '2' && !model.busy,
      );
      model.fail(
        const PlayerError('ERR_TIMEOUT', 'current failure stays visible'),
      );
      final activeError = model.error;
      for (var i = 0; i < 20; i++) {
        native.stream.add({
          'id': current.id,
          'event': {
            'type': 'error',
            'origin': {
              'schemaVersion': 1,
              'phase': 'retirement',
              'operation': 'unload',
              'sessionId': old['sessionId'],
              'acceptedPackIdentity': old,
            },
            'error': {'code': 'ERR_ENGINE', 'message': 'retired cleanup $i'},
          },
        });
      }
      await until(
        () => model.logs.any((line) => line.contains('retired cleanup 19')),
      );
      native.devSnapshot = {
        'pages': [
          {
            'id': 1,
            'route': 'pages/home/index',
            'data': {for (var i = 0; i < 23; i++) 'value$i': 'x' * 1900},
          },
        ],
      };
      await model.inspectData();
      final trimmed = model.inspectorData['playerRetirementDiagnostics'] as Map;
      expect(trimmed['responseTruncated'], true);
      expect((trimmed['entries'] as List).length, lessThan(16));
      expect(trimmed['lastSequence'], '20');
      expect(trimmed['droppedCount'], '4');
      expect(
        utf8.encode(jsonEncode(model.inspectorData)).length,
        lessThanOrEqualTo(48 * 1024),
      );
      final active = (model.inspectorData['playerFailures'] as Map)['current'];
      native.devSnapshot['pages'] = [];
      await model.inspectData();
      final retained =
          model.inspectorData['playerRetirementDiagnostics'] as Map;
      expect(retained['responseTruncated'], false);
      expect(retained['entries'] as List, hasLength(16));
      expect(((retained['entries'] as List).first as Map)['sequence'], '5');
      expect((model.inspectorData['playerFailures'] as Map)['current'], active);
      expect(model.error, activeError);
    },
  );

  for (final variant in [
    'same session',
    'unknown field',
    'wrong session',
    'numeric revision',
    'unknown operation',
  ]) {
    test('unproven retirement ($variant) remains an active failure', () async {
      await model.connect(ticket());
      await until(() => model.activePack != null && !model.busy);
      final current = model.controller!;
      final identity = Map<String, Object?>.from(
        model.nativeState['acceptedPackIdentity']! as Map,
      );
      if (variant != 'same session') identity['sessionId'] = 'retired-session';
      final origin = <String, Object?>{
        'schemaVersion': 1,
        'phase': 'retirement',
        'operation': 'unload',
        'sessionId': identity['sessionId'],
        'acceptedPackIdentity': identity,
      };
      if (variant == 'unknown field') origin['untrusted'] = true;
      if (variant == 'wrong session') origin['sessionId'] = 'different-session';
      if (variant == 'numeric revision') identity['acceptedPackRevision'] = 1;
      if (variant == 'unknown operation') origin['operation'] = 'anything';
      native.stream.add({
        'id': current.id,
        'event': {
          'type': 'error',
          'origin': origin,
          'error': {'code': 'ERR_ENGINE', 'message': 'must remain visible'},
        },
      });
      await until(() => model.error?.contains('must remain visible') == true);
      await model.inspectData();
      expect(
        (model.inspectorData['playerRetirementDiagnostics'] as Map)['entries'],
        isEmpty,
      );
      expect(
        (model.inspectorData['playerFailures'] as Map)['current'],
        isNotNull,
      );
    });
  }

  test('current failure clears with existing recovery while adoption history survives', () async {
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    model.fail(const PlayerError('ERR_TIMEOUT', 'safe UI text'));
    await model.inspectData();
    final adopted = (model.inspectorData['playerFailures'] as Map)['current'];
    expect(adopted, isNotNull);
    await model.disconnect();
    // Disconnect historically retains the error. Only reconnect/activation
    // follows the existing clear policy; provenance must mirror it.
    expect(model.error, 'ERR_TIMEOUT: safe UI text');
    await model.connect(ticket());
    await until(() => model.activePack != null && !model.busy);
    await model.inspectData();
    final journal = model.inspectorData['playerFailures'] as Map;
    expect(journal['current'], null);
    expect((journal['entries'] as List).single, adopted);
  });
}
