import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleState;

class DevelopmentLifecycleIntent {
  const DevelopmentLifecycleIntent({
    required this.epoch,
    required this.state,
    required this.foreground,
    required this.transportEnabled,
  });

  final int epoch;
  final AppLifecycleState state;
  final bool foreground;
  final bool transportEnabled;
}

/// Serializes guest lifecycle edges independently of development networking.
class DevelopmentLifecycleCoordinator {
  int _epoch = 0;
  bool _transportEnabled = true;
  Future<void> _queue = Future.value();

  bool isCurrent(DevelopmentLifecycleIntent intent) => intent.epoch == _epoch;

  Future<void> request(
    AppLifecycleState state, {
    required bool desktop,
    required void Function(DevelopmentLifecycleIntent) requested,
    required Future<void> Function(DevelopmentLifecycleIntent) apply,
  }) {
    // Inactive is focus loss, not proof of background. Preserve the last
    // transport intent in both directions (paused -> inactive stays paused).
    if (state != AppLifecycleState.inactive) {
      _transportEnabled = state == AppLifecycleState.resumed;
    }
    final intent = DevelopmentLifecycleIntent(
      epoch: ++_epoch,
      state: state,
      foreground:
          state == AppLifecycleState.resumed ||
          desktop && state == AppLifecycleState.inactive,
      transportEnabled: _transportEnabled,
    );
    requested(intent);
    final pending = _queue.then((_) => apply(intent));
    _queue = pending.catchError((Object _) {});
    return pending;
  }

  Future<void> get settled => _queue;
}

class DevelopmentConnectionLease<T> {
  DevelopmentConnectionLease._(
    this.id,
    this.connectionEpoch,
    this.value,
    this._close,
  );

  final int id;
  final int connectionEpoch;
  final T value;
  final Future<void> Function(T) _close;
  Future<void> Function()? unsubscribe;
  Future<void>? _cleanup;
}

enum DevelopmentConnectionEvent {
  dialStarted,
  opened,
  dialFailed,
  retired,
  closed,
  cleanupFailed,
  staleDialClosed,
  remoteClosed,
  socketError,
  retryScheduled,
}

/// Fixed, app-local diagnostic fields. No socket/error/URI is accepted here.
class DevelopmentConnectionDiagnostic {
  const DevelopmentConnectionDiagnostic(
    this.event, {
    required this.connectionEpoch,
    required this.attemptId,
    this.closeCode,
  });

  final DevelopmentConnectionEvent event;
  final int connectionEpoch;
  final int attemptId;
  final int? closeCode;

  Map<String, Object?> toJson() => {
    'schemaVersion': 1,
    'event': event.name,
    'connectionEpoch': connectionEpoch,
    'attemptId': attemptId,
    if (closeCode != null && closeCode! >= 1000 && closeCode! <= 4999)
      'closeCode': closeCode,
  };
}

class _ConnectionAttempt {
  _ConnectionAttempt(this.id, this.connectionEpoch);
  final int id;
  final int connectionEpoch;
  final completed = Completer<void>();
}

/// Owns event connections; callers bind callbacks to the accepted lease.
class DevelopmentConnectionOwner<T> {
  DevelopmentConnectionOwner({this.diagnostic});

  final void Function(DevelopmentConnectionDiagnostic)? diagnostic;
  bool _enabled = true;
  bool _closed = false;
  int _nextId = 0;
  DevelopmentConnectionLease<T>? _current;
  _ConnectionAttempt? _attempt;
  final _pending = <Future<void>>{};
  final _cleanups = <Future<void>>{};

  bool get enabled => _enabled && !_closed;
  DevelopmentConnectionLease<T>? get current => _current;

  void _record(
    DevelopmentConnectionEvent event,
    int epoch,
    int id, {
    int? closeCode,
  }) {
    try {
      diagnostic?.call(
        DevelopmentConnectionDiagnostic(
          event,
          connectionEpoch: epoch,
          attemptId: id,
          closeCode: closeCode,
        ),
      );
    } catch (_) {
      // A diagnostic observer cannot affect connection ownership or cleanup.
    }
  }

  bool owns(DevelopmentConnectionLease<T> lease) =>
      identical(_current, lease) && enabled;

  void observe(
    DevelopmentConnectionLease<T> lease,
    DevelopmentConnectionEvent event, {
    int? closeCode,
  }) {
    if (owns(lease))
      _record(event, lease.connectionEpoch, lease.id, closeCode: closeCode);
  }

  Future<void> open({
    required int connectionEpoch,
    required Future<T> Function(bool Function() isCurrent) dial,
    required Future<void> Function(T) close,
    required void Function(DevelopmentConnectionLease<T>) opened,
    required void Function(Object) failed,
  }) {
    if (!enabled) return Future.value();
    if (_current?.connectionEpoch == connectionEpoch) return Future.value();
    final pending = _attempt;
    if (pending?.connectionEpoch == connectionEpoch) {
      return pending!.completed.future;
    }
    final old = _current;
    if (old != null) unawaited(retire(old));
    final attempt = _ConnectionAttempt(++_nextId, connectionEpoch);
    _attempt = attempt;
    // A retired handshake must finish/close before another physical dial.
    // Otherwise its late server upgrade could evict the replacement peer.
    final predecessors = List<Future<void>>.of(_pending);
    final operation = () async {
      await Future.wait(predecessors);
      await _dial(attempt, dial, close, opened, failed);
    }();
    _pending.add(operation);
    unawaited(operation.then((_) => _pending.remove(operation)));
    return attempt.completed.future;
  }

  Future<void> _dial(
    _ConnectionAttempt attempt,
    Future<T> Function(bool Function() isCurrent) dial,
    Future<void> Function(T) close,
    void Function(DevelopmentConnectionLease<T>) opened,
    void Function(Object) failed,
  ) async {
    bool current() => enabled && identical(_attempt, attempt);
    try {
      if (!current()) return;
      _record(
        DevelopmentConnectionEvent.dialStarted,
        attempt.connectionEpoch,
        attempt.id,
      );
      final socket = await dial(current);
      final lease = DevelopmentConnectionLease._(
        attempt.id,
        attempt.connectionEpoch,
        socket,
        close,
      );
      if (!enabled || !identical(_attempt, attempt)) {
        _record(
          DevelopmentConnectionEvent.staleDialClosed,
          attempt.connectionEpoch,
          attempt.id,
        );
        await _cleanup(lease);
        return;
      }
      _current = lease;
      opened(lease);
      _record(
        DevelopmentConnectionEvent.opened,
        attempt.connectionEpoch,
        attempt.id,
      );
    } catch (error) {
      if (enabled && identical(_attempt, attempt)) {
        final lease = _current;
        if (lease?.id == attempt.id) await retire(lease!);
        _record(
          DevelopmentConnectionEvent.dialFailed,
          attempt.connectionEpoch,
          attempt.id,
        );
        failed(error);
      }
    } finally {
      if (identical(_attempt, attempt)) _attempt = null;
      attempt.completed.complete();
    }
  }

  Future<void> _cleanup(DevelopmentConnectionLease<T> lease) {
    final prior = lease._cleanup;
    if (prior != null) return prior;
    final completed = Completer<void>();
    lease._cleanup = completed.future;
    _cleanups.add(completed.future);
    unawaited(() async {
      var failed = false;
      try {
        await lease.unsubscribe?.call();
      } catch (_) {
        failed = true;
      }
      try {
        await lease._close(lease.value);
      } catch (_) {
        failed = true;
      } finally {
        _record(
          failed
              ? DevelopmentConnectionEvent.cleanupFailed
              : DevelopmentConnectionEvent.closed,
          lease.connectionEpoch,
          lease.id,
        );
        _cleanups.remove(completed.future);
        completed.complete();
      }
    }());
    return completed.future;
  }

  Future<void> suspend() {
    _enabled = false;
    return reset();
  }

  void resume() {
    if (!_closed) _enabled = true;
  }

  Future<void> retire(DevelopmentConnectionLease<T> lease) {
    if (identical(_current, lease)) _current = null;
    _record(
      DevelopmentConnectionEvent.retired,
      lease.connectionEpoch,
      lease.id,
    );
    return _cleanup(lease);
  }

  /// Detaches synchronously; cleanup can only touch the captured old lease.
  Future<void> reset() {
    _attempt = null;
    final old = _current;
    return old == null ? Future.value() : retire(old);
  }

  Future<void> close() async {
    _closed = true;
    await suspend();
    await Future.wait(List.of(_pending));
    await Future.wait(List.of(_cleanups));
  }
}
