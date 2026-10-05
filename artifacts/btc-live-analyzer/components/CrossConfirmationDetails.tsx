import React from 'react';
import { Text } from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { CrossConfirmation } from '@/lib/crossConfirmation';

const agreementLabels = {
  CONCORDANCIA: 'Concordância',
  CONFLITO: 'Conflito',
  NEUTRO: 'Sem direção concordante',
  DADOS_INSUFICIENTES: 'Dados insuficientes',
};
const confirmationLabels = {
  ALTA_CONFIRMADA: 'Alta confirmada',
  BAIXA_CONFIRMADA: 'Baixa confirmada',
  SEM_CONFIRMACAO: 'Sem confirmação',
};

export function CrossConfirmationDetails({ comparison }: { comparison?: CrossConfirmation }) {
  const colors = useColors();
  if (!comparison) return null; // Do not invent a comparison for older results.
  return (
    <Text
      testID="cross-confirmation-details"
      style={{ color: colors.mutedForeground, fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 }}
    >
      Kraken BTC/USD: {comparison.krakenDirection}{'\n'}
      Binance BTC/USDT: {comparison.binanceDirection}{'\n'}
      {agreementLabels[comparison.agreement]} · {confirmationLabels[comparison.finalConfirmation]}{'\n'}
      Confirmação final: {comparison.finalConfidence}% · Sinal final: {comparison.finalSignal}{'\n'}
      Confirmação adicional, não garantia de acerto.
    </Text>
  );
}
