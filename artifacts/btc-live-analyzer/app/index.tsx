import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { AnalyzerProvider, useAnalyzer } from '@/context/AnalyzerContext';
import { CrossConfirmationDetails } from '@/components/CrossConfirmationDetails';
import { DEFAULT_ANALYSIS_WINDOW_MS } from '@/lib/analysis';
import type { ChartPoint } from '@/lib/analysis';
import type { CaptureRegion } from '@/lib/screenCapture';
import { AnalysisHistory } from '@/components/AnalysisHistory';
import { AnalysisTestPanel } from '@/components/AnalysisTestPanel';

const signalColor = {
  'POSSÍVEL COMPRA': '#55d6a6',
  'POSSÍVEL VENDA': '#ee6f5c',
  AGUARDAR: '#f3b63f',
} as const;

const centralRegion: CaptureRegion = { left: 8, top: 24, width: 84, height: 48 };

function formatHistoryProgress(durationMs: number) {
  const totalSeconds = Math.floor(Math.min(durationMs, DEFAULT_ANALYSIS_WINDOW_MS) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds} / 5:00`;
}

function StatusPill({ label, active, tone }: { label: string; active: boolean; tone: 'green' | 'blue' }) {
  const colors = useColors();
  return (
    <View style={[styles.statusPill, { backgroundColor: active ? (tone === 'green' ? '#123b35' : '#17334a') : colors.muted }]}>
      <View style={[styles.statusDot, { backgroundColor: active ? (tone === 'green' ? '#55d6a6' : '#72b8e8') : colors.mutedForeground }]} />
      <Text style={[styles.statusPillText, { color: active ? (tone === 'green' ? '#9be3d2' : '#a7d8f7') : colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

function SignalBadge({ signal }: { signal: 'POSSÍVEL COMPRA' | 'POSSÍVEL VENDA' | 'AGUARDAR' }) {
  const colors = useColors();
  return (
    <View style={[styles.signalBadge, { backgroundColor: `${signalColor[signal]}18`, borderColor: `${signalColor[signal]}66` }]}>
      <View style={[styles.signalDot, { backgroundColor: signalColor[signal] }]} />
      <Text style={[styles.signalText, { color: signalColor[signal] }]}>{signal}</Text>
    </View>
  );
}

function ChartPreview({ points, currentPrice }: { points: ChartPoint[]; currentPrice: number | null }) {
  const colors = useColors();
  const visiblePoints = points.slice(-60);
  const prices = visiblePoints.map((point) => point.price);
  const minimum = prices.length > 0 ? Math.min(...prices) : 0;
  const maximum = prices.length > 0 ? Math.max(...prices) : 0;
  const rawRange = maximum - minimum;
  const displayRange = rawRange > 0 ? rawRange * 1.2 : Math.max(maximum * 0.001, 1);
  const displayMinimum = rawRange > 0 ? minimum - rawRange * 0.1 : minimum - displayRange / 2;
  const linePoints = visiblePoints.map((point, index) => {
    const x = 8 + (index / Math.max(visiblePoints.length - 1, 1)) * 304;
    const y = 6 + ((displayMinimum + displayRange - point.price) / displayRange) * 80;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const trendColor = visiblePoints.length < 2
    ? colors.primary
    : visiblePoints[visiblePoints.length - 1].price >= visiblePoints[0].price
      ? '#55d6a6'
      : '#ee6f5c';

  const formatPrice = (price: number | null) => price === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(price);

  return (
    <View style={[styles.chartPreview, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.chartLabelRow}>
        <Text style={[styles.chartLabel, { color: colors.mutedForeground }]}>BTC/USD · KRAKEN</Text>
        <Text style={[styles.chartPrice, { color: colors.foreground }]}>{formatPrice(currentPrice)}</Text>
      </View>
      <View style={styles.chartLines}>
        <Svg width="100%" height="100%" viewBox="0 0 320 92" preserveAspectRatio="none">
          {[16, 46, 76].map((y) => (
            <Line key={y} x1="0" x2="320" y1={y} y2={y} stroke={colors.border} strokeWidth="1" />
          ))}
          {visiblePoints.length > 1 ? (
            <Polyline
              points={linePoints}
              fill="none"
              stroke={trendColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {visiblePoints.length === 1 ? (
            <Circle cx="160" cy="46" r="3.5" fill={trendColor} />
          ) : null}
        </Svg>
        {visiblePoints.length < 2 ? (
          <View style={styles.chartEmptyState}>
            <Text style={[styles.chartEmptyText, { color: colors.mutedForeground }]}>
              {visiblePoints.length === 1 ? 'Aguardando mais cotações reais…' : 'Inicie para receber preços ao vivo'}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function AnalyzerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const analyzer = useAnalyzer();
  const [showRegion, setShowRegion] = useState<boolean>(false);
  const [draftRegion, setDraftRegion] = useState<CaptureRegion>(analyzer.region);

  const handleStart = async () => {
    await Haptics.selectionAsync();
    await analyzer.startAnalysis();
  };

  const handleStop = async () => {
    await Haptics.selectionAsync();
    await analyzer.stopAnalysis();
  };

  const openRegion = () => {
    setDraftRegion(analyzer.region);
    setShowRegion(true);
  };

  const confirmRegion = () => {
    analyzer.setRegion(draftRegion);
    setShowRegion(false);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 18, paddingBottom: Math.max(insets.bottom, 28) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.primary }]}>BTC / USD</Text>
            <Text style={[styles.title, { color: colors.foreground }]}>Live Analyzer</Text>
          </View>
          <View style={[styles.headerIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="activity" size={20} color={colors.primary} />
          </View>
        </View>

        <View style={styles.statusRow}>
          <StatusPill label={`CAPTURA ${analyzer.captureStatus}`} active={analyzer.captureStatus === 'ATIVA'} tone="green" />
          <StatusPill label={analyzer.analysisStatus} active={analyzer.marketStatus === 'CONECTADO'} tone="blue" />
        </View>

        {analyzer.isRunning ? (
          <Text testID="continuous-analysis-status" style={[styles.continuousStatus, { color: colors.accentForeground }]}>
            ANÁLISE CONTÍNUA ATIVA · CICLO {analyzer.cycleNumber}
          </Text>
        ) : null}

        {Platform.OS === 'android' ? (
          <Text testID="android-background-status" style={[styles.heroReason, { color: colors.mutedForeground }]}>
            {analyzer.backgroundAvailable
              ? 'Segundo plano Android: serviço nativo com notificação permanente. Sujeito aos limites de bateria e execução do sistema; Forçar parada encerra a análise.'
              : 'Expo Go/build sem serviço: análise somente com o app aberto. Segundo plano exige um APK Android com o módulo nativo.'}
          </Text>
        ) : null}

        {analyzer.completedCycle ? (
          <View
            testID="cycle-completion-notice"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[styles.cycleNotice, { backgroundColor: colors.secondary, borderColor: signalColor[analyzer.completedCycle.signal] }]}
          >
            <View style={styles.errorCopy}>
              <Text style={[styles.sectionEyebrow, { color: colors.mutedForeground }]}>CICLO DE 5 MINUTOS CONCLUÍDO</Text>
              <Text testID="completed-cycle-signal" style={[styles.cycleNoticeSignal, { color: signalColor[analyzer.completedCycle.signal] }]}>
                {analyzer.completedCycle.signal}
              </Text>
              <Text style={[styles.heroReason, { color: colors.foreground }]}>
                Tendência: {analyzer.completedCycle.direction} · Confirmação: {analyzer.completedCycle.confidence}%
              </Text>
              <CrossConfirmationDetails comparison={analyzer.completedCycle.crossConfirmation} />
              <Text style={[styles.heroReason, { color: colors.mutedForeground }]}>
                {analyzer.isRunning ? 'Resultado no histórico. A análise contínua permanece ativa.' : 'Resultado no histórico. Coleta interrompida.'}
              </Text>
            </View>
            <Pressable testID="dismiss-cycle-notice" accessibilityRole="button" accessibilityLabel="Fechar aviso do ciclo concluído" onPress={analyzer.dismissCycleNotice} hitSlop={10}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ) : null}

        {analyzer.error ? (
          <View style={[styles.errorBox, { backgroundColor: '#301e1c', borderColor: '#754039' }]}>
            <Feather name="info" size={17} color="#ee6f5c" />
            <View style={styles.errorCopy}>
              <Text style={styles.errorTitle}>Aviso do aplicativo</Text>
              <Text style={styles.errorText}>{analyzer.error}</Text>
            </View>
            <Pressable onPress={analyzer.clearError} hitSlop={10}>
              <Feather name="x" size={18} color="#ee6f5c" />
            </Pressable>
          </View>
        ) : null}

        <View testID="current-analysis" style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.heroTop}>
            <View>
              <Text style={[styles.sectionEyebrow, { color: colors.mutedForeground }]}>CICLO ATUAL</Text>
              <Text style={[styles.signalHeadline, { color: signalColor[analyzer.analysis.signal] }]}>{analyzer.analysis.signal}</Text>
            </View>
            <SignalBadge signal={analyzer.analysis.signal} />
          </View>
          <Text style={[styles.heroReason, { color: colors.mutedForeground }]}>{analyzer.analysis.reason}</Text>
          <View style={[styles.heroDivider, { backgroundColor: colors.border }]} />
          <View style={styles.metricRow}>
            <View style={styles.metric}>
              <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>TENDÊNCIA</Text>
              <Text style={[styles.metricValue, { color: colors.foreground }]}>{analyzer.analysis.trend}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>CONFIRMAÇÃO</Text>
              <Text style={[styles.metricValue, { color: colors.foreground }]}>{analyzer.analysis.confidence}%</Text>
            </View>
            <View style={styles.metric}>
              <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>CICLO {analyzer.cycleNumber}</Text>
              <Text testID="cycle-progress" style={[styles.metricValue, { color: colors.foreground }]}>{formatHistoryProgress(analyzer.historyDurationMs)}</Text>
            </View>
          </View>
        </View>

        <ChartPreview points={analyzer.history} currentPrice={analyzer.currentPrice} />

        <View style={styles.actionRow}>
          <Pressable
            testID="start-analysis"
            onPress={handleStart}
            disabled={analyzer.isRunning}
            style={({ pressed }) => [styles.primaryButton, { backgroundColor: analyzer.isRunning ? colors.muted : colors.primary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Feather name="play" size={17} color={analyzer.isRunning ? colors.mutedForeground : colors.primaryForeground} />
            <Text style={[styles.primaryButtonText, { color: analyzer.isRunning ? colors.mutedForeground : colors.primaryForeground }]}>
              {analyzer.isRunning ? 'ANALISANDO' : 'INICIAR ANÁLISE'}
            </Text>
          </Pressable>
          <Pressable
            testID="stop-analysis"
            onPress={handleStop}
            disabled={!analyzer.isRunning}
            style={({ pressed }) => [styles.secondaryButton, { borderColor: analyzer.isRunning ? colors.destructive : colors.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="square" size={15} color={analyzer.isRunning ? colors.destructive : colors.mutedForeground} />
            <Text style={[styles.secondaryButtonText, { color: analyzer.isRunning ? colors.destructive : colors.mutedForeground }]}>
              PARAR
            </Text>
          </Pressable>
        </View>

        <Pressable testID="select-chart-region" onPress={openRegion} style={({ pressed }) => [styles.regionButton, { backgroundColor: colors.secondary, opacity: pressed ? 0.75 : 1 }]}>
          <View style={[styles.regionIcon, { backgroundColor: colors.accent }]}>
            <Feather name="crop" size={18} color={colors.accentForeground} />
          </View>
          <View style={styles.regionCopy}>
            <Text style={[styles.regionTitle, { color: colors.foreground }]}>Área da captura local</Text>
            <Text style={[styles.regionSubtitle, { color: colors.mutedForeground }]}>{analyzer.region.width}% × {analyzer.region.height}% da tela</Text>
          </View>
          <Feather name="chevron-right" size={19} color={colors.mutedForeground} />
        </Pressable>

        <AnalysisHistory records={analyzer.signalHistory} />

        <AnalysisTestPanel />

        <View style={styles.disclaimer}>
          <Feather name="shield" size={14} color={colors.mutedForeground} />
          <Text style={[styles.disclaimerText, { color: colors.mutedForeground }]}>Sinais técnicos não garantem resultados. O app não executa ordens.</Text>
        </View>
      </ScrollView>

      <Modal visible={showRegion} transparent animationType="slide" onRequestClose={() => setShowRegion(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalEyebrow, { color: colors.primary }]}>CONFIGURAÇÃO</Text>
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Área da captura local</Text>
              </View>
              <Pressable onPress={() => setShowRegion(false)} hitSlop={12}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <Text style={[styles.modalText, { color: colors.mutedForeground }]}>Esta área continua disponível para a captura de tela local. Os sinais desta tela usam cotações públicas reais de BTC/USD.</Text>
            <View style={[styles.regionDemo, { borderColor: colors.border, backgroundColor: colors.background }]}>
              <View style={[styles.demoFrame, { borderColor: colors.border }]} />
              <View style={[styles.demoSelection, { borderColor: colors.primary, backgroundColor: `${colors.primary}16` }]} />
              <Text style={[styles.demoText, { color: colors.mutedForeground }]}>Pré-visualização da região</Text>
            </View>
            <View style={styles.presetRow}>
              {[
                { label: 'Gráfico amplo', value: { left: 5, top: 18, width: 90, height: 56 } },
                { label: 'Gráfico central', value: centralRegion },
              ].map((preset) => (
                <Pressable key={preset.label} onPress={() => setDraftRegion(preset.value)} style={[styles.preset, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                  <Text style={[styles.presetText, { color: colors.foreground }]}>{preset.label}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable onPress={confirmRegion} style={[styles.confirmButton, { backgroundColor: colors.primary }]}>
              <Text style={[styles.confirmButtonText, { color: colors.primaryForeground }]}>SALVAR ÁREA</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function Index() {
  return (
    <AnalyzerProvider>
      <AnalyzerScreen />
    </AnalyzerProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 12, fontFamily: 'Inter_700Bold', letterSpacing: 1.6 },
  title: { fontSize: 31, fontFamily: 'Inter_700Bold', letterSpacing: -1.2, marginTop: 3 },
  headerIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  continuousStatus: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_700Bold' },
  cycleNotice: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, flexDirection: 'row', alignItems: 'flex-start' },
  cycleNoticeSignal: { fontSize: 20, fontFamily: 'Inter_700Bold', marginVertical: 5 },
  statusPill: { borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusPillText: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.7 },
  errorBox: { borderWidth: 1, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  errorCopy: { flex: 1, gap: 3 },
  errorTitle: { color: '#f7c5bc', fontSize: 13, fontFamily: 'Inter_700Bold' },
  errorText: { color: '#e9a69b', fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  heroCard: { borderWidth: 1, borderRadius: 22, padding: 20, gap: 14 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  sectionEyebrow: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.3 },
  signalHeadline: { fontSize: 39, fontFamily: 'Inter_700Bold', letterSpacing: -1.5, marginTop: 4 },
  signalBadge: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', gap: 7, alignItems: 'center' },
  signalDot: { width: 7, height: 7, borderRadius: 4 },
  signalText: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
  heroReason: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular' },
  heroDivider: { height: 1 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metric: { gap: 5 },
  metricLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },
  metricValue: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  chartPreview: { height: 164, borderRadius: 20, borderWidth: 1, overflow: 'hidden', padding: 14, gap: 8 },
  chartLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chartLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  chartPrice: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  chartLines: { flex: 1, position: 'relative', overflow: 'hidden' },
  chartEmptyState: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  chartEmptyText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  actionRow: { flexDirection: 'row', gap: 10 },
  primaryButton: { flex: 1, minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  primaryButtonText: { fontSize: 12, fontFamily: 'Inter_700Bold', letterSpacing: 0.7 },
  secondaryButton: { minHeight: 52, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  secondaryButtonText: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 0.7 },
  regionButton: { minHeight: 70, borderRadius: 18, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  regionIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  regionCopy: { flex: 1, gap: 5 },
  regionTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  regionSubtitle: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  disclaimer: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 2 },
  disclaimerText: { flex: 1, fontSize: 10, lineHeight: 15, fontFamily: 'Inter_400Regular' },
  modalBackdrop: { flex: 1, backgroundColor: '#020807B8', justifyContent: 'flex-end' },
  modalCard: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, padding: 20, gap: 16 },
  modalHandle: { width: 38, height: 4, backgroundColor: '#52736b', borderRadius: 2, alignSelf: 'center', marginBottom: 2 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  modalEyebrow: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.2 },
  modalTitle: { fontSize: 25, fontFamily: 'Inter_700Bold', marginTop: 4 },
  modalText: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular' },
  regionDemo: { height: 142, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  demoFrame: { width: '80%', height: '64%', borderWidth: 1, borderRadius: 6 },
  demoSelection: { position: 'absolute', width: '62%', height: '45%', borderWidth: 2, borderRadius: 6 },
  demoText: { position: 'absolute', bottom: 12, fontSize: 10, fontFamily: 'Inter_500Medium' },
  presetRow: { flexDirection: 'row', gap: 10 },
  preset: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  presetText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  confirmButton: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  confirmButtonText: { fontSize: 12, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
});