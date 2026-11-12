import 'package:flutter/widgets.dart';

import '../l10n/app_localizations.dart';
import '../l10n/app_localizations_zh.dart';

/// Bare host widgets also default to Chinese; guest data is never translated.
AppLocalizations playerStrings(BuildContext context) =>
    AppLocalizations.of(context) ?? AppLocalizationsZh();

/// Keep wire/state values stable and localize only the host-facing label.
String playerPhaseLabel(AppLocalizations strings, String phase) =>
    switch (phase) {
      'disconnected' => strings.phaseDisconnected,
      'connecting' => strings.phaseConnecting,
      'pairing' => strings.phasePairing,
      'connected' => strings.phaseConnected,
      'downloading' => strings.phaseDownloading,
      'verified' => strings.phaseVerified,
      'starting' => strings.phaseStarting,
      'started' => strings.phaseStarted,
      'native-acknowledged' => strings.nativeFrameAcknowledged,
      'native-state-unknown' => strings.phaseNativeStateUnknown,
      'update-ready' => strings.phaseUpdateReady,
      'project-ready' => strings.phaseProjectReady,
      'preview-paused' => strings.phasePreviewPaused,
      'reconnecting' => strings.phaseReconnecting,
      'error' => strings.phaseError,
      'closed' => strings.phaseClosed,
      'idle' => strings.phaseIdle,
      'waiting' => strings.phaseWaiting,
      'background' => strings.phaseBackground,
      _ => phase,
    };

String playerPresentationLabel(AppLocalizations strings, String stage) =>
    switch (stage) {
      'awaiting-native-ack' => strings.awaitingNativeAck,
      'flutter-texture-consumed' => strings.flutterTextureConsumed,
      'native-frame-acknowledged' => strings.nativeFrameAcknowledged,
      'failed' => strings.presentationFailed,
      'closed' => strings.phaseClosed,
      _ => stage,
    };
