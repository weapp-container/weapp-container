import common from '@ohos.app.ability.common';
import display from '@ohos.display';
import deviceInfo from '@ohos.deviceInfo';
import bluetoothAccess from '@ohos.bluetooth.access';
import geoLocationManager from '@ohos.geoLocationManager';
import wifiManager from '@ohos.wifiManager';
import i18n from '@ohos.i18n';
import window from '@ohos.window';

export interface HarmonyHostObservation {
  windowWidth: number;
  windowHeight: number;
  displayMetrics: Object;
  syncSnapshots: Record<string, Object>;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function rectValue(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Collect one coherent OS observation before the native provider is configured. */
export async function collectHarmonyHostObservation(
  context: common.UIAbilityContext, windowWidth: number, windowHeight: number,
): Promise<HarmonyHostObservation> {
  const observedDisplay = display.getDefaultDisplaySync();
  const density = positive(observedDisplay.densityPixels, 1);
  const screenWidth = Math.max(1, Math.round(positive(observedDisplay.width / density, windowWidth)));
  const screenHeight = Math.max(1, Math.round(positive(observedDisplay.height / density, windowHeight)));
  const orientation = observedDisplay.orientation === display.Orientation.PORTRAIT ||
    observedDisplay.orientation === display.Orientation.PORTRAIT_INVERTED ? 'portrait' : 'landscape';
  const nativeWindow = await window.getLastWindow(context);
  const properties = nativeWindow.getWindowProperties();
  const avoid = nativeWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
  const topInset = rectValue(avoid.topRect.height) / density;
  const screenTop = Number.isFinite(properties.windowRect.top) ? properties.windowRect.top / density : 0;
  const system = nonEmpty(deviceInfo.osFullName, 'OpenHarmony');
  const brand = nonEmpty(deviceInfo.brand, nonEmpty(deviceInfo.manufacture, 'OpenHarmony'));
  const model = nonEmpty(deviceInfo.productModel, nonEmpty(deviceInfo.marketName, 'unknown'));
  const abi = nonEmpty(deviceInfo.abiList.split(',')[0], 'unknown');
  const cpuType = nonEmpty(deviceInfo.chipType, nonEmpty(deviceInfo.hardwareModel, 'unknown'));
  const language = nonEmpty(context.config.language, (() => {
    try { return i18n.getSystemLanguage(); } catch { return 'zh_CN'; }
  })());
  const theme = context.config.colorMode === 0 ? 'dark' : 'light';
  const fontScale = positive(context.config.fontSizeScale || 1, 1);
  const systemInfo = {
    brand, model, language, SDKVersion: '3.17.3', theme,
    fontSizeSetting: 16 * fontScale, platform: 'harmony', system, version: system,
    pixelRatio: density, screenWidth, screenHeight,
    windowWidth, windowHeight, statusBarHeight: topInset,
    deviceOrientation: orientation,
  };
  const device = {
    brand, model, abi, cpuType, memorySize: 0, benchmarkLevel: -1,
    platform: 'harmony', system,
  };
  const systemSetting = {
    bluetoothEnabled: bluetoothAccess.getState() === bluetoothAccess.BluetoothState.STATE_ON,
    locationEnabled: geoLocationManager.isLocationEnabled(),
    wifiEnabled: wifiManager.isWifiActive(),
    deviceOrientation: orientation,
  };
  const displayMetrics = {
    pixelRatio: density, screenWidth, screenHeight, statusBarHeight: topInset,
    screenTop,
    deviceOrientation: orientation,
  };
  const windowInfo = {
    pixelRatio: density, screenWidth, screenHeight, windowWidth, windowHeight,
    statusBarHeight: topInset, screenTop,
  };
  return {
    windowWidth: Math.max(1, Math.round(windowWidth)),
    windowHeight: Math.max(1, Math.round(windowHeight)),
    displayMetrics,
    syncSnapshots: {
      'wx.getDeviceInfo': device,
      'wx.getSystemInfoSync': systemInfo,
      'wx.getWindowInfo': windowInfo,
      'wx.getSystemSetting': systemSetting,
      'wx.getAppBaseInfo': {
        SDKVersion: systemInfo.SDKVersion, enableDebug: false, language,
        version: systemInfo.version, theme, fontSizeScaleFactor: fontScale,
      },
    },
  };
}
