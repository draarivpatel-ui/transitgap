import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BASIC, CITIES } from '../src/cities.js';
import { assess, gini, validatePlan } from '../src/model.js';
import { canonical, csvCell } from '../src/audit.js';
import { sha256Hex } from '../src/sha256.js';
import { ACCESS_BANDS, applyCustom, applyPreset, atkinson, clampCustom,
  corridorLeverage, CUSTOM_DEFAULTS, CUSTOM_LIMITS, evaluateAll,
  evaluateIntervention, EXPRESS_BUSES, FLOOR_HEADWAY, lineKm, palmaRatio,
  PRESETS, quantileMean, SHUTTLE_BUSES, SPEED_GAIN, topBottomRatio,
  UNIT_COSTS, weightedMean } from '../src/interventions.js';
import { buildPolicyJson, decodeScenario, encodeScenario, MAX_POLICY_BYTES,
  policyCsv, policyMarkdown, selectionFor, verifyPolicyJson } from '../src/policy.js';
import { runSelfTests, SELF_TEST_COUNT } from '../src/selftest.js';

function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const PRESET_NONBASE = PRESETS.filter(p => p.id !== 'baseline');
const busAnnual = (buses, hours) => buses * hours * UNIT_COSTS.serviceDays * UNIT_COSTS.busHour;

// SHA-256

for (const [i, [input, want]] of [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']
].entries()) {
  test(`SHA-256 FIPS 180-4 known-answer vector ${i + 1}`, () => assert.equal(sha256Hex(input), want));
}

test('SHA-256 agrees with node:crypto across padding boundaries', () => {
  for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 127, 128, 129, 1000]) {
    const text = 'x'.repeat(length);
    assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), `length ${length}`);
  }
});

test('SHA-256 accepts Uint8Array and is deterministic', () => {
  const bytes = new TextEncoder().encode('transit');
  assert.equal(sha256Hex(bytes), sha256Hex('transit'));
  assert.equal(sha256Hex('transit'), sha256Hex('transit'));
  assert.match(sha256Hex('x'), /^[a-f0-9]{64}$/);
});

// Weighted primitives

test('weightedMean reduces to an arithmetic mean for equal weights', () => {
  assert.equal(weightedMean([2, 4, 6], [1, 1, 1]), 4);
  assert.equal(weightedMean([1, 3], [3, 1]), 1.5);
});

for (const [i, [values, weights]] of [
  [[1, NaN], [1, 1]], [[1], [1, 2]], [[1, 2], [0, 0]], [[-1, 2], [1, 1]],
  [[1, 2], [1, -1]], [[Infinity, 2], [1, 1]], [[], []]
].entries()) {
  test(`weightedMean rejects invalid input ${i + 1}`, () => {
    assert.throws(() => weightedMean(values, weights), RangeError);
    assert.throws(() => quantileMean(values, weights, 0.5), RangeError);
    assert.throws(() => atkinson(values, weights), RangeError);
    assert.throws(() => topBottomRatio(values, weights), RangeError);
  });
}

test('quantileMean at full share equals the weighted mean', () => {
  const values = [0.9, 0.2, 0.5, 0.7];
  const weights = [3, 5, 2, 6];
  assert.equal(quantileMean(values, weights, 1), weightedMean(values, weights));
});

test('quantileMean slices fractional weights at the boundary', () => {
  // Sorted values 0.2(5), 0.5(5), 0.9(10): bottom 50% = all of 0.2, all of 0.5, half of 0.9? No:
  // target weight 10 of 20 -> 5 at 0.2 + 5 at 0.5 -> mean 0.35.
  assert.equal(quantileMean([0.9, 0.2, 0.5], [10, 5, 5], 0.5), 0.35);
  assert.equal(quantileMean([0.9, 0.2, 0.5], [10, 5, 5], 0.75), (0.2 * 5 + 0.5 * 5 + 0.9 * 5) / 15);
});

for (const p of [0, -0.2, 1.5, NaN, Infinity]) {
  test(`quantileMean rejects share ${p}`, () => assert.throws(() => quantileMean([1, 2], [1, 1], p), RangeError));
}

test('topBottomRatio is one for equal values and above one for unequal', () => {
  assert.equal(topBottomRatio([0.5, 0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1, 1]), 1);
  assert.ok(topBottomRatio([0.2, 0.4, 0.6, 0.8, 0.95], [1, 1, 1, 1, 1]) > 1);
});

test('palmaRatio is 0.25 for equal values and grows with concentration', () => {
  const equal = palmaRatio([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], Array(10).fill(1));
  assert.ok(close(equal, 0.25));
  const skewed = palmaRatio([0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 0.9, 5.0], Array(10).fill(1));
  assert.ok(skewed > equal);
});

for (let seed = 1; seed <= 12; seed++) {
  test(`Atkinson bounded and rises with spread, seeded ${seed}`, () => {
    const rng = random(seed * 31);
    const weights = Array.from({ length: 3 + seed % 6 }, () => 1 + Math.floor(rng() * 9));
    const base = weights.map((_, i) => 0.3 + 0.05 * i);
    const spread = base.map((x, i) => x + (i === base.length - 1 ? 0.4 : 0));
    const a = atkinson(base, weights);
    const b = atkinson(spread, weights);
    assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1);
    assert.ok(b > a);
  });
}

test('Atkinson handles the epsilon-one branch and zero values', () => {
  assert.ok(Math.abs(atkinson([4, 4, 4], [1, 1, 1], 1)) < 1e-12);
  assert.equal(atkinson([0, 5, 5], [1, 1, 1], 1), 1);
  assert.throws(() => atkinson([1, 2], [1, 1], 0), RangeError);
  assert.throws(() => atkinson([1, 2], [1, 1], -0.5), RangeError);
});

test('Atkinson stays bounded and below the Gini on city access data', () => {
  for (const city of CITIES) {
    const { rows } = assess(city, city.baseline, BASIC);
    const access = rows.map(r => r.access);
    const weights = city.neighborhoods.map(n => n.pop);
    const measured = atkinson(access, weights);
    assert.ok(measured >= 0 && measured < 1);
    assert.ok(measured <= gini(access, weights) + 1e-12);
  }
});

// Custom slider clamping

test('clampCustom fills defaults and respects every bound', () => {
  assert.deepEqual(clampCustom(), CUSTOM_DEFAULTS);
  assert.deepEqual(clampCustom(null), CUSTOM_DEFAULTS);
  const clamped = clampCustom({ headwayScale: 9, speedGain: -3, subsidy: 9e9, cap: -1 });
  assert.equal(clamped.headwayScale, CUSTOM_LIMITS.headwayScale[1]);
  assert.equal(clamped.speedGain, CUSTOM_LIMITS.speedGain[0]);
  assert.equal(clamped.subsidy, CUSTOM_LIMITS.subsidy[1]);
  assert.equal(clamped.cap, CUSTOM_LIMITS.cap[0]);
  for (const [name, [lo, hi]] of Object.entries(CUSTOM_LIMITS)) {
    const out = clampCustom({ [name]: NaN })[name];
    assert.equal(out, CUSTOM_DEFAULTS[name]);
    assert.equal(clampCustom({ [name]: lo - 1 })[name], lo);
    assert.equal(clampCustom({ [name]: hi + 1 })[name], hi);
  }
  const input = { headwayScale: 0.7 };
  clampCustom(input);
  assert.equal(Object.keys(input).length, 1);
});

// Preset applications, per city

for (const city of CITIES) {
  test(`Baseline preset is the identity in ${city.id}`, () => {
    const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, 'baseline'));
    assert.equal(evaluation.cost.annual, 0);
    assert.equal(evaluation.metrics.accessDelta, 0);
    assert.equal(evaluation.metrics.equityLift, 0);
    assert.equal(evaluation.metrics.liftPerMillion, null);
    assert.deepEqual(evaluation.result.metrics, evaluation.baseline.metrics);
  });

  for (const { id } of PRESET_NONBASE) {
    test(`${city.id}/${id} produces a valid plan with honest costs`, () => {
      const applied = applyPreset(city, BASIC, id);
      validatePlan(applied.city, applied.plan);
      const { service, capital, subsidy, savings, annual } = applied.cost;
      for (const piece of [service, capital, subsidy, savings]) {
        assert.ok(Number.isFinite(piece) && piece >= 0);
      }
      assert.equal(annual, service + capital + subsidy - savings);
      assert.ok(annual > 0);
    });

    test(`${city.id}/${id} never lengthens any neighborhood trip`, () => {
      const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, id));
      evaluation.result.rows.forEach((row, i) => row.times.forEach((t, j) => {
        assert.ok(t <= evaluation.baseline.rows[i].times[j] + 1e-9,
          `${row.id} service ${j} worsened`);
      }));
    });

    test(`${city.id}/${id} is byte-for-byte deterministic`, () => {
      const first = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, id));
      const second = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, id));
      assert.equal(canonical(first.metrics), canonical(second.metrics));
      assert.equal(canonical(first.city), canonical(second.city));
      assert.equal(canonical(first.cost), canonical(second.cost));
    });
  }

  test(`${city.id}/headway doubles every flexible fleet`, () => {
    const applied = applyPreset(city, BASIC, 'headway');
    const flex = city.lines.map((l, i) => i).filter(i => city.lines[i].min !== city.lines[i].max);
    flex.forEach(i => assert.equal(applied.plan.fleet[i], 2 * city.baseline.fleet[i]));
    assert.equal(applied.cost.service,
      busAnnual(flex.reduce((s, i) => s + city.baseline.fleet[i], 0), city.hours));
    assert.equal(applied.cost.capital, 0);
  });

  test(`${city.id}/floor guarantees at most ${FLOOR_HEADWAY} minute headways`, () => {
    const applied = applyPreset(city, BASIC, 'floor');
    const flex = city.lines.map((l, i) => i).filter(i => city.lines[i].min !== city.lines[i].max);
    flex.forEach(i => {
      const headway = applied.city.lines[i].cycle / applied.plan.fleet[i];
      assert.ok(headway <= FLOOR_HEADWAY + 1e-9, `${applied.city.lines[i].id} headway ${headway}`);
      assert.ok(applied.plan.fleet[i] >= city.baseline.fleet[i]);
    });
  });

  test(`${city.id}/brt speeds the busiest corridor without adding buses`, () => {
    const applied = applyPreset(city, BASIC, 'brt');
    const line = applied.city.lines.find(l => l.id === applied.meta.line);
    const original = city.lines.find(l => l.id === applied.meta.line);
    assert.ok(line.cycle < original.cycle);
    line.run.forEach((m, i) => assert.ok(close(m, original.run[i] * (1 - SPEED_GAIN))));
    assert.deepEqual(applied.plan.fleet, city.baseline.fleet);
    assert.ok(applied.cost.capital > 0);
    assert.equal(applied.cost.service, 0);
  });

  test(`${city.id}/shuttle bridges the lowest-access neighborhood`, () => {
    const applied = applyPreset(city, BASIC, 'shuttle');
    const base = assess(city, city.baseline, BASIC);
    const worst = base.rows.reduce((w, r, i) => r.access < base.rows[w].access ? i : w, 0);
    const added = applied.city.lines.at(-1);
    assert.equal(added.id, 'S1');
    assert.equal(added.stops.length, 2);
    assert.deepEqual(added.stops[0], [city.neighborhoods[worst].x, city.neighborhoods[worst].y]);
    assert.equal(applied.plan.fleet.at(-1), SHUTTLE_BUSES);
    assert.equal(applied.plan.fleet.length, city.lines.length + 1);
    assert.ok(applied.cost.service >= busAnnual(SHUTTLE_BUSES, city.hours));
  });

  test(`${city.id}/express links the two lowest-access neighborhoods through jobs`, () => {
    const applied = applyPreset(city, BASIC, 'express');
    const added = applied.city.lines.at(-1);
    const jobs = city.services.find(s => s.id === 'jobs').at;
    assert.equal(added.id, 'X1');
    assert.equal(added.stops.length, 3);
    assert.deepEqual(added.stops[1], jobs);
    assert.equal(applied.plan.fleet.at(-1), EXPRESS_BUSES);
    assert.ok(added.run.every(m => Number.isInteger(m) && m >= 1));
    assert.equal(added.cycle, 2 * added.run.reduce((a, b) => a + b, 0) + 6);
  });
}

// Custom packages

const CUSTOM_CASES = [
  { name: 'identity', params: { headwayScale: 1, speedGain: 0, subsidy: 0, cap: 0 } },
  { name: 'expansion', params: { headwayScale: 0.5, speedGain: 0, subsidy: 0, cap: 8_000_000 } },
  { name: 'unfunded expansion', params: { headwayScale: 0.5, speedGain: 0, subsidy: 0, cap: 0 } },
  { name: 'contraction', params: { headwayScale: 1.4, speedGain: 0, subsidy: 0, cap: 0 } },
  { name: 'mixed package', params: { headwayScale: 0.75, speedGain: 0.2, subsidy: 500000, cap: 1500000 } }
];

for (const city of CITIES) {
  for (const { name, params } of CUSTOM_CASES) {
    test(`${city.id}/custom:${name} stays valid, costed and deterministic`, () => {
      const applied = applyCustom(city, BASIC, params);
      validatePlan(applied.city, applied.plan);
      const { service, capital, subsidy, savings, annual } = applied.cost;
      assert.equal(annual, service + capital + subsidy - savings);
      assert.ok(service <= params.cap + 1e-6);
      assert.equal(subsidy, params.subsidy);
      const again = applyCustom(city, BASIC, params);
      assert.equal(canonical(applied.city), canonical(again.city));
      assert.deepEqual(applied.plan, again.plan);
    });
  }

  test(`${city.id}/custom identity reproduces baseline exactly`, () => {
    const evaluation = evaluateIntervention(city, BASIC, applyCustom(city, BASIC, CUSTOM_CASES[0].params));
    assert.equal(evaluation.cost.annual, 0);
    assert.equal(evaluation.metrics.accessDelta, 0);
    assert.deepEqual(evaluation.result.rows, evaluation.baseline.rows);
  });

  test(`${city.id}/custom cut books a service saving`, () => {
    const applied = applyCustom(city, BASIC, { headwayScale: 1.4, speedGain: 0, subsidy: 0, cap: 0 });
    assert.ok(applied.meta.cutBuses > 0);
    assert.ok(applied.cost.savings > 0);
    applied.plan.fleet.forEach((n, i) => assert.ok(n <= city.baseline.fleet[i]));
  });

  test(`${city.id}/custom subsidy only moves cost`, () => {
    const withSubsidy = applyCustom(city, BASIC, { headwayScale: 1, speedGain: 0, subsidy: 800000, cap: 0 });
    assert.equal(withSubsidy.cost.annual, 800000);
    assert.deepEqual(withSubsidy.plan.fleet, city.baseline.fleet);
  });

  test(`${city.id}/custom NaN parameters clamp instead of corrupting`, () => {
    const applied = applyCustom(city, BASIC, { headwayScale: NaN, speedGain: NaN, subsidy: NaN, cap: NaN });
    validatePlan(applied.city, applied.plan);
    assert.ok(Number.isFinite(applied.cost.annual));
  });

  test(`${city.id}/access improves monotonically as headways shrink`, () => {
    const mean = scale => evaluateIntervention(city, BASIC,
      applyCustom(city, BASIC, { headwayScale: scale, speedGain: 0, subsidy: 0, cap: 8_000_000 }))
      .metrics.access.after;
    const loose = mean(1.4);
    const base = mean(1);
    const tight = mean(0.5);
    assert.ok(base >= loose - 1e-9 && tight >= base - 1e-9);
  });
}

// Evaluation metric integrity

for (const city of CITIES) {
  test(`${city.id}/evaluation recomputes published metrics independently`, () => {
    const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, 'floor'));
    const weights = city.neighborhoods.map(n => n.pop);
    const total = weights.reduce((a, b) => a + b, 0);
    const access = evaluation.result.rows.map(r => r.access);
    assert.ok(close(evaluation.metrics.gini.after, gini(access, weights)));
    assert.ok(close(evaluation.metrics.access.after, weightedMean(access, weights)));
    assert.ok(close(evaluation.metrics.accessDelta,
      evaluation.metrics.access.after - evaluation.metrics.access.before));
    const manual = evaluation.result.rows.reduce((s, r, i) => s + weights[i] * r.within, 0)
      / (total * city.services.length);
    assert.ok(close(manual, evaluation.metrics.coverage.after));
    const jobs = city.services.findIndex(s => s.id === 'jobs');
    const reach = evaluation.result.rows.reduce((s, r, i) =>
      s + weights[i] * (r.times[jobs] <= 1800 ? 1 : 0), 0) / total;
    assert.ok(close(reach, evaluation.metrics.jobs30.after));
  });

  test(`${city.id}/band shares cover every resident-service pair`, () => {
    const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, 'headway'));
    for (const bands of [evaluation.bands.before, evaluation.bands.after]) {
      assert.equal(bands.length, ACCESS_BANDS.length + 1);
      assert.ok(close(bands.reduce((a, b) => a + b, 0), 1));
      bands.forEach(share => assert.ok(share >= 0 && share <= 1));
    }
  });

  test(`${city.id}/per-neighborhood deltas align with hood order`, () => {
    const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, 'express'));
    evaluation.neighborhoods.forEach((entry, i) => {
      assert.equal(entry.id, city.neighborhoods[i].id);
      assert.ok(close(entry.delta, entry.accessAfter - entry.accessBefore));
    });
    assert.ok(evaluation.result.rows.every((row, i) =>
      evaluation.neighborhoods[i].id === city.neighborhoods[i].id));
  });

  test(`${city.id}/lift-per-million is consistent with cost`, () => {
    for (const { id } of PRESET_NONBASE) {
      const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, id));
      if (evaluation.cost.annual > 0) {
        assert.ok(close(evaluation.metrics.liftPerMillion,
          evaluation.metrics.equityLift * 1e6 / evaluation.cost.annual));
      } else {
        assert.equal(evaluation.metrics.liftPerMillion, null);
      }
    }
  });
}

// Corridor leverage ranking

for (const city of CITIES) {
  test(`${city.id}/leverage ranks candidates by lift per dollar`, () => {
    const candidates = corridorLeverage(city, BASIC);
    assert.ok(candidates.length >= 5);
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1].liftPerMillion ?? -Infinity;
      const next = candidates[i].liftPerMillion ?? -Infinity;
      assert.ok(prev >= next);
    }
    candidates.forEach(c => {
      assert.ok(Number.isFinite(c.annualCost) && c.annualCost > 0);
      assert.ok(Number.isFinite(c.equityLift));
      assert.ok(['frequency', 'lane', 'bridge'].includes(c.kind));
    });
  });

  test(`${city.id}/leverage includes frequency and lane candidates`, () => {
    const candidates = corridorLeverage(city, BASIC);
    assert.ok(candidates.some(c => c.kind === 'frequency'));
    assert.ok(candidates.some(c => c.kind === 'lane'));
    const flex = city.lines.filter(l => l.min !== l.max).length;
    assert.ok(candidates.filter(c => c.kind === 'frequency').length === flex);
    assert.ok(candidates.filter(c => c.kind === 'lane').length === flex);
  });
}

// Hash codec

for (const { id } of PRESETS) {
  test(`hash round-trips preset ${id}`, () => {
    const encoded = encodeScenario({ preset: id, custom: {}, cityId: 'sunbelt' }, 'sunbelt');
    assert.equal(encoded, `scenario=${id}`);
    const decoded = decodeScenario(`#${encoded}`);
    assert.equal(decoded.preset, id);
    assert.deepEqual(decoded.custom, CUSTOM_DEFAULTS);
    assert.equal(decoded.cityId, null);
  });
}

const HASH_CASES = [
  { headwayScale: 0.7, speedGain: 0.15, subsidy: 400000, cap: 2000000 },
  { headwayScale: 0.5, speedGain: 0.4, subsidy: 3000000, cap: 8000000 },
  { headwayScale: 1.5, speedGain: 0.05, subsidy: 1, cap: 250000 },
  { headwayScale: 0.95, speedGain: 0, subsidy: 0, cap: 1 }
];

for (const [i, custom] of HASH_CASES.entries()) {
  test(`hash round-trips custom package ${i + 1}`, () => {
    const encoded = encodeScenario({ preset: 'custom', custom, cityId: 'rural' }, 'sunbelt');
    assert.match(encoded, /^scenario=custom/);
    const decoded = decodeScenario(`#${encoded}`);
    assert.equal(decoded.preset, 'custom');
    assert.equal(decoded.cityId, 'rural');
    assert.deepEqual(decoded.custom, clampCustom(custom));
    assert.equal(encodeScenario(decoded, 'sunbelt'), encoded);
  });
}

test('hash decode clamps out-of-range custom values', () => {
  const decoded = decodeScenario('#scenario=custom&hw=9&sg=-1&fs=99999999&cap=-5');
  assert.deepEqual(decoded.custom, {
    headwayScale: CUSTOM_LIMITS.headwayScale[1], speedGain: CUSTOM_LIMITS.speedGain[0],
    subsidy: CUSTOM_LIMITS.subsidy[1], cap: CUSTOM_LIMITS.cap[0]
  });
});

test('hash decode survives malformed and unknown input', () => {
  assert.equal(decodeScenario(''), null);
  assert.equal(decodeScenario('#policy'), null);
  assert.equal(decodeScenario('#scenario=bogus').preset, 'baseline');
  assert.equal(decodeScenario('#scenario').preset, 'baseline');
  assert.equal(decodeScenario('#scenario=express&city=nowhere').cityId, null);
  assert.equal(decodeScenario(null), null);
  assert.equal(decodeScenario('#scenario=floor&hw=0.8').preset, 'floor');
});

test('hash encode omits custom defaults and default city', () => {
  const encoded = encodeScenario({
    preset: 'custom', custom: { ...CUSTOM_DEFAULTS }, cityId: 'sunbelt' }, 'sunbelt');
  assert.equal(encoded, 'scenario=custom');
});

// Signed policy export

for (const city of CITIES) {
  test(`${city.id}/policy JSON is deterministic and digest-verified`, async () => {
    const selection = { preset: 'floor', custom: { ...CUSTOM_DEFAULTS } };
    const first = buildPolicyJson(city, BASIC, selection);
    assert.equal(first, buildPolicyJson(city, BASIC, selection));
    const { payload, sha256: hash } = JSON.parse(first);
    assert.equal(payload.synthetic, true);
    assert.equal(hash, createHash('sha256').update(canonical(payload)).digest('hex'));
    assert.equal(hash, sha256Hex(canonical(payload)));
    const result = await verifyPolicyJson(first);
    assert.deepEqual(result, { ok: true, city: city.id, sha256: hash });
  });

  test(`${city.id}/policy JSON rejects tampered payload by digest`, async () => {
    const first = JSON.parse(buildPolicyJson(city, BASIC, { preset: 'brt', custom: {} }));
    first.payload.scenarios[1].metrics.gini.after = 0.001;
    const result = await verifyPolicyJson(JSON.stringify(first));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'digest');
  });

  test(`${city.id}/policy JSON rejects rehashed forgery at replay`, async () => {
    const first = JSON.parse(buildPolicyJson(city, BASIC, { preset: 'shuttle', custom: {} }));
    first.payload.scenarios[0].metrics.accessDelta = 5;
    const forged = canonical({ payload: first.payload, sha256: sha256Hex(canonical(first.payload)) });
    const result = await verifyPolicyJson(forged);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'replay');
  });

  test(`${city.id}/policy CSV is quoted, complete and labeled`, () => {
    const text = policyCsv(city, BASIC, null);
    const lines = text.trimEnd().split('\r\n');
    assert.ok(lines[0].startsWith('# TransitGap'));
    assert.match(lines[0], /planning-model/i);
    const header = lines[1].split(',').map(c => c.replaceAll('"', ''));
    assert.ok(header.includes('equity_lift_per_1m'));
    assert.ok(header.includes('gini_after'));
    assert.equal(lines.length, PRESETS.length + 2);
    const ids = lines.slice(2).map(line => line.split(',')[0].replaceAll('"', ''));
    assert.deepEqual(ids, PRESETS.map(p => p.id));
  });

  test(`${city.id}/policy markdown carries digest, disclosure and bookmark`, () => {
    const selection = { preset: 'express', custom: { ...CUSTOM_DEFAULTS } };
    const md = policyMarkdown(city, BASIC, selection);
    const { payload } = JSON.parse(buildPolicyJson(city, BASIC, selection));
    assert.ok(md.includes(sha256Hex(canonical(payload))));
    assert.match(md, /Synthetic planning model output/);
    assert.match(md, /not real-agency figures/i);
    assert.ok(md.includes('`$'));
    assert.ok(md.includes(`#scenario=express`));
    assert.ok(md.includes(city.label));
  });
}

for (const [i, value] of [null, '', 'x', '{}', '{"payload":null}', '{"payload":{},"sha256":"00"}',
  '{"payload":{},"sha256":"' + 'a'.repeat(64) + '"}', 'x'.repeat(MAX_POLICY_BYTES + 1),
  '{"payload":{"version":"other"},"sha256":"' + 'a'.repeat(64) + '"}',
  '{"payload":{},"sha256":"' + 'a'.repeat(64) + '","extra":1}'].entries()) {
  test(`policy verifier rejects malformed input ${i + 1}`, async () => {
    assert.equal((await verifyPolicyJson(value)).ok, false);
  });
}

test('policy JSON verifies a custom selection end to end', async () => {
  const selection = { preset: 'custom', custom: { headwayScale: 0.6, speedGain: 0.1, subsidy: 100000, cap: 3000000 } };
  const text = buildPolicyJson(CITIES[1], BASIC, selection);
  const { payload } = JSON.parse(text);
  assert.equal(payload.selection.preset, 'custom');
  assert.ok(payload.scenarios.some(s => s.id === 'custom'));
  assert.deepEqual((await verifyPolicyJson(text)).ok, true);
});

test('policy CSV includes the active custom row', () => {
  const custom = { headwayScale: 0.6, speedGain: 0, subsidy: 0, cap: 4000000 };
  const lines = policyCsv(CITIES[0], BASIC, custom).trimEnd().split('\r\n');
  assert.equal(lines.length, PRESETS.length + 3);
  assert.equal(lines.at(-1).split(',')[0].replaceAll('"', ''), 'custom');
});

test('selectionFor mirrors the preset path', () => {
  for (const { id } of PRESETS) {
    const evaluation = selectionFor(CITIES[0], BASIC, { preset: id, custom: {} });
    assert.equal(evaluation.id, id);
  }
  const custom = selectionFor(CITIES[0], BASIC, {
    preset: 'custom', custom: { headwayScale: 0.5, speedGain: 0, subsidy: 0, cap: 8000000 } });
  assert.equal(custom.id, 'custom');
});

// lineKm

test('lineKm measures Manhattan corridor length', () => {
  const line = { stops: [[0, 0], [3, 0], [3, 4]] };
  assert.ok(close(lineKm(line, 500), 3.5));
  assert.equal(lineKm({ stops: [[1, 1]] }, 500), 0);
});

// Timetable mode integration

for (const city of CITIES) {
  test(`${city.id}/interventions run under the exact timetable`, () => {
    const options = { ...BASIC, mode: 'timetable', departure: 500 };
    for (const { id } of PRESET_NONBASE) {
      const evaluation = evaluateIntervention(city, options, applyPreset(city, options, id));
      assert.ok(Number.isFinite(evaluation.metrics.equityLift));
      assert.ok(evaluation.metrics.gini.after >= 0);
    }
    const applied = applyCustom(city, options, CUSTOM_CASES[4].params);
    validatePlan(applied.city, applied.plan);
  });
}

// Canonical boundary

test('canonical refuses non-finite numbers, documenting the export boundary', () => {
  assert.throws(() => canonical({ x: Infinity }), TypeError);
  assert.throws(() => canonical({ x: NaN }), TypeError);
  assert.equal(canonical({ x: null }), '{"x":null}');
});

// Self-test module

test('in-page self-test suite passes completely and deterministically', async () => {
  const first = await runSelfTests();
  assert.equal(first.total, SELF_TEST_COUNT);
  assert.equal(first.passed, first.total);
  first.results.forEach(r => {
    assert.ok(r.id && r.name && r.ok === true);
  });
  const second = await runSelfTests();
  assert.deepEqual(second.results.map(r => [r.id, r.ok]), first.results.map(r => [r.id, r.ok]));
});
