import 'package:flutter/material.dart';

import 'player_localizations.dart';

/// Staging controls input and semantics while keeping the native view painted.
/// Mobile platform views need a composited layer to enter a native window and
/// report real metrics; hiding their paint can deadlock capability preparation.
class PreviewStageSlot extends StatelessWidget {
  const PreviewStageSlot({
    super.key,
    required this.staged,
    required this.child,
    this.covered = false,
  });
  final bool staged;
  final bool covered;
  final Widget child;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    excluding: staged || covered,
    child: IgnorePointer(ignoring: staged || covered, child: child),
  );
}

/// Both slots stay in the same keyed Stack during preparation and acceptance.
/// A candidate paints underneath the accepted view, or beneath a loading cover
/// on first startup. Its native foreground flag is owned by the caller.
class PlayerPreviewStage extends StatelessWidget {
  const PlayerPreviewStage({
    super.key,
    this.accepted,
    this.candidate,
    this.recoveryCover,
  });
  final Widget? accepted;
  final Widget? candidate;

  /// A fault cover keeps its input-disabled native owner laid out underneath.
  final Widget? recoveryCover;

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      if (candidate != null) candidate!,
      if (accepted != null) accepted!,
      if (recoveryCover != null) recoveryCover!,
      if (candidate != null && accepted == null)
        IgnorePointer(
          child: ColoredBox(
            key: const ValueKey('native-preview-loading-cover'),
            color: const Color(0xff0a0f0e),
            child: Center(
              child: Text(playerStrings(context).preparingNativePreview),
            ),
          ),
        ),
    ],
  );
}
