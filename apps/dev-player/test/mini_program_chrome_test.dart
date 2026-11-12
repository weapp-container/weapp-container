import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/mini_program_chrome.dart';

void main() {
  Future<void> size(WidgetTester tester, Size size) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    tester.view.padding = const FakeViewPadding(top: 30, bottom: 20);
    tester.view.viewPadding = const FakeViewPadding(top: 30, bottom: 20);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewPadding);
  }

  testWidgets(
    'normal navigation fills safe viewport and reports real capsule geometry',
    (tester) async {
      await size(tester, const Size(402, 874));
      final observations = <Map<String, Object?>>[];
      var more = 0, closed = 0, back = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({
                'title': '购物',
                'canGoBack': true,
              }),
              onGeometry: observations.add,
              onMore: () => more++,
              onClose: () => closed++,
              onBack: () => back++,
              onSwitchTab: (_) {},
              preview: (_, _) =>
                  const ColoredBox(key: ValueKey('content'), color: Colors.red),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byKey(const ValueKey('content'))),
        const Size(402, 776),
      );
      final rect = observations.single['menuButtonRect'] as Map;
      expect(rect['width'], 88);
      expect(rect['height'], 32);
      expect(rect['right'], 394);
      expect(rect['top'], 38);
      expect((observations.single['contentRect'] as Map)['top'], 78);
      await tester.tap(find.byTooltip('更多'));
      await tester.tap(find.byTooltip('关闭小程序'));
      await tester.tap(find.byTooltip('返回'));
      expect((more, closed, back), (1, 1, 1));
      expect(find.byType(AspectRatio), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'custom navigation overlays capsule without reserving a header or blocking page input',
    (tester) async {
      await size(tester, const Size(402, 874));
      var taps = 0;
      final observations = <Map<String, Object?>>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({
                'navigationStyle': 'custom',
                'title': 'Hidden',
              }),
              onGeometry: observations.add,
              onMore: () {},
              onClose: () {},
              onBack: () {},
              onSwitchTab: (_) {},
              preview: (_, _) => GestureDetector(
                key: const ValueKey('content'),
                behavior: HitTestBehavior.opaque,
                onTap: () => taps++,
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byKey(const ValueKey('content'))),
        const Size(402, 874),
      );
      expect((observations.single['contentRect'] as Map)['top'], 0);
      final capsule = observations.single['menuButtonRect'] as Map;
      expect(capsule['top'], 38);
      expect(capsule['bottom'], 70);
      expect(find.text('Hidden'), findsNothing);
      await tester.tapAt(const Offset(40, 48));
      expect(taps, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'custom and normal transitions apply the top safe inset exactly once',
    (tester) async {
      await size(tester, const Size(402, 874));
      final observations = <Map<String, Object?>>[];
      late StateSetter update;
      var custom = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return MiniProgramShell(
                  chrome: MiniProgramChrome({
                    'navigationStyle': custom ? 'custom' : 'default',
                  }),
                  onGeometry: observations.add,
                  onMore: () {},
                  onClose: () {},
                  onBack: () {},
                  onSwitchTab: (_) {},
                  preview: (_, _) =>
                      const SizedBox.expand(key: ValueKey('content')),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final normal = observations.single;
      expect((normal['contentRect'] as Map)['top'], 78);
      expect((normal['menuButtonRect'] as Map)['top'], 38);
      update(() => custom = true);
      await tester.pumpAndSettle();
      expect((observations.last['contentRect'] as Map)['top'], 0);
      expect((observations.last['contentRect'] as Map)['height'], 874);
      expect(observations.last['menuButtonRect'], normal['menuButtonRect']);
      update(() => custom = false);
      await tester.pumpAndSettle();
      expect(observations.last['contentRect'], normal['contentRect']);
      expect(observations.last['menuButtonRect'], normal['menuButtonRect']);
      expect(observations.length, 3);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'iOS custom capsule clears the status bar while content fills it',
    (tester) async {
      await size(tester, const Size(393, 852));
      tester.view.padding = const FakeViewPadding(top: 59, bottom: 34);
      tester.view.viewPadding = const FakeViewPadding(top: 59, bottom: 34);
      final observations = <Map<String, Object?>>[];
      EdgeInsets? contentSafeArea;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({'navigationStyle': 'custom'}),
              onGeometry: observations.add,
              onMore: () {},
              onClose: () {},
              onBack: () {},
              onSwitchTab: (_) {},
              preview: (_, _) => Builder(
                builder: (context) {
                  contentSafeArea = MediaQuery.paddingOf(context);
                  return const SizedBox.expand(key: ValueKey('content'));
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect((observations.single['contentRect'] as Map)['top'], 0);
      expect((observations.single['contentRect'] as Map)['height'], 852);
      expect((observations.single['menuButtonRect'] as Map)['top'], 65);
      expect(contentSafeArea?.top, 59);
      expect(contentSafeArea?.bottom, 34);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  testWidgets(
    'custom page fills the bottom safe area while developer overlays avoid it',
    (tester) async {
      await size(tester, const Size(402, 874));
      final observations = <Map<String, Object?>>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({'navigationStyle': 'custom'}),
              busy: true,
              diagnostic: 'Build failed; accepted page remains available.',
              onGeometry: observations.add,
              onMore: () {},
              onClose: () {},
              onBack: () {},
              onSwitchTab: (_) {},
              preview: (_, _) =>
                  const SizedBox.expand(key: ValueKey('content')),
            ),
          ),
        ),
      );
      await tester.pump();
      expect((observations.single['contentRect'] as Map)['top'], 0);
      expect((observations.single['contentRect'] as Map)['height'], 874);
      expect(
        tester.getBottomRight(find.byKey(const ValueKey('content'))).dy,
        874,
      );
      expect(
        tester
            .getBottomRight(
              find.byKey(const ValueKey('mini-program-diagnostic')),
            )
            .dy,
        846,
      );
      expect(
        tester.getBottomRight(find.byType(LinearProgressIndicator)).dy,
        854,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('custom system tab bar retains bottom-safe control layout', (
    tester,
  ) async {
    await size(tester, const Size(402, 874));
    final observations = <Map<String, Object?>>[];
    Map<String, Object?>? native;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MiniProgramShell(
            chrome: const MiniProgramChrome({
              'navigationStyle': 'custom',
              'tabBar': {
                'visible': true,
                'list': [
                  {'pagePath': 'pages/home', 'text': '首页'},
                ],
              },
            }),
            nativeOverlay: true,
            onGeometry: observations.add,
            onMore: () {},
            onClose: () {},
            onBack: () {},
            onSwitchTab: (_) {},
            preview: (_, chrome) {
              native = chrome;
              return const SizedBox.expand(key: ValueKey('content'));
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect((observations.single['contentRect'] as Map)['top'], 0);
    expect((observations.single['contentRect'] as Map)['height'], 802);
    expect((native!['tabBarRect'] as Map)['top'], 802);
    expect((native!['tabBarRect'] as Map)['height'], 52);
    expect(tester.takeException(), isNull);
  });

  for (final foreground in ['#ffffff', '#000000']) {
    testWidgets(
      'custom $foreground foreground has a contrasting translucent capsule independent of navigation background',
      (tester) async {
        await size(tester, const Size(402, 874));
        final chrome = MiniProgramChrome({
          'navigationStyle': 'custom',
          'frontColor': foreground,
          'backgroundColor': foreground,
        });
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: MiniProgramShell(
                chrome: chrome,
                onGeometry: (_) {},
                onMore: () {},
                onClose: () {},
                onBack: () {},
                onSwitchTab: (_) {},
                preview: (_, _) => ColoredBox(color: chrome.foregroundColor),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final backplate = tester.widget<DecoratedBox>(
          find.byWidgetPredicate(
            (widget) =>
                widget is DecoratedBox &&
                widget.decoration is BoxDecoration &&
                (widget.decoration as BoxDecoration).borderRadius ==
                    BorderRadius.circular(18),
          ),
        );
        final color = (backplate.decoration as BoxDecoration).color!;
        expect(color, chrome.capsuleBackgroundColor);
        expect(color.a, inExclusiveRange(0, 1));
        for (final pageBackground in [Colors.white, Colors.black]) {
          final luminance = Color.alphaBlend(
            color,
            pageBackground,
          ).computeLuminance();
          final foregroundLuminance = chrome.foregroundColor.computeLuminance();
          final lighter = luminance > foregroundLuminance
              ? luminance
              : foregroundLuminance;
          final darker = luminance < foregroundLuminance
              ? luminance
              : foregroundLuminance;
          expect((lighter + .05) / (darker + .05), greaterThanOrEqualTo(4.5));
        }
        final more = tester.widget<Icon>(
          find.descendant(
            of: find.byKey(const ValueKey('mini-program-more')),
            matching: find.byType(Icon),
          ),
        );
        expect(more.color, chrome.foregroundColor);
        expect(tester.takeException(), isNull);
      },
    );
  }

  test(
    'custom status bar is transparent and retains configured icon style',
    () {
      for (final (foreground, android, ios) in [
        ('#ffffff', Brightness.light, Brightness.dark),
        ('#000000', Brightness.dark, Brightness.light),
      ]) {
        final custom = MiniProgramChrome({
          'navigationStyle': 'custom',
          'frontColor': foreground,
          'backgroundColor': '#ffffff',
        }).systemUiOverlayStyle;
        expect(custom.statusBarColor, Colors.transparent);
        expect(custom.systemStatusBarContrastEnforced, false);
        expect(custom.statusBarIconBrightness, android);
        expect(custom.statusBarBrightness, ios);
        final normal = MiniProgramChrome({
          'frontColor': foreground,
          'backgroundColor': '#112233',
        });
        expect(
          normal.systemUiOverlayStyle.statusBarColor,
          const Color(0xff112233),
        );
        expect(
          normal.systemUiOverlayStyle.systemStatusBarContrastEnforced,
          isNull,
        );
        expect(normal.systemUiOverlayStyle.statusBarIconBrightness, android);
        expect(normal.systemUiOverlayStyle.statusBarBrightness, ios);
        expect(
          normal.capsuleBackgroundColor,
          const Color(0xff112233).withValues(alpha: .88),
        );
      }
    },
  );

  testWidgets(
    'tab selection delegates a route and dynamic chrome does not create a Flutter page stack',
    (tester) async {
      await size(tester, const Size(320, 568));
      String? switched;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({
                'title': '很长很长的页面标题 Long page title',
                'frontColor': '#ffffff',
                'backgroundColor': '#112233',
                'tabBar': {
                  'visible': true,
                  'selectedIndex': 0,
                  'list': [
                    {'pagePath': 'pages/home', 'text': '首页'},
                    {'pagePath': 'pages/me', 'text': '我的'},
                  ],
                },
              }),
              onGeometry: (_) {},
              onMore: () {},
              onClose: () {},
              onBack: () {},
              onSwitchTab: (route) => switched = route,
              preview: (_, _) =>
                  const SizedBox.expand(key: ValueKey('content')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mini-program-tab-1')));
      expect(switched, 'pages/me');
      expect(tester.getSize(find.byKey(const ValueKey('content'))).height, 418);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'diagnostic and build state preserve content size; rotation advances measured geometry',
    (tester) async {
      await size(tester, const Size(402, 874));
      final observations = <Map<String, Object?>>[];
      late StateSetter update;
      var busy = false;
      String? error;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return MiniProgramShell(
                  chrome: const MiniProgramChrome({}),
                  busy: busy,
                  diagnostic: error,
                  onGeometry: observations.add,
                  onMore: () {},
                  onClose: () {},
                  onBack: () {},
                  onSwitchTab: (_) {},
                  preview: (_, _) =>
                      const SizedBox.expand(key: ValueKey('content')),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final original = tester.getSize(find.byKey(const ValueKey('content')));
      update(() {
        busy = true;
        error = 'error\n' * 200;
      });
      await tester.pump();
      expect(tester.getSize(find.byKey(const ValueKey('content'))), original);
      expect(observations.length, 1);
      tester.view.physicalSize = const Size(874, 402);
      await tester.pump();
      await tester.pump();
      expect(observations.length, 2);
      expect(observations.last['revision'], 2);
      expect((observations.last['contentRect'] as Map)['width'], 874);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'each native observation receives geometry even when rectangles are unchanged',
    (tester) async {
      await size(tester, const Size(402, 874));
      final observations = <Map<String, Object?>>[];
      late StateSetter update;
      var observationId = '17';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return MiniProgramShell(
                  chrome: const MiniProgramChrome({}),
                  layoutObservationId: observationId,
                  onGeometry: observations.add,
                  onMore: () {},
                  onClose: () {},
                  onBack: () {},
                  onSwitchTab: (_) {},
                  preview: (_, _) => const SizedBox.expand(),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(observations.single['observationId'], '17');
      final rect = observations.single['contentRect'];
      update(() => observationId = '18');
      await tester.pumpAndSettle();
      expect(observations.length, 2);
      expect(observations.last['observationId'], '18');
      expect(observations.last['contentRect'], rect);
      expect(observations.last['revision'], 2);
      update(() {});
      await tester.pumpAndSettle();
      expect(observations.length, 2);
    },
  );

  testWidgets(
    'accepted startup and title metadata do not consume the same layout observation twice',
    (tester) async {
      await size(tester, const Size(320, 533));
      final observations = <Map<String, Object?>>[];
      late StateSetter update;
      var chrome = <String, Object?>{'title': 'Before launch'};
      String observation = '2';
      Map<String, Object?>? native;
      Map<String, Object?>? host;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return MiniProgramShell(
                  chrome: MiniProgramChrome(chrome),
                  layoutObservationId: observation,
                  initialGeometryRevision: 2,
                  nativeOverlay: true,
                  onGeometry: observations.add,
                  onMore: () {},
                  onClose: () {},
                  onBack: () {},
                  onSwitchTab: (_) {},
                  preview: (geometry, metadata) {
                    host = geometry;
                    native = metadata;
                    return const SizedBox.expand();
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final accepted = observations.single;
      expect(accepted['revision'], 3);
      update(() {
        chrome = {
          ...chrome,
          'schemaVersion': 1,
          'sessionId': 'newly-loaded-session',
          'revision': 900,
          'page': {'id': 1, 'route': 'pages/home/index'},
          'stack': [
            {'id': 1, 'route': 'pages/home/index'},
          ],
        };
      });
      await tester.pumpAndSettle();
      expect(observations, hasLength(1));
      expect(host, accepted);
      expect((native!['chrome'] as Map)['sessionId'], 'newly-loaded-session');
      update(() {
        chrome = {
          ...chrome,
          'title': 'Updated title',
          'backgroundColor': '#112233',
          'frontColor': '#ffffff',
          'revision': 901,
        };
      });
      await tester.pumpAndSettle();
      expect(find.text('Updated title'), findsNothing);
      expect(observations, hasLength(1));
      expect(host!['revision'], 3);
      expect((native!['chrome'] as Map)['title'], 'Updated title');
      expect(native!['revision'], 3);
      update(() => observation = '3');
      await tester.pumpAndSettle();
      expect(observations, hasLength(2));
      expect(observations.last['observationId'], '3');
      expect(observations.last['revision'], 4);
      expect(observations.last['contentRect'], accepted['contentRect']);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'desktop preview fills the window and delegates native overlay geometry',
    (tester) async {
      await size(tester, const Size(1440, 900));
      final observations = <Map<String, Object?>>[];
      Map<String, Object?>? native;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MiniProgramShell(
              chrome: const MiniProgramChrome({
                'sessionId': 'session',
                'page': {'id': 7, 'route': 'pages/home'},
                'title': 'Native title',
              }),
              nativeOverlay: true,
              onGeometry: observations.add,
              onMore: () {},
              onClose: () {},
              onBack: () {},
              onSwitchTab: (_) {},
              preview: (_, chrome) {
                native = chrome;
                return const SizedBox.expand(key: ValueKey('content'));
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byKey(const ValueKey('content'))).width, 1440);
      expect(observations.single['sessionId'], 'session');
      expect(observations.single['pageId'], 7);
      expect((native!['toolbarRect'] as Map)['width'], 1440);
      expect(((native!['chrome'] as Map)['page'] as Map)['id'], 7);
      expect(find.text('Native title'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'large text retains capsule hit areas and ellipsizes a long title',
    (tester) async {
      await size(tester, const Size(320, 568));
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(2)),
            child: Scaffold(
              body: MiniProgramShell(
                chrome: const MiniProgramChrome({
                  'title': '很长的小程序页面标题 — Long page title',
                }),
                onGeometry: (_) {},
                onMore: () {},
                onClose: () {},
                onBack: () {},
                onSwitchTab: (_) {},
                preview: (_, _) => const SizedBox.expand(),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byKey(const ValueKey('mini-program-more'))).height,
        44,
      );
      final title = tester.widget<Text>(
        find.text('很长的小程序页面标题 — Long page title'),
      );
      expect(title.overflow, TextOverflow.ellipsis);
      expect(find.byTooltip('关闭小程序').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'dynamic tab indicators and style repaint without changing page geometry',
    (tester) async {
      await size(tester, const Size(360, 640));
      String? switched;
      final observations = <Map<String, Object?>>[];
      Future<void> show(bool indicators, String border) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: MiniProgramShell(
                chrome: MiniProgramChrome({
                  'tabBar': {
                    'visible': true,
                    'selectedIndex': 0,
                    'color': '#112233',
                    'selectedColor': '#445566',
                    'backgroundColor': '#ddeeff',
                    'borderStyle': border,
                    'list': [
                      {
                        'pagePath': 'home',
                        'text': 'Home',
                        if (indicators) 'badgeText': '...',
                      },
                      {
                        'pagePath': 'other',
                        'text': 'Other',
                        if (indicators) 'redDot': true,
                      },
                    ],
                  },
                }),
                onGeometry: observations.add,
                onMore: () {},
                onClose: () {},
                onBack: () {},
                onSwitchTab: (route) => switched = route,
                preview: (_, _) =>
                    const SizedBox.expand(key: ValueKey('dynamic-content')),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await show(true, 'white');
      final before = tester.getRect(
        find.byKey(const ValueKey('dynamic-content')),
      );
      expect(
        find.byKey(const ValueKey('mini-program-tab-badge-0')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('mini-program-tab-dot-1')),
        findsOneWidget,
      );
      expect(find.text('...'), findsOneWidget);
      expect(
        tester.widget<Text>(find.text('Home')).style!.color,
        const Color(0xff445566),
      );
      expect(
        tester.widget<Text>(find.text('Other')).style!.color,
        const Color(0xff112233),
      );
      final decorated = find
          .ancestor(
            of: find.byKey(const ValueKey('mini-program-tab-0')),
            matching: find.byType(DecoratedBox),
          )
          .first;
      var decoration =
          tester.widget<DecoratedBox>(decorated).decoration as BoxDecoration;
      expect(decoration.color, const Color(0xffddeeff));
      expect((decoration.border as Border).top.color, Colors.white);
      await tester.tap(find.byKey(const ValueKey('mini-program-tab-1')));
      expect(switched, 'other');
      await show(false, 'black');
      expect(
        find.byKey(const ValueKey('mini-program-tab-badge-0')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('mini-program-tab-dot-1')),
        findsNothing,
      );
      expect(
        tester.getRect(find.byKey(const ValueKey('dynamic-content'))),
        before,
      );
      decoration =
          tester.widget<DecoratedBox>(decorated).decoration as BoxDecoration;
      expect((decoration.border as Border).top.color, Colors.black);
      expect(tester.takeException(), isNull);
    },
  );
}
