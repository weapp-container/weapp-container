import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/player_workspace.dart';

String longDiagnostic() => [
  'Build: SyntaxError: Unexpected token in pages/home/index.js (7:20)',
  for (var i = 0; i < 200; i++)
    '    at BabelParser.parseExpression (node_modules/@babel/parser/lib/index.js:${1000 + i}:17)',
  'END OF COMPLETE DIAGNOSTIC <script>plain text only</script>',
].join('\n');

void main() {
  for (final size in [const Size(402, 874), const Size(320, 568)]) {
    testWidgets(
      'long build diagnostics preserve usable preview and tools at $size',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        final diagnostic = longDiagnostic();
        var toolsVisible = false;
        var previewTaps = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: StatefulBuilder(
              builder: (context, update) => Scaffold(
                appBar: AppBar(title: const Text('Weapp Container')),
                body: PlayerWorkspace(
                  diagnostic: diagnostic,
                  busy: true,
                  toolsVisible: toolsVisible,
                  onToolsChanged: (value) => update(() => toolsVisible = value),
                  onDiagnosticDetails: () => update(() => toolsVisible = true),
                  tools: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [PlayerDiagnosticDetails(message: diagnostic)],
                  ),
                  preview: (covered) => IgnorePointer(
                    ignoring: covered,
                    child: GestureDetector(
                      key: const ValueKey('preview-frame'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () => previewTaps++,
                      child: const Center(child: Text('Native preview')),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        expect(
          tester.getSize(find.byType(PlayerDiagnosticBanner)).height,
          lessThanOrEqualTo(128),
        );
        expect(
          tester.getSize(find.byKey(const ValueKey('preview-frame'))).height,
          greaterThan(200),
        );
        expect(
          find.byKey(const ValueKey('preview-tab')).hitTestable(),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('tools-tab')).hitTestable(),
          findsOneWidget,
        );
        final summary = tester.widget<Text>(
          find.byKey(const ValueKey('diagnostic-summary')),
        );
        expect(summary.maxLines, 3);
        expect(summary.overflow, TextOverflow.ellipsis);

        await tester.tap(find.byTooltip('诊断详情'));
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(toolsVisible, true);
        final detail = tester.widget<SelectableText>(
          find.byKey(const ValueKey('diagnostic-details-text')),
        );
        expect(
          detail.data,
          diagnostic,
          reason: 'Only the compact summary is truncated; full diagnostic remains selectable plain text',
        );
        final scroll = find.byKey(const ValueKey('diagnostic-details-scroll'));
        expect(tester.getSize(scroll).height, 240);
        final scrollState = tester.state<ScrollableState>(
          find.descendant(of: scroll, matching: find.byType(Scrollable)).first,
        );
        expect(scrollState.position.maxScrollExtent, greaterThan(1000));
        await tester.drag(scroll, const Offset(0, -160));
        await tester.pump();
        expect(scrollState.position.pixels, greaterThan(0));
        expect(tester.takeException(), isNull);

        await tester.tap(find.byKey(const ValueKey('preview-tab')));
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('preview-frame')));
        expect(
          previewTaps,
          1,
          reason:
              'A build diagnostic does not disable the accepted native preview',
        );
        expect(tester.takeException(), isNull);
        expect(find.byType(PlayerDiagnosticBanner), findsOneWidget);
      },
    );
  }

  testWidgets(
    'diagnostic details navigation never clears a paused preview input gate',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 568);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final diagnostic = longDiagnostic();
      var toolsVisible = false;
      var previewTaps = 0;
      final previewPaused = ValueNotifier(true);
      addTearDown(previewPaused.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, update) => Scaffold(
              body: PlayerWorkspace(
                diagnostic: diagnostic,
                busy: false,
                toolsVisible: toolsVisible,
                onToolsChanged: (value) => update(() => toolsVisible = value),
                onDiagnosticDetails: () => update(() => toolsVisible = true),
                tools: ListView(
                  children: [PlayerDiagnosticDetails(message: diagnostic)],
                ),
                preview: (covered) => IgnorePointer(
                  ignoring: previewPaused.value || covered,
                  child: GestureDetector(
                    key: const ValueKey('paused-preview'),
                    behavior: HitTestBehavior.opaque,
                    onTap: () => previewTaps++,
                    child: const Center(child: Text('Preview paused')),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('诊断详情'));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('preview-tab')));
      await tester.pump();
      await tester.tapAt(
        tester.getCenter(find.byKey(const ValueKey('paused-preview'))),
      );
      expect(previewTaps, 0);
      expect(previewPaused.value, true);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('diagnostic-summary')))
            .data,
        diagnostic,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
