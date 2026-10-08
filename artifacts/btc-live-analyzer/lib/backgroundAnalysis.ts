import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { AnalysisSessionSnapshot } from './analysisSession';

type BackgroundModule = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isActive: () => Promise<boolean>;
  getSnapshot: () => Promise<string | null>;
  publishSnapshot: (json: string, runToken: number) => Promise<void>;
  notifyCycle: (title: string, body: string, publicBody: string, runToken: number) => Promise<void>;
  notifyResult: (title: string, body: string, publicBody: string) => Promise<void>;
  addListener: (event: string, listener: (payload: { json?: string; message?: string; runToken?: number }) => void) => { remove: () => void };
};

export const nativeBackgroundAnalysis = Platform.OS === 'android'
  ? requireOptionalNativeModule<BackgroundModule>('BtcBackgroundAnalysis')
  : null;

export function isBackgroundAnalysisAvailable() {
  return nativeBackgroundAnalysis !== null;
}

export function subscribeBackgroundAnalysis(listener: (state: AnalysisSessionSnapshot) => void) {
  if (!nativeBackgroundAnalysis) return { remove: () => undefined };
  return nativeBackgroundAnalysis.addListener('onAnalysisState', (payload) => {
    if (payload.json) listener(JSON.parse(payload.json) as AnalysisSessionSnapshot);
  });
}

export async function getBackgroundAnalysisSnapshot(): Promise<AnalysisSessionSnapshot | null> {
  const json = await nativeBackgroundAnalysis?.getSnapshot();
  return json ? JSON.parse(json) as AnalysisSessionSnapshot : null;
}