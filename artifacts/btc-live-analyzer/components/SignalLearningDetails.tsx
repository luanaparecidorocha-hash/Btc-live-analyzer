import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { MIN_LEARNING_SAMPLES, recommendDuration } from '@/lib/signalLearning';
import type { LearningSnapshot, TradeSignal } from '@/lib/signalLearning';

const directions: TradeSignal[] = ['POSSÍVEL COMPRA', 'POSSÍVEL VENDA'];
export function SignalLearningDetails({ learning }: { learning: LearningSnapshot }) {
  const colors = useColors();
  const recent = learning.data.pending.at(-1) ?? learning.data.recent.at(-1);
  return (
    <View testID="signal-learning-panel" style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.foreground }]}>DURAÇÃO HISTÓRICA · 1–5 MINUTOS</Text>
      <Text style={[styles.copy, { color: colors.mutedForeground }]}>
        O ciclo principal continua em 5 minutos. Avaliação com cotações reais Kraken BTC/USD, após sinais elegíveis Kraken + Binance.
      </Text>
      {learning.error ? (
        <Text accessibilityRole="alert" style={[styles.copy, { color: colors.foreground }]}>{learning.error}</Text>
      ) : !learning.loaded ? (
        <Text style={[styles.copy, { color: colors.mutedForeground }]}>Carregando resultados salvos…</Text>
      ) : directions.map((signal) => {
        const recommendation = recommendDuration(learning.data, signal);
        const group = learning.data.stats[signal];
        const complete = group.comparable[0].evaluated;
        return (
          <View key={signal} style={styles.group}>
            <Text style={[styles.title, { color: colors.foreground }]}>{signal} · {signal === 'POSSÍVEL COMPRA' ? 'ALTA' : 'BAIXA'}</Text>
            <Text testID={`learning-${signal === 'POSSÍVEL COMPRA' ? 'buy' : 'sell'}`} style={[styles.copy, { color: colors.foreground }]}>
              {recommendation
                ? `Melhor duração histórica: ${recommendation.minutes} minutos\nTaxa de acerto histórica: ${recommendation.hitRate.toFixed(1)}%\nAmostras: ${recommendation.samples}`
                : `Sistema ainda está aprendendo · ${complete}/${MIN_LEARNING_SAMPLES} sinais completos. Dados insuficientes para escolher uma duração.`}
            </Text>
            {group.all.map((stat) => (
              <Text key={stat.minutes} style={[styles.copy, { color: colors.mutedForeground }]}>
                {stat.minutes} min · Acerto: {stat.evaluated ? `${(stat.positive / stat.evaluated * 100).toFixed(1)}%` : '—'} · Avaliados: {stat.evaluated}
              </Text>
            ))}
          </View>
        );
      })}
      {recent && (
        <View style={styles.group}>
          <Text style={[styles.title, { color: colors.foreground }]}>
            ÚLTIMO ACOMPANHAMENTO · {recent.predictedDirection}
          </Text>
          <Text style={[styles.copy, { color: colors.mutedForeground }]}>
            {new Date(recent.timestamp).toLocaleString('pt-BR')} · {recent.signal}{'\n'}
            Entrada: {recent.entry ? `$${recent.entry.price.toFixed(2)}` : 'aguardando cotação real'}
          </Text>
          {recent.results.map((result) => (
            <Text key={result.minutes} style={[styles.copy, { color: colors.mutedForeground }]}>
              {result.minutes} min · {result.status.replace('_', ' ')} · {result.variationPct === null ? '—' : `${result.variationPct >= 0 ? '+' : ''}${result.variationPct.toFixed(4)}%`}
            </Text>
          ))}
        </View>
      )}
      <Text style={[styles.copy, { color: colors.mutedForeground }]}>
        As taxas por horizonte incluem todas as observações válidas. A escolha usa somente sinais com os cinco horizontes válidos, separando compra e venda. Empate: menor duração. Preço sem mudança é neutro, não acerto. Cotação ausente/interrupção é “sem dados”, fora da taxa. Entrada e horizontes usam a primeira cotação até 15 s após o horário-alvo, sem interpolação.{'\n'}
        Acerto histórico não é a confirmação do sinal nem garantia de lucro. AGUARDAR permanece quando os critérios atuais não são atendidos. Estatísticas acumuladas independem dos 10 itens do histórico; apagar o histórico não apaga o aprendizado. Detalhes dos últimos 100 sinais são mantidos no dispositivo.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { padding: 16, borderWidth: 1, borderRadius: 16, gap: 10 },
  group: { gap: 4 },
  title: { fontFamily: 'Inter_600SemiBold', fontSize: 12, lineHeight: 18 },
  copy: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
});
