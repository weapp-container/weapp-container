// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Chinese (`zh`).
class AppLocalizationsZh extends AppLocalizations {
  AppLocalizationsZh([String locale = 'zh']) : super(locale);

  @override
  String get appTitle => 'Weapp Container 开发客户端';

  @override
  String get language => '语言';

  @override
  String get languageAndEnglish => '语言 / Language';

  @override
  String get languageSaveFailed => '无法保存语言设置，请重试。';

  @override
  String get connectProject => '连接你的项目';

  @override
  String get connectionInstructions => '在电脑上启动设备开发服务，然后扫描或粘贴连接地址。';

  @override
  String get connectionLink => '开发连接地址';

  @override
  String get connect => '连接';

  @override
  String get scan => '扫码';

  @override
  String get reconnectSaved => '重新连接已保存的设备';

  @override
  String get runtime => '运行时';

  @override
  String get deviceLocal => '设备本地';

  @override
  String get engine => '引擎';

  @override
  String get unknown => '未知';

  @override
  String get nativeSdkVersion => '原生 SDK 版本';

  @override
  String get sdkWrapperSource => 'SDK 包装层源码';

  @override
  String get renderer => '渲染器';

  @override
  String get skiaWaiting => 'Skia / 等待中';

  @override
  String get gpuAttached => 'GPU 已连接';

  @override
  String get yes => '是';

  @override
  String get notYet => '尚未';

  @override
  String get revision => '版本';

  @override
  String get route => '路由';

  @override
  String get processRss => '进程内存 RSS';

  @override
  String get notMeasured => '未测量';

  @override
  String get presentationBoundary => '呈现阶段';

  @override
  String get screenPresentation => '屏幕呈现';

  @override
  String get autoUpdate => '自动应用源码更新';

  @override
  String get autoUpdateDescription => '安全的视图更新保留状态；脚本变更会重启。';

  @override
  String get retryPreview => '重试预览';

  @override
  String get reloadLatest => '重载最新版本';

  @override
  String get previousPack => '上一个产物';

  @override
  String get disconnect => '断开连接';

  @override
  String get navigateRoute => '跳转到路由';

  @override
  String get readOnlyState => '只读运行时状态';

  @override
  String get refreshSnapshot => '刷新数据快照';

  @override
  String get console => '控制台';

  @override
  String get waitingConnection => '等待连接。';

  @override
  String get clearPacks => '关闭小程序并清理下载产物';

  @override
  String get clearStorage => '清除此项目的 wx 存储';

  @override
  String get cleanupDescription =>
      '清理下载产物会保留 wx 存储。设备上的 localhost 指设备自身；开发后端请使用电脑的局域网或 VPN 地址。';

  @override
  String get startupIncomplete => '启动未完成，请从更多菜单查看诊断';

  @override
  String get more => '更多';

  @override
  String get closeMiniProgram => '关闭小程序';

  @override
  String get back => '返回';

  @override
  String get diagnosticDetails => '诊断详情';

  @override
  String get latestDiagnostic => '最新诊断';

  @override
  String get preview => '预览';

  @override
  String get tools => '工具';

  @override
  String get toolsAndConsole => '工具与控制台';

  @override
  String get preparingNativePreview => '正在准备原生预览…';

  @override
  String get miniProgram => '小程序';

  @override
  String get miniProgramNavigation => '小程序导航';

  @override
  String get miniProgramTabs => '小程序标签栏';

  @override
  String get devTools => '开发工具';

  @override
  String get logs => '日志';

  @override
  String get performance => '性能';

  @override
  String get projectInfo => '项目信息';

  @override
  String get reloadMiniProgram => '重载小程序';

  @override
  String get cancel => '取消';

  @override
  String get openMiniProgram => '打开小程序';

  @override
  String get returnToMiniProgram => '返回小程序';

  @override
  String get toolsHeading => '开发工具 / 日志 / 性能';

  @override
  String get scanConnection => '扫描开发连接地址';

  @override
  String get cameraUnavailable => '相机不可用或未获得权限。请返回开发工具并粘贴连接地址。';

  @override
  String get phaseDisconnected => '未连接';

  @override
  String get phaseConnecting => '正在连接';

  @override
  String get phaseConnected => '已连接';

  @override
  String get phaseDownloading => '正在下载';

  @override
  String get phaseVerified => '已验证';

  @override
  String get phaseStarting => '正在启动';

  @override
  String get phaseStarted => '运行中';

  @override
  String get phaseProjectReady => '项目已就绪';

  @override
  String get phasePreviewPaused => '预览已暂停';

  @override
  String get phaseReconnecting => '正在重新连接';

  @override
  String get phaseError => '错误';

  @override
  String get phaseClosed => '已关闭';

  @override
  String get phaseIdle => '空闲';

  @override
  String get phaseWaiting => '等待中';

  @override
  String get phaseBackground => '后台';

  @override
  String get awaitingNativeAck => '等待原生帧确认';

  @override
  String get flutterTextureConsumed => 'Flutter 已消费纹理';

  @override
  String get nativeFrameAcknowledged => '原生帧已确认';

  @override
  String get presentationFailed => '呈现失败';

  @override
  String recentConnections(String connections) {
    return '最近连接：$connections';
  }

  @override
  String transferTimings(String transferMs, String applyMs, String bytes) {
    return '传输与验证：$transferMs ms\n运行时应用：$applyMs ms\n已下载：$bytes 字节';
  }

  @override
  String get phasePairing => '正在配对';

  @override
  String get phaseNativeStateUnknown => '原生状态未知';

  @override
  String get phaseUpdateReady => '更新已就绪';
}
