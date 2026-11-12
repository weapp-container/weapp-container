import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/main.dart';
import 'package:weapp_container_dev_player/src/player_language_selector.dart';
import 'package:weapp_container_dev_player/src/player_localizations.dart';
import 'package:weapp_container_dev_player/src/player_preferences.dart';

class _SessionProbe extends StatefulWidget {
  const _SessionProbe({required this.preferences, required this.onCreate});
  final PlayerPreferences preferences;
  final VoidCallback onCreate;
  @override
  State<_SessionProbe> createState() => _SessionProbeState();
}

class _SessionProbeState extends State<_SessionProbe> {
  int count = 0;
  @override
  void initState() {
    super.initState();
    widget.onCreate();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        PlayerLanguageSelector(preferences: widget.preferences),
        Text(playerStrings(context).connectProject),
        Text(playerPhaseLabel(playerStrings(context), 'native-acknowledged')),
        Text(playerPresentationLabel(playerStrings(context), 'failed')),
        TextButton(
          onPressed: () => setState(() => count++),
          child: Text('guest count: $count'),
        ),
      ],
    ),
  );
}

Future<void> _choose(WidgetTester tester, String language) async {
  await tester.tap(find.byKey(const ValueKey('player-language')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(language).last);
  await tester.pumpAndSettle();
}

void main() {
  for (final language in ['zh', 'en']) {
    testWidgets(
      'language dialog fits a narrow screen with large text ($language)',
      (tester) async {
        tester.view.physicalSize = const Size(320, 740);
        tester.view.devicePixelRatio = 1;
        tester.binding.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(
          tester.binding.platformDispatcher.clearTextScaleFactorTestValue,
        );
        final preferences = PlayerPreferences.memory(languageCode: language);
        addTearDown(preferences.dispose);
        await tester.pumpWidget(
          DevPlayerApp(
            preferences: preferences,
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () =>
                      showPlayerLanguageDialog(context, preferences),
                  child: const Text('settings'),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('settings'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await _choose(tester, language == 'zh' ? 'English' : '简体中文');
        expect(preferences.languageCode, language == 'zh' ? 'en' : 'zh');
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'Chinese is default even on an English system; switching retains state',
    (tester) async {
      tester.binding.platformDispatcher.localeTestValue = const Locale('en');
      addTearDown(tester.binding.platformDispatcher.clearLocaleTestValue);
      final preferences = PlayerPreferences.memory();
      addTearDown(preferences.dispose);
      var creates = 0;
      await tester.pumpWidget(
        DevPlayerApp(
          preferences: preferences,
          home: _SessionProbe(
            preferences: preferences,
            onCreate: () => creates++,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('连接你的项目'), findsOneWidget);
      expect(find.text('原生帧已确认'), findsOneWidget);
      expect(find.text('呈现失败'), findsOneWidget);
      await tester.tap(find.text('guest count: 0'));
      await _choose(tester, 'English');
      expect(find.text('Connect your project'), findsOneWidget);
      expect(find.text('Native frame acknowledged'), findsOneWidget);
      expect(find.text('Presentation failed'), findsOneWidget);
      expect(find.text('guest count: 1'), findsOneWidget);
      expect(creates, 1);
      await _choose(tester, '简体中文');
      expect(find.text('连接你的项目'), findsOneWidget);
      expect(find.text('guest count: 1'), findsOneWidget);
      expect(creates, 1);
    },
  );

  testWidgets('chosen language is restored on a fresh app launch', (
    tester,
  ) async {
    final directory = (await tester.runAsync(
      () => Directory.systemTemp.createTemp('player-locale-'),
    ))!;
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/preferences.json');
    final preferences = (await tester.runAsync(
      () => PlayerPreferences.load(file: file),
    ))!;
    addTearDown(preferences.dispose);
    await tester.pumpWidget(
      DevPlayerApp(
        preferences: preferences,
        home: _SessionProbe(preferences: preferences, onCreate: () {}),
      ),
    );
    await tester.pumpAndSettle();
    // File IO completes outside the widget test's fake clock.
    await tester.runAsync(() => preferences.setLanguageCode('en'));
    await tester.pumpAndSettle();
    expect(find.text('Connect your project'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    final restored = await tester.runAsync(
      () => PlayerPreferences.load(file: file),
    );
    addTearDown(restored!.dispose);
    await tester.pumpWidget(
      DevPlayerApp(
        preferences: restored,
        home: _SessionProbe(preferences: restored, onCreate: () {}),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connect your project'), findsOneWidget);
  });

  testWidgets(
    'save failure keeps accepted locale and displays a translated error',
    (tester) async {
      final directory = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('player-locale-fail-'),
      ))!;
      addTearDown(() => directory.delete(recursive: true));
      final blocked = File('${directory.path}/not-a-directory');
      await tester.runAsync(() => blocked.writeAsString('unchanged'));
      final preferences = (await tester.runAsync(
        () => PlayerPreferences.load(
          file: File('${blocked.path}/preferences.json'),
        ),
      ))!;
      addTearDown(preferences.dispose);
      await tester.pumpWidget(
        DevPlayerApp(
          preferences: preferences,
          home: _SessionProbe(preferences: preferences, onCreate: () {}),
        ),
      );
      await tester.pumpAndSettle();
      final selector = tester.widget<DropdownButton<String>>(
        find.byKey(const ValueKey('player-language')),
      );
      await tester.runAsync(() async {
        selector.onChanged!('en');
        // Wait for the serialized preference operation to settle.
        await preferences.setLanguageCode('en').catchError((Object _) {});
      });
      await tester.pumpAndSettle();
      expect(preferences.languageCode, 'zh');
      expect(find.text('连接你的项目'), findsOneWidget);
      expect(find.text('无法保存语言设置，请重试。'), findsOneWidget);
    },
  );
}
