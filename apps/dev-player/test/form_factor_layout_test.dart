import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/l10n/app_localizations.dart';
import 'package:weapp_container_dev_player/src/mini_program_chrome.dart';
import 'package:weapp_container_dev_player/src/player_language_selector.dart';
import 'package:weapp_container_dev_player/src/player_preferences.dart';
import 'package:weapp_container_dev_player/src/tab_icons.dart';

// These are logical layout boundary tests, not Android/iOS Simulator, native
// renderer, hinge/posture, runtime onResize, GPU or physical-device evidence.
class _Profile {
  const _Profile(this.name, this.size, this.platform, this.dpr, this.insets);

  final String name;
  final Size size;
  final TargetPlatform platform;
  final double dpr;
  final EdgeInsets insets;

  EdgeInsets padding(bool landscape) =>
      landscape && platform == TargetPlatform.iOS
      ? const EdgeInsets.fromLTRB(44, 0, 44, 21)
      : insets;
}

const _profiles = [
  _Profile(
    'small phone',
    Size(320, 568),
    TargetPlatform.android,
    1,
    EdgeInsets.only(top: 24, bottom: 24),
  ),
  _Profile(
    'standard Android',
    Size(360, 800),
    TargetPlatform.android,
    3,
    EdgeInsets.only(top: 24, bottom: 24),
  ),
  _Profile(
    'notched phone',
    Size(375, 812),
    TargetPlatform.iOS,
    3,
    EdgeInsets.only(top: 44, bottom: 34),
  ),
  _Profile(
    'large phone',
    Size(412, 915),
    TargetPlatform.android,
    2.625,
    EdgeInsets.only(top: 32, bottom: 24),
  ),
  _Profile(
    'compact tablet',
    Size(600, 960),
    TargetPlatform.android,
    2,
    EdgeInsets.only(top: 24, bottom: 24),
  ),
  _Profile(
    'mini tablet',
    Size(768, 1024),
    TargetPlatform.iOS,
    2,
    EdgeInsets.only(top: 24, bottom: 20),
  ),
  _Profile(
    'large tablet',
    Size(1024, 1366),
    TargetPlatform.iOS,
    2,
    EdgeInsets.only(top: 24, bottom: 20),
  ),
  _Profile(
    'foldable cover',
    Size(344, 882),
    TargetPlatform.android,
    2.75,
    EdgeInsets.only(top: 24, bottom: 24),
  ),
  _Profile(
    'foldable expanded',
    Size(673, 841),
    TargetPlatform.android,
    2.75,
    EdgeInsets.only(top: 24, bottom: 24),
  ),
];

class _InputProbe extends StatefulWidget {
  const _InputProbe({super.key});

  @override
  State<_InputProbe> createState() => _InputProbeState();
}

class _InputProbeState extends State<_InputProbe> {
  final positions = <Offset>[];

  @override
  Widget build(BuildContext context) => GestureDetector(
    behavior: HitTestBehavior.opaque,
    onTapDown: (event) => positions.add(event.localPosition),
    child: const ColoredBox(color: Color(0xffe6f4ed)),
  );
}

Widget _localized(Locale locale, Widget child) => MaterialApp(
  locale: locale,
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

void _configure(WidgetTester tester, _Profile profile, bool landscape) {
  final size = landscape ? profile.size.flipped : profile.size;
  final padding = profile.padding(landscape);
  tester.view.devicePixelRatio = profile.dpr;
  tester.view.physicalSize = size * profile.dpr;
  final physicalPadding = FakeViewPadding(
    left: padding.left * profile.dpr,
    top: padding.top * profile.dpr,
    right: padding.right * profile.dpr,
    bottom: padding.bottom * profile.dpr,
  );
  tester.view.padding = physicalPadding;
  tester.view.viewPadding = physicalPadding;
}

void _resetView(WidgetTester tester) {
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetPadding);
  addTearDown(tester.view.resetViewPadding);
  addTearDown(tester.binding.platformDispatcher.clearTextScaleFactorTestValue);
}

Rect _rect(Map<dynamic, dynamic> value) => Rect.fromLTWH(
  (value['left'] as num).toDouble(),
  (value['top'] as num).toDouble(),
  (value['width'] as num).toDouble(),
  (value['height'] as num).toDouble(),
);

void _inside(Rect actual, Rect container, String reason) {
  expect(
    actual.left,
    greaterThanOrEqualTo(container.left - .01),
    reason: reason,
  );
  expect(actual.top, greaterThanOrEqualTo(container.top - .01), reason: reason);
  expect(
    actual.right,
    lessThanOrEqualTo(container.right + .01),
    reason: reason,
  );
  expect(
    actual.bottom,
    lessThanOrEqualTo(container.bottom + .01),
    reason: reason,
  );
}

void main() {
  for (final profile in _profiles) {
    testWidgets(
      '${profile.name}: normal chrome, safe areas and local input remain consistent',
      (tester) async {
        _resetView(tester);
        final geometry = <Map<String, Object?>>[];
        final navigations = <String>[];
        var more = 0, close = 0, back = 0;
        Widget shell() => MiniProgramShell(
          key: const ValueKey('form-factor-shell'),
          chrome: const MiniProgramChrome({
            'title': 'Guest 标题 / A long project-owned navigation title',
            'canGoBack': true,
            'tabBar': {
              'visible': true,
              'selectedIndex': 0,
              'list': [
                {'pagePath': 'pages/home', 'text': 'Guest 首页'},
                {'pagePath': 'pages/settings', 'text': 'Guest Settings 设置'},
              ],
            },
          }),
          onGeometry: geometry.add,
          onMore: () => more++,
          onClose: () => close++,
          onBack: () => back++,
          onSwitchTab: navigations.add,
          preview: (_, _) => const _InputProbe(key: ValueKey('guest-input')),
        );

        for (final landscape in [false, true]) {
          _configure(tester, profile, landscape);
          final size = landscape ? profile.size.flipped : profile.size;
          final padding = profile.padding(landscape);
          final safe = Rect.fromLTRB(
            padding.left,
            padding.top,
            size.width - padding.right,
            size.height - padding.bottom,
          );
          for (final scale in [1.0, 2.0]) {
            tester.binding.platformDispatcher.textScaleFactorTestValue = scale;
            await tester.pumpWidget(_localized(const Locale('zh'), shell()));
            await tester.pumpAndSettle();
            final observation = geometry.last;
            final revisionCount = geometry.length;
            final content = _rect(observation['contentRect'] as Map);
            final capsule = _rect(observation['menuButtonRect'] as Map);
            final actualContent = tester.getRect(
              find.byKey(const ValueKey('guest-input')),
            );
            expect(actualContent, content);
            expect(content.width, closeTo(safe.width, .01));
            expect(content.left, closeTo(safe.left, .01));
            _inside(
              content,
              safe,
              'native content stays inside the safe viewport',
            );
            _inside(capsule, safe, 'capsule stays inside the safe viewport');
            final tabs = tester.getRect(
              find.byKey(const ValueKey('mini-program-tab-1')),
            );
            _inside(tabs, safe, 'tabs stay above the bottom safe inset');
            expect(tabs.top, closeTo(content.bottom, .01));
            expect(tabs.bottom, closeTo(safe.bottom, .01));
            _inside(
              tester.getRect(find.byKey(const ValueKey('mini-program-back'))),
              safe,
              'back button stays inside safe navigation',
            );

            final probe = tester.state<_InputProbeState>(
              find.byKey(const ValueKey('guest-input')),
            );
            final localPoint = const Offset(35, 30);
            await tester.tapAt(content.topLeft + localPoint);
            expect(probe.positions.last.dx, closeTo(localPoint.dx, .01));
            expect(probe.positions.last.dy, closeTo(localPoint.dy, .01));
            final inputCount = probe.positions.length;
            final beforeActions = (more, close, back, navigations.length);
            await tester.tap(find.byKey(const ValueKey('mini-program-more')));
            await tester.tap(find.byKey(const ValueKey('mini-program-close')));
            await tester.tap(find.byKey(const ValueKey('mini-program-back')));
            await tester.tap(find.byKey(const ValueKey('mini-program-tab-1')));
            await tester.pumpAndSettle();
            expect(
              (more, close, back, navigations.length),
              (
                beforeActions.$1 + 1,
                beforeActions.$2 + 1,
                beforeActions.$3 + 1,
                beforeActions.$4 + 1,
              ),
            );
            expect(navigations.last, 'pages/settings');
            expect(
              probe.positions.length,
              inputCount,
              reason:
                  'host controls must not leak input into guest coordinates',
            );

            await tester.pumpWidget(_localized(const Locale('en'), shell()));
            await tester.pumpAndSettle();
            expect(
              geometry.length,
              revisionCount,
              reason: 'UI language cannot create a guest layout revision',
            );
            expect(geometry.last, observation);
            expect(
              tester.state(find.byKey(const ValueKey('guest-input'))),
              same(probe),
            );
            expect(find.byTooltip('More'), findsOneWidget);
            expect(find.text('Guest 首页'), findsOneWidget);
            expect(tester.takeException(), isNull);
          }
        }
      },
      variant: TargetPlatformVariant.only(profile.platform),
    );
  }

  testWidgets(
    'custom fold-width and rotation transitions preserve screen-relative input',
    (tester) async {
      _resetView(tester);
      final geometry = <Map<String, Object?>>[];
      Widget shell() => MiniProgramShell(
        chrome: const MiniProgramChrome({'navigationStyle': 'custom'}),
        onGeometry: geometry.add,
        onMore: () {},
        onClose: () {},
        onBack: () {},
        onSwitchTab: (_) {},
        preview: (_, _) => const _InputProbe(key: ValueKey('custom-input')),
      );
      for (final (profile, landscape) in [
        (_profiles[7], false),
        (_profiles[8], false),
        (_profiles[8], true),
        (_profiles[7], false),
      ]) {
        _configure(tester, profile, landscape);
        await tester.pumpWidget(_localized(const Locale('zh'), shell()));
        await tester.pumpAndSettle();
        final size = landscape ? profile.size.flipped : profile.size;
        final content = _rect(geometry.last['contentRect'] as Map);
        expect(
          content,
          Offset.zero & size,
          reason:
              'custom navigation renders behind top/bottom system areas once',
        );
        final padding = profile.padding(landscape);
        _inside(
          _rect(geometry.last['menuButtonRect'] as Map),
          Rect.fromLTRB(
            padding.left,
            padding.top,
            size.width - padding.right,
            size.height - padding.bottom,
          ),
          'custom capsule avoids system areas',
        );
        final revision = geometry.last['revision'];
        final probe = tester.state<_InputProbeState>(
          find.byKey(const ValueKey('custom-input')),
        );
        await tester.tapAt(const Offset(24, 100));
        expect(probe.positions.last, const Offset(24, 100));
        await tester.pumpWidget(_localized(const Locale('en'), shell()));
        await tester.pumpAndSettle();
        expect(geometry.last['revision'], revision);
        expect(
          tester.state(find.byKey(const ValueKey('custom-input'))),
          same(probe),
        );
        expect(tester.takeException(), isNull);
      }
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  for (final profile in [_profiles.first, _profiles[6], _profiles[7]]) {
    testWidgets(
      '${profile.name}: language dialog fits portrait and short landscape',
      (tester) async {
        _resetView(tester);
        final preferences = PlayerPreferences.memory();
        addTearDown(preferences.dispose);
        for (final landscape in [false, true]) {
          _configure(tester, profile, landscape);
          for (final scale in [1.0, 2.0]) {
            tester.binding.platformDispatcher.textScaleFactorTestValue = scale;
            await tester.pumpWidget(
              ListenableBuilder(
                listenable: preferences,
                builder: (_, _) => _localized(
                  preferences.locale,
                  Builder(
                    builder: (context) => Center(
                      child: IconButton(
                        tooltip: 'language settings',
                        icon: const Icon(Icons.language),
                        onPressed: () =>
                            showPlayerLanguageDialog(context, preferences),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            await tester.tap(find.byTooltip('language settings'));
            await tester.pumpAndSettle();
            final dialog = find.byType(AlertDialog);
            expect(dialog, findsOneWidget);
            final size = landscape ? profile.size.flipped : profile.size;
            _inside(
              tester.getRect(dialog),
              Offset.zero & size,
              'language dialog stays in the current logical viewport',
            );
            for (final target in ['en', 'zh']) {
              await tester.tap(find.byKey(const ValueKey('player-language')));
              await tester.pumpAndSettle();
              await tester.tap(
                find.text(target == 'en' ? 'English' : '简体中文').last,
              );
              await tester.pumpAndSettle();
              expect(preferences.languageCode, target);
              expect(tester.takeException(), isNull);
            }
            Navigator.of(tester.element(dialog)).pop();
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
          }
        }
      },
      variant: TargetPlatformVariant.only(profile.platform),
    );
  }

  testWidgets('icon tab labels remain within the tab control at 2x text size', (
    tester,
  ) async {
    _resetView(tester);
    _configure(tester, _profiles.first, false);
    tester.binding.platformDispatcher.textScaleFactorTestValue = 2;
    final png = Uint8List.fromList(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
    );
    await tester.pumpWidget(
      _localized(
        const Locale('zh'),
        MiniProgramShell(
          chrome: const MiniProgramChrome({
            'title': 'Icon tabs',
            'tabBar': {
              'visible': true,
              'selectedIndex': 0,
              'list': [
                {
                  'pagePath': 'pages/home',
                  'text': '首页 Home',
                  'iconPath': 'tab.png',
                },
                {
                  'pagePath': 'pages/settings',
                  'text': 'Settings 设置',
                  'iconPath': 'tab.png',
                },
              ],
            },
          }),
          icons: TabIconCatalog({
            'tab.png': VerifiedTabIcon(
              'tab.png',
              'test-icon',
              'image/png',
              png,
            ),
          }),
          onGeometry: (_) {},
          onMore: () {},
          onClose: () {},
          onBack: () {},
          onSwitchTab: (_) {},
          preview: (_, _) => const SizedBox.expand(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester.takeException(),
      isNull,
      reason: 'text scaling plus an icon must not overflow the tab bar',
    );
  });

  testWidgets(
    'accessible navigation titles keep their full line height and guest origin',
    (tester) async {
      _resetView(tester);
      final semantics = tester.ensureSemantics();
      const compactIos = _Profile(
        'iPhone SE logical viewport',
        Size(375, 667),
        TargetPlatform.iOS,
        2,
        EdgeInsets.only(top: 20),
      );
      final geometry = <Map<String, Object?>>[];
      try {
        for (final profile in [compactIos, _profiles[2]]) {
          for (final landscape in [false, true]) {
            _configure(tester, profile, landscape);
            for (final scale in [3.2, 3.4]) {
              tester.binding.platformDispatcher.textScaleFactorTestValue =
                  scale;
              for (final title in ['小程序页面', 'Guest navigation title']) {
                await tester.pumpWidget(
                  _localized(
                    const Locale('zh'),
                    MiniProgramShell(
                      chrome: MiniProgramChrome({
                        'title': title,
                        'canGoBack': true,
                      }),
                      onGeometry: geometry.add,
                      onMore: () {},
                      onClose: () {},
                      onBack: () {},
                      onSwitchTab: (_) {},
                      preview: (_, _) =>
                          const _InputProbe(key: ValueKey('large-title-input')),
                    ),
                  ),
                );
                await tester.pumpAndSettle();
                final titleFinder = find.text(title);
                expect(titleFinder, findsOneWidget);
                expect(
                  tester.getSemantics(titleFinder).label,
                  title,
                  reason: 'guest-owned title remains complete in accessibility',
                );
                final paragraph = tester.renderObject<RenderParagraph>(
                  find.descendant(
                    of: titleFinder,
                    matching: find.byType(RichText),
                  ),
                );
                final painter = TextPainter(
                  text: paragraph.text,
                  textAlign: paragraph.textAlign,
                  textDirection: paragraph.textDirection,
                  textScaler: paragraph.textScaler,
                  locale: paragraph.locale,
                  maxLines: 1,
                  ellipsis: '…',
                  strutStyle: paragraph.strutStyle,
                  textWidthBasis: paragraph.textWidthBasis,
                  textHeightBehavior: paragraph.textHeightBehavior,
                )..layout(maxWidth: paragraph.size.width);
                final requiredHeight = painter.height;
                painter.dispose();
                expect(
                  paragraph.size.height,
                  greaterThanOrEqualTo(requiredHeight - .01),
                  reason: 'single-line glyph metrics must not be squeezed into the fixed normal navigation height',
                );
                final content = _rect(geometry.last['contentRect'] as Map);
                final native = tester.widget<MiniProgramShell>(
                  find.byType(MiniProgramShell),
                );
                expect(native.chrome.title, title);
                final inset = profile.padding(landscape);
                final viewport = landscape
                    ? profile.size.flipped
                    : profile.size;
                final toolbar = Rect.fromLTRB(
                  inset.left,
                  inset.top,
                  viewport.width - inset.right,
                  content.top,
                );
                final lineOrigin = paragraph.localToGlobal(Offset.zero);
                _inside(
                  Rect.fromLTWH(
                    lineOrigin.dx,
                    lineOrigin.dy,
                    paragraph.size.width,
                    requiredHeight,
                  ),
                  toolbar,
                  'the complete painted line must stay within measured navigation',
                );
                expect(
                  content,
                  tester.getRect(
                    find.byKey(const ValueKey('large-title-input')),
                  ),
                  reason: 'host geometry includes the expanded navigation once',
                );
                final point = const Offset(24, 30);
                await tester.tapAt(content.topLeft + point);
                final probe = tester.state<_InputProbeState>(
                  find.byKey(const ValueKey('large-title-input')),
                );
                expect(probe.positions.last, point);
                expect(tester.takeException(), isNull);
              }
            }
          }
        }
      } finally {
        semantics.dispose();
      }
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );
}
