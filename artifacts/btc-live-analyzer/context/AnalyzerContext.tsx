import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  analyzeChart,
  DEFAULT_ANALYSIS_WINDOW_MS,
  scheduleAnalysisDeadline,
  trimHistory,
} from '@/lib/analysis';
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
import { createAnalysisHistoryStore, mergeAnalysisHistory } from '@/lib/analysisHistory';
import type { AnalysisRecord } from '@/lib/analysisHistory';

export type SignalRecord = AnalysisRecord;

type CaptureHistoryPoint = {
  timestamp: number;
  position: number;
};

type AnalyzerContextValue = {
  isRunning: boolean;
  marketStatus: MarketFeedStatus;
  captureStatus: CaptureStatus;
  analysisStatus: 'CONECTANDO' | 'RECONECTANDO' | 'COLETANDO DADOS' | 'ANALISANDO' | 'COLETA CONCLUÍDA' | 'AGUARDANDO DADOS';
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
  collectionComplete: boolean;
  error: string | null;
  setRegion: (region: CaptureRegion) => void;
  startAnalysis: () => Promise<void>;
  stopAnalysis: () => Promise<void>;
  clearError: () => void;
};

const REGION_KEY = '@btc-live-analyzer/region';
const defaultRegion: CaptureRegion = { left: 8, top: 24, width: 84, height: 48 };
const PRICE_SAMPLE_INTERVAL_MS = 5 * 1000;
const CAPTURE_FRAME_SAMPLE_INTERVAL_MS = 15 * 1000;
const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

export function AnalyzerProvider({ children }: { children: React.ReactNode }) {
  const [marketStatus, setMarketStatus] = useState<MarketFeedStatus>('DESATIVADA');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('DESATIVADA');
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [captureHistory, setCaptureHistory] = useState<CaptureHistoryPoint[]>([]);
  const [collectionStartedAt, setCollectionStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(0);
  const [collectionComplete, setCollectionComplete] = useState(false);
  const [finalAnalysis, setFinalAnalysis] = useState<ReturnType<typeof analyzeChart> | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [lastPriceAt, setLastPriceAt] = useState<number | null>(null);
  const [signalHistory, setSignalHistory] = useState<SignalRecord[]>([]);
  const [region, setRegionState] = useState<CaptureRegion>(defaultRegion);
  const [lastSignal, setLastSignal] = useState<Signal>('AGUARDAR');
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyStore = useMemo(() => createAnalysisHistoryStore(AsyncStorage), []);
  const marketConnection = useRef<MarketFeedConnection | null>(null);
  const historyRef = useRef<ChartPoint[]>([]);
  const collectionStartedAtRef = useRef<number | null>(null);
  const collectionClosedRef = useRef(true);
  const captureStatusRef = useRef<CaptureStatus>('DESATIVADA');
  const finishCollectionRef = useRef<(completedAt: number) => void>(() => undefined);
  const cancelDeadlineRef = useRef<(() => void) | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(REGION_KEY)
      .then((storedRegion) => {
        if (storedRegion) setRegionState(JSON.parse(storedRegion) as CaptureRegion);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    historyStore.load()
      .then((saved) => {
        if (active) setSignalHistory((current) => mergeAnalysisHistory(saved, current));
      })
      .catch(() => {
        if (active) setHistoryError('Não foi possível carregar o histórico salvo. Os dados antigos não serão sobrescritos.');
      });
    return () => { active = false; };
  }, [historyStore]);

  useEffect(() => {
    const stateSubscription = subscribeCaptureState((status, message) => {
      captureStatusRef.current = status;
      setCaptureStatus(status);
      if (status === 'ERRO') setCaptureError(message ?? 'O serviço de captura encontrou um erro.');
      if (status === 'ATIVA') setCaptureError(null);
    });
    const frameSubscription = subscribeCaptureFrames((frame) => {
      if (collectionClosedRef.current) return;
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
    collectionClosedRef.current = true;
    cancelDeadlineRef.current?.();
    cancelDeadlineRef.current = null;
    if (progressTimerRef.current !== null) clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;
    marketConnection.current?.close();
    marketConnection.current = null;
  }, []);

  const historyDurationMs = collectionComplete
    ? DEFAULT_ANALYSIS_WINDOW_MS
    : collectionStartedAt !== null
      ? Math.min(
          DEFAULT_ANALYSIS_WINDOW_MS,
          Math.max(0, clockNow - collectionStartedAt),
        )
      : 0;
  const analysis = useMemo(
    () => finalAnalysis ?? analyzeChart(
      history,
      DEFAULT_ANALYSIS_WINDOW_MS,
      collectionStartedAt === null
        ? lastPriceAt ?? 0
        : Math.min(
            clockNow,
            collectionStartedAt + DEFAULT_ANALYSIS_WINDOW_MS - 1,
          ),
    ),
    [clockNow, collectionStartedAt, finalAnalysis, history, lastPriceAt],
  );
  const isRunning = !collectionComplete && marketStatus !== 'DESATIVADA';
  const analysisStatus = collectionComplete
    ? 'COLETA CONCLUÍDA'
    : marketStatus === 'RECONECTANDO'
      ? 'RECONECTANDO'
      : marketStatus === 'CONECTANDO'
        ? 'CONECTANDO'
        : marketStatus === 'CONECTADO' && historyDurationMs < DEFAULT_ANALYSIS_WINDOW_MS
          ? 'COLETANDO DADOS'
          : marketStatus === 'CONECTADO'
            ? 'ANALISANDO'
            : 'AGUARDANDO DADOS';
  const error = marketError ?? captureError ?? historyError;
  const cancelCollectionTimers = useCallback(() => {
    cancelDeadlineRef.current?.();
    cancelDeadlineRef.current = null;
    if (progressTimerRef.current !== null) clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;
  }, []);

  const finishCollection = useCallback((completedAt: number) => {
    if (collectionClosedRef.current) return;
    const startedAt = collectionStartedAtRef.current;
    if (startedAt === null || completedAt < startedAt + DEFAULT_ANALYSIS_WINDOW_MS) return;

    collectionClosedRef.current = true;
    cancelCollectionTimers();
    const result = analyzeChart(
      historyRef.current,
      DEFAULT_ANALYSIS_WINDOW_MS,
      completedAt,
    );
    const record: SignalRecord = {
      timestamp: completedAt,
      signal: result.signal,
      direction: result.trend,
      confidence: result.confidence,
      durationMs: DEFAULT_ANALYSIS_WINDOW_MS,
      reason: result.reason,
    };

    setClockNow(completedAt);
    setFinalAnalysis(result);
    setCollectionComplete(true);
    setLastSignal(result.signal);
    setLastSignalAt(completedAt);
    setSignalHistory((current) => mergeAnalysisHistory(current, [record]));
    void historyStore.append(record)
      .then((saved) => {
        setSignalHistory((current) => mergeAnalysisHistory(saved, current));
        setHistoryError(null);
      })
      .catch(() => setHistoryError('Análise mantida nesta sessão, mas não foi possível salvar o histórico no dispositivo.'));

    marketConnection.current?.close();
    marketConnection.current = null;
    setMarketStatus('DESATIVADA');
    setMarketError(null);
    if (result.signal !== 'AGUARDAR') {
      notifySignal(result.signal, result.confidence).catch(() => undefined);
    }

    if (
      Platform.OS !== 'web'
      && isNativeCaptureAvailable()
      && captureStatusRef.current === 'ATIVA'
    ) {
      void stopScreenCapture()
        .then(() => {
          captureStatusRef.current = 'DESATIVADA';
          setCaptureStatus('DESATIVADA');
          setCaptureError(null);
        })
        .catch((captureStopError) => {
          const message = captureStopError instanceof Error
            ? captureStopError.message
            : 'Não foi possível interromper a captura.';
          captureStatusRef.current = 'ERRO';
          setCaptureStatus('ERRO');
          setCaptureError(message);
        });
    }
  }, [cancelCollectionTimers, historyStore]);
  finishCollectionRef.current = finishCollection;

  useEffect(() => {
    if (collectionStartedAt === null || collectionComplete) return;

    const cancelDeadline = scheduleAnalysisDeadline(
      collectionStartedAt,
      (completedAt) => finishCollectionRef.current(completedAt),
    );
    cancelDeadlineRef.current = cancelDeadline;
    const progressTimer = setInterval(() => {
      const completedAt = collectionStartedAt + DEFAULT_ANALYSIS_WINDOW_MS;
      const now = Date.now();
      if (now >= completedAt) {
        finishCollectionRef.current(completedAt);
      } else {
        setClockNow(now);
      }
    }, 1000);
    progressTimerRef.current = progressTimer;

    return () => {
      cancelDeadline();
      if (cancelDeadlineRef.current === cancelDeadline) cancelDeadlineRef.current = null;
      clearInterval(progressTimer);
      if (progressTimerRef.current === progressTimer) progressTimerRef.current = null;
    };
  }, [collectionComplete, collectionStartedAt]);

  const setRegion = (nextRegion: CaptureRegion) => {
    setRegionState(nextRegion);
    AsyncStorage.setItem(REGION_KEY, JSON.stringify(nextRegion)).catch(() => undefined);
  };

  const startAnalysis = async () => {
    cancelCollectionTimers();
    marketConnection.current?.close();
    marketConnection.current = null;
    collectionClosedRef.current = false;
    collectionStartedAtRef.current = null;
    historyRef.current = [];
    setMarketError(null);
    setCaptureError(null);
    setHistory([]);
    setCaptureHistory([]);
    setCollectionStartedAt(null);
    setClockNow(0);
    setCollectionComplete(false);
    setFinalAnalysis(null);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    setMarketStatus('CONECTANDO');

    marketConnection.current = connectBtcUsdTicker({
      onPrice: (point: MarketPricePoint) => {
        if (collectionClosedRef.current) return;
        const startedAt = collectionStartedAtRef.current;
        if (startedAt !== null && point.timestamp >= startedAt + DEFAULT_ANALYSIS_WINDOW_MS) {
          finishCollectionRef.current(startedAt + DEFAULT_ANALYSIS_WINDOW_MS);
          return;
        }

        setCurrentPrice(point.price);
        setLastPriceAt(point.timestamp);
        setMarketError(null);
        const current = historyRef.current;
        const lastPoint = current[current.length - 1];
        const gapExceeded = lastPoint !== undefined
          && point.timestamp - lastPoint.timestamp > 20 * 1000;
        if (startedAt === null || gapExceeded) {
          collectionStartedAtRef.current = point.timestamp;
          setCollectionStartedAt(point.timestamp);
          setClockNow(point.timestamp);
          setFinalAnalysis(null);
        }

        const pointsBeforeSample = gapExceeded ? [] : current;
        const latestPoint = pointsBeforeSample[pointsBeforeSample.length - 1];
        const nextHistory = latestPoint
          && point.timestamp - latestPoint.timestamp < PRICE_SAMPLE_INTERVAL_MS
          ? pointsBeforeSample
          : trimHistory([...pointsBeforeSample, point], point.timestamp);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      },
      onStatus: (status: MarketFeedStatus) => {
        setMarketStatus(status);
        if (status === 'RECONECTANDO' && !collectionClosedRef.current) {
          cancelCollectionTimers();
          historyRef.current = [];
          collectionStartedAtRef.current = null;
          setHistory([]);
          setCollectionStartedAt(null);
          setClockNow(0);
          setCollectionComplete(false);
          setFinalAnalysis(null);
          setCurrentPrice(null);
          setLastPriceAt(null);
        }
      },
      onError: setMarketError,
    });

    if (Platform.OS !== 'web') await prepareNotifications();
    if (collectionClosedRef.current) return;
    if (!isNativeCaptureAvailable()) {
      captureStatusRef.current = 'DESATIVADA';
      setCaptureStatus('DESATIVADA');
      return;
    }

    captureStatusRef.current = 'SOLICITANDO PERMISSÃO';
    setCaptureStatus('SOLICITANDO PERMISSÃO');
    try {
      const permission = await requestScreenCapturePermission();
      if (collectionClosedRef.current) return;
      if (!permission.granted) {
        captureStatusRef.current = permission.status;
        setCaptureStatus(permission.status);
        setCaptureError(permission.message ?? 'A autorização de captura não foi concedida.');
        return;
      }
      await startScreenCapture(region);
      if (collectionClosedRef.current) {
        await stopScreenCapture();
        captureStatusRef.current = 'DESATIVADA';
        setCaptureStatus('DESATIVADA');
      }
    } catch (captureFailure) {
      const message = captureFailure instanceof Error
        ? captureFailure.message
        : 'Não foi possível iniciar o serviço de captura.';
      captureStatusRef.current = 'ERRO';
      setCaptureStatus('ERRO');
      setCaptureError(message);
    }
  };

  const stopAnalysis = async () => {
    cancelCollectionTimers();
    collectionClosedRef.current = true;
    collectionStartedAtRef.current = null;
    historyRef.current = [];
    marketConnection.current?.close();
    marketConnection.current = null;
    setMarketStatus('DESATIVADA');
    setHistory([]);
    setCaptureHistory([]);
    setCollectionStartedAt(null);
    setClockNow(0);
    setCollectionComplete(false);
    setFinalAnalysis(null);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    if (Platform.OS === 'web' || !isNativeCaptureAvailable()) {
      captureStatusRef.current = 'DESATIVADA';
      setCaptureStatus('DESATIVADA');
      return;
    }

    try {
      await stopScreenCapture();
      captureStatusRef.current = 'DESATIVADA';
      setCaptureStatus('DESATIVADA');
      setCaptureError(null);
    } catch (captureStopError) {
      const message = captureStopError instanceof Error
        ? captureStopError.message
        : 'Não foi possível interromper a captura.';
      captureStatusRef.current = 'ERRO';
      setCaptureStatus('ERRO');
      setCaptureError(message);
    }
  };

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
    collectionComplete,
    error,
    setRegion,
    startAnalysis,
    stopAnalysis,
    clearError: () => {
      setMarketError(null);
      setCaptureError(null);
      setHistoryError(null);
    },
  }), [
    analysis,
    analysisStatus,
    captureHistory,
    captureStatus,
    collectionComplete,
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