import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'dart:math' as math;

import 'player_localizations.dart';
import 'tab_icons.dart';

/// Runtime-owned presentation metadata. No app/page JSON is parsed here.
class MiniProgramChrome {
  const MiniProgramChrome(this.snapshot);
  final Map<String, Object?> snapshot;
  String get title => snapshot['title'] as String? ?? '小程序';
  bool get customNavigation => snapshot['navigationStyle'] == 'custom';
  bool get canGoBack => snapshot['canGoBack'] == true;
  Color get backgroundColor => color(snapshot['backgroundColor'], Colors.white);
  Color get foregroundColor => color(snapshot['frontColor'], Colors.black);
  bool get darkForeground => foregroundColor.computeLuminance() < .5;
  Color get capsuleBackgroundColor => customNavigation
      ? (darkForeground ? Colors.white : Colors.black).withValues(alpha: .56)
      : backgroundColor.withValues(alpha: .88);
  SystemUiOverlayStyle get systemUiOverlayStyle => SystemUiOverlayStyle(
    statusBarColor: customNavigation ? Colors.transparent : backgroundColor,
    statusBarIconBrightness: darkForeground
        ? Brightness.dark
        : Brightness.light,
    statusBarBrightness: darkForeground ? Brightness.light : Brightness.dark,
    systemStatusBarContrastEnforced: customNavigation ? false : null,
  );
  Map get tabBar =>
      snapshot['tabBar'] is Map ? snapshot['tabBar'] as Map : const {};
  List<Map> get tabs => tabBar['list'] is List
      ? (tabBar['list'] as List).whereType<Map>().toList(growable: false)
      : const [];
  bool get hasTabBar => tabBar['visible'] == true && tabs.isNotEmpty;
  int get selectedTab => (tabBar['selectedIndex'] as num?)?.toInt() ?? -1;
  static Color color(Object? value, Color fallback) =>
      value is String && RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(value)
      ? Color(0xff000000 | int.parse(value.substring(1), radix: 16))
      : fallback;
}

typedef MiniProgramPreviewBuilder = Widget Function(
  Map<String, Object?>? hostChrome,
  Map<String, Object?>? nativeChrome,
);

/// Measures host chrome independently of the native renderer and its DPR.
class MiniProgramShell extends StatefulWidget {
  const MiniProgramShell({
    super.key,
    required this.chrome,
    required this.preview,
    required this.onGeometry,
    required this.onMore,
    required this.onClose,
    required this.onBack,
    required this.onSwitchTab,
    this.nativeOverlay = false,
    this.initialGeometryRevision = 0,
    this.layoutObservationId,
    this.icons = const TabIconCatalog(),
    this.diagnostic,
    this.busy = false,
  });
  final MiniProgramChrome chrome;
  final MiniProgramPreviewBuilder preview;
  final ValueChanged<Map<String, Object?>> onGeometry;
  final VoidCallback onMore;
  final VoidCallback onClose;
  final VoidCallback onBack;
  final ValueChanged<String> onSwitchTab;
  final bool nativeOverlay;
  final int initialGeometryRevision;

  /// Every native observation requires a reply, including identical rectangles.
  final String? layoutObservationId;
  final TabIconCatalog icons;
  final String? diagnostic;
  final bool busy;
  @override
  State<MiniProgramShell> createState() => _MiniProgramShellState();
}

class _MiniProgramShellState extends State<MiniProgramShell> {
  final _content = GlobalKey();
  final _toolbar = GlobalKey();
  final _capsule = GlobalKey();
  final _tabBar = GlobalKey();
  int _revision = 0;
  bool _pending = false;
  Map<String, Object?>? _host;
  Map<String, Object?>? _native;
  Map<String, Object?>? _last;
  String? _answeredObservationId;
  Map<String, String> _accessibilityLabels = const {};

  @override
  void initState() {
    super.initState();
    _revision = widget.initialGeometryRevision;
  }

  @override
  void didUpdateWidget(covariant MiniProgramShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    _revision = math.max(_revision, widget.initialGeometryRevision);
  }

  Map<String, Object?> _rect(Rect rect, {bool edges = false}) => {
    'left': rect.left,
    'top': rect.top,
    'width': rect.width,
    'height': rect.height,
    if (edges) 'right': rect.right,
    if (edges) 'bottom': rect.bottom,
  };
  Rect? _bounds(GlobalKey key) {
    final box = key.currentContext?.findRenderObject();
    return box is RenderBox && box.hasSize
        ? box.localToGlobal(Offset.zero) & box.size
        : null;
  }

  bool _equal(Object? a, Object? b) {
    if (identical(a, b)) return true;
    if (a is Map && b is Map)
      return a.length == b.length &&
          a.keys.every((key) => b.containsKey(key) && _equal(a[key], b[key]));
    if (a is List && b is List)
      return a.length == b.length &&
          List.generate(a.length, (i) => _equal(a[i], b[i])).every((v) => v);
    return a == b;
  }

  void _measure() {
    final strings = playerStrings(context);
    _accessibilityLabels = {
      'more': strings.more,
      'close': strings.closeMiniProgram,
      'back': strings.back,
      'navigation': strings.miniProgramNavigation,
      'tabs': strings.miniProgramTabs,
    };
    if (_pending) return;
    _pending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _pending = false;
      if (!mounted) return;
      final content = _bounds(_content),
          toolbar = _bounds(_toolbar),
          menu = _bounds(_capsule);
      if (content == null || toolbar == null || menu == null || content.isEmpty)
        return;
      final tabs = widget.chrome.hasTabBar ? _bounds(_tabBar) : null;
      final layout = <String, Object?>{
        'content': _rect(content),
        'toolbar': _rect(toolbar),
        'menu': _rect(menu, edges: true),
        if (tabs != null) 'tabs': _rect(tabs),
      };
      final metadata = widget.icons.enrich(widget.chrome.snapshot);
      if (_equal(_last, layout) &&
          _answeredObservationId == widget.layoutObservationId) {
        // Native host controls own accessibility on Windows/Linux. A language
        // change updates their labels without resizing or restarting the guest.
        if (_native != null &&
            (!_equal(_native!['accessibilityLabels'], _accessibilityLabels) ||
                !_equal(_native!['chrome'], metadata))) {
          setState(() {
            _native = {
              ..._native!,
              'chrome': metadata,
              'accessibilityLabels': _accessibilityLabels,
            };
          });
        }
        return;
      }
      _last = layout;
      _answeredObservationId = widget.layoutObservationId;
      final revision = ++_revision;
      final host = <String, Object?>{
        'schemaVersion': 1,
        'revision': revision,
        if (widget.layoutObservationId != null)
          'observationId': widget.layoutObservationId,
        if (widget.chrome.snapshot['sessionId'] != null)
          'sessionId': widget.chrome.snapshot['sessionId'],
        if (widget.chrome.snapshot['page'] is Map &&
            (widget.chrome.snapshot['page'] as Map)['id'] != null)
          'pageId': (widget.chrome.snapshot['page'] as Map)['id'],
        'contentRect': _rect(content),
        'menuButtonRect': _rect(menu, edges: true),
      };
      final native = <String, Object?>{
        'schemaVersion': 1,
        'revision': revision,
        'chrome': metadata,
        'accessibilityLabels': _accessibilityLabels,
        'toolbarRect': _rect(toolbar),
        'menuButtonRect': _rect(menu, edges: true),
        if (tabs != null) 'tabBarRect': _rect(tabs),
      };
      setState(() {
        _host = host;
        _native = native;
      });
      widget.onGeometry(host);
    });
  }

  Widget _capsuleButtons() => SizedBox(
    width: 96,
    height: 44,
    child: Stack(
      alignment: Alignment.center,
      children: [
        DecoratedBox(
          key: _capsule,
          decoration: BoxDecoration(
            color: widget.chrome.capsuleBackgroundColor,
            border: Border.all(
              color: widget.chrome.foregroundColor.withValues(alpha: .2),
            ),
            borderRadius: BorderRadius.circular(18),
          ),
          child: const SizedBox(width: 88, height: 32),
        ),
        SizedBox(
          width: 88,
          height: 44,
          child: Row(
            children: [
              Expanded(
                child: IconButton(
                  key: const ValueKey('mini-program-more'),
                  tooltip: playerStrings(context).more,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minHeight: 44),
                  iconSize: 23,
                  onPressed: widget.onMore,
                  icon: Icon(
                    Icons.more_horiz,
                    color: widget.chrome.foregroundColor,
                  ),
                ),
              ),
              SizedBox(
                height: 18,
                child: VerticalDivider(
                  width: 1,
                  color: widget.chrome.foregroundColor.withValues(alpha: .2),
                ),
              ),
              Expanded(
                child: IconButton(
                  key: const ValueKey('mini-program-close'),
                  tooltip: playerStrings(context).closeMiniProgram,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minHeight: 44),
                  iconSize: 20,
                  onPressed: widget.onClose,
                  icon: Icon(
                    Icons.adjust,
                    color: widget.chrome.foregroundColor,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  String get _navigationTitle => widget.chrome.snapshot['title'] is String
      ? widget.chrome.title
      : playerStrings(context).miniProgram;

  TextStyle get _navigationTitleStyle => TextStyle(
    color: widget.chrome.foregroundColor,
    fontSize: 17,
    fontWeight: FontWeight.w600,
  );

  double _navigationHeight() {
    final minimum = defaultTargetPlatform == TargetPlatform.android
        ? 48.0
        : 44.0;
    // Custom navigation only has a floating capsule. Ordinary navigation must
    // reserve the actual accessible title line, including inherited font metrics.
    if (widget.chrome.customNavigation) return minimum;
    final painter = TextPainter(
      text: TextSpan(
        text: _navigationTitle,
        style: DefaultTextStyle.of(context).style.merge(_navigationTitleStyle),
      ),
      maxLines: 1,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      locale: Localizations.maybeLocaleOf(context),
    )..layout();
    final height = math.max(minimum, painter.height + 8);
    painter.dispose();
    return height;
  }

  Widget _navigation(double height) => SizedBox(
    key: _toolbar,
    height: height,
    child: Stack(
      fit: StackFit.expand,
      children: [
        if (!widget.chrome.customNavigation && !widget.nativeOverlay) ...[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 104),
            child: Center(
              child: Text(
                _navigationTitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: _navigationTitleStyle,
              ),
            ),
          ),
          if (widget.chrome.canGoBack)
            Align(
              alignment: Alignment.centerLeft,
              child: IconButton(
                key: const ValueKey('mini-program-back'),
                tooltip: playerStrings(context).back,
                onPressed: widget.onBack,
                icon: Icon(
                  Icons.chevron_left,
                  color: widget.chrome.foregroundColor,
                ),
              ),
            ),
        ],
        Positioned(
          right: 4,
          top: (height - 44) / 2,
          child: widget.nativeOverlay
              ? Opacity(
                  opacity: 0,
                  child: IgnorePointer(child: _capsuleButtons()),
                )
              : _capsuleButtons(),
        ),
      ],
    ),
  );

  double _tabsHeight() {
    var height = 52.0;
    final style = DefaultTextStyle.of(context).style
        .merge(const TextStyle(fontSize: 13));
    for (var i = 0; i < widget.chrome.tabs.length; i++) {
      final tab = widget.chrome.tabs[i];
      final painter = TextPainter(
        text: TextSpan(text: tab['text'] as String? ?? '', style: style),
        maxLines: 1,
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        locale: Localizations.maybeLocaleOf(context),
      )..layout();
      final icon = widget.icons.resolve(
        widget.chrome.selectedTab == i
            ? tab['selectedIconPath'] ?? tab['iconPath']
            : tab['iconPath'],
      );
      // Keep the default 52px bar and grow with actual accessible text metrics.
      // Measuring the bar itself also keeps the guest content/input origin in
      // sync with the space used by the host controls.
      height = math.max(height, painter.height + (icon == null ? 0 : 22) + 8);
      painter.dispose();
    }
    return height;
  }

  Widget _tabs() => SizedBox(
    key: _tabBar,
    height: _tabsHeight(),
    child: widget.nativeOverlay
        ? const SizedBox.expand()
        : DecoratedBox(
            decoration: BoxDecoration(
              color: MiniProgramChrome.color(
                widget.chrome.tabBar['backgroundColor'],
                Colors.white,
              ),
              border: Border(
                top: BorderSide(
                  color: widget.chrome.tabBar['borderStyle'] == 'white'
                      ? Colors.white
                      : Colors.black,
                  width: .5,
                ),
              ),
            ),
            child: Row(
              children: [
                for (var i = 0; i < widget.chrome.tabs.length; i++)
                  Expanded(
                    child: Semantics(
                      selected: widget.chrome.selectedTab == i,
                      button: true,
                      child: InkWell(
                        key: ValueKey('mini-program-tab-$i'),
                        onTap: () {
                          final route = widget.chrome.tabs[i]['pagePath'];
                          if (route is String) widget.onSwitchTab(route);
                        },
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                if (widget.icons.resolve(
                                      widget.chrome.selectedTab == i
                                          ? widget
                                                    .chrome
                                                    .tabs[i]['selectedIconPath'] ??
                                                widget
                                                    .chrome
                                                    .tabs[i]['iconPath']
                                          : widget.chrome.tabs[i]['iconPath'],
                                    )
                                    case final icon?)
                                  Image.memory(
                                    icon.bytes,
                                    width: 22,
                                    height: 22,
                                    fit: BoxFit.contain,
                                    excludeFromSemantics: true,
                                    gaplessPlayback: true,
                                  ),
                                Text(
                                  widget.chrome.tabs[i]['text'] as String? ??
                                      '',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: MiniProgramChrome.color(
                                      widget
                                          .chrome
                                          .tabBar[widget.chrome.selectedTab == i
                                          ? 'selectedColor'
                                          : 'color'],
                                      Colors.black,
                                    ),
                                    fontSize: 13,
                                  ),
                                ),
                              ],
                            ),
                            if (widget.chrome.tabs[i]['badgeText']
                                case final String badge when badge.isNotEmpty)
                              Positioned(
                                top: 3,
                                right: 10,
                                child: IgnorePointer(
                                  child: Container(
                                    key: ValueKey('mini-program-tab-badge-$i'),
                                    constraints: const BoxConstraints(
                                      minWidth: 16,
                                    ),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 4,
                                    ),
                                    decoration: BoxDecoration(
                                      color: Colors.red,
                                      borderRadius: BorderRadius.circular(9),
                                    ),
                                    child: Text(
                                      badge,
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 11,
                                        height: 1.45,
                                      ),
                                    ),
                                  ),
                                ),
                              )
                            else if (widget.chrome.tabs[i]['redDot'] == true)
                              Positioned(
                                top: 5,
                                right: 12,
                                child: IgnorePointer(
                                  child: Container(
                                    key: ValueKey('mini-program-tab-dot-$i'),
                                    width: 7,
                                    height: 7,
                                    decoration: const BoxDecoration(
                                      color: Colors.red,
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
  );

  @override
  Widget build(BuildContext context) {
    _measure();
    // Custom pages paint behind the status bar. Only their floating toolbar
    // consumes the top inset; the measured content keeps its screen origin.
    final topInset = MediaQuery.paddingOf(context).top;
    final extendsBottom =
        widget.chrome.customNavigation && !widget.chrome.hasTabBar;
    // The render surface owns the home-indicator background on custom pages.
    // Keep its safe-area observation intact; only host controls avoid this area.
    final bottomInset = extendsBottom
        ? MediaQuery.paddingOf(context).bottom
        : 0.0;
    final height = _navigationHeight();
    return SafeArea(
      top: !widget.chrome.customNavigation,
      bottom: !extendsBottom,
      child: ColoredBox(
        color: widget.chrome.backgroundColor,
        child: LayoutBuilder(
          builder: (context, bounds) {
            _measure();
            return SizedBox.expand(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Column(
                    children: [
                      if (!widget.chrome.customNavigation) _navigation(height),
                      Expanded(
                        child: SizedBox.expand(
                          key: _content,
                          child: widget.preview(
                            _host,
                            widget.nativeOverlay ? _native : null,
                          ),
                        ),
                      ),
                      if (widget.chrome.hasTabBar) _tabs(),
                    ],
                  ),
                  if (widget.chrome.customNavigation)
                    Positioned(
                      left: 0,
                      right: 0,
                      top: topInset,
                      child: _navigation(height),
                    ),
                  if (widget.busy)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: bottomInset,
                      child: const IgnorePointer(
                        child: LinearProgressIndicator(minHeight: 2),
                      ),
                    ),
                  if (widget.diagnostic != null && !widget.nativeOverlay)
                    Positioned(
                      left: 8,
                      bottom: (widget.chrome.hasTabBar ? 60 : 8) + bottomInset,
                      child: IconButton.filledTonal(
                        key: const ValueKey('mini-program-diagnostic'),
                        tooltip: playerStrings(context).diagnosticDetails,
                        onPressed: widget.onMore,
                        icon: const Icon(Icons.error_outline),
                      ),
                    ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}
