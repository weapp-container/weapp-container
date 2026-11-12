import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container/weapp_container.dart';
import 'package:weapp_container_dev_player/src/player_failure.dart';

void main() {
  void adopt(
    PlayerFailureJournal journal, {
    String? code = 'ERR_CANCELLED',
    Map<String, Object?> state = const {},
    WeappViewFailure? failure,
  }) {
    journal.adopt(
      phase: PlayerFailurePhase.preview,
      code: code,
      controllerRole: 'accepted',
      controllerId: 7,
      acceptedControllerId: 7,
      acceptedState: state,
      viewFailure: failure,
    );
  }

  test('explicit zero and model-local identities', () {
    final a = PlayerFailureJournal(), b = PlayerFailureJournal();
    expect(a.journalId, matches(RegExp(r'^[a-f0-9]{32}$')));
    expect(a.journalId, isNot(b.journalId));
    expect(a.snapshot(), {
      'schemaVersion': 1,
      'journalId': a.journalId,
      'lastSequence': '0',
      'droppedCount': '0',
      'responseTruncated': false,
      'current': null,
      'entries': [],
    });
  });
  test(
    'adoption snapshots exact original operation without arbitrary error text',
    () {
      final journal = PlayerFailureJournal();
      final exception = PlatformException(
        code: 'ERR_CANCELLED',
        message: 'private://secret',
        details: {'token': 'private-token'},
      );
      final diagnostic = WeappViewDiagnostic(
        operation: WeappViewOperation.hostLayout,
        viewLease: 3,
        operationSequence: 9,
        retired: false,
        error: exception,
      );
      adopt(
        journal,
        failure: WeappViewFailure(
          error: exception,
          stackTrace: StackTrace.fromString('private stack'),
          diagnostic: diagnostic,
          proofOutcome: WeappViewFailureProof.unavailable,
        ),
      );
      final current = journal.snapshot()['current'] as Map;
      expect(current['code'], 'ERR_CANCELLED');
      expect((current['origin'] as Map)['view'], {
        'operation': 'hostLayout',
        'viewLease': '3',
        'operationSequence': '9',
        'retired': false,
        'code': 'ERR_CANCELLED',
        'nativeReason': 'unclassified',
        'disposition': 'active-error',
        'proofOutcome': 'unavailable',
      });
      final text = jsonEncode(journal.snapshot());
      for (final secret in [
        'private-token',
        'private://',
        'private stack',
        'token',
        'message',
      ]) {
        expect(text, isNot(contains(secret)));
      }
    },
  );
  test(
    'unavailable View code is one consistent explicit unknown projection',
    () {
      final journal = PlayerFailureJournal();
      final original = PlatformException(code: 'ERR_CANCELLED');
      final diagnostic = WeappViewDiagnostic(
        operation: WeappViewOperation.foreground,
        viewLease: 2,
        operationSequence: 3,
        retired: false,
        error: Object(),
      );
      adopt(
        journal,
        failure: WeappViewFailure(
          error: original,
          stackTrace: StackTrace.empty,
          diagnostic: diagnostic,
        ),
      );
      final current = journal.snapshot()['current'] as Map;
      expect(current['code'], 'ERR_UNKNOWN');
      expect(
        ((current['origin'] as Map)['view'] as Map)['code'],
        'ERR_UNKNOWN',
      );
      expect(
        ((current['origin'] as Map)['view'] as Map)['operationSequence'],
        '3',
      );
    },
  );

  test('unknown codes are explicit and cannot carry arbitrary content', () {
    final journal = PlayerFailureJournal();
    for (final code in [
      'ERR_SECRET_CREDENTIAL_123',
      'ERR_TIMEOUT\nsecret',
      null,
    ]) {
      adopt(journal, code: code);
      expect((journal.snapshot()['current'] as Map)['code'], 'ERR_UNKNOWN');
    }
  });
  test('observation is copied at adoption and source extras never escape', () {
    final journal = PlayerFailureJournal();
    final identity = <String, Object?>{
      'root': 'a' * 64,
      'acceptedPackRevision': '9007199254740994',
      'sessionId': 'sdk-7-1',
      'token': 'forbidden',
    };
    final state = <String, Object?>{
      'sessionId': 'sdk-7-1',
      'ownerId': '7',
      'hostSurface': {'surfaceGeneration': '2', 'token': 'forbidden'},
      'frameRevision': 12,
      'acceptedPackIdentity': identity,
      'secret': 'forbidden',
    };
    adopt(journal, state: state);
    identity['sessionId'] = 'mutated';
    state['ownerId'] = '99';
    final current = journal.snapshot()['current'] as Map;
    final observed = current['observedAccepted'] as Map;
    expect(observed['ownerId'], '7');
    expect(observed['frameRevision'], '12');
    expect(
      (observed['acceptedPackIdentity'] as Map)['acceptedPackRevision'],
      '9007199254740994',
    );
    expect(jsonEncode(observed), isNot(contains('forbidden')));
    observed['ownerId'] = 'response mutation';
    expect(
      ((journal.snapshot()['current'] as Map)['observedAccepted']
          as Map)['ownerId'],
      '7',
    );
  });
  test(
    'history bounds, clear and replacement preserve original adoption sequence',
    () {
      final journal = PlayerFailureJournal();
      for (var i = 0; i < 20; i++) adopt(journal);
      var snapshot = journal.snapshot();
      expect(snapshot['lastSequence'], '20');
      expect(snapshot['droppedCount'], '4');
      expect((snapshot['entries'] as List).length, 16);
      expect(((snapshot['entries'] as List).first as Map)['sequence'], '5');
      journal.clearCurrent();
      snapshot = journal.snapshot();
      expect(snapshot['current'], null);
      expect(snapshot['lastSequence'], '20');
      expect((snapshot['entries'] as List).length, 16);
      adopt(journal, code: 'ERR_TIMEOUT');
      snapshot = journal.snapshot();
      expect((snapshot['current'] as Map)['sequence'], '21');
      expect((snapshot['entries'] as List).last, snapshot['current']);
    },
  );
  test('invalid observed scalars stay unknown, rather than inferred from another field', () {
    final journal = PlayerFailureJournal();
    adopt(
      journal,
      state: {
        'sessionId': 'private://path',
        'ownerId': '01',
        'frameRevision': 1.5,
        'hostSurface': {'surfaceGeneration': '-1'},
        'acceptedPackIdentity': {
          'root': 'not a hash',
          'acceptedPackRevision': '1',
          'sessionId': 'sdk',
        },
      },
    );
    final observed =
        (journal.snapshot()['current'] as Map)['observedAccepted'] as Map;
    expect(observed, {
      'controllerId': '7',
      'sessionId': null,
      'ownerId': null,
      'frameRevision': null,
      'surfaceGeneration': null,
      'acceptedPackIdentity': null,
    });
  });
}
