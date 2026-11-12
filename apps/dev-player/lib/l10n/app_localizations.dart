import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('zh'),
    Locale('en'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In zh, this message translates to:
  /// **'Weapp Container 开发客户端'**
  String get appTitle;

  /// No description provided for @language.
  ///
  /// In zh, this message translates to:
  /// **'语言'**
  String get language;

  /// No description provided for @languageAndEnglish.
  ///
  /// In zh, this message translates to:
  /// **'语言 / Language'**
  String get languageAndEnglish;

  /// No description provided for @languageSaveFailed.
  ///
  /// In zh, this message translates to:
  /// **'无法保存语言设置，请重试。'**
  String get languageSaveFailed;

  /// No description provided for @connectProject.
  ///
  /// In zh, this message translates to:
  /// **'连接你的项目'**
  String get connectProject;

  /// No description provided for @connectionInstructions.
  ///
  /// In zh, this message translates to:
  /// **'在电脑上启动设备开发服务，然后扫描或粘贴连接地址。'**
  String get connectionInstructions;

  /// No description provided for @connectionLink.
  ///
  /// In zh, this message translates to:
  /// **'开发连接地址'**
  String get connectionLink;

  /// No description provided for @connect.
  ///
  /// In zh, this message translates to:
  /// **'连接'**
  String get connect;

  /// No description provided for @scan.
  ///
  /// In zh, this message translates to:
  /// **'扫码'**
  String get scan;

  /// No description provided for @reconnectSaved.
  ///
  /// In zh, this message translates to:
  /// **'重新连接已保存的设备'**
  String get reconnectSaved;

  /// No description provided for @runtime.
  ///
  /// In zh, this message translates to:
  /// **'运行时'**
  String get runtime;

  /// No description provided for @deviceLocal.
  ///
  /// In zh, this message translates to:
  /// **'设备本地'**
  String get deviceLocal;

  /// No description provided for @engine.
  ///
  /// In zh, this message translates to:
  /// **'引擎'**
  String get engine;

  /// No description provided for @unknown.
  ///
  /// In zh, this message translates to:
  /// **'未知'**
  String get unknown;

  /// No description provided for @nativeSdkVersion.
  ///
  /// In zh, this message translates to:
  /// **'原生 SDK 版本'**
  String get nativeSdkVersion;

  /// No description provided for @sdkWrapperSource.
  ///
  /// In zh, this message translates to:
  /// **'SDK 包装层源码'**
  String get sdkWrapperSource;

  /// No description provided for @renderer.
  ///
  /// In zh, this message translates to:
  /// **'渲染器'**
  String get renderer;

  /// No description provided for @skiaWaiting.
  ///
  /// In zh, this message translates to:
  /// **'Skia / 等待中'**
  String get skiaWaiting;

  /// No description provided for @gpuAttached.
  ///
  /// In zh, this message translates to:
  /// **'GPU 已连接'**
  String get gpuAttached;

  /// No description provided for @yes.
  ///
  /// In zh, this message translates to:
  /// **'是'**
  String get yes;

  /// No description provided for @notYet.
  ///
  /// In zh, this message translates to:
  /// **'尚未'**
  String get notYet;

  /// No description provided for @revision.
  ///
  /// In zh, this message translates to:
  /// **'版本'**
  String get revision;

  /// No description provided for @route.
  ///
  /// In zh, this message translates to:
  /// **'路由'**
  String get route;

  /// No description provided for @processRss.
  ///
  /// In zh, this message translates to:
  /// **'进程内存 RSS'**
  String get processRss;

  /// No description provided for @notMeasured.
  ///
  /// In zh, this message translates to:
  /// **'未测量'**
  String get notMeasured;

  /// No description provided for @presentationBoundary.
  ///
  /// In zh, this message translates to:
  /// **'呈现阶段'**
  String get presentationBoundary;

  /// No description provided for @screenPresentation.
  ///
  /// In zh, this message translates to:
  /// **'屏幕呈现'**
  String get screenPresentation;

  /// No description provided for @autoUpdate.
  ///
  /// In zh, this message translates to:
  /// **'自动应用源码更新'**
  String get autoUpdate;

  /// No description provided for @autoUpdateDescription.
  ///
  /// In zh, this message translates to:
  /// **'安全的视图更新保留状态；脚本变更会重启。'**
  String get autoUpdateDescription;

  /// No description provided for @retryPreview.
  ///
  /// In zh, this message translates to:
  /// **'重试预览'**
  String get retryPreview;

  /// No description provided for @reloadLatest.
  ///
  /// In zh, this message translates to:
  /// **'重载最新版本'**
  String get reloadLatest;

  /// No description provided for @previousPack.
  ///
  /// In zh, this message translates to:
  /// **'上一个产物'**
  String get previousPack;

  /// No description provided for @disconnect.
  ///
  /// In zh, this message translates to:
  /// **'断开连接'**
  String get disconnect;

  /// No description provided for @navigateRoute.
  ///
  /// In zh, this message translates to:
  /// **'跳转到路由'**
  String get navigateRoute;

  /// No description provided for @readOnlyState.
  ///
  /// In zh, this message translates to:
  /// **'只读运行时状态'**
  String get readOnlyState;

  /// No description provided for @refreshSnapshot.
  ///
  /// In zh, this message translates to:
  /// **'刷新数据快照'**
  String get refreshSnapshot;

  /// No description provided for @console.
  ///
  /// In zh, this message translates to:
  /// **'控制台'**
  String get console;

  /// No description provided for @waitingConnection.
  ///
  /// In zh, this message translates to:
  /// **'等待连接。'**
  String get waitingConnection;

  /// No description provided for @clearPacks.
  ///
  /// In zh, this message translates to:
  /// **'关闭小程序并清理下载产物'**
  String get clearPacks;

  /// No description provided for @clearStorage.
  ///
  /// In zh, this message translates to:
  /// **'清除此项目的 wx 存储'**
  String get clearStorage;

  /// No description provided for @cleanupDescription.
  ///
  /// In zh, this message translates to:
  /// **'清理下载产物会保留 wx 存储。设备上的 localhost 指设备自身；开发后端请使用电脑的局域网或 VPN 地址。'**
  String get cleanupDescription;

  /// No description provided for @startupIncomplete.
  ///
  /// In zh, this message translates to:
  /// **'启动未完成，请从更多菜单查看诊断'**
  String get startupIncomplete;

  /// No description provided for @more.
  ///
  /// In zh, this message translates to:
  /// **'更多'**
  String get more;

  /// No description provided for @closeMiniProgram.
  ///
  /// In zh, this message translates to:
  /// **'关闭小程序'**
  String get closeMiniProgram;

  /// No description provided for @back.
  ///
  /// In zh, this message translates to:
  /// **'返回'**
  String get back;

  /// No description provided for @diagnosticDetails.
  ///
  /// In zh, this message translates to:
  /// **'诊断详情'**
  String get diagnosticDetails;

  /// No description provided for @latestDiagnostic.
  ///
  /// In zh, this message translates to:
  /// **'最新诊断'**
  String get latestDiagnostic;

  /// No description provided for @preview.
  ///
  /// In zh, this message translates to:
  /// **'预览'**
  String get preview;

  /// No description provided for @tools.
  ///
  /// In zh, this message translates to:
  /// **'工具'**
  String get tools;

  /// No description provided for @toolsAndConsole.
  ///
  /// In zh, this message translates to:
  /// **'工具与控制台'**
  String get toolsAndConsole;

  /// No description provided for @preparingNativePreview.
  ///
  /// In zh, this message translates to:
  /// **'正在准备原生预览…'**
  String get preparingNativePreview;

  /// No description provided for @miniProgram.
  ///
  /// In zh, this message translates to:
  /// **'小程序'**
  String get miniProgram;

  /// No description provided for @miniProgramNavigation.
  ///
  /// In zh, this message translates to:
  /// **'小程序导航'**
  String get miniProgramNavigation;

  /// No description provided for @miniProgramTabs.
  ///
  /// In zh, this message translates to:
  /// **'小程序标签栏'**
  String get miniProgramTabs;

  /// No description provided for @devTools.
  ///
  /// In zh, this message translates to:
  /// **'开发工具'**
  String get devTools;

  /// No description provided for @logs.
  ///
  /// In zh, this message translates to:
  /// **'日志'**
  String get logs;

  /// No description provided for @performance.
  ///
  /// In zh, this message translates to:
  /// **'性能'**
  String get performance;

  /// No description provided for @projectInfo.
  ///
  /// In zh, this message translates to:
  /// **'项目信息'**
  String get projectInfo;

  /// No description provided for @reloadMiniProgram.
  ///
  /// In zh, this message translates to:
  /// **'重载小程序'**
  String get reloadMiniProgram;

  /// No description provided for @cancel.
  ///
  /// In zh, this message translates to:
  /// **'取消'**
  String get cancel;

  /// No description provided for @openMiniProgram.
  ///
  /// In zh, this message translates to:
  /// **'打开小程序'**
  String get openMiniProgram;

  /// No description provided for @returnToMiniProgram.
  ///
  /// In zh, this message translates to:
  /// **'返回小程序'**
  String get returnToMiniProgram;

  /// No description provided for @toolsHeading.
  ///
  /// In zh, this message translates to:
  /// **'开发工具 / 日志 / 性能'**
  String get toolsHeading;

  /// No description provided for @scanConnection.
  ///
  /// In zh, this message translates to:
  /// **'扫描开发连接地址'**
  String get scanConnection;

  /// No description provided for @cameraUnavailable.
  ///
  /// In zh, this message translates to:
  /// **'相机不可用或未获得权限。请返回开发工具并粘贴连接地址。'**
  String get cameraUnavailable;

  /// No description provided for @phaseDisconnected.
  ///
  /// In zh, this message translates to:
  /// **'未连接'**
  String get phaseDisconnected;

  /// No description provided for @phaseConnecting.
  ///
  /// In zh, this message translates to:
  /// **'正在连接'**
  String get phaseConnecting;

  /// No description provided for @phaseConnected.
  ///
  /// In zh, this message translates to:
  /// **'已连接'**
  String get phaseConnected;

  /// No description provided for @phaseDownloading.
  ///
  /// In zh, this message translates to:
  /// **'正在下载'**
  String get phaseDownloading;

  /// No description provided for @phaseVerified.
  ///
  /// In zh, this message translates to:
  /// **'已验证'**
  String get phaseVerified;

  /// No description provided for @phaseStarting.
  ///
  /// In zh, this message translates to:
  /// **'正在启动'**
  String get phaseStarting;

  /// No description provided for @phaseStarted.
  ///
  /// In zh, this message translates to:
  /// **'运行中'**
  String get phaseStarted;

  /// No description provided for @phaseProjectReady.
  ///
  /// In zh, this message translates to:
  /// **'项目已就绪'**
  String get phaseProjectReady;

  /// No description provided for @phasePreviewPaused.
  ///
  /// In zh, this message translates to:
  /// **'预览已暂停'**
  String get phasePreviewPaused;

  /// No description provided for @phaseReconnecting.
  ///
  /// In zh, this message translates to:
  /// **'正在重新连接'**
  String get phaseReconnecting;

  /// No description provided for @phaseError.
  ///
  /// In zh, this message translates to:
  /// **'错误'**
  String get phaseError;

  /// No description provided for @phaseClosed.
  ///
  /// In zh, this message translates to:
  /// **'已关闭'**
  String get phaseClosed;

  /// No description provided for @phaseIdle.
  ///
  /// In zh, this message translates to:
  /// **'空闲'**
  String get phaseIdle;

  /// No description provided for @phaseWaiting.
  ///
  /// In zh, this message translates to:
  /// **'等待中'**
  String get phaseWaiting;

  /// No description provided for @phaseBackground.
  ///
  /// In zh, this message translates to:
  /// **'后台'**
  String get phaseBackground;

  /// No description provided for @awaitingNativeAck.
  ///
  /// In zh, this message translates to:
  /// **'等待原生帧确认'**
  String get awaitingNativeAck;

  /// No description provided for @flutterTextureConsumed.
  ///
  /// In zh, this message translates to:
  /// **'Flutter 已消费纹理'**
  String get flutterTextureConsumed;

  /// No description provided for @nativeFrameAcknowledged.
  ///
  /// In zh, this message translates to:
  /// **'原生帧已确认'**
  String get nativeFrameAcknowledged;

  /// No description provided for @presentationFailed.
  ///
  /// In zh, this message translates to:
  /// **'呈现失败'**
  String get presentationFailed;

  /// No description provided for @recentConnections.
  ///
  /// In zh, this message translates to:
  /// **'最近连接：{connections}'**
  String recentConnections(String connections);

  /// No description provided for @transferTimings.
  ///
  /// In zh, this message translates to:
  /// **'传输与验证：{transferMs} ms\n运行时应用：{applyMs} ms\n已下载：{bytes} 字节'**
  String transferTimings(String transferMs, String applyMs, String bytes);

  /// No description provided for @phasePairing.
  ///
  /// In zh, this message translates to:
  /// **'正在配对'**
  String get phasePairing;

  /// No description provided for @phaseNativeStateUnknown.
  ///
  /// In zh, this message translates to:
  /// **'原生状态未知'**
  String get phaseNativeStateUnknown;

  /// No description provided for @phaseUpdateReady.
  ///
  /// In zh, this message translates to:
  /// **'更新已就绪'**
  String get phaseUpdateReady;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
