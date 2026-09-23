# Build Android com captura MediaProjection

O `BtcScreenCapture` é um módulo Android local. Ele usa a autorização oficial do
Android, `MediaProjection`, `ImageReader` e um `Foreground Service` com tipo
`mediaProjection`. Nenhum frame é salvo em vídeo ou enviado para um servidor.

## Preparar o Development Build

Na raiz do repositório:

```bash
pnpm install
pnpm --filter @workspace/btc-live-analyzer run android:prebuild
```

O comando gera `artifacts/btc-live-analyzer/android/` e inclui o módulo local
em `modules/btc-screen-capture`.

## Executar em um aparelho Android

É necessário ter Android SDK, ADB e um aparelho com depuração USB habilitada:

```bash
cd artifacts/btc-live-analyzer
pnpm run android:debug
```

Ou, usando o script:

```bash
./scripts/build-android.sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Gerar o APK

Para um APK de release local:

```bash
cd artifacts/btc-live-analyzer
pnpm run android:prebuild
pnpm run android:release
```

O arquivo será gerado em:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

Esse APK precisa ser assinado antes de distribuição. Para testes no celular,
use o APK debug.

## Usar a captura

1. Abra o app instalado.
2. Configure a área do gráfico.
3. Toque em **INICIAR ANÁLISE**.
4. Aceite a caixa oficial do Android para compartilhar/capturar a tela.
5. Confirme que a notificação permanente **BTC Live Analyzer** apareceu.
6. Coloque o app em segundo plano e observe a notificação continuar ativa.
7. O app só muda para **ANALISANDO** quando recebe frames reais. Antes da janela
   mínima de cinco minutos, o sinal permanece **AGUARDAR**.
8. Toque em **PARAR** ou revogue a autorização para encerrar.

## Verificações

```bash
pnpm --filter @workspace/btc-live-analyzer run typecheck
pnpm --filter @workspace/btc-live-analyzer run doctor
pnpm --filter @workspace/btc-live-analyzer run android:prebuild
```

O teste físico de autorização, segundo plano, encerramento e recuperação exige
um aparelho Android ou emulador com suporte a MediaProjection. O preview Expo
continua servindo apenas para validar a interface; ele não contém o módulo
nativo.