import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show AppExitResponse;

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:weapp_container/weapp_container.dart';

import 'l10n/app_localizations.dart';
import 'src/player_language_selector.dart';
import 'src/player_localizations.dart';
import 'src/player_preferences.dart';
import 'src/player_model.dart';
import 'src/mini_program_chrome.dart';
import 'src/player_workspace.dart';
import 'src/preview_stage.dart';
import 'src/runtime_identity.dart';
import 'src/host_services.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final preferences = await PlayerPreferences.loadOrDefault();
  runApp(DevPlayerApp(preferences: preferences));
}

class DevPlayerApp extends StatelessWidget {
  const DevPlayerApp({super.key, required this.preferences, this.home});

  final PlayerPreferences preferences;
  final Widget? home;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: preferences,
    builder: (context, _) => MaterialApp(
      onGenerateTitle: (context) => playerStrings(context).appTitle,
      locale: preferences.locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorSchemeSeed: const Color(0xff76d6ad),
        scaffoldBackgroundColor: const Color(0xff101716),
        useMaterial3: true,
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
        ),
      ),
      home: home ?? PlayerHome(preferences: preferences),
    ),
  );
}

class PlayerHome extends StatefulWidget {
  const PlayerHome({super.key, required this.preferences});
  final PlayerPreferences preferences;
  @override
  State<PlayerHome> createState() => _PlayerHomeState();
}

class _PlayerHomeState extends State<PlayerHome> with WidgetsBindingObserver {
  final model = PlayerModel(hostServices: const DevelopmentDeviceServices());
  final connection = TextEditingController();
  final route = TextEditingController();
  final toolsScroll = ScrollController();
  StreamSubscription<Uri>? _links;
  final _appLinks = AppLinks();
  AppLifecycleListener? _lifecycle;
  bool ready = false;
  bool showConsole = false;
  bool showMenu = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    model.addListener(_changed);
    model.onNativeMore = () => _run(_openMore);
    model.onNativeClose = () => _run(_closeMiniProgram);
    model.onNativeBack = () => _run(model.back);
    model.onNativeSwitchTab = (path) => _run(() => model.switchTab(path));
    _lifecycle = AppLifecycleListener(
      onExitRequested: () async {
        await model.close();
        return AppExitResponse.exit;
      },
    );
    unawaited(_initialize());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _initialize() async {
    try {
      await model.initialize();
      _links = _appLinks.uriLinkStream.listen(
        (link) => _run(() => model.connect(link.toString())),
        onError: (_) => model.fail(StateError('Deep link failed')),
      );
      final initial = await _appLinks.getInitialLink();
      if (initial != null) await model.connect(initial.toString());
    } catch (error) {
      model.fail(error);
    }
    if (mounted) setState(() => ready = true);
  }

  void _run(Future<void> Function() action) {
    unawaited(action().catchError((Object error) => model.fail(error)));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _run(() => model.setAppLifecycle(state));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _lifecycle?.dispose();
    model.removeListener(_changed);
    unawaited(_links?.cancel());
    model.dispose();
    connection.dispose();
    route.dispose();
    toolsScroll.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final link = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const ScanConnection()));
    if (link != null && mounted) await model.connect(link);
  }

  Future<void> _language() =>
      showPlayerLanguageDialog(context, widget.preferences);

  Widget _badge(String label, String value) => Padding(
    padding: const EdgeInsets.only(right: 16, bottom: 8),
    child: RichText(
      text: TextSpan(
        style: Theme.of(context).textTheme.bodySmall,
        children: [
          TextSpan(
            text: '$label  ',
            style: const TextStyle(color: Color(0xff8ea19a)),
          ),
          TextSpan(
            text: value,
            style: const TextStyle(color: Color(0xffd9eee4)),
          ),
        ],
      ),
    ),
  );

  Widget _tools() {
    final s = playerStrings(context);
    final page = model.nativeState['page'] as Map?;
    final runtime = model.capabilities['runtime'] as Map?;
    return ListView(
      controller: toolsScroll,
      padding: const EdgeInsets.all(24),
      children: [
        PlayerLanguageSelector(preferences: widget.preferences),
        const SizedBox(height: 16),
        if (model.error != null) PlayerDiagnosticDetails(message: model.error!),
        Text(
          s.connectProject,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          s.connectionInstructions,
          style: const TextStyle(color: Color(0xffa7bbb2), height: 1.5),
        ),
        const SizedBox(height: 20),
        TextField(
          controller: connection,
          minLines: 2,
          maxLines: 3,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(
            labelText: s.connectionLink,
            hintText: 'weapp-container://connect?…',
          ),
          onSubmitted: (_) => _run(() async {
            final link = connection.text;
            connection.clear();
            await model.connect(link);
          }),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            FilledButton.icon(
              onPressed: !ready
                  ? null
                  : () => _run(() async {
                      final link = connection.text;
                      connection.clear();
                      await model.connect(link);
                    }),
              icon: const Icon(Icons.link),
              label: Text(s.connect),
            ),
            if (Platform.isAndroid || Platform.isIOS)
              OutlinedButton.icon(
                onPressed: () => _run(_scan),
                icon: const Icon(Icons.qr_code_scanner),
                label: Text(s.scan),
              ),
            TextButton(
              onPressed: !ready ? null : () => _run(model.reconnectSaved),
              child: Text(s.reconnectSaved),
            ),
          ],
        ),
        if (model.history.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text(
            s.recentConnections(model.history.take(3).join(' · ')),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 22),
          child: Divider(),
        ),
        Wrap(
          children: [
            _badge(s.runtime, s.deviceLocal),
            _badge(
              s.engine,
              model.nativeState['engine']?.toString() ?? s.unknown,
            ),
            _badge(
              s.nativeSdkVersion,
              nativeSdkVersionLabel(
                model.capabilities,
                unknownLabel: s.unknown,
              ),
            ),
            _badge(
              s.sdkWrapperSource,
              const String.fromEnvironment('WEAPP_CONTAINER_SDK_SOURCE').isEmpty
                  ? s.unknown
                  : const String.fromEnvironment('WEAPP_CONTAINER_SDK_SOURCE'),
            ),
            _badge(
              s.renderer,
              runtime?['renderer']?.toString() ?? s.skiaWaiting,
            ),
            _badge(
              s.gpuAttached,
              runtime?['gpuSurface'] == true ? s.yes : s.notYet,
            ),
            _badge(s.revision, model.activePack?.descriptor.generation ?? '—'),
            _badge(s.route, page?['route']?.toString() ?? '—'),
            _badge(
              s.processRss,
              '${(ProcessInfo.currentRss / 1048576).toStringAsFixed(1)} MiB',
            ),
            _badge('FPS', s.notMeasured),
            _badge(
              s.presentationBoundary,
              playerPresentationLabel(s, model.presentationStage),
            ),
            _badge(s.screenPresentation, s.notMeasured),
          ],
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: model.autoUpdate,
          onChanged: model.setAutoUpdate,
          title: Text(s.autoUpdate),
          subtitle: Text(s.autoUpdateDescription),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (model.previewPaused)
              OutlinedButton.icon(
                onPressed: model.busy ? null : () => _run(model.retryPreview),
                icon: const Icon(Icons.play_arrow),
                label: Text(s.retryPreview),
              ),
            OutlinedButton.icon(
              onPressed: model.busy || !model.connected
                  ? null
                  : () => _run(model.reload),
              icon: const Icon(Icons.refresh),
              label: Text(s.reloadLatest),
            ),
            OutlinedButton.icon(
              onPressed: model.busy || model.previousPack == null
                  ? null
                  : () => _run(model.rollback),
              icon: const Icon(Icons.history),
              label: Text(s.previousPack),
            ),
            TextButton(
              onPressed: model.connected ? () => _run(model.disconnect) : null,
              child: Text(s.disconnect),
            ),
          ],
        ),
        const SizedBox(height: 20),
        TextField(
          controller: route,
          decoration: InputDecoration(
            labelText: s.navigateRoute,
            hintText: 'pages/home/index',
          ),
          onSubmitted: (value) => _run(() => model.navigate(value)),
        ),
        const SizedBox(height: 12),
        Text(
          s.transferTimings(
            (model.timings['transferAndVerifyMs'] ?? '—').toString(),
            (model.timings['applyMs'] ?? '—').toString(),
            (model.timings['downloadBytes'] ?? '—').toString(),
          ),
          style: const TextStyle(
            fontFamily: 'monospace',
            color: Color(0xffa7bbb2),
            height: 1.6,
          ),
        ),
        const SizedBox(height: 24),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text(s.readOnlyState),
          onExpansionChanged: (expanded) {
            if (expanded) _run(model.inspectData);
          },
          children: [
            TextButton(
              onPressed: model.controller == null
                  ? null
                  : () => _run(model.inspectData),
              child: Text(s.refreshSnapshot),
            ),
            SelectableText(
              const JsonEncoder.withIndent('  ').convert(
                model.inspectorData.isEmpty
                    ? model.nativeState
                    : model.inspectorData,
              ),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
          ],
        ),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text(s.console),
          initiallyExpanded: true,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: SelectableText(
                model.logs.isEmpty
                    ? s.waitingConnection
                    : model.logs.join('\n'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  height: 1.6,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextButton(
          onPressed: model.busy ? null : () => _run(model.clearProject),
          child: Text(s.clearPacks),
        ),
        TextButton(
          onPressed: model.busy || model.controller == null
              ? null
              : () => _run(model.clearStorage),
          child: Text(s.clearStorage),
        ),
        Text(
          s.cleanupDescription,
          style: const TextStyle(
            fontSize: 11,
            color: Color(0xff8ea19a),
            height: 1.5,
          ),
        ),
      ],
    );
  }

  Future<void> _setConsole(bool value) async {
    await model.setPreviewOccluded(value);
    if (mounted)
      setState(() {
        showConsole = value;
        showMenu = false;
      });
  }

  Future<void> _openMore() async {
    await model.setPreviewOccluded(true);
    if (mounted && model.appRequested) setState(() => showMenu = true);
  }

  Future<void> _closeMenu() async {
    if (mounted) setState(() => showMenu = false);
    await model.setPreviewOccluded(false);
  }

  Future<void> _closeMiniProgram() async {
    if (mounted)
      setState(() {
        showMenu = false;
        showConsole = false;
      });
    await model.closeMiniProgram();
  }

  Future<void> _back() async {
    if (showMenu) return _closeMenu();
    if (showConsole) return _setConsole(false);
    if (model.appRequested) await model.back();
  }

  Widget _program(WeappContainerController value, {required bool staged}) {
    final prospective = identical(value, model.prospectiveController);
    final observed = prospective
        ? model.prospectiveChrome
        : staged
        ? model.candidateChrome
        : model.nativeState['chrome'];
    final chrome = MiniProgramChrome(
      observed is Map ? Map<String, Object?>.from(observed) : const {},
    );
    return PreviewStageSlot(
      key: ValueKey('native-preview-${value.id}'),
      staged: staged,
      covered: model.previewOccluded || model.previewPaused || prospective,
      child: MiniProgramShell(
        key: ValueKey('mini-program-shell-${value.id}'),
        chrome: chrome,
        layoutObservationId:
            value.lastHostLayoutObservation?['observationId'] as String?,
        icons: staged ? model.candidateTabIcons : model.tabIcons,
        initialGeometryRevision: model.initialChromeRevision(value),
        nativeOverlay: Platform.isWindows || Platform.isLinux,
        busy: !staged && model.busy,
        diagnostic: staged ? null : model.error,
        onGeometry: (geometry) {
          if (prospective) {
            _run(() => model.observeProspectiveChrome(value, geometry));
          } else if (staged) {
            _run(() => model.observeHostChrome(value, geometry));
          } else {
            _run(() => model.observeActiveShellGeometry(value, geometry));
          }
        },
        onMore: () => _run(_openMore),
        onClose: () => _run(_closeMiniProgram),
        onBack: () => _run(model.back),
        onSwitchTab: (path) => _run(() => model.switchTab(path)),
        preview: (hostChrome, nativeChrome) => WeappContainerView(
          key: ValueKey(value.id),
          controller: value,
          hostChrome: hostChrome,
          hostLayoutObservation: value.pendingHostLayout,
          prepareOnly: staged || prospective,
          onHostChromeApplied: (revision) =>
              model.hostChromeApplied(value, revision),
          nativeChrome: nativeChrome,
          occluded:
              staged ||
              model.previewOccluded ||
              model.previewPaused ||
              prospective,
          foreground: model.appForeground,
          onDiagnostic: (diagnostic) =>
              model.recordPreviewDiagnostic(diagnostic, source: value),
          onFailure: (failure) {
            if (staged) {
              model.fail(failure.error, source: value, viewFailure: failure);
            } else {
              model.handlePreviewError(failure, source: value);
            }
          },
        ),
      ),
    );
  }

  Widget _preview() {
    final accepted = model.controller;
    final candidate = model.candidateController;
    final prospective = model.prospectiveController;
    if (accepted == null && candidate == null) {
      return MiniProgramShell(
        chrome: const MiniProgramChrome({}),
        busy: model.busy,
        diagnostic: model.error,
        onGeometry: (_) {},
        onMore: () => _run(_openMore),
        onClose: () => _run(_closeMiniProgram),
        onBack: () => _run(_closeMiniProgram),
        onSwitchTab: (_) {},
        preview: (_, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (model.busy) const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(
                model.error == null
                    ? playerPhaseLabel(playerStrings(context), model.phase)
                    : playerStrings(context).startupIncomplete,
                style: const TextStyle(color: Colors.black54),
              ),
            ],
          ),
        ),
      );
    }
    return PlayerPreviewStage(
      accepted: accepted == null
          ? MiniProgramShell(
              chrome: MiniProgramChrome(model.candidateChrome),
              onGeometry: (_) {},
              onMore: () => _run(_openMore),
              onClose: () => _run(_closeMiniProgram),
              onBack: () => _run(_closeMiniProgram),
              onSwitchTab: (_) {},
              preview: (_, _) =>
                  const Center(child: CircularProgressIndicator()),
            )
          : _program(accepted, staged: false),
      recoveryCover: !model.previewPaused && prospective == null
          ? null
          : MiniProgramShell(
              chrome: MiniProgramChrome(
                model.nativeState['chrome'] is Map
                    ? Map<String, Object?>.from(
                        model.nativeState['chrome'] as Map,
                      )
                    : const {},
              ),
              onGeometry: (_) {},
              onMore: () => _run(_openMore),
              onClose: () => _run(_closeMiniProgram),
              onBack: () => _run(model.back),
              onSwitchTab: (path) => _run(() => model.switchTab(path)),
              diagnostic: model.error,
              preview: (_, _) => Center(
                child: FilledButton.icon(
                  onPressed: model.busy ? null : () => _run(model.retryPreview),
                  icon: const Icon(Icons.refresh),
                  label: Text(playerStrings(context).retryPreview),
                ),
              ),
            ),
      candidate: candidate == null ? null : _program(candidate, staged: true),
    );
  }

  Widget _moreMenu() => Positioned.fill(
    child: Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            onTap: () => _run(_closeMenu),
            child: const ColoredBox(color: Color(0x66000000)),
          ),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Material(
                color: const Color(0xff18231f),
                borderRadius: BorderRadius.circular(18),
                clipBehavior: Clip.antiAlias,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: 520,
                    maxHeight:
                        MediaQuery.sizeOf(context).height -
                        MediaQuery.paddingOf(context).vertical -
                        24,
                  ),
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ListTile(
                          title: Text(playerStrings(context).miniProgram),
                          subtitle: Text(
                            model.nativeState['page'] is Map
                                ? (model.nativeState['page'] as Map)['route']
                                          ?.toString() ??
                                      playerPhaseLabel(
                                        playerStrings(context),
                                        model.phase,
                                      )
                                : playerPhaseLabel(
                                    playerStrings(context),
                                    model.phase,
                                  ),
                          ),
                        ),
                        for (final entry in [
                          (
                            Icons.developer_mode,
                            playerStrings(context).devTools,
                          ),
                          (Icons.terminal, playerStrings(context).logs),
                          (Icons.speed, playerStrings(context).performance),
                          (
                            Icons.info_outline,
                            playerStrings(context).projectInfo,
                          ),
                        ])
                          ListTile(
                            leading: Icon(entry.$1),
                            title: Text(entry.$2),
                            onTap: () => _run(() => _setConsole(true)),
                          ),
                        ListTile(
                          leading: const Icon(Icons.language),
                          title: Text(
                            playerStrings(context).languageAndEnglish,
                          ),
                          onTap: _language,
                        ),
                        ListTile(
                          leading: const Icon(Icons.refresh),
                          title: Text(playerStrings(context).reloadMiniProgram),
                          onTap: () => _run(() async {
                            await _closeMenu();
                            await model.reload();
                          }),
                        ),
                        ListTile(
                          leading: const Icon(Icons.close),
                          title: Text(playerStrings(context).closeMiniProgram),
                          onTap: () => _run(_closeMiniProgram),
                        ),
                        TextButton(
                          onPressed: () => _run(_closeMenu),
                          child: Text(playerStrings(context).cancel),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final active = model.appRequested;
    final observed = model.nativeState['chrome'];
    final chrome = MiniProgramChrome(
      observed is Map ? Map<String, Object?>.from(observed) : const {},
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: active ? chrome.systemUiOverlayStyle : SystemUiOverlayStyle.light,
      child: PopScope(
        canPop: !active && !showMenu && !showConsole,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _run(_back);
        },
        child: CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.escape): () => _run(_back),
          },
          child: Focus(
            autofocus: true,
            child: Scaffold(
              backgroundColor: active ? chrome.backgroundColor : null,
              appBar: active
                  ? null
                  : AppBar(
                      title: const Text('Weapp Container'),
                      actions: [
                        IconButton(
                          tooltip: playerStrings(context).languageAndEnglish,
                          onPressed: _language,
                          icon: const Icon(Icons.language),
                        ),
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Center(
                            child: Text(
                              playerPhaseLabel(
                                playerStrings(context),
                                model.phase,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
              body: !active
                  ? SafeArea(
                      child: Column(
                        children: [
                          if (model.availablePack != null)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
                              child: SizedBox(
                                width: double.infinity,
                                child: FilledButton.icon(
                                  key: const ValueKey('open-mini-program'),
                                  onPressed: model.closingMiniProgram
                                      ? null
                                      : () => _run(model.openMiniProgram),
                                  icon: const Icon(Icons.play_arrow),
                                  label: Text(
                                    playerStrings(context).openMiniProgram,
                                  ),
                                ),
                              ),
                            ),
                          Expanded(child: _tools()),
                        ],
                      ),
                    )
                  : Stack(
                      fit: StackFit.expand,
                      children: [
                        _preview(),
                        if (showConsole)
                          Positioned.fill(
                            child: ColoredBox(
                              color: const Color(0xff101716),
                              child: SafeArea(
                                child: Column(
                                  children: [
                                    SizedBox(
                                      height: 52,
                                      child: Row(
                                        children: [
                                          IconButton(
                                            tooltip: playerStrings(context)
                                                .returnToMiniProgram,
                                            onPressed: () =>
                                                _run(() => _setConsole(false)),
                                            icon: const Icon(Icons.arrow_back),
                                          ),
                                          Expanded(
                                            child: Text(
                                              playerStrings(context)
                                                  .toolsHeading,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Expanded(child: _tools()),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        if (showMenu) _moreMenu(),
                      ],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class ScanConnection extends StatefulWidget {
  const ScanConnection({super.key});
  @override
  State<ScanConnection> createState() => _ScanConnectionState();
}

class _ScanConnectionState extends State<ScanConnection> {
  final scanner = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  bool accepted = false;
  @override
  void dispose() {
    unawaited(scanner.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(playerStrings(context).scanConnection)),
    body: MobileScanner(
      controller: scanner,
      onDetect: (capture) {
        if (accepted) return;
        for (final code in capture.barcodes) {
          final text = code.rawValue;
          if (text != null && text.startsWith('weapp-container://connect?')) {
            accepted = true;
            Navigator.pop(context, text);
            return;
          }
        }
      },
      errorBuilder: (context, error) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(playerStrings(context).cameraUnavailable),
        ),
      ),
    ),
  );
}
