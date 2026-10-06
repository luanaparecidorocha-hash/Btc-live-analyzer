import React, { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { AnalysisRecord } from '@/lib/analysisHistory';
import { CrossConfirmationDetails } from '@/components/CrossConfirmationDetails';

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return 'Não registrada';
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AnalysisHistory({ records, onClear }: { records: AnalysisRecord[]; onClear: () => Promise<void> }) {
  const colors = useColors();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearingRef = useRef(false);
  const cancel = () => { if (!clearingRef.current) setConfirmClear(false); };
  const erase = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    setClearError(null);
    try {
      await onClear();
      setConfirmClear(false);
    } catch {
      setClearError('Não foi possível apagar o histórico. Tente novamente.');
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  };
  return (
    <View testID="analysis-history" style={styles.section}>
      <View style={styles.heading}>
        <Text style={[styles.title, { color: colors.foreground }]}>Histórico de análises</Text>
        <Text style={[styles.count, { color: colors.mutedForeground }]}>{records.length} concluída(s)</Text>
      </View>
      <Pressable
        testID="clear-analysis-history"
        accessibilityRole="button"
        onPress={() => { setClearError(null); setConfirmClear(true); }}
        style={[styles.clearButton, { borderColor: colors.destructive }]}
      >
        <Text style={[styles.buttonText, { color: colors.destructive }]}>APAGAR HISTÓRICO</Text>
      </Pressable>
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
            <CrossConfirmationDetails comparison={record.crossConfirmation} />
          </View>
        );
      })}
      {records.length > 0 ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          Salvo neste dispositivo. Confirmação indica força dos sinais, não garantia de acerto.
        </Text>
      ) : null}
      <Modal visible={confirmClear} transparent animationType="fade" onRequestClose={cancel}>
        <View style={[styles.backdrop, { backgroundColor: `${colors.background}DD` }]}>
          <View
            accessibilityViewIsModal
            testID="clear-history-confirmation"
            style={[styles.dialog, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.title, { color: colors.foreground }]}>Deseja apagar todo o histórico de análises?</Text>
            {clearError ? <Text accessibilityRole="alert" style={[styles.reason, { color: colors.destructive }]}>{clearError}</Text> : null}
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" testID="cancel-clear-history" disabled={clearing} onPress={cancel} style={styles.dialogButton}>
                <Text style={[styles.buttonText, { color: colors.foreground }]}>CANCELAR</Text>
              </Pressable>
              <Pressable accessibilityRole="button" testID="confirm-clear-history" disabled={clearing} onPress={() => { void erase(); }} style={styles.dialogButton}>
                <Text style={[styles.buttonText, { color: colors.destructive, opacity: clearing ? 0.5 : 1 }]}>APAGAR</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  title: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  count: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  clearButton: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  buttonText: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 400, borderRadius: 18, borderWidth: 1, padding: 20, gap: 16 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dialogButton: { paddingHorizontal: 16, paddingVertical: 14 },
  record: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 10 },
  date: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  result: { fontFamily: 'Inter_700Bold', fontSize: 18 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  reason: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 },
  note: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16 },
});