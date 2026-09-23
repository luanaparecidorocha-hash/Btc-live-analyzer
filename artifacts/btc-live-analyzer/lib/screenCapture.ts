import { Platform } from 'react-native';

export type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CapturePermissionResult = {
  granted: boolean;
  supported: boolean;
  message?: string;
};

/**
 * This is the explicit boundary for the Android MediaProjection bridge.
 * Expo Go cannot register a custom Android Foreground Service or MediaProjection
 * module, so this build never fakes a capture. A native Android build can
 * replace this implementation without changing the analyzer or UI contracts.
 */
export async function requestScreenCapturePermission(): Promise<CapturePermissionResult> {
  if (Platform.OS !== 'android') {
    return {
      granted: false,
      supported: false,
      message: 'A captura de tela está disponível apenas no Android.',
    };
  }

  return {
    granted: false,
    supported: false,
    message: 'A captura MediaProjection precisa de uma build Android nativa para solicitar a autorização oficial do sistema.',
  };
}

export async function stopScreenCapture(): Promise<void> {
  return Promise.resolve();
}