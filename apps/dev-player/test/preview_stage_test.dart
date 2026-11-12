import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:weapp_container_dev_player/src/preview_stage.dart';
import 'package:weapp_container_dev_player/src/runtime_identity.dart';

class PaintProbe extends LeafRenderObjectWidget {
  const PaintProbe({super.key, required this.name, required this.paints});
  final String name;
  final List<String> paints;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _PaintProbe(name, paints);
}

class _PaintProbe extends RenderBox {
  _PaintProbe(this.name, this.paints);
  final String name;
  final List<String> paints;
  @override
  void performLayout() {
    size = constraints.biggest;
  }

  @override
  bool hitTestSelf(Offset position) => true;
  @override
  void paint(PaintingContext context, Offset offset) {
    paints.add(name);
    context.canvas.drawRect(offset & size, Paint()..color = Colors.white);
  }
}

class MountProbe extends StatefulWidget {
  const MountProbe({
    super.key,
    required this.name,
    required this.paints,
    required this.retired,
  });
  final String name;
  final List<String> paints;
  final List<String> retired;
  @override
  State<MountProbe> createState() => _MountProbeState();
}

class _MountProbeState extends State<MountProbe> {
  @override
  Widget build(BuildContext context) =>
      PaintProbe(name: widget.name, paints: widget.paints);
  @override
  void dispose() {
    widget.retired.add(widget.name);
    super.dispose();
  }
}

Widget frame(Widget child) => Directionality(
  textDirection: TextDirection.ltr,
  child: Center(child: SizedBox(width: 240, height: 320, child: child)),
);

void main() {
  testWidgets(
    'candidate actually paints under its cover instead of rounding to zero alpha',
    (tester) async {
      final paints = <String>[];
      // Reproduce the original failure at the Flutter rendering boundary: real
      // layout exists, but .001 rounds to alpha zero and child paint never runs.
      await tester.pumpWidget(
        frame(
          Opacity(
            opacity: 0.001,
            child: PaintProbe(name: 'old-hidden-candidate', paints: paints),
          ),
        ),
      );
      expect(paints, isEmpty);
      await tester.pumpWidget(
        frame(
          PlayerPreviewStage(
            candidate: PreviewStageSlot(
              staged: true,
              child: PaintProbe(
                key: const ValueKey('candidate'),
                name: 'candidate',
                paints: paints,
              ),
            ),
          ),
        ),
      );
      expect(
        paints,
        contains('candidate'),
        reason: 'Platform views emit their native composition layer from paint',
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('candidate'))),
        const Size(240, 320),
      );
      expect(
        find.byKey(const ValueKey('native-preview-loading-cover')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'candidate paints below accepted view and acceptance preserves its mounted state',
    (tester) async {
      final paints = <String>[], retired = <String>[];
      Widget slot(String name, bool staged) => KeyedSubtree(
        key: ValueKey('native-$name'),
        child: PreviewStageSlot(
          staged: staged,
          child: MountProbe(
            key: ValueKey('probe-$name'),
            name: name,
            paints: paints,
            retired: retired,
          ),
        ),
      );
      await tester.pumpWidget(
        frame(PlayerPreviewStage(accepted: slot('a', false))),
      );
      final acceptedA = tester.state(find.byKey(const ValueKey('probe-a')));
      paints.clear();
      await tester.pumpWidget(
        frame(
          PlayerPreviewStage(
            accepted: slot('a', false),
            candidate: slot('b', true),
          ),
        ),
      );
      final candidateB = tester.state(find.byKey(const ValueKey('probe-b')));
      expect(
        tester.state(find.byKey(const ValueKey('probe-a'))),
        same(acceptedA),
      );
      expect(paints, ['b', 'a']);
      expect(retired, isEmpty);
      await tester.pumpWidget(
        frame(PlayerPreviewStage(accepted: slot('b', false))),
      );
      expect(
        tester.state(find.byKey(const ValueKey('probe-b'))),
        same(candidateB),
      );
      expect(retired, ['a']);
    },
  );

  testWidgets('staged and covered slots retain paint while excluding input', (
    tester,
  ) async {
    final paints = <String>[];
    var taps = 0;
    Widget slot(bool staged, bool covered) => PreviewStageSlot(
      staged: staged,
      covered: covered,
      child: GestureDetector(
        onTap: () => taps++,
        behavior: HitTestBehavior.opaque,
        child: PaintProbe(name: 'view', paints: paints),
      ),
    );
    for (final flags in [(true, false), (false, true)]) {
      await tester.pumpWidget(frame(slot(flags.$1, flags.$2)));
      // A flag change alone need not repaint an unchanged render object. Ask
      // for paint explicitly so both input states verify paint is not hidden.
      tester.renderObject<RenderBox>(find.byType(PaintProbe)).markNeedsPaint();
      await tester.pump();
      expect(paints, contains('view'));
      await tester.tapAt(tester.getCenter(find.byType(PreviewStageSlot)));
      expect(taps, 0);
      paints.clear();
    }
    await tester.pumpWidget(frame(slot(false, false)));
    await tester.tapAt(tester.getCenter(find.byType(PreviewStageSlot)));
    expect(taps, 1);
  });

  testWidgets('recovery cover preserves a measurable input-disabled owner', (
    tester,
  ) async {
    final paints = <String>[], retired = <String>[];
    var taps = 0;
    Widget preview(bool paused) => frame(
      PlayerPreviewStage(
        accepted: PreviewStageSlot(
          key: const ValueKey('owner'),
          staged: false,
          covered: paused,
          child: GestureDetector(
            onTap: () => taps++,
            behavior: HitTestBehavior.opaque,
            child: MountProbe(
              key: const ValueKey('recovery-native'),
              name: 'native',
              paints: paints,
              retired: retired,
            ),
          ),
        ),
        recoveryCover: paused
            ? const IgnorePointer(child: ColoredBox(color: Colors.black))
            : null,
      ),
    );
    await tester.pumpWidget(preview(false));
    final owner = tester.state(find.byKey(const ValueKey('recovery-native')));
    await tester.pumpWidget(preview(true));
    tester.renderObject<RenderBox>(find.byType(PaintProbe)).markNeedsPaint();
    await tester.pump();
    expect(
      tester.state(find.byKey(const ValueKey('recovery-native'))),
      same(owner),
    );
    expect(tester.getSize(find.byType(PaintProbe)), const Size(240, 320));
    expect(paints, contains('native'));
    expect(retired, isEmpty);
    await tester.tapAt(tester.getCenter(find.byType(PaintProbe)));
    expect(taps, 0);
    await tester.pumpWidget(preview(false));
    expect(
      tester.state(find.byKey(const ValueKey('recovery-native'))),
      same(owner),
    );
    await tester.tapAt(tester.getCenter(find.byType(PaintProbe)));
    expect(taps, 1);
    expect(retired, isEmpty);
  });

  test(
    'native SDK badge uses only the version reported by native capabilities',
    () {
      expect(nativeSdkVersionLabel({'sdkVersion': '9.4.2-test'}), '9.4.2-test');
      expect(nativeSdkVersionLabel({}), 'Unknown');
      expect(
        nativeSdkVersionLabel({'wrapperSourceVersion': '9.4.2-test'}),
        'Unknown',
      );
      expect(nativeSdkVersionLabel({'sdkVersion': 42}), 'Unknown');
      expect(nativeSdkVersionLabel({'sdkVersion': '  '}), 'Unknown');
      expect(
        nativeSdkVersionLabel({'sdkVersion': 'invalid\nvalue'}),
        'Unknown',
      );
    },
  );
}
