import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/l10n/app_localizations.dart';
import 'package:weapp_container_dev_player/src/mini_program_chrome.dart';
import 'package:weapp_container_dev_player/src/player_workspace.dart';
import 'package:weapp_container_dev_player/src/preview_stage.dart';

class _PreviewProbe extends StatefulWidget {
  const _PreviewProbe({super.key});

  @override
  State<_PreviewProbe> createState() => _PreviewProbeState();
}

class _PreviewProbeState extends State<_PreviewProbe> {
  var taps = 0;

  @override
  Widget build(BuildContext context) => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onTap: () => setState(() => taps++),
    child: Center(child: Text('guest count: $taps')),
  );
}

Widget _localized(Locale locale, Widget child) => MaterialApp(
  locale: locale,
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

void main() {
  testWidgets(
    'language changes localize host controls without remounting or resizing the guest',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(402, 874);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final geometry = <Map<String, Object?>>[];
      Widget shell() => MiniProgramShell(
        chrome: const MiniProgramChrome({
          'title': 'Guest 页面 title',
          'canGoBack': true,
          'tabBar': {
            'visible': true,
            'selectedIndex': 0,
            'list': [
              {'pagePath': 'pages/home', 'text': 'Guest 首页'},
            ],
          },
        }),
        onGeometry: geometry.add,
        onMore: () {},
        onClose: () {},
        onBack: () {},
        onSwitchTab: (_) {},
        preview: (_, _) => const _PreviewProbe(key: ValueKey('guest')),
      );

      await tester.pumpWidget(_localized(const Locale('zh'), shell()));
      await tester.pumpAndSettle();
      expect(find.byTooltip('更多'), findsOneWidget);
      expect(find.byTooltip('关闭小程序'), findsOneWidget);
      expect(find.byTooltip('返回'), findsOneWidget);
      final guest = tester.state<_PreviewProbeState>(
        find.byKey(const ValueKey('guest')),
      );
      await tester.tap(find.byKey(const ValueKey('guest')));
      await tester.pump();
      final previousGeometry = Map<String, Object?>.from(geometry.single);

      await tester.pumpWidget(_localized(const Locale('en'), shell()));
      await tester.pumpAndSettle();
      final strings = AppLocalizations.of(
        tester.element(find.byType(MiniProgramShell)),
      )!;
      expect(find.byTooltip(strings.more), findsOneWidget);
      expect(find.byTooltip(strings.closeMiniProgram), findsOneWidget);
      expect(find.byTooltip(strings.back), findsOneWidget);
      expect(find.byTooltip('更多'), findsNothing);
      expect(find.text('Guest 页面 title'), findsOneWidget);
      expect(find.text('Guest 首页'), findsOneWidget);
      expect(find.text('guest count: 1'), findsOneWidget);
      expect(tester.state(find.byKey(const ValueKey('guest'))), same(guest));
      expect(geometry, [previousGeometry]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('only missing guest titles use the localized host fallback', (
    tester,
  ) async {
    Widget shell(Map<String, Object?> snapshot) => MiniProgramShell(
      chrome: MiniProgramChrome(snapshot),
      onGeometry: (_) {},
      onMore: () {},
      onClose: () {},
      onBack: () {},
      onSwitchTab: (_) {},
      preview: (_, _) => const SizedBox.expand(),
    );
    await tester.pumpWidget(_localized(const Locale('zh'), shell({})));
    await tester.pumpAndSettle();
    expect(find.text('小程序'), findsOneWidget);

    await tester.pumpWidget(_localized(const Locale('en'), shell({})));
    await tester.pumpAndSettle();
    final english = AppLocalizations.of(
      tester.element(find.byType(MiniProgramShell)),
    )!.miniProgram;
    expect(find.text(english), findsOneWidget);
    expect(find.text('小程序'), findsNothing);

    await tester.pumpWidget(
      _localized(const Locale('en'), shell({'title': ''})),
    );
    await tester.pumpAndSettle();
    expect(find.text(english), findsNothing);
    expect(find.text(''), findsOneWidget);
    expect(const MiniProgramChrome({}).title, '小程序');
    expect(const MiniProgramChrome({'title': ''}).title, '');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'native control labels change without advancing layout revision',
    (tester) async {
      final geometry = <Map<String, Object?>>[];
      Map<String, Object?>? native;
      Widget shell() => MiniProgramShell(
        chrome: const MiniProgramChrome({
          'title': 'Guest title',
          'canGoBack': true,
        }),
        nativeOverlay: true,
        onGeometry: geometry.add,
        onMore: () {},
        onClose: () {},
        onBack: () {},
        onSwitchTab: (_) {},
        preview: (_, descriptor) {
          native = descriptor;
          return const _PreviewProbe(key: ValueKey('native-guest'));
        },
      );
      await tester.pumpWidget(_localized(const Locale('zh'), shell()));
      await tester.pumpAndSettle();
      final previous = Map<String, Object?>.from(native!);
      expect(native!['accessibilityLabels'], {
        'more': '更多',
        'close': '关闭小程序',
        'back': '返回',
        'navigation': '小程序导航',
        'tabs': '小程序标签栏',
      });
      final guest = tester.state(find.byKey(const ValueKey('native-guest')));

      await tester.pumpWidget(_localized(const Locale('en'), shell()));
      await tester.pumpAndSettle();
      expect(native!['accessibilityLabels'], {
        'more': 'More',
        'close': 'Close mini program',
        'back': 'Back',
        'navigation': 'Mini program navigation',
        'tabs': 'Mini program tabs',
      });
      expect(native!['revision'], previous['revision']);
      expect(native!['toolbarRect'], previous['toolbarRect']);
      expect(native!['menuButtonRect'], previous['menuButtonRect']);
      expect(native!['chrome'], previous['chrome']);
      expect(geometry, hasLength(1));
      expect(
        tester.state(find.byKey(const ValueKey('native-guest'))),
        same(guest),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('diagnostic labels translate while raw technical text remains', (
    tester,
  ) async {
    const message = 'ERR_ENGINE at pages/home/index.js:8\n原始错误';
    Widget details() => Column(
      children: [
        PlayerDiagnosticBanner(message: message, onDetails: () {}),
        const PlayerDiagnosticDetails(message: message),
      ],
    );
    for (final locale in [const Locale('zh'), const Locale('en')]) {
      await tester.pumpWidget(_localized(locale, details()));
      await tester.pumpAndSettle();
      final strings = AppLocalizations.of(
        tester.element(find.byType(PlayerDiagnosticDetails)),
      )!;
      expect(find.byTooltip(strings.diagnosticDetails), findsOneWidget);
      expect(find.text(strings.latestDiagnostic), findsOneWidget);
      expect(
        tester
            .widget<SelectableText>(
              find.byKey(const ValueKey('diagnostic-details-text')),
            )
            .data,
        message,
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('loading overlay uses the selected language', (tester) async {
    for (final locale in [const Locale('zh'), const Locale('en')]) {
      await tester.pumpWidget(
        _localized(
          locale,
          const PlayerPreviewStage(candidate: SizedBox.expand()),
        ),
      );
      await tester.pumpAndSettle();
      final strings = AppLocalizations.of(
        tester.element(find.byType(PlayerPreviewStage)),
      )!;
      expect(find.text(strings.preparingNativePreview), findsOneWidget);
      expect(
        find.byKey(const ValueKey('native-preview-loading-cover')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    }
  });

  for (final width in [320.0, 402.0]) {
    testWidgets('workspace labels use the selected language at width $width', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 874);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      for (final locale in [const Locale('zh'), const Locale('en')]) {
        await tester.pumpWidget(
          _localized(
            locale,
            PlayerWorkspace(
              diagnostic: null,
              busy: false,
              toolsVisible: false,
              onToolsChanged: (_) {},
              onDiagnosticDetails: () {},
              tools: const SizedBox.expand(),
              preview: (_) => const SizedBox.expand(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final strings = AppLocalizations.of(
          tester.element(find.byType(PlayerWorkspace)),
        )!;
        expect(find.text(strings.preview), findsOneWidget);
        expect(
          find.text(width < 360 ? strings.tools : strings.toolsAndConsole),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      }
    });
  }
}
