import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/development_connection.dart';

class SocketFixture {
  int closes = 0;
  Future<void> close() async => closes++;
}

void main() {
  test(
    'focus loss keeps transport intent while guest foreground is unchanged',
    () async {
      final lifecycle = DevelopmentLifecycleCoordinator();
      final observed = <DevelopmentLifecycleIntent>[];
      for (final state in [
        AppLifecycleState.resumed,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]) {
        await lifecycle.request(
          state,
          desktop: false,
          requested: observed.add,
          apply: (_) async {},
        );
      }
      expect(observed.map((x) => x.foreground), [
        true,
        false,
        true,
        false,
        false,
        false,
        true,
      ]);
      expect(observed.map((x) => x.transportEnabled), [
        true,
        true,
        true,
        false,
        false,
        false,
        true,
      ]);
    },
  );

  test('guest lifecycle transitions finish in arrival order without dropping background', () async {
    final lifecycle = DevelopmentLifecycleCoordinator();
    final gate = Completer<void>();
    final started = <bool>[];
    final finished = <bool>[];
    Future<void> apply(DevelopmentLifecycleIntent intent) async {
      started.add(intent.foreground);
      if (!intent.foreground) await gate.future;
      finished.add(intent.foreground);
    }

    final background = lifecycle.request(
      AppLifecycleState.paused,
      desktop: false,
      requested: (_) {},
      apply: apply,
    );
    final foreground = lifecycle.request(
      AppLifecycleState.resumed,
      desktop: false,
      requested: (_) {},
      apply: apply,
    );
    await Future<void>.delayed(Duration.zero);
    expect(started, [false]);
    gate.complete();
    await Future.wait([background, foreground]);
    expect(finished, [false, true]);
  });

  Future<DevelopmentConnectionLease<SocketFixture>> attach(
    DevelopmentConnectionOwner<SocketFixture> owner,
    SocketFixture socket,
  ) async {
    late DevelopmentConnectionLease<SocketFixture> accepted;
    await owner.open(
      connectionEpoch: 1,
      dial: (_) async => socket,
      close: (value) => value.close(),
      opened: (lease) => accepted = lease,
      failed: (error) => fail('Unexpected dial failure'),
    );
    return accepted;
  }

  test('retiring a captured old connection cannot close a new socket after cancel awaits', () async {
    final owner = DevelopmentConnectionOwner<SocketFixture>();
    final oldSocket = SocketFixture(), nextSocket = SocketFixture();
    final oldLease = await attach(owner, oldSocket);
    final cancellation = Completer<void>();
    oldLease.unsubscribe = () => cancellation.future;
    final retiring = owner.suspend();
    owner.resume();
    final nextLease = await attach(owner, nextSocket);
    cancellation.complete();
    await retiring;
    expect(oldSocket.closes, 1);
    expect(nextSocket.closes, 0);
    expect(owner.owns(nextLease), true);
    expect(owner.owns(oldLease), false);
  });

  test(
    'late old close cannot retire the replacement lease in the same auth epoch',
    () async {
      final owner = DevelopmentConnectionOwner<SocketFixture>();
      final first = await attach(owner, SocketFixture());
      await owner.suspend();
      owner.resume();
      final second = await attach(owner, SocketFixture());
      expect(owner.owns(first), false);
      await owner.retire(first);
      expect(owner.owns(second), true);
      expect(second.value.closes, 0);
      await owner.suspend();
    },
  );

  test('background invalidates a pending handshake and closes only its late socket', () async {
    final owner = DevelopmentConnectionOwner<SocketFixture>();
    final first = Completer<SocketFixture>();
    final opened = <DevelopmentConnectionLease<SocketFixture>>[];
    final pending = owner.open(
      connectionEpoch: 1,
      dial: (_) => first.future,
      close: (socket) => socket.close(),
      opened: opened.add,
      failed: (_) => fail('Unexpected failure'),
    );
    await Future<void>.delayed(Duration.zero);
    await owner.suspend();
    owner.resume();
    final nextPending = attach(owner, SocketFixture());
    final stale = SocketFixture();
    first.complete(stale);
    await pending;
    final next = await nextPending;
    expect(opened, isEmpty);
    expect(stale.closes, 1);
    expect(owner.owns(next), true);
    await owner.suspend();
  });

  test(
    'overlapping resumed/retry opens share one attempt and one socket',
    () async {
      final owner = DevelopmentConnectionOwner<SocketFixture>();
      final gate = Completer<SocketFixture>();
      var dials = 0, accepted = 0;
      Future<void> open() => owner.open(
        connectionEpoch: 1,
        dial: (_) {
          dials++;
          return gate.future;
        },
        close: (socket) => socket.close(),
        opened: (_) => accepted++,
        failed: (_) => fail('Unexpected failure'),
      );
      final first = open(), second = open();
      gate.complete(SocketFixture());
      await Future.wait([first, second]);
      expect(dials, 1);
      expect(accepted, 1);
      await owner.suspend();
    },
  );

  test('a later background remains suspended after an older native foreground completes', () async {
    final lifecycle = DevelopmentLifecycleCoordinator();
    final gate = Completer<void>();
    final requested = <DevelopmentLifecycleIntent>[];
    final applied = <DevelopmentLifecycleIntent>[];
    Future<void> apply(DevelopmentLifecycleIntent intent) async {
      if (intent.state == AppLifecycleState.resumed) await gate.future;
      applied.add(intent);
    }

    final foreground = lifecycle.request(
      AppLifecycleState.resumed,
      desktop: false,
      requested: requested.add,
      apply: apply,
    );
    final background = lifecycle.request(
      AppLifecycleState.paused,
      desktop: false,
      requested: requested.add,
      apply: apply,
    );
    expect(requested.last.transportEnabled, false);
    expect(lifecycle.isCurrent(requested.first), false);
    gate.complete();
    await Future.wait([foreground, background]);
    expect(applied.map((x) => x.foreground), [true, false]);
    expect(lifecycle.isCurrent(applied.last), true);
  });

  test('failed native lifecycle remains observable and does not poison later transition ordering', () async {
    final lifecycle = DevelopmentLifecycleCoordinator();
    final first = lifecycle.request(
      AppLifecycleState.paused,
      desktop: false,
      requested: (_) {},
      apply: (_) async {
        throw StateError('native boundary failed');
      },
    );
    final failure = expectLater(first, throwsStateError);
    var applied = false;
    final second = lifecycle.request(
      AppLifecycleState.resumed,
      desktop: false,
      requested: (_) {},
      apply: (_) async {
        applied = true;
      },
    );
    await failure;
    await second;
    expect(applied, true);
  });

  test(
    'desktop inactive retains its original native foreground behavior',
    () async {
      final lifecycle = DevelopmentLifecycleCoordinator();
      late DevelopmentLifecycleIntent observed;
      await lifecycle.request(
        AppLifecycleState.inactive,
        desktop: true,
        requested: (intent) => observed = intent,
        apply: (_) async {},
      );
      expect(observed.foreground, true);
      expect(observed.transportEnabled, true);
    },
  );

  test('reset invalidates authorization attempt before a late handshake can publish', () async {
    final owner = DevelopmentConnectionOwner<SocketFixture>();
    final authorization = Completer<void>();
    var lateHandshakes = 0;
    final old = owner.open(
      connectionEpoch: 1,
      dial: (current) async {
        await authorization.future;
        if (!current()) throw StateError('retired authorization');
        lateHandshakes++;
        return SocketFixture();
      },
      close: (socket) => socket.close(),
      opened: (_) => fail('Retired attempt published'),
      failed: (_) => fail('Retired error reached the active owner'),
    );
    await Future<void>.delayed(Duration.zero);
    await owner.reset();
    final replacement = attach(owner, SocketFixture());
    authorization.complete();
    await old;
    final lease = await replacement;
    expect(lateHandshakes, 0);
    expect(owner.owns(lease), true);
    await owner.close();
  });

  test('retired physical handshake is cleaned before a new server upgrade is attempted', () async {
    final owner = DevelopmentConnectionOwner<SocketFixture>();
    final handshake = Completer<SocketFixture>();
    final closed = Completer<void>();
    final oldSocket = SocketFixture();
    final old = owner.open(
      connectionEpoch: 1,
      dial: (_) => handshake.future,
      close: (socket) async {
        await closed.future;
        await socket.close();
      },
      opened: (_) => fail('Retired socket accepted'),
      failed: (_) => fail('Unexpected error'),
    );
    await Future<void>.delayed(Duration.zero);
    await owner.reset();
    var upgrades = 0;
    final next = owner.open(
      connectionEpoch: 2,
      dial: (_) async {
        upgrades++;
        return SocketFixture();
      },
      close: (socket) => socket.close(),
      opened: (_) {},
      failed: (_) => fail('Unexpected error'),
    );
    handshake.complete(oldSocket);
    await Future<void>.delayed(Duration.zero);
    expect(upgrades, 0);
    closed.complete();
    await Future.wait([old, next]);
    expect(oldSocket.closes, 1);
    expect(upgrades, 1);
    expect(owner.current!.connectionEpoch, 2);
    await owner.close();
  });

  test('cleanup failure still closes captured socket and diagnostics cannot affect cleanup', () async {
    final observations = <Map<String, Object?>>[];
    final owner = DevelopmentConnectionOwner<SocketFixture>(
      diagnostic: (event) {
        observations.add(event.toJson());
        throw StateError('secret URI must not escape diagnostic observer');
      },
    );
    final socket = SocketFixture();
    final lease = await attach(owner, socket);
    lease.unsubscribe = () async {
      throw StateError('weapp-container://secret github_pat_do_not_log');
    };
    await owner.suspend();
    await owner.retire(lease);
    expect(socket.closes, 1);
    expect(observations.last['event'], 'retired');
    expect(
      observations.where((x) => x['event'] == 'cleanupFailed'),
      hasLength(1),
    );
    expect(
      observations
          .expand((x) => x.values)
          .whereType<String>()
          .any(
            (x) =>
                x.contains('secret') ||
                x.contains('://') ||
                x.contains('github_pat'),
          ),
      false,
    );
    expect(owner.current, isNull);
    await owner.close();
  });

  test('close drains a late handshake and is permanent/idempotent', () async {
    final owner = DevelopmentConnectionOwner<SocketFixture>();
    final handshake = Completer<SocketFixture>();
    final socket = SocketFixture();
    final pending = owner.open(
      connectionEpoch: 1,
      dial: (_) => handshake.future,
      close: (socket) => socket.close(),
      opened: (_) => fail('Closed owner accepted socket'),
      failed: (_) => fail('Closed owner reported stale error'),
    );
    await Future<void>.delayed(Duration.zero);
    final close = owner.close();
    owner.resume();
    var dials = 0;
    await owner.open(
      connectionEpoch: 2,
      dial: (_) async {
        dials++;
        return SocketFixture();
      },
      close: (socket) => socket.close(),
      opened: (_) {},
      failed: (_) {},
    );
    handshake.complete(socket);
    await Future.wait([close, pending]);
    await owner.close();
    expect(dials, 0);
    expect(socket.closes, 1);
    expect(owner.enabled, false);
  });
}
