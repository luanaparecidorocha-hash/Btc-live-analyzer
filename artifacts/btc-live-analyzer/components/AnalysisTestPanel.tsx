import React, { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from '@/lib/analysis';
import type { AnalysisResult } from '@/lib/analysis';
import { ANALYSIS_SCENARIOS, createAnalysisScenario } from '@/lib/analysisScenarios';
import type { AnalysisScenario } from '@/lib/analysisScenarios';

// Independent, ephemeral UI state. Deliberately does not use AnalyzerContext,
// AsyncStorage, market/capture services or notifications.
export function AnalysisTestPanel() {
  const colors = useColors();
  const [enabled, setEnabled] = useState(false);
  const [execution, setExecution] = useState<{
    scenario: AnalysisScenario;
    sampleCount: number;
    result: AnalysisResult;
  } | null>(null);

  function runScenario(scenario: AnalysisScenario) {
    if (!enabled) return;
    const input = createAnalysisScenario(scenario, DEFAULT_ANALYSIS_WINDOW_MS);
    const result = analyzeChart(input.points, input.windowMs, input.now);
    setExecution({ scenario, sampleCount: input.points.length, result });
  }

  return (
    <View testID="analysis-test-panel" style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.heading}>
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.foreground }]}>Teste interno do motor</Text>
          <Text testID="simulation-status" style={[styles.status, { color: enabled ? colors.primary : colors.mutedForeground }]}>
            {enabled ? 'DADOS SIMULADOS · ATIVADO' : 'DESATIVADO'}
          </Text>
        </View>
        <Switch
          testID="enable-analysis-test"
          accessibilityLabel="Ativar modo de teste com dados simulados"
          value={enabled}
          onValueChange={(value) => { setEnabled(value); setExecution(null); }}
          trackColor={{ false: colors.muted, true: colors.accent }}
          thumbColor={enabled ? colors.primary : colors.mutedForeground}
        />
      </View>
      <Text style={[styles.copy, { color: colors.mutedForeground }]}>
        Painel separado da análise real. Não usa Kraken ou captura, não salva no histórico e nunca executa ordens.
      </Text>
      {enabled ? (
        <>
          <Text style={[styles.copy, { color: colors.primary }]}>
            Janela simulada de 5:00, executada instantaneamente no mesmo motor. O relógio e a coleta real não são alterados.
          </Text>
          <View style={styles.buttons}>
            {ANALYSIS_SCENARIOS.map((scenario) => (
              <Pressable
                key={scenario}
                testID={`run-simulation-${scenario}`}
                accessibilityRole="button"
                accessibilityLabel={`Executar cenário simulado de ${scenario}`}
                onPress={() => runScenario(scenario)}
                style={({ pressed }) => [styles.button, { backgroundColor: colors.secondary, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
              >
                <Text style={[styles.buttonText, { color: colors.foreground }]}>Executar {scenario}</Text>
              </Pressable>
            ))}
          </View>
          {execution ? (
            <View testID="simulation-result" style={[styles.result, { backgroundColor: colors.background, borderColor: colors.primary }]}>
              <Text style={[styles.status, { color: colors.primary }]}>RESULTADO SIMULADO · {execution.scenario}</Text>
              <Text testID="simulation-signal" style={[styles.signal, { color: colors.foreground }]}>{execution.result.signal}</Text>
              <Text testID="simulation-trend" style={[styles.copy, { color: colors.foreground }]}>
                Tendência: {execution.result.trend}
              </Text>
              <Text style={[styles.copy, { color: colors.foreground }]}>
                Confirmação: {execution.result.confidence}% · {execution.sampleCount} amostras · 5:00 simulados
              </Text>
              <Text style={[styles.copy, { color: colors.mutedForeground }]}>{execution.result.reason}</Text>
              <Text style={[styles.note, { color: colors.primary }]}>
                Somente validação da lógica. Não é cotação ao vivo nem recomendação para operar.
              </Text>
            </View>
          ) : (
            <Text style={[styles.copy, { color: colors.mutedForeground }]}>Escolha um cenário para executar o teste.</Text>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  headingCopy: { flex: 1, gap: 6 },
  title: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  status: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },
  copy: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular' },
  buttons: { gap: 8 },
  button: { minHeight: 44, borderWidth: 1, borderRadius: 12, justifyContent: 'center', alignItems: 'center', padding: 10 },
  buttonText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  result: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  signal: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  note: { fontSize: 11, lineHeight: 17, fontFamily: 'Inter_400Regular' },
});