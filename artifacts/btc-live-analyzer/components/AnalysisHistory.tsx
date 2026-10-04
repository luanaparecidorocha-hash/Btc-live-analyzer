import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { AnalysisRecord } from '@/lib/analysisHistory';

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return 'Não registrada';
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AnalysisHistory({ records }: { records: AnalysisRecord[] }) {
  const colors = useColors();
  return (
    <View testID="analysis-history" style={styles.section}>
      <View style={styles.heading}>
        <Text style={[styles.title, { color: colors.foreground }]}>Histórico de análises</Text>
        <Text style={[styles.count, { color: colors.mutedForeground }]}>{records.length} concluída(s)</Text>
      </View>
      {records.length === 0 ? (
        <Text style={[styles.reason, { color: colors.mutedForeground }]}>
          As análises concluídas em 5 minutos serão salvas aqui, inclusive AGUARDAR.
        </Text>
      ) : [...records].reverse().map((record) => {
        const tone = record.signal === 'POSSÍVEL VENDA'
          ? colors.destructive
          : record.signal === 'POSSÍVEL COMPRA' ? colors.accentForeground : colors.primary;
        return (
          <View
            key={record.timestamp}
            testID={`analysis-history-record-${record.timestamp}`}
            style={[styles.record, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.date, { color: colors.mutedForeground }]}>
              {new Date(record.timestamp).toLocaleString('pt-BR')}
            </Text>
            <Text style={[styles.result, { color: tone }]}>{record.signal}</Text>
            <View style={styles.metrics}>
              <Text style={[styles.metric, { color: colors.foreground }]}>Tendência: {record.direction}</Text>
              <Text style={[styles.metric, { color: colors.foreground }]}>Confirmação: {record.confidence}%</Text>
              <Text style={[styles.metric, { color: colors.foreground }]}>Duração: {formatDuration(record.durationMs)}</Text>
            </View>
            <Text style={[styles.reason, { color: colors.mutedForeground }]}>{record.reason}</Text>
          </View>
        );
      })}
      {records.length > 0 ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          Salvo neste dispositivo. Confirmação indica força dos sinais, não garantia de acerto.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  title: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  count: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  record: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 10 },
  date: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  result: { fontFamily: 'Inter_700Bold', fontSize: 18 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  reason: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 },
  note: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
});