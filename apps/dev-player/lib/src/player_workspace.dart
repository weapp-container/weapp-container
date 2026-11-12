import 'package:flutter/material.dart';

import 'player_localizations.dart';

/// Diagnostics never take the preview's layout budget. The complete plain-text
/// diagnostic is available in the tools panel, independently of native input
/// suspension and runtime error state.
class PlayerDiagnosticBanner extends StatelessWidget {
  const PlayerDiagnosticBanner({
    super.key,
    required this.message,
    required this.onDetails,
  });
  final String message;
  final VoidCallback onDetails;

  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xff4a2925),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 128),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            const Icon(Icons.error_outline, color: Color(0xffffb4a9)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                message,
                key: const ValueKey('diagnostic-summary'),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13),
              ),
            ),
            IconButton(
              onPressed: onDetails,
              tooltip: playerStrings(context).diagnosticDetails,
              icon: const Icon(Icons.read_more),
            ),
          ],
        ),
      ),
    ),
  );
}

class PlayerDiagnosticDetails extends StatefulWidget {
  const PlayerDiagnosticDetails({super.key, required this.message});
  final String message;

  @override
  State<PlayerDiagnosticDetails> createState() =>
      _PlayerDiagnosticDetailsState();
}

class _PlayerDiagnosticDetailsState extends State<PlayerDiagnosticDetails> {
  final scroll = ScrollController();

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        playerStrings(context).latestDiagnostic,
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 8),
      SizedBox(
        height: 240,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border.all(color: const Color(0xff77423a)),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Scrollbar(
            controller: scroll,
            child: SingleChildScrollView(
              key: const ValueKey('diagnostic-details-scroll'),
              controller: scroll,
              primary: false,
              padding: const EdgeInsets.all(12),
              child: SelectableText(
                widget.message,
                key: const ValueKey('diagnostic-details-text'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ),
          ),
        ),
      ),
      const SizedBox(height: 24),
    ],
  );
}

/// The actual Player body, shared with layout regressions. Tools covers a live
/// preview without unmounting it; native suspension is still owned by its host.
class PlayerWorkspace extends StatelessWidget {
  const PlayerWorkspace({
    super.key,
    required this.diagnostic,
    required this.busy,
    required this.toolsVisible,
    required this.onToolsChanged,
    required this.onDiagnosticDetails,
    required this.tools,
    required this.preview,
  });
  final String? diagnostic;
  final bool busy;
  final bool toolsVisible;
  final ValueChanged<bool> onToolsChanged;
  final VoidCallback onDiagnosticDetails;
  final Widget tools;
  final Widget Function(bool covered) preview;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      if (diagnostic != null)
        PlayerDiagnosticBanner(
          message: diagnostic!,
          onDetails: onDiagnosticDetails,
        ),
      if (busy) const LinearProgressIndicator(minHeight: 2),
      Expanded(
        child: LayoutBuilder(
          builder: (context, bounds) {
            if (bounds.maxWidth >= 850) {
              return Row(
                children: [
                  SizedBox(width: 410, child: tools),
                  const VerticalDivider(width: 1),
                  Expanded(child: preview(false)),
                ],
              );
            }
            return Column(
              children: [
                SegmentedButton<bool>(
                  segments: [
                    ButtonSegment(
                      value: false,
                      label: Text(
                        playerStrings(context).preview,
                        key: const ValueKey('preview-tab'),
                      ),
                    ),
                    ButtonSegment(
                      value: true,
                      label: Text(
                        bounds.maxWidth < 360
                            ? playerStrings(context).tools
                            : playerStrings(context).toolsAndConsole,
                        key: const ValueKey('tools-tab'),
                      ),
                    ),
                  ],
                  selected: {toolsVisible},
                  onSelectionChanged: (selection) =>
                      onToolsChanged(selection.single),
                ),
                Expanded(
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      preview(toolsVisible),
                      if (toolsVisible)
                        ColoredBox(
                          color: const Color(0xff101716),
                          child: tools,
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    ],
  );
}
