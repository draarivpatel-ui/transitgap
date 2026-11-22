import { BASIC, CITIES } from './cities.js';
import { assess, gini, optimize } from './model.js';
import { buildAudit, canonical, csvCell, verifyAudit } from './audit.js';
import { sha256Hex } from './sha256.js';
import { applyCustom, applyPreset, atkinson, evaluateIntervention, PRESETS,
  quantileMean, topBottomRatio } from './interventions.js';
import { decodeScenario, encodeScenario, selectionFor } from './policy.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const CHECKS = [
  {
    id: 'sha256-abc', name: 'SHA-256 known-answer vector',
    run: () => sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  },
  {
    id: 'sha256-empty', name: 'SHA-256 empty-message vector',
    run: () => sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  },
  {
    id: 'sha256-blocks', name: 'SHA-256 two-block vector',
    run: () => sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
      === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  },
  {
    id: 'gini-bounds', name: 'Gini bounds and equal-access zero',
    run: () => {
      if (gini([0, 10], [1, 1]) !== 0.5) return 'known value failed';
      if (gini([6, 6, 6], [1, 4, 20]) !== 0) return 'equal access not zero';
      let seed = 7;
      for (let k = 0; k < 40; k++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const n = 2 + (seed % 9);
        const values = Array.from({ length: n }, (_, i) => ((seed >> (i % 24)) & 63) / 4 + 0.25);
        const weights = Array.from({ length: n }, (_, i) => 1 + ((seed >> (i % 16)) & 7));
        const g = gini(values, weights);
        if (!(g >= 0 && g < 1)) return `bound broken at sample ${k}`;
      }
      return true;
    }
  },
  {
    id: 'gini-transfer', name: 'Gini falls on an equalizing transfer',
    run: () => {
      const weights = [1, 1, 1];
      const unequal = gini([1, 2, 7], weights);
      const moved = gini([2, 2, 6], weights);
      return moved < unequal || 'regressive ordering failed';
    }
  },
  {
    id: 'atkinson-bounds', name: 'Atkinson index bounds and zero',
    run: () => {
      if (Math.abs(atkinson([5, 5, 5], [1, 1, 1])) > 1e-12) return 'equal values not zero';
      const a = atkinson([1, 2, 9], [2, 5, 3]);
      const b = atkinson([1, 2, 19], [2, 5, 3]);
      return (a >= 0 && a < 1 && b >= 0 && b < 1 && b > a) || 'bounds or ordering failed';
    }
  },
  {
    id: 'weights-conserved', name: 'Population weights conserved in metrics',
    run: () => {
      for (const city of CITIES) {
        const evaluation = selectionFor(city, BASIC, { preset: 'floor' });
        const total = city.neighborhoods.reduce((s, n) => s + n.pop, 0);
        const manual = evaluation.result.rows.reduce((s, r, i) =>
          s + city.neighborhoods[i].pop * r.within, 0) / (total * city.services.length);
        if (!close(manual, evaluation.metrics.coverage.after)) {
          return `${city.id} coverage weight mismatch`;
        }
        const dep = city.neighborhoods.reduce((s, n) => s + n.pop * n.dependent, 0);
        const manualDep = evaluation.result.rows.reduce((s, r, i) =>
          s + city.neighborhoods[i].pop * city.neighborhoods[i].dependent * r.within / r.times.length, 0) / dep;
        if (!close(manualDep, evaluation.metrics.dependentCoverage.after)) {
          return `${city.id} dependent weight mismatch`;
        }
      }
      return true;
    }
  },
  {
    id: 'intervention-dominance', name: 'No neighborhood is slower under any preset',
    run: () => {
      for (const city of CITIES) {
        for (const { id } of PRESETS) {
          const evaluation = evaluateIntervention(city, BASIC, applyPreset(city, BASIC, id));
          for (const [i, row] of evaluation.result.rows.entries()) {
            for (const [j, t] of row.times.entries()) {
              if (t > evaluation.baseline.rows[i].times[j] + 1e-9) {
                return `${city.id}/${id} worsened ${row.id} service ${j}`;
              }
            }
          }
        }
      }
      return true;
    }
  },
  {
    id: 'custom-identity', name: 'Zero-budget custom package is the identity',
    run: () => {
      for (const city of CITIES) {
        const evaluation = evaluateIntervention(city, BASIC,
          applyCustom(city, BASIC, { headwayScale: 1, speedGain: 0, subsidy: 0, cap: 0 }));
        if (evaluation.cost.annual !== 0) return `${city.id} nonzero cost`;
        if (!close(evaluation.metrics.accessDelta, 0) || !close(evaluation.metrics.equityLift, 0)) {
          return `${city.id} nonzero deltas`;
        }
        for (const [i, row] of evaluation.result.rows.entries()) {
          if (!row.times.every((t, j) => t === evaluation.baseline.rows[i].times[j])) {
            return `${city.id} times changed`;
          }
        }
      }
      return true;
    }
  },
  {
    id: 'optimizer-dominance', name: 'Optimizer never loses to baseline',
    run: () => {
      for (const city of CITIES) {
        const base = assess(city, city.baseline, BASIC);
        const fit = optimize(city, BASIC);
        if (fit.result.metrics.score > base.metrics.score + 1e-10) return `${city.id} regressed`;
      }
      return true;
    }
  },
  {
    id: 'hash-roundtrip', name: 'Scenario hash round-trips deterministically',
    run: () => {
      const once = { preset: 'custom', custom: { headwayScale: 0.7, speedGain: 0.15, subsidy: 400000, cap: 2000000 }, cityId: 'rural' };
      const hash = encodeScenario(once, 'sunbelt');
      const back = decodeScenario(`#${hash}`);
      if (!back || back.preset !== 'custom' || back.cityId !== 'rural') return 'fields lost';
      for (const k of ['headwayScale', 'speedGain', 'subsidy', 'cap']) {
        if (back.custom[k] !== once.custom[k]) return `custom.${k} changed`;
      }
      const again = encodeScenario(back, 'sunbelt');
      return again === hash || `re-encode drifted: ${again}`;
    }
  },
  {
    id: 'csv-injection', name: 'CSV formula neutralization',
    run: () => csvCell('=1+1').startsWith(`"'`) && csvCell('\t=x').startsWith(`"'`)
      && csvCell('plain').startsWith('"')
  },
  {
    id: 'quantile-order', name: 'Quintile means respect sorted order',
    run: () => {
      const values = [0.9, 0.4, 0.7, 0.2, 0.55];
      const weights = [10, 10, 10, 10, 10];
      const bottom = quantileMean(values, weights, 0.2);
      if (bottom !== 0.2) return `bottom quintile ${bottom}`;
      return topBottomRatio(values, weights) > 1 || 'ratio did not exceed one';
    }
  },
  {
    id: 'canonical-stable', name: 'Canonical serialization is deterministic',
    run: () => {
      const a = canonical({ b: [1, { z: 2, a: 'x' }], a: null });
      const b = canonical({ a: null, b: [1, { a: 'x', z: 2 }] });
      return a === b || a;
    }
  },
  {
    id: 'audit-roundtrip', name: 'Signed audit verifies on replay', async: true,
    run: async () => {
      const audit = await buildAudit(CITIES[0], BASIC, 'optimized');
      const result = await verifyAudit(audit);
      return result.ok || result.reason;
    }
  }
];

export const SELF_TEST_COUNT = CHECKS.length;

export async function runSelfTests() {
  const results = [];
  for (const check of CHECKS) {
    let ok = false;
    let detail = '';
    try {
      const out = await check.run();
      ok = out === true;
      if (!ok) detail = typeof out === 'string' ? out : 'returned false';
    } catch (error) {
      detail = error?.message ?? String(error);
    }
    results.push({ id: check.id, name: check.name, ok, detail });
  }
  return { results, passed: results.filter(r => r.ok).length, total: results.length };
}
