import AsyncStorage from '@react-native-async-storage/async-storage';
import { acquireBinanceMarketFeed, binanceMarketFeed } from '@/lib/binanceMarketData';
import type { BinanceFeedSnapshot } from '@/lib/binanceMarketData';
import { createCrossConfirmedAnalyzer } from '@/lib/crossConfirmation';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import {
  analyzeChart,
  DEFAULT_ANALYSIS_WINDOW_MS,
} from '@/lib/analysis';
import type { ChartPoint, OhlcCandle, Signal } from '@/lib/analysis';
import { connectBtcUsdTicker } from '@/lib/marketData';
import type { MarketFeedConnection, MarketFeedStatus, MarketPricePoint } from '@/lib/marketData';
import {
  CaptureRegion,
  CaptureStatus,
  isNativeCaptureAvailable,
  getScreenCaptureState,
  requestScreenCapturePermission,
  startScreenCapture,
  stopScreenCapture,
  subscribeCaptureFrames,
  subscribeCaptureState,
} from '@/lib/screenCapture';
import { notifySignal, prepareNotifications } from '@/lib/notifications';
import { createAnalysisHistoryStore, mergeAnalysisHistory } from '@/lib/analysisHistory';
import type { AnalysisRecord } from '@/lib/analysisHistory';
import { createContinuousCollection } from '@/lib/continuousCollection';
import { getBackgroundAnalysisSnapshot, isBackgroundAnalysisAvailable, nativeBackgroundAnalysis, subscribeBackgroundAnalysis } from '@/lib/backgroundAnalysis';
import type { AnalysisSessionSnapshot } from '@/lib/analysisSession';
import { createSignalLearningStore } from '@/lib/signalLearning';
import type { LearningSnapshot } from '@/lib/signalLearning';

export type SignalRecord = AnalysisRecord;
const analyzeCrossConfirmed = createCrossConfirmedAnalyzer(analyzeChart, binanceMarketFeed.getSnapshot);

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
  krakenCandles: OhlcCandle[];
  binanceSnapshot: BinanceFeedSnapshot;
  analysisNow: number;
  captureHistory: CaptureHistoryPoint[];
  historyDurationMs: number;
  currentPrice: number | null;
  lastPriceAt: number | null;
  signalHistory: SignalRecord[];
  learning: LearningSnapshot;
  region: CaptureRegion;
  lastSignal: Signal;
  lastSignalAt: number | null;
  analysis: ReturnType<typeof analyzeChart>;
  cycleNumber: number;
  completedCycle: SignalRecord | null;
  backgroundAvailable: boolean;
  dismissCycleNotice: () => void;
  error: string | null;
  setRegion: (region: CaptureRegion) => void;
  startAnalysis: () => Promise<void>;
  stopAnalysis: () => Promise<void>;
  clearAnalysisHistory: () => Promise<void>;
  clearError: () => void;
};

const REGION_KEY = '@btc-live-analyzer/region';
const defaultRegion: CaptureRegion = { left: 8, top: 24, width: 84, height: 48 };
const CAPTURE_FRAME_SAMPLE_INTERVAL_MS = 15 * 1000;
const CANDLE_HISTORY_LIMIT = 60;
const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

function upsertCandle(history: readonly OhlcCandle[], candle: OhlcCandle): OhlcCandle[] {
  return [
    ...history.filter((item) => item.timestamp !== candle.timestamp),
    { ...candle },
  ].sort((left, right) => left.timestamp - right.timestamp).slice(-CANDLE_HISTORY_LIMIT);
}

export function AnalyzerProvider({ children }: { children: React.ReactNode }) {
  const [marketStatus, setMarketStatus] = useState<MarketFeedStatus>('DESATIVADA');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('DESATIVADA');
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [marketCandles, setMarketCandles] = useState<OhlcCandle[]>([]);
  const [binanceSnapshot, setBinanceSnapshot] = useState<BinanceFeedSnapshot>(
    () => binanceMarketFeed.getSnapshot(),
  );
  const [captureHistory, setCaptureHistory] = useState<CaptureHistoryPoint[]>([]);
  const [collectionStartedAt, setCollectionStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [cycleNumber, setCycleNumber] = useState(1);
  const [completedCycle, setCompletedCycle] = useState<SignalRecord | null>(null);
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
  const learningStore = useMemo(() => createSignalLearningStore(AsyncStorage), []);
  const [learning, setLearning] = useState<LearningSnapshot>(() => learningStore.snapshot());
  const marketConnection = useRef<MarketFeedConnection | null>(null);
  const candleHistoryRef = useRef<OhlcCandle[]>([]);
  const releaseBinanceFeed = useRef<(() => void) | null>(null);
  const captureStatusRef = useRef<CaptureStatus>('DESATIVADA');
  const runGeneration = useRef(0);
  const backgroundRunning = useRef(false);
  const starting = useRef(false);
  const dismissedCycle = useRef<number | null>(null);
  const dismissedBackgroundError = useRef<string | null>(null);
  const collection = useMemo(() => createContinuousCollection({
    windowMs: DEFAULT_ANALYSIS_WINDOW_MS,
    onUpdate: (state) => {
      setCollectionStartedAt(state.startedAt);
      setClockNow(state.now);
      setCycleNumber(state.cycleNumber);
      setHistory(state.points);
    },
    onComplete: (points, completedAt) => {
      const result = analyzeCrossConfirmed(
        [...points],
        DEFAULT_ANALYSIS_WINDOW_MS,
        completedAt,
        candleHistoryRef.current,
      );
      const record: SignalRecord = {
        timestamp: completedAt,
        signal: result.signal,
        direction: result.trend,
        confidence: result.confidence,
        durationMs: DEFAULT_ANALYSIS_WINDOW_MS,
        reason: result.reason,
        crossConfirmation: result.crossConfirmation,
      };
      learningStore.register(record);
      setLastSignal(result.signal);
      setLastSignalAt(completedAt);
      setCompletedCycle(record);
      setCaptureHistory([]);
      setSignalHistory((current) => mergeAnalysisHistory(current, [record]));
      void historyStore.append(record)
        .then(() => {
          setHistoryError(null);
        })
        .catch(() => setHistoryError('Análise mantida nesta sessão, mas não foi possível salvar o histórico no dispositivo.'));
      const recommendation = result.signal === 'AGUARDAR' ? null : learningStore.recommendation(result.signal);
      void notifySignal(result.signal, result.confidence, result.trend, recommendation)
        .catch(() => setMarketError('O ciclo foi concluído, mas a notificação não pôde ser exibida.'));
    },
  }), [historyStore, learningStore]);

  useEffect(() => {
    const unsubscribe = learningStore.subscribe(setLearning);
    setLearning(learningStore.snapshot());
    void learningStore.load().catch(() => undefined); // Error is shown in the learning panel.
    return unsubscribe;
  }, [learningStore]);

  useEffect(() => {
    const syncSnapshot = () => setBinanceSnapshot(binanceMarketFeed.getSnapshot());
    const unsubscribe = binanceMarketFeed.subscribe(syncSnapshot);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncSnapshot();
    });
    syncSnapshot();
    return () => {
      unsubscribe();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const native = nativeBackgroundAnalysis;
    if (!native) return;
    let active = true;
    function restore(state: AnalysisSessionSnapshot) {
      if (!active) return;
      backgroundRunning.current = state.isRunning;
      setIsRunning(state.isRunning);
      setMarketStatus(state.marketStatus);
      setHistory(state.history);
      candleHistoryRef.current = state.candles ?? [];
      setMarketCandles(candleHistoryRef.current);
      setCollectionStartedAt(state.collectionStartedAt);
      setClockNow(state.clockNow);
      setCycleNumber(state.cycleNumber);
      setCurrentPrice(state.currentPrice);
      setLastPriceAt(state.lastPriceAt);
      setCompletedCycle(state.completedCycle?.timestamp === dismissedCycle.current ? null : state.completedCycle);
      // Completed history comes from the shared persistent store, not a stale
      // Android snapshot that could restore entries after manual deletion.
      if (!state.error) dismissedBackgroundError.current = null;
      setMarketError(state.error === dismissedBackgroundError.current ? null : state.error);
      if (state.completedCycle) {
        setLastSignal(state.completedCycle.signal);
        setLastSignalAt(state.completedCycle.timestamp);
      }
    }
    const subscription = subscribeBackgroundAnalysis(restore);
    // Native startup may fail before Headless JS begins publishing. Likewise,
    // a destroyed service must not leave a stale "running" UI behind.
    const stopSubscription = native.addListener('onAnalysisStop', (payload) => {
      void native.isActive().then(async (running) => {
        if (!active || running) return;
        const stoppedGeneration = ++runGeneration.current;
        backgroundRunning.current = false;
        setIsRunning(false);
        setMarketStatus('DESATIVADA');
        setCurrentPrice(null);
        setLastPriceAt(null);
        if (payload.message && payload.message !== 'Análise interrompida pelo usuário.' && payload.message !== 'Serviço Android interrompido.') {
          setMarketError(payload.message);
        }
        const state = await getBackgroundAnalysisSnapshot();
        if (!active || stoppedGeneration !== runGeneration.current) return;
        if (state && !state.isRunning) restore(state);
        await stopScreenCapture();
      }).catch(() => {
        if (active) setMarketError('Não foi possível consultar a parada do serviço Android.');
      });
    });
    let refreshGeneration = 0;
    async function refreshNativeState() {
      if (starting.current) return; // Permission Activity is not a new analysis run.
      const generation = ++refreshGeneration;
      const run = runGeneration.current;
      const [running, state, capture] = await Promise.all([
        native!.isActive(), getBackgroundAnalysisSnapshot(), getScreenCaptureState(),
      ]);
      if (!active || generation !== refreshGeneration || run !== runGeneration.current || starting.current) return;
      if (state) restore({
        ...state,
        isRunning: running,
        marketStatus: running ? state.marketStatus : 'DESATIVADA',
        currentPrice: running ? state.currentPrice : null,
        lastPriceAt: running ? state.lastPriceAt : null,
      });
      else {
        backgroundRunning.current = running;
        setIsRunning(running);
        if (!running) setMarketStatus('DESATIVADA');
      }
      captureStatusRef.current = capture.status;
      setCaptureStatus(capture.status);
      setCaptureError(capture.message ?? (capture.status === 'ERRO' ? 'A captura foi interrompida.' : null));
    }
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshNativeState().catch(() => {
        if (active) setMarketError('Não foi possível consultar o estado real dos serviços Android.');
      });
    });
    void refreshNativeState().catch(() => {
      if (active) setMarketError('Não foi possível restaurar o estado do serviço Android.');
    });
    return () => { active = false; subscription.remove(); stopSubscription.remove(); appStateSubscription.remove(); };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(REGION_KEY)
      .then((storedRegion) => {
        if (storedRegion) setRegionState(JSON.parse(storedRegion) as CaptureRegion);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = historyStore.subscribe((saved) => {
      if (active) setSignalHistory(saved);
    });
    historyStore.load()
      .catch(() => {
        if (active) setHistoryError('Não foi possível carregar o histórico salvo. Os dados antigos não serão sobrescritos.');
      });
    return () => { active = false; unsubscribe(); };
  }, [historyStore]);

  useEffect(() => {
    const stateSubscription = subscribeCaptureState((status, message) => {
      captureStatusRef.current = status;
      setCaptureStatus(status);
      if (status === 'ERRO' || message) setCaptureError(message ?? 'O serviço de captura encontrou um erro.');
      if (status === 'ATIVA') setCaptureError(null);
    });
    const frameSubscription = subscribeCaptureFrames((frame) => {
      if (!collection.isRunning() && !backgroundRunning.current) return;
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
  }, [collection]);

  useEffect(() => () => {
    runGeneration.current += 1;
    collection.stop();
    if (!backgroundRunning.current) learningStore.interrupt();
    marketConnection.current?.close();
    marketConnection.current = null;
    releaseBinanceFeed.current?.();
    releaseBinanceFeed.current = null;
  }, [collection]);

  const historyDurationMs = collectionStartedAt !== null
      ? Math.min(
          DEFAULT_ANALYSIS_WINDOW_MS,
          Math.max(0, clockNow - collectionStartedAt),
        )
      : 0;
  const analysisNow = collectionStartedAt === null
    ? lastPriceAt ?? 0
    : Math.min(clockNow, collectionStartedAt + DEFAULT_ANALYSIS_WINDOW_MS - 1);
  const analysis = useMemo(
    () => analyzeChart(history, DEFAULT_ANALYSIS_WINDOW_MS, analysisNow, marketCandles),
    [analysisNow, history, marketCandles],
  );
  const analysisStatus = marketStatus === 'RECONECTANDO'
      ? 'RECONECTANDO'
      : marketStatus === 'CONECTANDO'
        ? 'CONECTANDO'
        : marketStatus === 'CONECTADO' && collectionStartedAt === null
          ? 'AGUARDANDO DADOS'
        : marketStatus === 'CONECTADO' && historyDurationMs < DEFAULT_ANALYSIS_WINDOW_MS
          ? 'COLETANDO DADOS'
          : marketStatus === 'CONECTADO'
            ? 'ANALISANDO'
            : 'AGUARDANDO DADOS';
  const error = marketError ?? captureError ?? historyError;

  const setRegion = (nextRegion: CaptureRegion) => {
    setRegionState(nextRegion);
    AsyncStorage.setItem(REGION_KEY, JSON.stringify(nextRegion)).catch(() => undefined);
  };

  const clearAnalysisHistory = async () => {
    try {
      await historyStore.clear();
      setHistoryError(null);
    } catch (error) {
      setHistoryError('Não foi possível apagar o histórico no dispositivo. Tente novamente.');
      throw error;
    }
  };

  const startAnalysis = async () => {
    if (collection.isRunning() || backgroundRunning.current || starting.current) return;
    starting.current = true;
    const generation = ++runGeneration.current;
    try {
    await learningStore.load().catch(() => undefined);
    if (generation !== runGeneration.current) return;
    if (nativeBackgroundAnalysis) {
      if (await nativeBackgroundAnalysis.isActive()) return;
      const permitted = await prepareNotifications();
      if (!permitted) {
        const proceed = await new Promise<boolean>((resolve) => Alert.alert(
          'Notificações desativadas',
          'O Android não autorizou as notificações. A coleta pode continuar, mas os avisos dos ciclos não aparecerão. Você pode permitir notificações nas configurações do aplicativo.',
          [
            { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Continuar sem avisos', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ));
        if (!proceed || generation !== runGeneration.current) return;
      }
      if (generation !== runGeneration.current) return;
    }
    marketConnection.current?.close();
    marketConnection.current = null;
    releaseBinanceFeed.current?.();
    releaseBinanceFeed.current = null;
    if (!nativeBackgroundAnalysis) {
      collection.start();
      releaseBinanceFeed.current = acquireBinanceMarketFeed();
    }
    setIsRunning(true);
    setCompletedCycle(null);
    setMarketError(null);
    setCaptureError(null);
    setHistory([]);
    setCaptureHistory([]);
    setCollectionStartedAt(null);
    setClockNow(0);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    setMarketStatus('CONECTANDO');

    if (nativeBackgroundAnalysis) {
      await nativeBackgroundAnalysis.start();
      backgroundRunning.current = true;
    } else {
    marketConnection.current = connectBtcUsdTicker({
      onPrice: (point: MarketPricePoint) => {
        if (generation !== runGeneration.current || !collection.isRunning()) return;
        setCurrentPrice(point.price);
        setLastPriceAt(point.timestamp);
        setMarketError(null);
        collection.push(point);
        learningStore.observe(point);
      },
      onCandle: (candle) => {
        if (generation !== runGeneration.current || !collection.isRunning()) return;
        candleHistoryRef.current = upsertCandle(candleHistoryRef.current, candle);
        setMarketCandles(candleHistoryRef.current);
      },
      onStatus: (status: MarketFeedStatus) => {
        if (generation !== runGeneration.current || !collection.isRunning()) return;
        setMarketStatus(status);
        if (status === 'RECONECTANDO') {
          learningStore.interrupt();
          collection.reconnect();
          setCaptureHistory([]);
          setCurrentPrice(null);
          setLastPriceAt(null);
        }
      },
      onError: (message) => {
        if (generation === runGeneration.current && collection.isRunning()) setMarketError(message);
      },
    });
    }

    if (Platform.OS !== 'web' && !nativeBackgroundAnalysis) await prepareNotifications();
    if (generation !== runGeneration.current || (!collection.isRunning() && !backgroundRunning.current)) return;
    if (!isNativeCaptureAvailable()) {
      captureStatusRef.current = 'DESATIVADA';
      setCaptureStatus('DESATIVADA');
      return;
    }

    captureStatusRef.current = 'SOLICITANDO PERMISSÃO';
    setCaptureStatus('SOLICITANDO PERMISSÃO');
    try {
      const permission = await requestScreenCapturePermission();
      if (generation !== runGeneration.current || (!collection.isRunning() && !backgroundRunning.current)) return;
      if (!permission.granted) {
        captureStatusRef.current = permission.status;
        setCaptureStatus(permission.status);
        setCaptureError(permission.message ?? 'A autorização de captura não foi concedida.');
        return;
      }
      await startScreenCapture(region);
      if (generation !== runGeneration.current || (!collection.isRunning() && !backgroundRunning.current)) {
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
    } catch (startError) {
      backgroundRunning.current = false;
      collection.stop();
      marketConnection.current?.close();
      marketConnection.current = null;
      releaseBinanceFeed.current?.();
      releaseBinanceFeed.current = null;
      setIsRunning(false);
      setMarketStatus('DESATIVADA');
      setMarketError(startError instanceof Error ? startError.message : 'Não foi possível iniciar a análise.');
      if (nativeBackgroundAnalysis) await nativeBackgroundAnalysis.stop().catch(() => undefined);
    } finally {
      starting.current = false;
    }
  };

  const stopAnalysis = async () => {
    runGeneration.current += 1;
    learningStore.interrupt();
    backgroundRunning.current = false;
    collection.stop();
    setIsRunning(false);
    marketConnection.current?.close();
    marketConnection.current = null;
    releaseBinanceFeed.current?.();
    releaseBinanceFeed.current = null;
    setMarketStatus('DESATIVADA');
    setHistory([]);
    setCaptureHistory([]);
    setCollectionStartedAt(null);
    setClockNow(0);
    setCurrentPrice(null);
    setLastPriceAt(null);
    setLastSignal('AGUARDAR');
    setLastSignalAt(null);
    if (nativeBackgroundAnalysis) {
      try { await nativeBackgroundAnalysis.stop(); }
      catch {
        const mayStillBeActive = await nativeBackgroundAnalysis.isActive().catch(() => true);
        backgroundRunning.current = mayStillBeActive;
        setIsRunning(mayStillBeActive);
        setMarketError('Não foi possível confirmar a parada do serviço Android. Verifique a notificação permanente.');
      }
    }
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
    krakenCandles: marketCandles,
    binanceSnapshot,
    analysisNow,
    captureHistory,
    historyDurationMs,
    currentPrice,
    lastPriceAt,
    signalHistory,
    learning,
    region,
    lastSignal,
    lastSignalAt,
    analysis,
    cycleNumber,
    completedCycle,
    backgroundAvailable: isBackgroundAnalysisAvailable(),
    dismissCycleNotice: () => {
      dismissedCycle.current = completedCycle?.timestamp ?? null;
      setCompletedCycle(null);
    },
    error,
    setRegion,
    startAnalysis,
    stopAnalysis,
    clearAnalysisHistory,
    clearError: () => {
      dismissedBackgroundError.current = marketError;
      setMarketError(null);
      setCaptureError(null);
      setHistoryError(null);
    },
  }), [
    analysis,
    analysisStatus,
    captureHistory,
    captureStatus,
    binanceSnapshot,
    cycleNumber,
    completedCycle,
    currentPrice,
    error,
    history,
    historyDurationMs,
    isRunning,
    lastPriceAt,
    lastSignal,
    lastSignalAt,
    marketStatus,
    analysisNow,
    marketCandles,
    region,
    signalHistory,
    learning,
  ]);

  return <AnalyzerContext.Provider value={value}>{children}</AnalyzerContext.Provider>;
}

export function useAnalyzer() {
  const context = useContext(AnalyzerContext);
  if (!context) throw new Error('useAnalyzer must be used inside AnalyzerProvider');
  return context;
}