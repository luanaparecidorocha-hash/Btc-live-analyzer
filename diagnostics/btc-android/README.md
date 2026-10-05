# Diagnóstico do APK existente — BTC Live Analyzer

Esta ferramenta não compila nem instala APKs, não limpa dados/logs e não executa
`force-stop`. Ela abre o APK já instalado e coleta evidências localmente.
Não altera captura, análise, Kraken, notificações ou a janela de cinco minutos.
Ela não envia nada pela rede.

## Computador com Windows, macOS ou Linux

1. Instale Python 3.9+ e Android SDK Platform-Tools:
   https://developer.android.com/tools/releases/platform-tools
2. Ative as opções de desenvolvedor e a depuração USB no Android.
   Use apenas um computador confiável. Conecte o cabo e autorize o computador.
3. Verifique `adb devices`: deve mostrar um dispositivo com estado `device`.
   Se estiver `unauthorized`, autorize o computador no celular.
4. Abra um terminal na pasta desta ferramenta e execute:
   - Windows: `py collect_crash.py`
   - macOS/Linux: `python3 collect_crash.py`
5. O programa abre o app e coleta por 70 segundos. Se o app permanecer aberto,
   toque em INICIAR ANÁLISE. Se fechar antes, apenas aguarde.
6. Revise e envie `btc-fatal-exception.txt`, `device.json`, `exit-info.txt` e
   `launch.txt`, encontrados na nova pasta `btc-diagnostic-...`.

Se houver vários dispositivos, use `--serial IDENTIFICADOR`. Aumente a duração
com `--seconds 120` se necessário. Não use `adb logcat --pid`: o PID muda após
um crash e pode excluir justamente a falha que procuramos.

Os arquivos `*-LOCAL.txt` podem incluir logs de outros aplicativos. Eles ficam
apenas no seu computador. Não os envie integralmente sem revisar. Se o arquivo
fatal não identificar Java, procure `Fatal signal`, `>>> com.btcliveanalyzer.app <<<`
e o backtrace nos arquivos LOCAL; esses trechos e exit-info distinguem falha
nativa, ANR e encerramento pelo Android.

## Sem Python, mas com ADB

No terminal, execute antes de abrir o aplicativo:

```text
adb logcat -b crash -d -v threadtime > btc-crash-anterior.txt
adb logcat -b crash -b main -b system -v threadtime AndroidRuntime:V ReactNativeJS:V ReactNative:V BtcAnalysisService:V BtcBackgroundAnalysis:V libc:F DEBUG:V "*:S" > btc-runtime.txt
```

Enquanto o segundo comando continua coletando, abra o aplicativo no celular e
reproduza a falha. Aguarde alguns segundos e pressione Ctrl+C no computador.
Depois execute:

```text
adb shell dumpsys activity exit-info com.btcliveanalyzer.app > btc-exit-info.txt
```

Envie apenas o bloco que contém `FATAL EXCEPTION`, `Process: com.btcliveanalyzer.app`,
a exceção, todos os `Caused by` e as linhas da stack. Para falha C/C++, envie o
trecho `Fatal signal`/backtrace referente ao pacote BTC. Sem limpar dados ou logs.

## Somente o celular

Nas opções do desenvolvedor, procure “Gerar relatório de bug” ou “Take bug report”.
Reproduza o fechamento com o APK atual e gere o relatório imediatamente depois.
O nome e a disponibilidade dessa opção dependem do fabricante.

Relatórios completos podem conter informações de outros apps, redes e dados
pessoais. Prefira extrair/enviar apenas a falha atribuída ao pacote BTC. Informe
também o modelo do aparelho, a versão Android e se fechou sem tocar em INICIAR.

## Limites da investigação

Os logs EAS confirmam compilação, mas NÃO contêm logs do aparelho. Não há causa
exata ou linha fatal confirmada até obter o stack/registro de encerramento real.
Uma stack Java pode trazer arquivo/linha; uma falha C/C++ pode exigir símbolos;
uma JavascriptException minificada pode exigir o source map do mesmo build.
