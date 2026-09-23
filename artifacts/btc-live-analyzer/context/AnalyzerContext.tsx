import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { analyzeChart, ChartPoint, Signal, trimHistory } from '@/lib/analysis';
import { CaptureRegion, requestScreenCapturePermission, stopScreenCapture } from '@/lib/screenCapture';
import { notifySignal, prepareNotifications } from '@/lib/notifications';

type AnalyzerContextValue = {
  isRunning: boolean;
  captureStatus: 'ATIVA' | 'INATIVA';
  analysisStatus: 'ANALISANDO' | 'AGUARDANDO DADOS';
  history: ChartPoint[];
  region: CaptureRegion;
  lastSignal: Signal;
  lastSignalAt: number | null;
  analysis: ReturnType<typeof analyzeChart>;
  error: string | null;
  setRegion: (region: CaptureRegion) => void;
  startAnalysis: () => Promise<void>;
  stopAnalysis: () => Promise<void>;
  clearError: () => void;
};

const STORAGE_KEY = '@btc-live-analyzer/region';
const defaultRegion: CaptureRegion = { left: 8, top: 24, width: 84, height: 48 };
const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

export function AnalyzerProvider({ children }: { children: React.ReactNode }) {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [region, setRegionState] = useState<CaptureRegion>(defaultRegion);
  const [lastSignal, setLastSignal] = useState<Signal>('AGUARDAR');
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored) setRegionState(JSON.parse(stored) as CaptureRegion);
      })
      .catch(() => undefined);
  }, []);

  const analysis = useMemo(() => analyzeChart(history), [history]);

  const setRegion = (nextRegion: CaptureRegion) => {
    setRegionState(nextRegion);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextRegion)).catch(() => undefined);
  };

  const startAnalysis = async () => {
    setError(null);
    const permission = await requestScreenCapturePermission();
    if (!permission.granted) {
      setError(permission.message ?? 'A autorização de captura não foi concedida.');
      return;
    }
    await prepareNotifications();
    setIsRunning(true);
  };

  const stopAnalysis = async () => {
    await stopScreenCapture();
    setIsRunning(false);
  };

  useEffect(() => {
    if (!isRunning || Platform.OS === 'web') return undefined;
    const timer = setInterval(() => {
      setHistory((current) => trimHistory(current));
    }, 30_000);
    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (analysis.signal === 'AGUARDAR' || analysis.signal === lastSignal) return;
    setLastSignal(analysis.signal);
    setLastSignalAt(Date.now());
    notifySignal(analysis.signal, analysis.confidence).catch(() => undefined);
  }, [analysis, lastSignal]);

  const value = useMemo<AnalyzerContextValue>(() => ({
    isRunning,
    captureStatus: isRunning ? 'ATIVA' : 'INATIVA',
    analysisStatus: isRunning ? 'ANALISANDO' : 'AGUARDANDO DADOS',
    history,
    region,
    lastSignal,
    lastSignalAt,
    analysis,
    error,
    setRegion,
    startAnalysis,
    stopAnalysis,
    clearError: () => setError(null),
  }), [analysis, error, history, isRunning, lastSignal, lastSignalAt, region]);

  return <AnalyzerContext.Provider value={value}>{children}</AnalyzerContext.Provider>;
}

export function useAnalyzer() {
  const context = useContext(AnalyzerContext);
  if (!context) throw new Error('useAnalyzer must be used inside AnalyzerProvider');
  return context;
}