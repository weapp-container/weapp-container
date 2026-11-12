import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/player_failure.dart';

Map<String, Object?> identity(String session) => {
  'root': List.filled(64, 'a').join(),
  'acceptedPackRevision': session == 'old-session'
      ? '18446744073709551614'
      : '18446744073709551615',
  'sessionId': session,
};

Map<String, Object?> origin() => {
  'schemaVersion': 1,
  'phase': 'retirement',
  'operation': 'unload',
  'sessionId': 'old-session',
  'acceptedPackIdentity': identity('old-session'),
};

void main() {
  test(
    'origin is closed, immutable and session-bound without narrowing u64',
    () {
      final raw = origin();
      final parsed = RuntimeRetirementOrigin.tryParse(raw)!;
      (raw['acceptedPackIdentity'] as Map)['sessionId'] = 'mutated';
      expect(
        (parsed.fields['acceptedPackIdentity'] as Map)['sessionId'],
        'old-session',
      );
      expect(
        parsed.precedesAccepted(identity('new-session'), 'new-session'),
        true,
      );
      expect(
        parsed.precedesAccepted(identity('old-session'), 'old-session'),
        false,
      );
      expect(
        parsed.precedesAccepted(identity('new-session'), 'different'),
        false,
      );
      expect(() => parsed.fields['phase'] = 'runtime', throwsUnsupportedError);
      for (final revision in ['18446744073709551614', '18446744073709551613']) {
        expect(
          parsed.precedesAccepted(
            identity('new-session')..['acceptedPackRevision'] = revision,
            'new-session',
          ),
          false,
        );
      }
    },
  );

  test(
    'malformed or unbound provenance cannot classify an error as retirement',
    () {
      for (final field in origin().keys) {
        final raw = origin()..remove(field);
        expect(RuntimeRetirementOrigin.tryParse(raw), null, reason: field);
      }
      expect(
        RuntimeRetirementOrigin.tryParse(origin()..['extra'] = 'private'),
        null,
      );
      expect(
        RuntimeRetirementOrigin.tryParse(origin()..['phase'] = 'runtime'),
        null,
      );
      expect(
        RuntimeRetirementOrigin.tryParse(origin()..['schemaVersion'] = 1.0),
        null,
      );
      expect(
        RuntimeRetirementOrigin.tryParse(origin()..['sessionId'] = 'foreign'),
        null,
      );
      for (final revision in [1, '0', '01', '-1', '18446744073709551616']) {
        final raw = origin();
        (raw['acceptedPackIdentity'] as Map)['acceptedPackRevision'] = revision;
        expect(
          RuntimeRetirementOrigin.tryParse(raw),
          null,
          reason: '$revision',
        );
      }
    },
  );

  test('retirement history is independently bounded and does not retain error text', () {
    final journal = PlayerRetirementJournal();
    final parsed = RuntimeRetirementOrigin.tryParse(origin())!;
    final state = <String, Object?>{
      'sessionId': 'new-session',
      'acceptedPackIdentity': identity('new-session'),
    };
    for (var i = 0; i < 19; i++) {
      journal.record(
        origin: parsed,
        code: 'private arbitrary code',
        controllerId: 1,
        acceptedState: state,
      );
    }
    final snapshot = journal.snapshot();
    expect(snapshot['lastSequence'], '19');
    expect(snapshot['droppedCount'], '3');
    final entries = snapshot['entries'] as List;
    expect(entries, hasLength(16));
    expect((entries.first as Map)['sequence'], '4');
    expect((entries.last as Map)['code'], 'ERR_UNKNOWN');
    expect(snapshot.toString(), isNot(contains('private arbitrary code')));
    entries.clear();
    expect(journal.snapshot()['entries'] as List, hasLength(16));
    expect(
      journal.record(
        origin: parsed,
        code: 'ERR_ENGINE',
        controllerId: 1,
        acceptedState: {
          'sessionId': 'old-session',
          'acceptedPackIdentity': identity('old-session'),
        },
      ),
      false,
    );
    expect(
      journal.record(
        origin: parsed,
        code: 'ERR_ENGINE',
        controllerId: 0,
        acceptedState: state,
      ),
      false,
    );
    expect(journal.snapshot()['lastSequence'], '19');
  });
}
