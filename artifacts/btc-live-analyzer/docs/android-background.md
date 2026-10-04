# Análise Android em segundo plano — implementação e validação pendente

## Estado atual

O código do serviço e a integração estão preparados, mas **não há APK
compilado/instalado nem validação em aparelho nesta etapa**. TypeScript,
testes de sessão, resolução/autolinking e bundle Android não comprovam que
o serviço funciona em segundo plano no Android real.

## Arquitetura

- Módulo local Expo `btc-background-analysis`, somente Android.
- Serviço `dataSync` em primeiro plano, iniciado por ação do usuário com o
  aplicativo aberto. Notificação permanente com ação PARAR.
- Uma tarefa React Native Headless JS, permitida também com a tela aberta,
  mantém o mesmo runtime/TimingModule ativo. A classe nativa Headless JS do
  React Native 0.86 gerencia o wake lock parcial; não há um segundo wake lock
  nem uma segunda lógica de sinais em Kotlin.
- No APK com o módulo instalado, somente essa tarefa chama a conexão Kraken
  existente, o coletor contínuo existente, o motor existente e o armazenamento
  existente. A UI recebe snapshots; abrir a tela não abre outra conexão.
- Cada resultado é salvo antes da tentativa de notificação. Todos os sinais,
  inclusive AGUARDAR, incluem tendência, confirmação e conclusão de 5 minutos.
- PARAR encerra feed/coletor/serviço, remove notificações próprias e impede
  avisos atrasados. Escritas de ciclos já finalizados podem terminar para
  evitar perda de resultados. Não existe alarme periódico ou WorkManager.
- IDs de execução descartam eventos e notificações de sessões antigas.
- O estado atual é restaurado enquanto o processo/serviço existe; o histórico
  usa a mesma chave AsyncStorage e é restaurado mesmo após reiniciar o processo.
  Não se promete retomar uma janela parcial após encerramento do processo.
- Expo Go/web/iOS preservam o fluxo anterior de análise com aplicativo aberto.
  Expo Go NÃO contém esse serviço e não valida segundo plano.

## Configuração nativa necessária

O entrypoint `index.js` registra a tarefa antes do Expo Router. O módulo é
autolinkado; não depende de instalar outra biblioteca ou de alterar perfis EAS,
identificador Android, Expo SDK ou configurações de captura.

Permissões adicionadas: `FOREGROUND_SERVICE_DATA_SYNC` e `WAKE_LOCK`.
`INTERNET`, `FOREGROUND_SERVICE` e `POST_NOTIFICATIONS` já eram necessárias.
As permissões de MediaProjection continuam separadas para captura.
Não há solicitação de localização; as declarações de localização herdadas
de dependências são bloqueadas no prebuild.

Notificações usam o pedido padrão Android via Expo Notifications. Recusa permite
cancelar ou continuar com aviso explícito de que os resultados não aparecerão
na gaveta de notificações. O Android pode mostrar o serviço apenas em seu
gerenciador de tarefas se POST_NOTIFICATIONS estiver negada.

## Limites que não devem ser ocultados

- Em Android 15+ para targets atuais, `dataSync` tem um limite agregado de
  **6 horas em segundo plano por período de 24 horas**, sujeito às regras do
  sistema. `onTimeout` encerra o serviço e informa a limitação na UI.
- Forçar parada, revogar permissões relevantes, restrições de bateria/Doze,
  indisponibilidade de rede e políticas de fabricantes podem interromper
  ou atrasar a execução. Não há promessa de execução contínua indefinida.
- O serviço é `START_NOT_STICKY`: não tenta ressuscitar após término do processo.
  O usuário precisa abrir o app e iniciar novamente nesses casos.
- Um ciclo mantém a duração lógica exata de cinco minutos e o motor mantém seus
  critérios de qualidade de dados. O sistema pode atrasar o callback em condições
  extremas; não é correto prometer entrega de notificação em tempo real garantido.

## Roteiro obrigatório no APK Android

Gerar o APK usando a configuração Android já existente, em ambiente com JDK e
SDK Android estáveis. Se o projeto Android estiver pré-gerado, sincronizar
`app.json` pelo processo habitual de prebuild sem apagar personalizações.
Não reutilizar o Expo Go como substituto do APK.

1. Android 13+: instalação limpa, INICIAR, conceder POST_NOTIFICATIONS.
   Repetir negando: Cancelar não abre feed; Continuar sem avisos explica a
   limitação e não pede localização. Testar notificações já desativadas.
2. Confirmar uma única instância do serviço e da tarefa e uma única conexão
   Kraken. Tocar INICIAR rapidamente duas vezes não deve duplicar.
3. Enviar o app para Home por mais de dez minutos com rede real: confirmar duas
   conclusões, notificações com os campos completos, dois registros e terceiro
   ciclo ativo. Repetir com tela bloqueada.
4. Retornar ao app: restaurar contador/estado/histórico sem reconectar à Kraken
   nem abrir uma tarefa adicional. Separadamente testar recriação da Activity.
5. Interromper temporariamente a rede: verificar reconexão pelo feed existente,
   descarte apenas da janela incompleta e preservação de resultados anteriores.
6. PARAR na UI e na notificação permanente: serviço, wake lock, tarefa, socket e
   timer devem encerrar; notificações próprias devem sumir. Esperar mais de cinco
   minutos e confirmar ausência de novos resultados/avisos.
7. Fazer STOP/INICIAR rapidamente várias vezes, inclusive durante escrita de
   resultado, para validar os guardas nativos de execução e ausência de duplicação.
8. Reabrir/reiniciar processo: histórico restaurado. Forçar parada deve encerrar
   a análise e NÃO apresentar estado ativo fictício ao voltar.
9. Android 15+: validar `onTimeout` e o limite dataSync; verificar que o serviço
   para dentro do prazo do sistema, sem ANR ou tentativas ocultas de contorno.
10. Validar MediaProjection existente separadamente: permissões, captura durante
    coleta, encerramento por PARAR e tratamento de revogação/bloqueio da tela.

Só após esses testes é possível confirmar o funcionamento real em segundo plano.