// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Weapp Container Dev Player';

  @override
  String get language => 'Language';

  @override
  String get languageAndEnglish => 'Language / 语言';

  @override
  String get languageSaveFailed =>
      'Could not save the language setting. Please try again.';

  @override
  String get connectProject => 'Connect your project';

  @override
  String get connectionInstructions =>
      'Run the device development server on your computer, then scan or paste its connection link.';

  @override
  String get connectionLink => 'Development connection link';

  @override
  String get connect => 'Connect';

  @override
  String get scan => 'Scan';

  @override
  String get reconnectSaved => 'Reconnect saved device';

  @override
  String get runtime => 'Runtime';

  @override
  String get deviceLocal => 'Device local';

  @override
  String get engine => 'Engine';

  @override
  String get unknown => 'Unknown';

  @override
  String get nativeSdkVersion => 'Native SDK version';

  @override
  String get sdkWrapperSource => 'SDK wrapper source';

  @override
  String get renderer => 'Renderer';

  @override
  String get skiaWaiting => 'Skia / waiting';

  @override
  String get gpuAttached => 'GPU attached';

  @override
  String get yes => 'Yes';

  @override
  String get notYet => 'Not yet';

  @override
  String get revision => 'Revision';

  @override
  String get route => 'Route';

  @override
  String get processRss => 'Process RSS';

  @override
  String get notMeasured => 'Not measured';

  @override
  String get presentationBoundary => 'Presentation boundary';

  @override
  String get screenPresentation => 'Screen presentation';

  @override
  String get autoUpdate => 'Apply source updates automatically';

  @override
  String get autoUpdateDescription =>
      'Safe view updates retain state; script changes restart.';

  @override
  String get retryPreview => 'Retry preview';

  @override
  String get reloadLatest => 'Reload latest';

  @override
  String get previousPack => 'Previous pack';

  @override
  String get disconnect => 'Disconnect';

  @override
  String get navigateRoute => 'Navigate to route';

  @override
  String get readOnlyState => 'Read-only runtime state';

  @override
  String get refreshSnapshot => 'Refresh data snapshot';

  @override
  String get console => 'Console';

  @override
  String get waitingConnection => 'Waiting for a connection.';

  @override
  String get clearPacks => 'Close app and clear downloaded packs';

  @override
  String get clearStorage => 'Clear this project’s wx storage';

  @override
  String get cleanupDescription =>
      'Downloaded pack cleanup retains wx storage. Device localhost is this device; use your computer’s LAN/VPN address for development backends.';

  @override
  String get startupIncomplete =>
      'Startup is incomplete. Open More for diagnostics.';

  @override
  String get more => 'More';

  @override
  String get closeMiniProgram => 'Close mini program';

  @override
  String get back => 'Back';

  @override
  String get diagnosticDetails => 'Diagnostic details';

  @override
  String get latestDiagnostic => 'Latest diagnostic';

  @override
  String get preview => 'Preview';

  @override
  String get tools => 'Tools';

  @override
  String get toolsAndConsole => 'Tools & console';

  @override
  String get preparingNativePreview => 'Preparing native preview…';

  @override
  String get miniProgram => 'Mini program';

  @override
  String get miniProgramNavigation => 'Mini program navigation';

  @override
  String get miniProgramTabs => 'Mini program tabs';

  @override
  String get devTools => 'Developer tools';

  @override
  String get logs => 'Logs';

  @override
  String get performance => 'Performance';

  @override
  String get projectInfo => 'Project information';

  @override
  String get reloadMiniProgram => 'Reload mini program';

  @override
  String get cancel => 'Cancel';

  @override
  String get openMiniProgram => 'Open mini program';

  @override
  String get returnToMiniProgram => 'Return to mini program';

  @override
  String get toolsHeading => 'Developer tools / Logs / Performance';

  @override
  String get scanConnection => 'Scan development connection';

  @override
  String get cameraUnavailable =>
      'Camera is unavailable or permission was denied. Return to Tools and paste the connection link.';

  @override
  String get phaseDisconnected => 'Disconnected';

  @override
  String get phaseConnecting => 'Connecting';

  @override
  String get phaseConnected => 'Connected';

  @override
  String get phaseDownloading => 'Downloading';

  @override
  String get phaseVerified => 'Verified';

  @override
  String get phaseStarting => 'Starting';

  @override
  String get phaseStarted => 'Running';

  @override
  String get phaseProjectReady => 'Project ready';

  @override
  String get phasePreviewPaused => 'Preview paused';

  @override
  String get phaseReconnecting => 'Reconnecting';

  @override
  String get phaseError => 'Error';

  @override
  String get phaseClosed => 'Closed';

  @override
  String get phaseIdle => 'Idle';

  @override
  String get phaseWaiting => 'Waiting';

  @override
  String get phaseBackground => 'Background';

  @override
  String get awaitingNativeAck => 'Awaiting native frame acknowledgement';

  @override
  String get flutterTextureConsumed => 'Flutter texture consumed';

  @override
  String get nativeFrameAcknowledged => 'Native frame acknowledged';

  @override
  String get presentationFailed => 'Presentation failed';

  @override
  String recentConnections(String connections) {
    return 'Recent: $connections';
  }

  @override
  String transferTimings(String transferMs, String applyMs, String bytes) {
    return 'Transfer + verify: $transferMs ms\nRuntime apply: $applyMs ms\nDownloaded: $bytes bytes';
  }

  @override
  String get phasePairing => 'Pairing';

  @override
  String get phaseNativeStateUnknown => 'Native state unknown';

  @override
  String get phaseUpdateReady => 'Update ready';
}
