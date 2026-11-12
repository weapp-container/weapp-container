import 'dart:convert';
import 'dart:math';

import 'package:weapp_container/weapp_container.dart';

/// A native SDK retirement origin. This describes the retired session, while
/// the Player's observed accepted state describes the recipient of the event.
class RuntimeRetirementOrigin {
  RuntimeRetirementOrigin._(this.fields);

  final Map<String, Object?> fields;
  String get sessionId => fields['sessionId']! as String;

  static bool _exact(Map value, Set<String> keys) =>
      value.length == keys.length && keys.every(value.containsKey);

  static RuntimeRetirementOrigin? tryParse(Object? value) {
    if (value is! Map ||
        !_exact(value, {
          'schemaVersion',
          'phase',
          'operation',
          'sessionId',
          'acceptedPackIdentity',
        }) ||
        value['schemaVersion'] is! int ||
        value['schemaVersion'] != 1 ||
        value['phase'] != 'retirement' ||
        !const {
          'unload',
          'cancelNavigation',
          'cancelHostCalls',
        }.contains(value['operation']))
      return null;
    final identity = value['acceptedPackIdentity'];
    if (identity is! Map ||
        !_exact(identity, {'root', 'acceptedPackRevision', 'sessionId'}) ||
        identity['acceptedPackRevision'] is! String)
      return null;
    final parsed = PlayerFailureJournal._identity(identity);
    final session = PlayerFailureJournal._session(value['sessionId']);
    if (parsed == null || session == null || parsed['sessionId'] != session)
      return null;
    return RuntimeRetirementOrigin._(
      PlayerFailureJournal._freeze({
        'schemaVersion': 1,
        'phase': 'retirement',
        'operation': value['operation'],
        'sessionId': session,
        'acceptedPackIdentity': parsed,
      }) as Map<String, Object?>,
    );
  }

  bool precedesAccepted(Object? value, Object? observedSession) {
    if (value is! Map ||
        !_exact(value, {'root', 'acceptedPackRevision', 'sessionId'}) ||
        value['acceptedPackRevision'] is! String)
      return false;
    final accepted = PlayerFailureJournal._identity(value);
    return accepted != null &&
        accepted['sessionId'] == observedSession &&
        accepted['sessionId'] != sessionId &&
        BigInt.parse(
              (fields['acceptedPackIdentity'] as Map)['acceptedPackRevision']
                  as String,
            ) <
            BigInt.parse(accepted['acceptedPackRevision'] as String);
  }
}

/// Retirement diagnostics never replace an active failure or grant input. Keep
/// their bounded history separate from the active-error adoption journal.
class PlayerRetirementJournal {
  final String journalId = List.generate(
    16,
    (_) => Random.secure().nextInt(256),
  ).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  BigInt _sequence = BigInt.zero;
  BigInt _dropped = BigInt.zero;
  final _entries = <Map<String, Object?>>[];

  bool record({
    required RuntimeRetirementOrigin origin,
    required String? code,
    required int controllerId,
    required Map<String, Object?> acceptedState,
  }) {
    if (!origin.precedesAccepted(
      acceptedState['acceptedPackIdentity'],
      acceptedState['sessionId'],
    ))
      return false;
    final observed = PlayerFailureJournal.observeAccepted(
      controllerId: controllerId,
      state: acceptedState,
    );
    if (observed == null) return false;
    _sequence += BigInt.one;
    _entries.add(
      PlayerFailureJournal._freeze({
        'schemaVersion': 1,
        'sequence': _sequence.toString(),
        'recordedAtMs': DateTime.now().millisecondsSinceEpoch.toString(),
        'code': PlayerFailureJournal.controlledCode(code),
        'origin': origin.fields,
        'observedAccepted': observed,
      }) as Map<String, Object?>,
    );
    if (_entries.length > PlayerFailureJournal.maximumEntries) {
      _entries.removeAt(0);
      _dropped += BigInt.one;
    }
    return true;
  }

  Map<String, Object?> snapshot() => jsonDecode(
    jsonEncode({
      'schemaVersion': 1,
      'journalId': journalId,
      'lastSequence': _sequence.toString(),
      'droppedCount': _dropped.toString(),
      'responseTruncated': false,
      'entries': _entries,
    }),
  ) as Map<String, Object?>;
}

/// Controlled provenance only. None of these records contain the UI error text,
/// arbitrary exceptions, native details, logs, URIs, credentials or guest data.
enum PlayerFailurePhase {
  player,
  preview,
  build,
  development,
  runtime,
  executionHealth,
  cleanup,
  navigation,
  layout,
  connection,
}

class PlayerFailureJournal {
  PlayerFailureJournal()
    : journalId = List.generate(
        16,
        (_) => Random.secure().nextInt(256),
      ).map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  final String journalId;
  BigInt _sequence = BigInt.zero;
  BigInt _dropped = BigInt.zero;
  Map<String, Object?>? _current;
  final _entries = <Map<String, Object?>>[];
  static const maximumEntries = 16;
  static final _maximumU64 = BigInt.parse('18446744073709551615');
  static const knownCodes = <String>{
    'ERR_BUSY',
    'ERR_CANCELLED',
    'ERR_CLEANUP',
    'ERR_CONTEXT_LOST',
    'ERR_CREDENTIALS',
    'ERR_DEVICE_AUTH',
    'ERR_DEV_BUDGET',
    'ERR_DEV_CACHE_BUDGET',
    'ERR_DEV_GENERATION',
    'ERR_DEV_HTTP',
    'ERR_DEV_INSPECT_BUSY',
    'ERR_DEV_INSPECT_DATA',
    'ERR_DEV_INSPECT_LIMIT',
    'ERR_DEV_JSON',
    'ERR_DEV_MESSAGE',
    'ERR_DEV_NETWORK',
    'ERR_DEV_OUTCOME_UNKNOWN',
    'ERR_DEV_PATH',
    'ERR_DEV_PROJECT',
    'ERR_DEV_STALE_INSPECTION',
    'ERR_DIAGNOSTIC_SINK',
    'ERR_EGL',
    'ERR_ENGINE',
    'ERR_EXECUTION_RESTART_REQUIRED',
    'ERR_GL',
    'ERR_GLES',
    'ERR_GPU',
    'ERR_INVALID_MANIFEST',
    'ERR_METAL',
    'ERR_METAL_UNAVAILABLE',
    'ERR_MODULE_LOAD',
    'ERR_NOT_READY',
    'ERR_PAIRING_RESPONSE',
    'ERR_PAIRING_URI',
    'ERR_PERMISSION_DENIED',
    'ERR_PLAYER',
    'ERR_PREFERENCES_DISPOSED',
    'ERR_PREFERENCES_LANGUAGE',
    'ERR_PREFERENCES_STORAGE',
    'ERR_PREFERENCES_WRITE',
    'ERR_PREVIEW',
    'ERR_PROTOCOL_VERSION',
    'ERR_RENDER',
    'ERR_STALE_CALL',
    'ERR_SURFACE_DETACHED',
    'ERR_SURFACE_LOST',
    'ERR_TEXTURE',
    'ERR_TIMEOUT',
    'ERR_TLS_PIN',
    'ERR_UNKNOWN',
    'ERR_UNSUPPORTED_CAPABILITY',
    'ERR_VIEW_DESTROYED',
    'ERR_VIEW_EXECUTION',
    'ERR_VIEW_INVALID_BATCH',
    'ERR_VIEW_MODULE',
    'ERR_VIEW_REQUIRES_RESET',
    'ERR_VIEW_UNSUPPORTED_VALUE',
    'ERR_WGL',
    'ERR_WIN32',
  };
  static const _roles = {
    'accepted',
    'candidate',
    'prospective',
    'retired',
    'none',
  };

  static String controlledCode(String? value) =>
      knownCodes.contains(value) ? value! : 'ERR_UNKNOWN';

  static String? _decimal(Object? value) {
    if (value is int && value >= 0) value = value.toString();
    if (value is! String ||
        !RegExp(r'^(?:0|[1-9][0-9]{0,19})$').hasMatch(value))
      return null;
    final number = BigInt.parse(value);
    return number <= _maximumU64 ? value : null;
  }

  static String? _positive(Object? value) {
    final parsed = _decimal(value);
    return parsed == '0' ? null : parsed;
  }

  static String? _session(Object? value) =>
      value is String && RegExp(r'^[A-Za-z0-9._:-]{1,128}$').hasMatch(value)
      ? value
      : null;

  static Map<String, Object?>? _identity(Object? value) {
    if (value is! Map) return null;
    final root = value['root'],
        revision = _positive(value['acceptedPackRevision']),
        session = _session(value['sessionId']);
    if (root is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(root) ||
        revision == null ||
        session == null)
      return null;
    return {
      'root': root,
      'acceptedPackRevision': revision,
      'sessionId': session,
    };
  }

  static Map<String, Object?>? observeAccepted({
    required int? controllerId,
    required Map<String, Object?> state,
  }) {
    final id = _positive(controllerId);
    if (id == null) return null;
    final surface = state['hostSurface'];
    return {
      'controllerId': id,
      'sessionId': _session(state['sessionId']),
      'ownerId': _positive(state['ownerId']),
      'surfaceGeneration': surface is Map
          ? _positive(surface['surfaceGeneration'])
          : null,
      'frameRevision': _decimal(state['frameRevision']),
      'acceptedPackIdentity': _identity(state['acceptedPackIdentity']),
    };
  }

  void adopt({
    required PlayerFailurePhase phase,
    required String? code,
    required String controllerRole,
    required int? controllerId,
    required Map<String, Object?> acceptedState,
    required int? acceptedControllerId,
    WeappViewFailure? viewFailure,
  }) {
    if (!_roles.contains(controllerRole))
      throw ArgumentError('Unknown controlled controller role');
    _sequence += BigInt.one;
    final view = viewFailure?.diagnostic;
    final entry = <String, Object?>{
      'schemaVersion': 1,
      'sequence': _sequence.toString(),
      'recordedAtMs': DateTime.now().millisecondsSinceEpoch.toString(),
      'phase': phase.name,
      // View provenance uses that exact immutable projection, even when its
      // original error code could not safely be read. Never diverge the two.
      'code': controlledCode(view == null ? code : view.code),
      'origin': {
        'controllerRole': controllerRole,
        'controllerId': _positive(controllerId),
        'view': view == null
            ? null
            : {
                'operation': view.operation.name,
                'viewLease': view.viewLease.toString(),
                'operationSequence': view.operationSequence.toString(),
                'retired': view.retired,
                'code': controlledCode(view.code),
                'nativeReason': view.nativeReason,
                'disposition': viewFailure!.disposition,
                'proofOutcome': viewFailure.proofOutcome.name,
              },
      },
      // This is the state observed when adopting the error, never a claim that
      // this frame/session caused it. A View attempt is bound only above.
      'observedAccepted': observeAccepted(
        controllerId: acceptedControllerId,
        state: acceptedState,
      ),
    };
    // Copy now, before notifyListeners or a later mutable native state update.
    _current = _freeze(entry) as Map<String, Object?>;
    _entries.add(_current!);
    if (_entries.length > maximumEntries) {
      _entries.removeAt(0);
      _dropped += BigInt.one;
    }
  }

  void clearCurrent() => _current = null;

  static Object? _freeze(Object? value) => value is Map
      ? Map<String, Object?>.unmodifiable(
          value.map((k, v) => MapEntry(k as String, _freeze(v))),
        )
      : value is List
      ? List<Object?>.unmodifiable(value.map(_freeze))
      : value;

  Map<String, Object?> snapshot() => jsonDecode(
    jsonEncode({
      'schemaVersion': 1,
      'journalId': journalId,
      'lastSequence': _sequence.toString(),
      'droppedCount': _dropped.toString(),
      'responseTruncated': false,
      'current': _current,
      'entries': _entries,
    }),
  ) as Map<String, Object?>;
}
