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

## Build remoto com EAS

O projeto também está preparado para build remoto sem depender do Android SDK do
Replit. O perfil `preview` em `eas.json` usa:

- distribuição `internal`;
- artefato Android `apk`;
- prebuild Expo com o módulo local em `modules/btc-screen-capture`.

O diretório `android/` não precisa ser versionado: o autolinking do Expo encontra
o `expo-module.config.json` durante o prebuild e o manifest do módulo é mesclado
na aplicação. Não é necessário um Config Plugin separado para este módulo, pois
as permissões estão declaradas tanto no `app.json` quanto no manifest da library,
e o serviço é registrado pelo próprio manifest Android do módulo.

O build remoto exige que o projeto EAS esteja vinculado ao aplicativo
`com.btcliveanalyzer.app` e que as credenciais Android sejam configuradas no
ambiente de build. O workflow deve usar o perfil `preview`; a existência do
perfil não significa que um APK já foi gerado.

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
9. Confirme que nenhum botão ou fluxo do aplicativo envia ordens para uma
   corretora: os resultados são somente `POSSÍVEL COMPRA`, `POSSÍVEL VENDA` ou
   `AGUARDAR`.

## Verificações

```bash
pnpm --filter @workspace/btc-live-analyzer run typecheck
pnpm --filter @workspace/btc-live-analyzer run doctor
pnpm --filter @workspace/btc-live-analyzer run android:prebuild
```

Para verificar a integração nativa sem gerar um APK, também é possível conferir
o autolinking Android a partir do diretório do artifact:

```bash
cd artifacts/btc-live-analyzer
pnpm exec expo-modules-autolinking verify --platform android
pnpm exec expo-modules-autolinking resolve --platform android --json
```

O teste físico de autorização, segundo plano, encerramento e recuperação exige
um aparelho Android ou emulador com suporte a MediaProjection. O preview Expo
continua servindo apenas para validar a interface; ele não contém o módulo
nativo.