import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BASIC, CITIES } from '../src/cities.js';
import { assess, buildGraph, dijkstra, gini, operatingBudget, optimize, shadeCandidates, validatePlan,
  walkSeconds, waitSeconds } from '../src/model.js';
import { buildAudit, canonical, csv, csvCell, geojson, sha256, verifyAudit } from '../src/audit.js';

function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function oracle(graph, source, start, timetable) {
  const best = Array(graph.length).fill(Infinity);
  best[source] = start;
  for (let k = 1; k < graph.length; k++) {
    let changed = false;
    graph.forEach((edges, from) => {
      if (best[from] === Infinity) return;
      for (const e of edges) {
        let board = best[from];
        if (e.headway) {
          board = timetable
            ? e.phase + Math.ceil((board - e.phase) / e.headway) * e.headway
            : board + e.headway * 0.5;
        }
        if (board + e.seconds < best[e.to]) {
          best[e.to] = board + e.seconds;
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  return best;
}

for (let seed = 1; seed <= 140; seed++) {
  test(`Dijkstra versus Bellman-Ford on seeded graph ${seed}`, () => {
    const rng = random(seed);
    const graph = Array.from({ length: 4 + Math.floor(rng() * 26) }, () => []);
    graph.forEach((edges, from) => {
      for (let to = 0; to < graph.length; to++) {
        if (from === to || rng() > 0.24) continue;
        const data = rng() < 0.35 ? { headway: 30 + Math.floor(rng() * 91), phase: Math.floor(rng() * 250) } : {};
        edges.push({ to, seconds: Math.floor(rng() * 110), ...data });
      }
    });
    const source = seed % graph.length;
    const start = Math.floor(rng() * 3600);
    for (const timetable of [false, true]) {
      const { arrival, previous } = dijkstra(graph, source, start, timetable);
      assert.deepEqual([...arrival], oracle(graph, source, start, timetable));
      previous.forEach((p, to) => {
        if (p) assert.equal(arrival[to], arrival[p.node] + p.edge.seconds + p.wait);
      });
    }
  });
}

for (let seed = 1; seed <= 48; seed++) {
  test(`Timetable next departure and FIFO boundary ${seed}`, () => {
    const headway = seed * 15;
    const phase = seed * 21;
    const scheduled = phase + headway * (seed - 25);
    assert.equal(waitSeconds(headway, phase, scheduled - 1), 1);
    assert.equal(waitSeconds(headway, phase, scheduled), 0);
    assert.equal(waitSeconds(headway, phase, scheduled + 1), headway - 1);
    const graph = [[{ to: 1, seconds: 80, headway, phase }], []];
    assert.equal(dijkstra(graph, 0).arrival[1], 80 + headway / 2);
  });
}

for (let seed = 1; seed <= 36; seed++) {
  test(`Heat and sun penalty monotonicity ${seed}`, () => {
    const rng = random(seed * 13);
    const meters = 75 + rng() * 2000;
    const sun = rng();
    assert.equal(walkSeconds(meters, sun, 26), Math.ceil(meters / 1.25));
    assert.equal(walkSeconds(meters, sun, 34.99), walkSeconds(meters, sun, 26));
    assert.ok(walkSeconds(meters, sun, 35) >= walkSeconds(meters, sun, 26));
    assert.ok(walkSeconds(meters, sun, 43) >= walkSeconds(meters, sun, 35));
    assert.ok(walkSeconds(meters, sun, 43) >= walkSeconds(meters, 0, 43));
  });
}

for (let seed = 1; seed <= 36; seed++) {
  test(`Weighted Gini versus replicated-data Lorenz area ${seed}`, () => {
    const rng = random(seed * 121);
    const values = Array.from({ length: 3 + seed % 8 }, () => 1 + Math.floor(rng() * 80));
    const weights = values.map(() => Math.floor(rng() * 8));
    const expanded = values.flatMap((x, i) => Array(weights[i]).fill(x)).sort((a, b) => a - b);
    let sum = 0;
    let area = 0;
    for (const x of expanded) {
      area += sum + x / 2;
      sum += x;
    }
    const oracleGini = sum ? 1 - (2 * area / expanded.length / sum) : 0;
    const measured = gini(values, weights);
    assert.ok(measured >= 0 && measured < 1);
    assert.ok(Math.abs(measured - oracleGini) < 1e-12);
    assert.ok(Math.abs(measured - gini(values.map(x => x * 13), weights)) < 1e-12);
    assert.ok(Math.abs(measured - gini(values.slice().reverse(), weights.slice().reverse())) < 1e-12);
  });
}

const settings = [
  BASIC, { ...BASIC, heat: false }, { ...BASIC, mode: 'timetable' },
  { ...BASIC, mode: 'timetable', departure: 497 }, { ...BASIC, mode: 'timetable', departure: 1439 }
];

for (const city of CITIES) {
  for (const options of settings) {
    const label = `${city.id}/${options.heat}/${options.mode}/${options.departure}`;
    test(`City graph against the oracle ${label}`, () => {
      const { graph, at } = buildGraph(city, city.baseline.fleet, options.heat);
      for (const n of city.neighborhoods) {
        const src = at([n.x, n.y]);
        const start = options.departure * 60;
        const timetable = options.mode === 'timetable';
        assert.deepEqual([...dijkstra(graph, src, start, timetable).arrival], oracle(graph, src, start, timetable));
      }
    });
    test(`Budget conservation and dominance against baseline ${label}`, () => {
      const base = assess(city, city.baseline, options);
      const fit = optimize(city, options);
      const cap = operatingBudget(city);
      assert.equal(base.metrics.busHours, cap);
      assert.equal(base.metrics.shadeCount, city.shadeBudget);
      assert.ok(fit.result.metrics.busHours <= cap);
      assert.ok(fit.result.metrics.shadeCount <= city.shadeBudget);
      assert.ok(fit.result.metrics.score <= base.metrics.score + 1e-10);
      assert.deepEqual(assess(city, fit.plan, options), fit.result);
      if (!options.heat) assert.equal(fit.result.metrics.exposed, 0);
    });
  }
  test(`Exports and byte-for-byte deterministic audit ${city.id}`, async () => {
    const before = assess(city, city.baseline, BASIC);
    const { result } = optimize(city, BASIC);
    const audit = await buildAudit(city, BASIC, 'optimized');
    assert.equal(audit, await buildAudit(city, BASIC, 'optimized'));
    const { payload, sha256: hash } = JSON.parse(audit);
    assert.equal(hash, createHash('sha256').update(canonical(payload)).digest('hex'));
    assert.equal((await verifyAudit(audit)).ok, true);
    const geo = geojson(city, before, result);
    assert.equal(geo.features.length, city.neighborhoods.length);
    assert.equal(geo.synthetic, true);
    for (const [i, feature] of geo.features.entries()) {
      const [ring] = feature.geometry.coordinates;
      assert.deepEqual(ring[0], ring.at(-1));
      const doubleArea = ring.slice(1).reduce((s, [x, y], j) => s + ring[j][0] * y - x * ring[j][1], 0);
      assert.ok(doubleArea > 0);
      assert.equal(feature.properties.plan_hospital_min, result.rows[i].times[0] / 60);
      assert.ok(ring.every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90));
    }
    const table = csv(city, before, result).trimEnd().split('\r\n');
    const header = table[0].split(',');
    assert.equal(table.length, city.neighborhoods.length + 1);
    assert.equal(Number(table[1].split(',')[header.indexOf('"plan_hospital_min"')].replaceAll('"', '')),
      result.rows[0].times[0] / 60);
  });
}

test('Independent brute force of the complete rural fleet and shelter product', () => {
  const city = CITIES[2];
  let minimum = Infinity;
  let fleets = 0;
  const hospitalMin = city.neighborhoods.map(() => Infinity);
  for (let a = 1; a <= 4; a++) {
    for (let b = 1; b <= 4; b++) {
      for (let c = 1; c <= 4; c++) {
        if (a + b + c > 5) continue;
        fleets++;
        for (const shade of [[], ...shadeCandidates(city).map(s => [s])]) {
          const { metrics, rows } = assess(city, { fleet: [a, b, c], shade }, BASIC);
          minimum = Math.min(minimum, metrics.score);
          rows.forEach((row, i) => { hospitalMin[i] = Math.min(hospitalMin[i], row.times[0]); });
        }
      }
    }
  }
  const answer = optimize(city, BASIC);
  assert.equal(answer.evaluated, fleets);
  assert.equal(answer.result.metrics.score, minimum);
  assert.deepEqual(answer.hospitalFloor, hospitalMin);
  assert.ok(answer.result.metrics.hospitalOver.includes('mesa'));
});

test('Gini handles mass at zero and equal access', () => {
  assert.equal(gini([0, 10], [1, 1]), 0.5);
  assert.equal(gini([0, 0], [1, 1]), 0);
  assert.equal(gini([6, 6, 6], [1, 4, 20]), 0);
  assert.equal(gini([1], [0]), 0);
  assert.throws(() => gini([NaN], [1]));
  assert.throws(() => gini([1], [-1]));
});

test('Twice boarding takes two waits, but riding through a stop does not', () => {
  const graph = [
    [{ to: 1, seconds: 0, headway: 600, phase: 300 }], [{ to: 2, seconds: 60 }],
    [{ to: 3, seconds: 60 }, { to: 4, seconds: 0 }], [{ to: 5, seconds: 0 }],
    [{ to: 5, seconds: 0, headway: 600, phase: 100 }], []
  ];
  assert.equal(dijkstra(graph, 0, 0, true).arrival[5], 420);
  graph[2].shift();
  assert.equal(dijkstra(graph, 0, 0, true).arrival[5], 700);
});

test('Audit verifies a hand-edited, legal plan but rejects rehashed forged outcomes', async () => {
  const city = CITIES[0];
  const plan = { fleet: [1, 2, 2], shade: [] };
  const serialized = await buildAudit(city, BASIC, 'custom', plan);
  const { payload, sha256: hash } = JSON.parse(serialized);
  assert.deepEqual((await verifyAudit(serialized)), { ok: true, city: city.id, sha256: hash });
  payload.result.rows[0].times[0] += 60;
  assert.equal((await verifyAudit(canonical({ payload, sha256: hash }))).reason, 'digest');
  assert.equal((await verifyAudit(canonical({ payload, sha256: await sha256(canonical(payload)) }))).reason, 'replay');
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

for (const [i, value] of ['=1+1', '+42', '-2', '@SUM(A1)', '\tvalue', '\nnot a new row', '\ufeff =1',
  '\u200f@now', '  \uff0b2', '\r=x'].entries()) {
  test(`CSV formula neutralization ${i + 1}`, () => assert.ok(csvCell(value).startsWith(`"'`)));
}
test('CSV quoting preserves plain negative numbers and escapes embedded markup', () => {
  assert.equal(csvCell(-2.3), '"-2.3"');
  assert.equal(csvCell('one, "two"'), '"one, ""two"""');
  assert.equal(csvCell('text = 10'), '"text = 10"');
});

for (const [i, value] of [null, '', '{', '[]', '{"payload":null}', '{"payload":{}}',
  'x'.repeat(256_001), '{"sha256":null,"payload":{}}', '{"__proto__":{"bad":true}}'].entries()) {
  test(`Rejects malformed audit ${i + 1}`, async () => assert.equal((await verifyAudit(value)).ok, false));
}

for (let seed = 1; seed <= 20; seed++) {
  test(`Invalid shape fuzz ${seed}`, () => {
    const city = CITIES[seed % CITIES.length];
    const plan = structuredClone(city.baseline);
    const rng = random(seed);
    plan.fleet[seed % plan.fleet.length] = seed % 2 ? Math.floor(rng() * 20) + 5 : rng();
    assert.throws(() => validatePlan(city, plan));
    assert.throws(() => optimize(city, { ...BASIC, departure: -seed }));
    assert.throws(() => validatePlan(city, { ...city.baseline, shade: [[900 + seed, 0]] }));
  });
}
