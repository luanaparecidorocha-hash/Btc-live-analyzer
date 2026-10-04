import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from '../lib/analysis.ts';
import { ANALYSIS_SCENARIOS, createAnalysisScenario } from '../lib/analysisScenarios.ts';

const expectedSignals = {
  ALTA: 'POSSÍVEL COMPRA',
  BAIXA: 'POSSÍVEL VENDA',
  LATERAL: 'AGUARDAR',
};

for (const scenario of ANALYSIS_SCENARIOS) {
  test(`internal ${scenario} scenario uses the real engine and returns ${expectedSignals[scenario]}`, () => {
    const input = createAnalysisScenario(scenario, DEFAULT_ANALYSIS_WINDOW_MS);
    const original = structuredClone(input);
    const result = analyzeChart(input.points, input.windowMs, input.now);
    assert.equal(result.trend, scenario);
    assert.equal(result.signal, expectedSignals[scenario]);
    assert.equal(input.windowMs, 300_000);
    assert.equal(input.now, 300_000);
    assert.equal(input.points.length, 60);
    assert.equal(input.points[0].timestamp, 0);
    assert.equal(input.points.at(-1).timestamp, 295_000);
    assert.ok(result.reason.length > 0);
    assert.ok(result.confidence >= 0 && result.confidence <= 100);
    if (scenario !== 'LATERAL') assert.ok(result.confidence >= 68);
    assert.deepEqual(input, original, 'the engine must not mutate test inputs');
    assert.deepEqual(createAnalysisScenario(scenario, DEFAULT_ANALYSIS_WINDOW_MS), input);
    console.log(`${scenario}: ${result.trend} / ${result.signal} / ${result.confidence}%`);
  });

  test(`${scenario} test inputs obey the unchanged five-minute engine gate`, () => {
    const input = createAnalysisScenario(scenario, DEFAULT_ANALYSIS_WINDOW_MS);
    const result = analyzeChart(input.points, input.windowMs, input.now - 1);
    assert.equal(result.signal, 'AGUARDAR');
    assert.match(result.reason, /antes de avaliar um sinal/);
  });
}

test('directional fixtures are monotonic and the lateral fixture genuinely oscillates', () => {
  for (const scenario of ['ALTA', 'BAIXA']) {
    const { points } = createAnalysisScenario(scenario, DEFAULT_ANALYSIS_WINDOW_MS);
    const sign = scenario === 'ALTA' ? 1 : -1;
    assert.ok(points.slice(1).every((point, index) => (point.price - points[index].price) * sign > 0));
  }
  const { points } = createAnalysisScenario('LATERAL', DEFAULT_ANALYSIS_WINDOW_MS);
  const deltas = points.slice(1).map((point, index) => point.price - points[index].price);
  assert.ok(deltas.filter((delta) => delta > 0).length >= 20);
  assert.ok(deltas.filter((delta) => delta < 0).length >= 20);
});

test('each execution has independent data and invalid scenarios fail explicitly', () => {
  const first = createAnalysisScenario('ALTA', DEFAULT_ANALYSIS_WINDOW_MS);
  const second = createAnalysisScenario('ALTA', DEFAULT_ANALYSIS_WINDOW_MS);
  first.points[0].price = 1;
  assert.equal(second.points[0].price, 80_000);
  assert.throws(() => createAnalysisScenario('INVALID', DEFAULT_ANALYSIS_WINDOW_MS), /inválido/);
  assert.throws(() => createAnalysisScenario('ALTA', 0), /inválida/);
});