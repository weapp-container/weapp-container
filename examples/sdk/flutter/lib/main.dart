import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:weapp_container/weapp_container.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const Consumer());
}

class Consumer extends StatelessWidget {
  const Consumer({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Weapp SDK Consumer',
    theme: ThemeData(useMaterial3: true),
    home: const Acceptance(),
  );
}

class Acceptance extends StatefulWidget {
  const Acceptance({super.key});
  @override
  State<Acceptance> createState() => _AcceptanceState();
}

class _AcceptanceState extends State<Acceptance> {
  final viewKey = GlobalKey();
  final checks = <String>[];
  final messages = <Map<String, dynamic>>[];
  WeappContainerController? controller;
  StreamSubscription<WeappContainerEvent>? subscription;
  Directory? support;
  late String pack;
  String stage = 'starting';
  String? error;
  Map<String, dynamic>? geometry;
  bool visible = true;
  bool foreground = true;
  bool compact = false;
  bool verifying = false;
  int taps = 0;
  bool timer = false;
  double scroll = 0;
  Map<String, Object?> get report => {
    'schemaVersion': 1,
    'stage': stage,
    'status': error != null
        ? 'failed'
        : stage == 'complete'
        ? 'passed'
        : 'running',
    'error': error,
    'checks': checks,
    'geometry': geometry,
    'tapCount': taps,
    'timer': timer,
    'scrollTop': scroll,
  };
  @override
  void initState() {
    super.initState();
    unawaited(start().catchError(fail));
  }

  void fail(Object exception, [StackTrace? stack]) {
    error = '$exception\n${stack ?? ''}';
    stage = 'failed';
    if (mounted) setState(() {});
    unawaited(writeReport());
  }

  Future<void> writeReport() async {
    final directory = support;
    if (directory == null) return;
    await File('${directory.path}/sdk-flutter-report.json')
        .writeAsString(jsonEncode(report), flush: true);
  }

  void progress(String value) {
    stage = value;
    if (mounted) setState(() {});
    unawaited(writeReport());
  }

  Future<void> start() async {
    final directory = await getApplicationSupportDirectory();
    support = directory;
    pack = '${directory.path}/sdk-acceptance-pack';
    final index = jsonDecode(
      await rootBundle.loadString('assets/fixture-index.json'),
    ) as List;
    for (final name in index.cast<String>()) {
      final bytes = await rootBundle.load('assets/portable-pack/$name');
      final file = File('$pack/$name');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(
        bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
      );
    }
    await open();
    final c = controller!;
    await until(() => messages.any((m) => m['kind'] == 'hostResult'));
    final state = await c.state();
    final initial =
        messages.firstWhere((m) => m['kind'] == 'initWindow')['window'] as Map;
    expect(
      initial['windowWidth'] == (state['viewport'] as Map)['width'],
      'Real initial dimensions',
    );
    checks.add('measured-initial-window-and-native-host-call');
    await c.sendMessage({'op': 'inspect'});
    await until(() => geometry != null);
    progress('ready-for-input');
  }

  Future<void> open() async {
    final next = await WeappContainerController.create(
      storageKey: 'flutter-independent-acceptance',
    );
    await next.registerHostMethod(
      'native.echo',
      (call) async => {'value': call.payload},
    );
    await next.registerHostMethod('native.delayed', (call) async {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      call.cancellation.throwIfCancelled();
      return 'hidden-ok';
    });
    await next.registerHostMethod('host.echo', (call) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
      return call.payload;
    });
    subscription = next.events.listen(handleEvent, onError: fail);
    setState(() {
      controller = next;
      visible = true;
      foreground = true;
    });
    await next.load(pack);
  }

  void handleEvent(WeappContainerEvent event) {
    try {
      if (event.type == 'error') {
        fail(StateError(event.fields.toString()));
        return;
      }
      if (event.type != 'message' || event.message is! Map) return;
      final message = Map<String, dynamic>.from(event.message as Map);
      messages.add(message);
      if (message['kind'] == 'geometry') {
        geometry = message;
        final box = viewKey.currentContext?.findRenderObject() as RenderBox?;
        if (box != null) {
          final origin = box.localToGlobal(Offset.zero);
          geometry!['viewOrigin'] = {'x': origin.dx, 'y': origin.dy};
          geometry!['viewSize'] = {
            'width': box.size.width,
            'height': box.size.height,
          };
        }
      }
      if (message['kind'] == 'tap') taps = (message['count'] as num).toInt();
      if (message['kind'] == 'timer') timer = true;
      if (message['kind'] == 'scroll')
        scroll = (message['scrollTop'] as num).toDouble();
      if (mounted) setState(() {});
      if (stage == 'ready-for-input' &&
          taps > 0 &&
          timer &&
          scroll > 0 &&
          !verifying) {
        verifying = true;
        unawaited(verify().catchError(fail));
      }
    } catch (error, stack) {
      fail(error, stack);
    }
  }

  Future<void> verify() async {
    progress('verifying');
    checks.add('real-platform-tap-scroll-and-JavaScript-timer');
    var c = controller!;
    await c.navigate('pages/detail/index');
    expect(
      (await c.state())['page'] is Map &&
          ((await c.state())['page'] as Map)['route'] == 'pages/detail/index',
      'Navigate',
    );
    await c.back();
    expect(
      ((await c.state())['page'] as Map)['route'] == 'pages/home/index',
      'Back',
    );
    checks.add('navigate-back');
    var mark = messages.length;
    await c.sendMessage({'op': 'echo', 'value': '中文 🧊 \u0000'});
    await until(
      () => messages
          .skip(mark)
          .any((m) => m['kind'] == 'echo' && m['value'] == '中文 🧊 \u0000'),
    );
    checks.add('async-UTF8-host-reply');
    final generation = (await c.state())['generation'];
    try {
      await c.load('$pack/missing');
      throw StateError('Invalid pack accepted');
    } on PlatformException {
      /* Expected transactional load failure. */
    }
    expect(
      (await c.state())['generation'] == generation,
      'Failed replacement preserves generation',
    );
    checks.add('failed-reload-preserves-runtime');
    mark = messages.length;
    await c.sendMessage({'kind': 'hidden'});
    await updateForeground(c, false);
    await until(
      () => messages.skip(mark).any((m) => m['kind'] == 'hiddenDone'),
    );
    await updateForeground(c, true);
    checks.add('host-completion-while-hidden-and-resume');
    setState(() {
      visible = false;
    });
    await WidgetsBinding.instance.endOfFrame;
    setState(() {
      visible = true;
      compact = true;
    });
    await WidgetsBinding.instance.endOfFrame;
    // Rapid remount must wait for the old native View/texture retirement.
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(
      (await c.state())['generation'] == generation,
      'Remount preserves generation',
    );
    checks.add('rapid-detach-remount-resize');
    mark = messages.length;
    await c.sendMessage({'op': 'store', 'value': 'flutter-persistent'});
    await until(() => messages.skip(mark).any((m) => m['kind'] == 'stored'));
    await c.flushStorage();
    await c.close(); // Close while the platform widget is still mounted.
    await subscription?.cancel();
    setState(() {
      controller = null;
    });
    await WidgetsBinding.instance.endOfFrame;
    messages.clear();
    await open();
    c = controller!;
    mark = messages.length;
    await c.sendMessage({'op': 'read'});
    await until(
      () => messages
          .skip(mark)
          .any(
            (m) =>
                m['kind'] == 'storedValue' &&
                m['value'] == 'flutter-persistent',
          ),
    );
    checks.add('close-mounted-widget-and-stable-storage-reopen');
    final before = (await c.state())['generation'];
    await c.load(pack);
    expect(
      (await c.state())['generation'] == (before as num) + 1,
      'Successful reload',
    );
    checks.add('successful-reload');
    await c.close();
    await c.close();
    checks.add('idempotent-final-close');
    setState(() {
      controller = null;
    });
    await WidgetsBinding.instance.endOfFrame;
    progress('complete');
    await writeReport();
  }

  void expect(bool value, String label) {
    if (!value) throw StateError(label);
  }

  Future<void> updateForeground(
    WeappContainerController controller,
    bool value,
  ) async {
    // Keep the View's input gate and the native session lifecycle in sync.
    setState(() => foreground = value);
    await WidgetsBinding.instance.endOfFrame;
    final end = DateTime.now().add(const Duration(seconds: 20));
    while ((await controller.state())['foreground'] != value) {
      if (DateTime.now().isAfter(end)) {
        throw TimeoutException('Waiting for native foreground=$value');
      }
      await Future<void>.delayed(const Duration(milliseconds: 30));
    }
  }

  Future<void> until(bool Function() condition) async {
    final end = DateTime.now().add(const Duration(seconds: 20));
    while (!condition()) {
      if (DateTime.now().isAfter(end))
        throw TimeoutException('Waiting for $stage: ${jsonEncode(report)}');
      await Future<void>.delayed(const Duration(milliseconds: 30));
    }
  }

  @override
  void dispose() {
    unawaited(subscription?.cancel());
    unawaited(controller?.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          const Padding(
            padding: EdgeInsets.all(8),
            child: Text('Flutter host · installed Weapp Container SDK'),
          ),
          Semantics(
            identifier: 'sdk-status',
            label: jsonEncode(report),
            excludeSemantics: true,
            child: SizedBox(
              height: 42,
              child: Text(
                error == null ? stage : 'FAILED: $error',
                maxLines: 2,
              ),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
              child: Align(
                alignment: Alignment.topCenter,
                child: SizedBox(
                  key: viewKey,
                  width: double.infinity,
                  height: compact ? 330 : double.infinity,
                  child: controller == null || !visible
                      ? const SizedBox.shrink()
                      : Semantics(
                          identifier: 'sdk-container',
                          container: true,
                          child: WeappContainerView(
                            key: ValueKey(controller!.id),
                            controller: controller!,
                            foreground: foreground,
                            onError: fail,
                          ),
                        ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
