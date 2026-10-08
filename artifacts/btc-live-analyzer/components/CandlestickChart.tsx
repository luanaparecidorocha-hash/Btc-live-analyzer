import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import type { AnalysisResult, OhlcCandle } from '@/lib/analysis';

export type ChartSource = 'KRAKEN' | 'BINANCE';

type CandlestickChartProps = {
  source: ChartSource;
  onSourceChange: (source: ChartSource) => void;
  candles: readonly OhlcCandle[];
  currentPrice: number | null;
  analysis: AnalysisResult;
  feedStatus: 'DESATIVADA' | 'CONECTANDO' | 'CONECTADO' | 'RECONECTANDO';
};

const VIEW_WIDTH = 360;
const PLOT_LEFT = 10;
const PLOT_RIGHT = 282;
const PRICE_AXIS_X = 291;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 144;
const GRID_COUNT = 4;
const signalLabels: AnalysisResult['signal'][] = [
  'POSSÍVEL COMPRA',
  'POSSÍVEL VENDA',
  'AGUARDAR',
];

function formatPrice(price: number | null) {
  return price === null
    ? '—'
    : `$${new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(price)}`;
}

function formatAxisPrice(price: number) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(price);
}

function formatCandleTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function CandlestickChart({
  source,
  onSourceChange,
  candles,
  currentPrice,
  analysis,
  feedStatus,
}: CandlestickChartProps) {
  const colors = useColors();
  const minimum = candles.length > 0 ? Math.min(...candles.map((candle) => candle.low)) : 0;
  const maximum = candles.length > 0 ? Math.max(...candles.map((candle) => candle.high)) : 0;
  const rawRange = maximum - minimum;
  const padding = rawRange > 0
    ? rawRange * 0.12
    : Math.max(Math.abs(maximum) * 0.001, 1);
  const displayMinimum = minimum - padding;
  const displayMaximum = maximum + padding;
  const displayRange = displayMaximum - displayMinimum || 1;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const toY = (price: number) => PLOT_TOP
    + ((displayMaximum - price) / displayRange) * plotHeight;
  const slotWidth = candles.length > 0 ? plotWidth / candles.length : plotWidth;
  const bodyWidth = Math.max(3, Math.min(16, slotWidth * 0.56));
  const quoteCurrency = source === 'KRAKEN' ? 'USD' : 'USDT';
  const pair = source === 'KRAKEN' ? 'BTC/USD' : 'BTC/USDT';
  const activeSignalColor = analysis.signal === 'POSSÍVEL COMPRA'
    ? colors.accentForeground
    : analysis.signal === 'POSSÍVEL VENDA'
      ? colors.destructive
      : colors.tint;
  const sourceStatusColor = feedStatus === 'CONECTADO'
    ? colors.accentForeground
    : colors.mutedForeground;
  const timeLabelIndices = candles.length > 2
    ? [...new Set([0, Math.floor((candles.length - 1) / 2), candles.length - 1])]
    : candles.map((_, index) => index);

  return (
    <View testID="candlestick-chart" style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>GRÁFICO OHLC</Text>
          <Text style={[styles.pair, { color: colors.foreground }]}>{pair}</Text>
        </View>
        <View style={styles.headerMeta}>
          <Text style={[styles.interval, { color: colors.primary }]}>1 MIN</Text>
          <Text style={[styles.window, { color: colors.mutedForeground }]}>JANELA 5 MIN</Text>
        </View>
      </View>

      <View style={[styles.sourceSwitch, { backgroundColor: colors.background, borderColor: colors.border }]}>
        {([
          { value: 'KRAKEN', label: 'KRAKEN · USD' },
          { value: 'BINANCE', label: 'BINANCE · USDT' },
        ] as const).map((option) => {
          const selected = source === option.value;
          return (
            <Pressable
              key={option.value}
              testID={`chart-source-${option.value.toLowerCase()}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Mostrar candles da ${option.value}`}
              onPress={() => onSourceChange(option.value)}
              style={[
                styles.sourceOption,
                selected && { backgroundColor: colors.secondary, borderColor: colors.border },
              ]}
            >
              <Text style={[
                styles.sourceOptionText,
                { color: selected ? colors.foreground : colors.mutedForeground },
              ]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.priceRow}>
        <View style={styles.priceGroup}>
          <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>
            {feedStatus === 'CONECTADO' ? 'PREÇO ATUAL' : 'ÚLTIMO PREÇO'}
          </Text>
          <Text testID="chart-current-price" style={[styles.price, { color: colors.foreground }]}>
            {formatPrice(currentPrice)}
          </Text>
        </View>
        <View style={styles.sourceStatus}>
          <View style={[styles.statusDot, { backgroundColor: sourceStatusColor }]} />
          <Text style={[styles.statusText, { color: sourceStatusColor }]}>{feedStatus}</Text>
        </View>
      </View>

      <View style={styles.chartCanvas}>
        <Svg
          width="100%"
          height="190"
          viewBox={`0 0 ${VIEW_WIDTH} 190`}
          preserveAspectRatio="none"
          testID="ohlc-svg"
        >
          {Array.from({ length: GRID_COUNT }, (_, index) => {
            const fraction = index / (GRID_COUNT - 1);
            const y = PLOT_TOP + plotHeight * fraction;
            const price = displayMaximum - displayRange * fraction;
            return (
              <React.Fragment key={`grid-${index}`}>
                <Line
                  x1={PLOT_LEFT}
                  x2={PLOT_RIGHT}
                  y1={y}
                  y2={y}
                  stroke={colors.border}
                  strokeWidth="1"
                />
                {candles.length > 0 ? (
                  <SvgText
                    x={PRICE_AXIS_X}
                    y={y + 3}
                    fill={colors.mutedForeground}
                    fontSize="9"
                  >
                    {formatAxisPrice(price)}
                  </SvgText>
                ) : null}
              </React.Fragment>
            );
          })}

          {candles.map((candle, index) => {
            const centerX = PLOT_LEFT + slotWidth * (index + 0.5);
            const openY = toY(candle.open);
            const closeY = toY(candle.close);
            const highY = toY(candle.high);
            const lowY = toY(candle.low);
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
            const candleColor = candle.close > candle.open
              ? colors.accentForeground
              : candle.close < candle.open
                ? colors.destructive
                : colors.mutedForeground;
            return (
              <React.Fragment key={candle.timestamp}>
                <Line
                  x1={centerX}
                  x2={centerX}
                  y1={highY}
                  y2={lowY}
                  stroke={candleColor}
                  strokeWidth="1.5"
                />
                <Rect
                  x={centerX - bodyWidth / 2}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  fill={candleColor}
                  rx="0.6"
                />
              </React.Fragment>
            );
          })}

          {timeLabelIndices.map((index) => {
            const candle = candles[index];
            const x = PLOT_LEFT + slotWidth * (index + 0.5);
            const anchor = index === 0 ? 'start' : index === candles.length - 1 ? 'end' : 'middle';
            return (
              <SvgText
                key={`time-${candle.timestamp}`}
                x={x}
                y={177}
                fill={colors.mutedForeground}
                fontSize="9"
                textAnchor={anchor}
              >
                {formatCandleTime(candle.timestamp)}
              </SvgText>
            );
          })}
        </Svg>
        {candles.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Aguardando candles reais de 1 minuto fechados
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.candleCountRow, { borderTopColor: colors.border }]}>
        <Text testID="chart-candle-count" style={[styles.metricLabel, { color: colors.mutedForeground }]}>
          {candles.length} {candles.length === 1 ? 'CANDLE FECHADO' : 'CANDLES FECHADOS'}
        </Text>
        <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>
          COTAÇÃO {quoteCurrency}
        </Text>
      </View>

      <View style={styles.analysisRow}>
        <View style={styles.analysisMetric}>
          <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>TENDÊNCIA</Text>
          <Text style={[styles.metricValue, { color: colors.foreground }]}>{analysis.trend}</Text>
        </View>
        <View style={styles.analysisMetric}>
          <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>CONFIRMAÇÃO</Text>
          <Text style={[styles.metricValue, { color: colors.foreground }]}>{analysis.confidence}%</Text>
        </View>
        <View style={styles.signalGroup}>
          <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>SINAL DA FONTE</Text>
          <View style={[
            styles.signalBadge,
            { backgroundColor: `${activeSignalColor}18`, borderColor: `${activeSignalColor}66` },
          ]}>
            <Text testID="chart-source-signal" style={[styles.signalText, { color: activeSignalColor }]}>
              {signalLabels.includes(analysis.signal) ? analysis.signal : 'AGUARDAR'}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 20, padding: 14, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.2 },
  pair: { fontSize: 17, fontFamily: 'Inter_700Bold', marginTop: 3 },
  headerMeta: { alignItems: 'flex-end', gap: 3 },
  interval: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
  window: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5 },
  sourceSwitch: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 3 },
  sourceOption: {
    flex: 1,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  sourceOptionText: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.35 },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  priceGroup: { gap: 3 },
  metricLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.65 },
  price: { fontSize: 18, fontFamily: 'Inter_700Bold', letterSpacing: -0.4 },
  sourceStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 3 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.65 },
  chartCanvas: { height: 190, position: 'relative', overflow: 'hidden' },
  emptyState: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 10, fontFamily: 'Inter_500Medium', textAlign: 'center' },
  candleCountRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, paddingTop: 9 },
  analysisRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, paddingTop: 2 },
  analysisMetric: { flex: 1, gap: 4 },
  metricValue: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  signalGroup: { flex: 1.45, gap: 4, alignItems: 'flex-end' },
  signalBadge: { minHeight: 24, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, justifyContent: 'center' },
  signalText: { fontSize: 8, fontFamily: 'Inter_700Bold', letterSpacing: 0.25 },
});
