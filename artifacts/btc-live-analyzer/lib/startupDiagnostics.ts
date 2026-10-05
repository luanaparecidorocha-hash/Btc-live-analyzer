// No imports: install the JS handler before background-task/router imports.
type DiagnosticModule = {
  recordDiagnostic?: (stage: string, detail: string) => void;
  markStartupReady?: () => void;
};
type RuntimeErrorUtils = {
  getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
};
let native: DiagnosticModule | null = null;
const pending: Array<[string, string]> = [];
const runtime = globalThis as typeof globalThis & { ErrorUtils?: RuntimeErrorUtils };

export function recordStartupDiagnostic(stage: string, detail = '') {
  if (!native?.recordDiagnostic) {
    if (pending.length < 32) pending.push([stage, detail]);
    return;
  }
  try { native.recordDiagnostic(stage, detail); }
  catch (error) { console.warn('[BTC diagnostics] Falha ao persistir diagnóstico.', error); }
}

if (runtime.ErrorUtils) {
  const previous = runtime.ErrorUtils.getGlobalHandler();
  runtime.ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      recordStartupDiagnostic(isFatal ? 'JS_FATAL' : 'JS_ERROR', error.stack || String(error));
    } finally {
      previous(error, isFatal);
    }
  });
}

recordStartupDiagnostic('js.entry.begin');
try {
  // Dynamic require is deliberate: the handler above precedes native imports.
  const { Platform } = require('react-native');
  if (Platform.OS === 'android') {
    native = require('expo').requireOptionalNativeModule('BtcBackgroundAnalysis');
    if (native?.recordDiagnostic) {
      for (const [stage, detail] of pending.splice(0)) native.recordDiagnostic(stage, detail);
      recordStartupDiagnostic('js.diagnostic.bridge.ready');
    }
  }
} catch (error) {
  recordStartupDiagnostic('JS_FATAL', error instanceof Error ? error.stack || error.message : String(error));
  // Do not hide native-module/bootstrap errors under a silent fallback.
  throw error;
}

export function markStartupReady() {
  try { native?.markStartupReady?.(); }
  catch (error) { console.warn('[BTC diagnostics] Falha ao concluir diagnóstico de inicialização.', error); }
}
