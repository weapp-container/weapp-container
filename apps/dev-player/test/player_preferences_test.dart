import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

import '../lib/src/player_preferences.dart';

void main() {
  late Directory root;
  late File file;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('player-preferences-test-');
    file = File('${root.path}/settings/preferences.json');
  });

  tearDown(() async {
    await root.delete(recursive: true);
  });

  test(
    'default storage uses application support rather than project data',
    () async {
      final original = PathProviderPlatform.instance;
      PathProviderPlatform.instance = _PreferencesPathProvider(root.path);
      addTearDown(() => PathProviderPlatform.instance = original);
      final preferences = await PlayerPreferences.load();
      addTearDown(preferences.dispose);
      await preferences.setLanguageCode('en');
      final persisted = File('${root.path}/preferences.json');
      expect(jsonDecode(await persisted.readAsString())['languageCode'], 'en');
      expect(await file.exists(), isFalse);
    },
  );

  test(
    'first launch defaults to Chinese and persists an explicit choice',
    () async {
      final preferences = await PlayerPreferences.load(file: file);
      addTearDown(preferences.dispose);
      expect(preferences.languageCode, 'zh');
      expect(preferences.locale, const Locale('zh'));
      expect(await file.exists(), isFalse);

      var notifications = 0;
      preferences.addListener(() => notifications++);
      await preferences.setLanguageCode('en');
      expect(preferences.locale, const Locale('en'));
      expect(notifications, 1);
      expect(jsonDecode(await file.readAsString()), {
        'schemaVersion': 1,
        'languageCode': 'en',
      });
      final restored = await PlayerPreferences.load(file: file);
      addTearDown(restored.dispose);
      expect(restored.languageCode, 'en');
      expect(await file.parent.list().length, 1);
    },
  );

  test(
    'unavailable preferences open in Chinese and never claim a saved choice',
    () async {
      final preferences = PlayerPreferences.unavailable();
      addTearDown(preferences.dispose);
      var notifications = 0;
      preferences.addListener(() => notifications++);
      for (final language in ['en', 'zh']) {
        await expectLater(
          preferences.setLanguageCode(language),
          throwsA(
            isA<PlayerPreferencesException>().having(
              (error) => error.code,
              'code',
              'ERR_PREFERENCES_STORAGE',
            ),
          ),
        );
      }
      expect(preferences.languageCode, 'zh');
      expect(preferences.locale, const Locale('zh'));
      expect(notifications, 0);
      expect(await file.exists(), isFalse);
    },
  );

  for (final failure in [
    PlatformException(code: 'storage unavailable', message: '/private/path'),
    MissingPluginException('platform plugin unavailable'),
    const FileSystemException('access denied', '/private/path'),
  ]) {
    test(
      'storage bootstrap failure leaves the Player available: ${failure.runtimeType}',
      () async {
        final original = PathProviderPlatform.instance;
        PathProviderPlatform.instance = _FailingPreferencesPathProvider(
          failure,
        );
        addTearDown(() => PathProviderPlatform.instance = original);
        await expectLater(
          PlayerPreferences.load(),
          throwsA(isA<PlayerPreferencesException>()),
        );
        final preferences = await PlayerPreferences.loadOrDefault();
        addTearDown(preferences.dispose);
        var notifications = 0;
        preferences.addListener(() => notifications++);
        expect(preferences.languageCode, 'zh');
        await expectLater(
          preferences.setLanguageCode('en'),
          throwsA(
            isA<PlayerPreferencesException>()
                .having(
                  (error) => error.code,
                  'code',
                  'ERR_PREFERENCES_STORAGE',
                )
                .having(
                  (error) => error.toString(),
                  'safe error',
                  isNot(contains('/private/path')),
                ),
          ),
        );
        expect(preferences.languageCode, 'zh');
        expect(notifications, 0);
      },
    );
  }

  test(
    'bootstrap fallback does not swallow a platform implementation bug',
    () async {
      final original = PathProviderPlatform.instance;
      final failure = StateError('implementation bug');
      PathProviderPlatform.instance = _FailingPreferencesPathProvider(failure);
      addTearDown(() => PathProviderPlatform.instance = original);
      await expectLater(
        PlayerPreferences.loadOrDefault(),
        throwsA(same(failure)),
      );
    },
  );

  test(
    'safe bootstrap keeps successful persistent loading and writing',
    () async {
      await file.parent.create(recursive: true);
      await file.writeAsString('{"schemaVersion":1,"languageCode":"en"}');
      final preferences = await PlayerPreferences.loadOrDefault(file: file);
      addTearDown(preferences.dispose);
      expect(preferences.languageCode, 'en');
      await preferences.setLanguageCode('zh');
      expect(jsonDecode(await file.readAsString())['languageCode'], 'zh');
    },
  );

  for (final source in [
    '{invalid JSON',
    '[]',
    '{"schemaVersion":2,"languageCode":"en"}',
    '{"schemaVersion":1,"languageCode":"fr"}',
    '{"schemaVersion":1,"languageCode":null}',
  ]) {
    test('invalid preference data is preserved: $source', () async {
      await file.parent.create(recursive: true);
      await file.writeAsString(source);
      final original = await file.readAsBytes();
      final preferences = await PlayerPreferences.load(file: file);
      addTearDown(preferences.dispose);
      expect(preferences.languageCode, 'zh');
      expect(await file.readAsBytes(), original);
      // An explicit Chinese selection repairs the saved preference even though
      // the effective fallback language has not changed.
      await preferences.setLanguageCode('zh');
      expect(jsonDecode(await file.readAsString()), {
        'schemaVersion': 1,
        'languageCode': 'zh',
      });
    });
  }

  test(
    'unsupported choices leave memory, disk and listeners unchanged',
    () async {
      final preferences = await PlayerPreferences.load(file: file);
      addTearDown(preferences.dispose);
      await preferences.setLanguageCode('en');
      final original = await file.readAsBytes();
      var notifications = 0;
      preferences.addListener(() => notifications++);
      await expectLater(
        preferences.setLanguageCode('fr'),
        throwsA(
          isA<PlayerPreferencesException>().having(
            (error) => error.code,
            'code',
            'ERR_PREFERENCES_LANGUAGE',
          ),
        ),
      );
      expect(preferences.languageCode, 'en');
      expect(await file.readAsBytes(), original);
      expect(notifications, 0);
    },
  );

  test(
    'write failures retain the accepted language and the queue recovers',
    () async {
      final preferences = await PlayerPreferences.load(file: file);
      addTearDown(preferences.dispose);
      await preferences.setLanguageCode('en');
      await file.parent.delete(recursive: true);
      final blocker = File(file.parent.path);
      await blocker.writeAsString('unrelated data');
      var notifications = 0;
      preferences.addListener(() => notifications++);
      await expectLater(
        preferences.setLanguageCode('zh'),
        throwsA(
          isA<PlayerPreferencesException>()
              .having((error) => error.code, 'code', 'ERR_PREFERENCES_WRITE')
              .having(
                (error) => error.toString(),
                'safe error',
                isNot(contains(root.path)),
              )
              .having(
                (error) => error.toString(),
                'safe error',
                isNot(contains('unrelated data')),
              ),
        ),
      );
      expect(preferences.languageCode, 'en');
      expect(notifications, 0);
      expect(await blocker.readAsString(), 'unrelated data');

      await blocker.delete();
      await preferences.setLanguageCode('zh');
      expect(preferences.languageCode, 'zh');
      expect(notifications, 1);
      expect(jsonDecode(await file.readAsString())['languageCode'], 'zh');
    },
  );

  test(
    'rename failure preserves an existing destination and removes staging',
    () async {
      final preferences = await PlayerPreferences.load(file: file);
      addTearDown(preferences.dispose);
      await Directory(file.path).create(recursive: true);
      final marker = File('${file.path}/marker');
      await marker.writeAsString('keep');
      await expectLater(
        preferences.setLanguageCode('en'),
        throwsA(
          isA<PlayerPreferencesException>().having(
            (error) => error.code,
            'code',
            'ERR_PREFERENCES_WRITE',
          ),
        ),
      );
      expect(preferences.languageCode, 'zh');
      expect(await marker.readAsString(), 'keep');
      expect(await file.parent.list().length, 1);
    },
  );

  test('rapid changes commit in request order without stale writes', () async {
    final preferences = await PlayerPreferences.load(file: file);
    addTearDown(preferences.dispose);
    final accepted = <String>[];
    preferences.addListener(() => accepted.add(preferences.languageCode));
    await Future.wait([
      preferences.setLanguageCode('en'),
      preferences.setLanguageCode('zh'),
      preferences.setLanguageCode('en'),
    ]);
    expect(accepted, ['en', 'zh', 'en']);
    expect(preferences.languageCode, 'en');
    final restored = await PlayerPreferences.load(file: file);
    addTearDown(restored.dispose);
    expect(restored.languageCode, 'en');
    expect(await file.parent.list().length, 1);
  });

  test('memory mode validates choices and notifies only on change', () async {
    final preferences = PlayerPreferences.memory();
    addTearDown(preferences.dispose);
    expect(preferences.languageCode, 'zh');
    final accepted = <String>[];
    preferences.addListener(() => accepted.add(preferences.languageCode));
    await preferences.setLanguageCode('zh');
    await preferences.setLanguageCode('en');
    await preferences.setLanguageCode('en');
    expect(accepted, ['en']);
    expect(await file.exists(), isFalse);
    expect(
      () => PlayerPreferences.memory(languageCode: 'fr'),
      throwsA(isA<PlayerPreferencesException>()),
    );
  });

  test(
    'disposing during a queued save does not notify a disposed model',
    () async {
      final preferences = PlayerPreferences.memory();
      var notifications = 0;
      preferences.addListener(() => notifications++);
      final pending = preferences.setLanguageCode('en');
      preferences.dispose();
      await pending;
      expect(notifications, 0);
      await expectLater(
        preferences.setLanguageCode('zh'),
        throwsA(
          isA<PlayerPreferencesException>().having(
            (error) => error.code,
            'code',
            'ERR_PREFERENCES_DISPOSED',
          ),
        ),
      );
    },
  );
}

class _PreferencesPathProvider extends PathProviderPlatform {
  _PreferencesPathProvider(this.path);

  final String path;

  @override
  Future<String?> getApplicationSupportPath() async => path;
}

class _FailingPreferencesPathProvider extends PathProviderPlatform {
  _FailingPreferencesPathProvider(this.failure);

  final Object failure;

  @override
  Future<String?> getApplicationSupportPath() async => throw failure;
}
