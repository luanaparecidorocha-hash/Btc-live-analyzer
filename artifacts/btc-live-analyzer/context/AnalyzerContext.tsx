import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS, trimHistory } from '@/lib/analysis';
import type { ChartPoint, Signal } from '@/lib/analysis';
import { connectBtcUsdTicker } from '@/lib/marketData';
import type { MarketFeedConnection, MarketFeedStatus, MarketPricePoint } from '@/lib/marketData';
import {
  CaptureRegion,
  CaptureStatus,
  isNativeCaptureAvailable,
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

type CaptureHistoryPoint = {
  timestamp: number;
  position: number;
};

type AnalyzerContextValue = {
  isRunning: boolean;
  marketStatus: MarketFeedStatus;
  captureStatus: CaptureStatus;
  analysisStatus: 'CONECTANDO' | 'RECONECTANDO' | 'COLETANDO DADOS' | 'ANALISANDO' | 'AGUARDANDO DADOS';
  history: ChartPoint[];
  captureHistory: CaptureHistoryPoint[];
  historyDurationMs: number;
  currentPrice: number | null;
  lastPriceAt: number | null;
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
const PRICE_SAMPLE_INTERVAL_MS = 5 * 1000;
const CAPTURE_FRAME_SAMPLE_INTERVAL_MS = 15 * 1000;
const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

export function AnalyzerProvider({ children }: { children: React.ReactNode }) {
  const [marketStatus, setMarketStatus] = useState<MarketFeedStatus>('DESATIVADA');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('DESATIVADA');
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [captureHistory, setCaptureHistory] = useState<CaptureHistoryPoint[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [lastPriceAt, setLastPriceAt] = useState<number | null>(null);
  const [signalHistory, setSignalHistory] = useState<SignalRecord[]>([]);
  const [region, setRegionState] = useState<CaptureRegion>(defaultRegion);
  const [lastSignal, setLastSignal] = useState<Signal>('AGUARDAR');
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const marketConnection = useRef<MarketFeedConnection | null>(null);

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
      if (status === 'ERRO') setCaptureError(message ?? 'O serviço de captura encontrou um erro.');
      if (status === 'ATIVA') setCaptureError(null);
    });
    const frameSubscription = subscribeCaptureFrames((frame) => {
      setCaptureHistory((current) => {
        const lastPoint = current[current.length - 1];
        if (lastPoint && frame.timestamp - lastPoint.timestamp < CAPTURE_FRAME_SAMPLE_INTERVAL_MS) {
          return current;
        }
        const next = [...current, { timestamp: frame.timestamp, position: frame.position }];
        const firstCurrentPoint = next.findIndex(
          (point) => point.timestamp >= frame.timestamp - DEFAULT_ANALYSIS_WINDOW_MS,
        );
        return firstCurrentPoint > 0 ? next.slice(firstCurrentPoint - 1) : next;
      });
    });
    return () => {
      stateSubscription.remove();
      frameSubscription.remove();
    };
  }, []);

  useEffect(() => () => {
    marketConnection.current?.close();
    marketConnection.current = null;
  }, []);

  const historyDurationMs = history.length > 0 && lastPriceAt !== null
    ? Math.min(DEFAULT_ANALYSIS_WINDOW_MS, Math.max(0, lastPriceAt - history[0].timestamp))
    : 0;
  const analysis = useMemo(
    () => analyzeChart(history, DEFAULT_ANALYSIS_WINDOW_MS, lastPriceAt ?? 0),
    [history, lastPriceAt],
  );
  const isRunning = marketStatus !== 'DESATIVADA';
  const analysisStatus = marketStatus === 'RECONECTANDO'
    ? 'RECONECTANDO'
    : marketStatus === 'CONECTANDO'
      ? 'CONECTANDO'
      : marketStatus === 'CONECTADO' && historyDurationMs < DEFAULT_ANALYSIS_WINDOW_MS
        ? 'COLETANDO DADOS'
        : marketStatus === 'CONECTADO'
          ? 'ANALISANDO'
          : 'AGUARDANDO DADOS';
  const error = marketError ?? captureError;

  const setRegion = (nextRegion: CaptureRegion) => {
    setRegionState(nextRegion);
    AsyncStorage.setItem(REGION_KEY, JSON.stringify(nextRegion)).catch(() => undefined);
  };

  const startAnalysis = async () => {
    marketConnection.current?.close();
    marketConnection.current = null;
    setMarketError(null);
    setCaptureError(null);
    setHistory([]);
    setCaptureHistory([]);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    setMarketStatus('CONECTANDO');

    marketConnection.current = connectBtcUsdTicker({
      onPrice: (point: MarketPricePoint) => {
        setCurrentPrice(point.price);
        setLastPriceAt(point.timestamp);
        setMarketError(null);
        setHistory((current) => {
          const lastPoint = current[current.length - 1];
          if (lastPoint && point.timestamp - lastPoint.timestamp > 20 * 1000) {
            return [point];
          }
          if (lastPoint && point.timestamp - lastPoint.timestamp < PRICE_SAMPLE_INTERVAL_MS) {
            return current;
          }
          return trimHistory([...current, point], point.timestamp);
        });
      },
      onStatus: (status: MarketFeedStatus) => {
        setMarketStatus(status);
        if (status === 'RECONECTANDO') {
          setHistory([]);
          setCurrentPrice(null);
          setLastPriceAt(null);
        }
      },
      onError: setMarketError,
    });

    if (Platform.OS !== 'web') await prepareNotifications();
    if (!isNativeCaptureAvailable()) {
      setCaptureStatus('DESATIVADA');
      return;
    }

    setCaptureStatus('SOLICITANDO PERMISSÃO');
    try {
      const permission = await requestScreenCapturePermission();
      if (!permission.granted) {
        setCaptureStatus(permission.status);
        setCaptureError(permission.message ?? 'A autorização de captura não foi concedida.');
        return;
      }
      await startScreenCapture(region);
    } catch (captureFailure) {
      const message = captureFailure instanceof Error
        ? captureFailure.message
        : 'Não foi possível iniciar o serviço de captura.';
      setCaptureStatus('ERRO');
      setCaptureError(message);
    }
  };

  const stopAnalysis = async () => {
    marketConnection.current?.close();
    marketConnection.current = null;
    setMarketStatus('DESATIVADA');
    setHistory([]);
    setCaptureHistory([]);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    if (Platform.OS === 'web' || !isNativeCaptureAvailable()) {
      setCaptureStatus('DESATIVADA');
      return;
    }

    try {
      await stopScreenCapture();
      setCaptureStatus('DESATIVADA');
      setCaptureError(null);
    } catch (captureStopError) {
      const message = captureStopError instanceof Error
        ? captureStopError.message
        : 'Não foi possível interromper a captura.';
      setCaptureStatus('ERRO');
      setCaptureError(message);
    }
  };

  useEffect(() => {
    if (
      marketStatus !== 'CONECTADO'
      || historyDurationMs < DEFAULT_ANALYSIS_WINDOW_MS
      || analysis.signal === 'AGUARDAR'
      || analysis.signal === lastSignal
    ) return;
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
  }, [analysis, historyDurationMs, lastSignal, marketStatus]);

  const value = useMemo<AnalyzerContextValue>(() => ({
    isRunning,
    marketStatus,
    captureStatus,
    analysisStatus,
    history,
    captureHistory,
    historyDurationMs,
    currentPrice,
    lastPriceAt,
    signalHistory,
    region,
    lastSignal,
    lastSignalAt,
    analysis,
    error,
    setRegion,
    startAnalysis,
    stopAnalysis,
    clearError: () => {
      setMarketError(null);
      setCaptureError(null);
    },
  }), [
    analysis,
    analysisStatus,
    captureHistory,
    captureStatus,
    currentPrice,
    error,
    history,
    historyDurationMs,
    isRunning,
    lastPriceAt,
    lastSignal,
    lastSignalAt,
    marketStatus,
    region,
    signalHistory,
  ]);

  return <AnalyzerContext.Provider value={value}>{children}</AnalyzerContext.Provider>;
}

export function useAnalyzer() {
  const context = useContext(AnalyzerContext);
  if (!context) throw new Error('useAnalyzer must be used inside AnalyzerProvider');
  return context;
}