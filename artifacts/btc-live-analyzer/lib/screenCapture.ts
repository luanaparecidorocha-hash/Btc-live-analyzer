import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type CaptureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CaptureStatus = 'DESATIVADA' | 'SOLICITANDO PERMISSÃO' | 'ATIVA' | 'ERRO';

export type CapturePermissionResult = {
  granted: boolean;
  supported: boolean;
  status: CaptureStatus;
  message?: string;
};

export type NativeCaptureFrame = {
  timestamp: number;
  position: number;
  meanLuma: number;
  candidatePixels: number;
};

type NativeCaptureModule = {
  getState: () => Promise<{ status: CaptureStatus; message?: string }>;
  requestPermission: () => Promise<CapturePermissionResult>;
  start: (region: CaptureRegion) => Promise<void>;
  stop: () => Promise<void>;
  addListener: (eventName: 'onCaptureStateChanged' | 'onFrame', listener: (payload: Record<string, unknown>) => void) => { remove: () => void };
};

const nativeCapture = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeCaptureModule>('BtcScreenCapture')
  : null;

export function isNativeCaptureAvailable(): boolean {
  return nativeCapture !== null;
}

export async function requestScreenCapturePermission(): Promise<CapturePermissionResult> {
  if (!nativeCapture) {
    return {
      granted: false,
      supported: false,
      status: 'ERRO',
      message: 'O módulo MediaProjection não está disponível nesta plataforma ou build.',
    };
  }

  return nativeCapture.requestPermission();
}

export async function startScreenCapture(region: CaptureRegion): Promise<void> {
  if (!nativeCapture) throw new Error('O módulo MediaProjection não está disponível nesta build.');
  await nativeCapture.start(region);
}

export async function stopScreenCapture(): Promise<void> {
  if (!nativeCapture) return;
  await nativeCapture.stop();
}

export async function getScreenCaptureState(): Promise<{ status: CaptureStatus; message?: string }> {
  if (!nativeCapture) return { status: 'DESATIVADA' };
  return nativeCapture.getState();
}

export function subscribeCaptureState(listener: (status: CaptureStatus, message?: string) => void): { remove: () => void } {
  if (!nativeCapture) return { remove: () => undefined };
  return nativeCapture.addListener('onCaptureStateChanged', (payload: Record<string, unknown>) => {
    listener(payload.status as CaptureStatus, payload.message as string | undefined);
  });
}

export function subscribeCaptureFrames(listener: (frame: NativeCaptureFrame) => void): { remove: () => void } {
  if (!nativeCapture) return { remove: () => undefined };
  return nativeCapture.addListener('onFrame', (payload: Record<string, unknown>) => {
    listener({
      timestamp: Number(payload.timestamp),
      position: Number(payload.position),
      meanLuma: Number(payload.meanLuma),
      candidatePixels: Number(payload.candidatePixels),
    });
  });
}