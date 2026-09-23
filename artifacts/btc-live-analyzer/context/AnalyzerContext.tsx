import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { analyzeChart, ChartPoint, Signal, trimHistory } from '@/lib/analysis';
import {
  CaptureRegion,
  CaptureStatus,
  requestScreenCapturePermission,
  startScreenCapture,
  stopScreenCapture,
  subscribeCaptureFrames,
  subscribeCaptureState,
} from '@/lib/screenCapture';
import { notifySignal, prepareNotifications } from '@/lib/notifications';

export type SignalRecord = {
  timestamp: number;
  signal: Signal;
  direction: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  reason: string;
};

type AnalyzerContextValue = {
  isRunning: boolean;
  captureStatus: CaptureStatus;
  analysisStatus: 'ANALISANDO' | 'AGUARDANDO DADOS';
  history: ChartPoint[];
  signalHistory: SignalRecord[];
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

const REGION_KEY = '@btc-live-analyzer/region';
const SIGNAL_KEY = '@btc-live-analyzer/signal-history';
const defaultRegion: CaptureRegion = { left: 8, top: 24, width: 84, height: 48 };
const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

export function AnalyzerProvider({ children }: { children: React.ReactNode }) {
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('DESATIVADA');
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [signalHistory, setSignalHistory] = useState<SignalRecord[]>([]);
  const [region, setRegionState] = useState<CaptureRegion>(defaultRegion);
  const [lastSignal, setLastSignal] = useState<Signal>('AGUARDAR');
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(REGION_KEY), AsyncStorage.getItem(SIGNAL_KEY)])
      .then(([storedRegion, storedSignals]) => {
        if (storedRegion) setRegionState(JSON.parse(storedRegion) as CaptureRegion);
        if (storedSignals) setSignalHistory(JSON.parse(storedSignals) as SignalRecord[]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const stateSubscription = subscribeCaptureState((status, message) => {
      setCaptureStatus(status);
      if (status === 'ERRO') setError(message ?? 'O serviço de captura encontrou um erro.');
      if (status === 'ATIVA') setError(null);
    });
    const frameSubscription = subscribeCaptureFrames((frame) => {
      setHistory((current) => trimHistory([...current, { timestamp: frame.timestamp, position: frame.position }], frame.timestamp));
    });
    return () => {
      stateSubscription.remove();
      frameSubscription.remove();
    };
  }, []);

  const analysis = useMemo(() => analyzeChart(history), [history]);
  const isRunning = captureStatus === 'SOLICITANDO PERMISSÃO' || captureStatus === 'ATIVA';
  const analysisStatus = captureStatus === 'ATIVA' && history.length >= 4 ? 'ANALISANDO' : 'AGUARDANDO DADOS';

  const setRegion = (nextRegion: CaptureRegion) => {
    setRegionState(nextRegion);
    AsyncStorage.setItem(REGION_KEY, JSON.stringify(nextRegion)).catch(() => undefined);
  };

  const startAnalysis = async () => {
    setError(null);
    setCaptureStatus('SOLICITANDO PERMISSÃO');
    const permission = await requestScreenCapturePermission();
    if (!permission.granted) {
      setCaptureStatus(permission.status);
      setError(permission.message ?? 'A autorização de captura não foi concedida.');
      return;
    }
    await prepareNotifications();
    try {
      await startScreenCapture(region);
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : 'Não foi possível iniciar o serviço de captura.';
      setCaptureStatus('ERRO');
      setError(message);
    }
  };

  const stopAnalysis = async () => {
    await stopScreenCapture();
    setCaptureStatus('DESATIVADA');
  };

  useEffect(() => {
    if (analysis.signal === 'AGUARDAR' || analysis.signal === lastSignal) return;
    const record: SignalRecord = {
      timestamp: Date.now(),
      signal: analysis.signal,
      direction: analysis.trend,
      confidence: analysis.confidence,
      reason: analysis.reason,
    };
    setLastSignal(analysis.signal);
    setLastSignalAt(record.timestamp);
    setSignalHistory((current) => {
      const next = [...current, record].slice(-100);
      AsyncStorage.setItem(SIGNAL_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
    notifySignal(analysis.signal, analysis.confidence).catch(() => undefined);
  }, [analysis, lastSignal]);

  const value = useMemo<AnalyzerContextValue>(() => ({
    isRunning,
    captureStatus,
    analysisStatus,
    history,
    signalHistory,
    region,
    lastSignal,
    lastSignalAt,
    analysis,
    error,
    setRegion,
    startAnalysis,
    stopAnalysis,
    clearError: () => setError(null),
  }), [analysis, analysisStatus, captureStatus, error, history, isRunning, lastSignal, lastSignalAt, region, signalHistory]);

  return <AnalyzerContext.Provider value={value}>{children}</AnalyzerContext.Provider>;
}

export function useAnalyzer() {
  const context = useContext(AnalyzerContext);
  if (!context) throw new Error('useAnalyzer must be used inside AnalyzerProvider');
  return context;
}