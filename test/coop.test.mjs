import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC, CITIES } from '../src/cities.js';
import { assess, buildGraph, key, optimize, walkSeconds } from '../src/model.js';
import { sha256Hex } from '../src/sha256.js';
import { actionBrief, actionBriefJson, cleanHost, COOP_DEFAULTS, COOP_LIMITS, coopLine, DRIVE_METERS_PER_MIN,
  DWELL_MIN, evaluateCoop, LAYOVER_MIN, MAX_HOST, needRanking, normalizeCoop, orderStops, SERVICE_IDS,
  SERVICE_NAMES, suggestCoop, walkShed, WALK_SHED_SECONDS, withCoop } from '../src/coop.js';
import { renderMap } from '../src/map.js';

const fits = new Map(CITIES.map(city => [city.id, optimize(city, BASIC)]));
const blocks = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const ids = city => city.neighborhoods.map(n => n.id);

test('defaults sit inside their limits', () => {
  for (const [field, [lo, hi]] of Object.entries(COOP_LIMITS)) {
    if (field in COOP_DEFAULTS) assert.ok(COOP_DEFAULTS[field] >= lo && COOP_DEFAULTS[field] <= hi, field);
  }
});

test('service ids match the city service order', () => {
  for (const city of CITIES) assert.deepEqual(city.services.map(s => s.id), [...SERVICE_IDS]);
  for (const id of SERVICE_IDS) assert.equal(typeof SERVICE_NAMES[id], 'string');
});

test('normalizeCoop rejects an empty pickup list', () => {
  assert.throws(() => normalizeCoop(CITIES[0], { pickups: [], anchor: 'hospital' }), RangeError);
});

test('normalizeCoop rejects an unknown destination', () => {
  assert.throws(() => normalizeCoop(CITIES[0], { pickups: ['east'], anchor: 'mall' }), RangeError);
});

test('normalizeCoop drops unknown and duplicate pickups and caps at three', () => {
  const c = normalizeCoop(CITIES[0], { pickups: ['east', 'east', 'nowhere', 'arroyo', 'citrus', 'south'], anchor: 'grocery' });
  assert.deepEqual(c.pickups, ['east', 'arroyo', 'citrus']);
});

for (const [field, [lo, hi]] of Object.entries(COOP_LIMITS).filter(([f]) => f !== 'pickups')) {
  test(`normalizeCoop clamps ${field} into [${lo}, ${hi}]`, () => {
    const base = { pickups: ['east'], anchor: 'hospital' };
    assert.equal(normalizeCoop(CITIES[0], { ...base, [field]: lo - 10 })[field], lo);
    assert.equal(normalizeCoop(CITIES[0], { ...base, [field]: hi + 10 })[field], hi);
    assert.equal(normalizeCoop(CITIES[0], { ...base, [field]: 'abc' })[field], COOP_DEFAULTS[field]);
    assert.equal(normalizeCoop(CITIES[0], { ...base, [field]: lo + 0.4 })[field], lo);
  });
}

test('cleanHost strips markup, control characters and Markdown syntax', () => {
  assert.equal(cleanHost('<b>Senior *Center*</b>\n#1 | [x]'), 'bSenior Center/b 1 x');
  assert.equal(cleanHost(null), '');
  assert.equal(cleanHost('a'.repeat(200)).length, MAX_HOST);
  assert.equal(cleanHost('  Library   Teen  Group '), 'Library Teen Group');
});

for (const city of CITIES) {
  test(`${city.id}: orderStops ends at the destination and keeps every pickup once`, () => {
    for (const anchor of SERVICE_IDS) {
      const pickups = ids(city).slice(0, 3);
      const { order, stops } = orderStops(city, pickups, anchor);
      assert.deepEqual([...order].sort(), [...pickups].sort());
      assert.equal(key(stops.at(-1)), key(city.services.find(s => s.id === anchor).at));
      const dest = city.services.find(s => s.id === anchor).at;
      const first = city.neighborhoods.find(n => n.id === order[0]);
      for (const id of pickups) {
        const n = city.neighborhoods.find(x => x.id === id);
        assert.ok(blocks([first.x, first.y], dest) >= blocks([n.x, n.y], dest), 'farthest pickup starts the loop');
      }
    }
  });

  test(`${city.id}: coopLine legs follow the driving formula`, () => {
    const coop = normalizeCoop(city, { pickups: ids(city).slice(1, 3), anchor: 'grocery', vehicles: 2 });
    const built = coopLine(city, coop);
    const { stops } = built.line;
    built.line.run.forEach((minutes, i) => {
      const meters = blocks(stops[i], stops[i + 1]) * city.blockMeters;
      assert.equal(minutes, Math.max(1, Math.ceil(meters / DRIVE_METERS_PER_MIN) + DWELL_MIN));
    });
    assert.equal(built.cycle, 2 * built.oneWay + 2 * LAYOVER_MIN);
    assert.equal(built.headway, built.cycle / 2);
    assert.equal(built.line.min, 2);
    assert.equal(built.line.max, 2);
    assert.equal(built.line.run.length, built.line.stops.length - 1);
  });

  test(`${city.id}: withCoop leaves the city and plan untouched and passes plan validation`, () => {
    const fit = fits.get(city.id);
    const snapshot = JSON.stringify([city, fit.plan]);
    const coop = normalizeCoop(city, { pickups: [ids(city)[0]], anchor: 'hospital', vehicles: 3 });
    const built = withCoop(city, fit.plan, coop);
    assert.equal(built.city.lines.length, city.lines.length + 1);
    assert.equal(built.city.fleetBudget, city.fleetBudget + 3);
    assert.deepEqual(built.plan.fleet, [...fit.plan.fleet, 3]);
    assert.doesNotThrow(() => assess(built.city, built.plan, BASIC));
    assert.equal(JSON.stringify([city, fit.plan]), snapshot);
  });

  test(`${city.id}: the co-op line adds onboard states to the graph`, () => {
    const fit = fits.get(city.id);
    const coop = normalizeCoop(city, { pickups: ids(city).slice(0, 2), anchor: 'jobs' });
    const built = withCoop(city, fit.plan, coop);
    const plain = buildGraph(city, fit.plan.fleet, true).graph.length;
    const more = buildGraph(built.city, built.plan.fleet, true).graph.length;
    assert.equal(more - plain, 2 * built.line.stops.length);
  });

  test(`${city.id}: walkShed uses the model walking time and the ten-minute limit`, () => {
    const coop = normalizeCoop(city, { pickups: [ids(city)[2]], anchor: 'school' });
    const shed = walkShed(city, coop, true);
    const p = city.neighborhoods[2];
    city.neighborhoods.forEach((n, i) => {
      const want = walkSeconds(blocks([n.x, n.y], [p.x, p.y]) * city.blockMeters, 0.5, city.heat);
      assert.equal(shed[i].seconds, want);
      assert.equal(shed[i].inside, want <= WALK_SHED_SECONDS);
    });
    assert.equal(shed[2].seconds, 0);
  });

  test(`${city.id}: needRanking is sorted and counts missing services`, () => {
    const fit = fits.get(city.id);
    const rank = needRanking(city, fit.result);
    assert.equal(rank.length, city.neighborhoods.length);
    for (let i = 1; i < rank.length; i++) assert.ok(rank[i - 1].score >= rank[i].score);
    for (const r of rank) {
      const i = city.neighborhoods.findIndex(n => n.id === r.id);
      assert.equal(r.missing.length, 4 - fit.result.rows[i].within);
    }
  });

  test(`${city.id}: a co-op never makes any trip slower`, () => {
    const fit = fits.get(city.id);
    for (const anchor of SERVICE_IDS) {
      const ev = evaluateCoop(city, fit.plan, BASIC, { pickups: ids(city).slice(0, 2), anchor });
      ev.before.rows.forEach((b, i) => b.times.forEach((t, j) => assert.ok(ev.after.rows[i].times[j] <= t + 1e-9)));
      assert.ok(ev.gains.coverageAfter >= ev.gains.coverageBefore - 1e-12);
      assert.ok(ev.gains.newPairs >= 0);
      assert.ok(ev.gains.priorityPairs >= 0);
    }
  });

  test(`${city.id}: gained services agree with the before and after trip times`, () => {
    const fit = fits.get(city.id);
    const ev = evaluateCoop(city, fit.plan, BASIC, { pickups: ids(city).slice(3, 5), anchor: 'hospital' });
    ev.rows.forEach((r, i) => {
      assert.equal(r.afterWithin - r.beforeWithin, r.gained.length);
      for (const s of r.gained) assert.ok(ev.after.rows[i].times[SERVICE_IDS.indexOf(s)] <= 1800);
    });
    assert.deepEqual(ev.gains.reached, ev.rows.filter(r => r.gained.length).map(r => r.id));
  });

  test(`${city.id}: capacity arithmetic`, () => {
    const fit = fits.get(city.id);
    const ev = evaluateCoop(city, fit.plan, BASIC, { pickups: [ids(city)[4]], anchor: 'grocery', vehicles: 3, seats: 8, hours: 4, days: 6 });
    const trips = Math.floor(4 * 60 / ev.cycle) * 2;
    assert.equal(ev.capacity.tripsPerVehicle, trips);
    assert.equal(ev.capacity.weeklySeats, trips * 3 * 8 * 6);
    assert.equal(ev.capacity.shiftsPerWeek, 18);
    assert.equal(ev.capacity.driverHoursPerWeek, 72);
    const eligible = ev.rows.filter(r => r.inShed).reduce((s, r) => s + r.priority, 0);
    assert.equal(ev.capacity.eligible, eligible);
  });

  test(`${city.id}: more vehicles never lengthen trips`, () => {
    const fit = fits.get(city.id);
    const input = { pickups: ids(city).slice(0, 2), anchor: 'school' };
    const one = evaluateCoop(city, fit.plan, BASIC, { ...input, vehicles: 1 });
    const four = evaluateCoop(city, fit.plan, BASIC, { ...input, vehicles: 4 });
    assert.ok(four.headway < one.headway);
    one.after.rows.forEach((r, i) => r.times.forEach((t, j) => assert.ok(four.after.rows[i].times[j] <= t + 1e-9)));
  });

  test(`${city.id}: suggestCoop is deterministic and beats or ties every single-pickup loop`, () => {
    const fit = fits.get(city.id);
    const a = suggestCoop(city, fit.plan, BASIC);
    const b = suggestCoop(city, fit.plan, BASIC);
    assert.deepEqual([a.coop, a.order], [b.coop, b.order]);
    const n = city.neighborhoods.length;
    assert.equal(a.searched, SERVICE_IDS.length * (n + n * (n - 1) / 2));
    const score = ev => ev.gains.priorityPairs + 2500 * ev.gains.hospitalCleared.length - ev.cycle;
    for (const anchor of SERVICE_IDS) for (const id of ids(city)) {
      assert.ok(score(a) >= score(evaluateCoop(city, fit.plan, BASIC, { anchor, pickups: [id] })));
    }
  });

  test(`${city.id}: the suggested loop improves 30-minute access`, () => {
    const fit = fits.get(city.id);
    const ev = suggestCoop(city, fit.plan, BASIC);
    assert.ok(ev.gains.coveragePP > 0);
    assert.ok(ev.gains.priorityPairs > 0);
  });

  test(`${city.id}: action brief carries the route, gains and safety checklist`, () => {
    const fit = fits.get(city.id);
    const ev = evaluateCoop(city, fit.plan, BASIC, { pickups: ids(city).slice(0, 2), anchor: 'hospital', host: 'Maple <Senior> Center' });
    const md = actionBrief(city, ev);
    assert.match(md, /^# Community Action Brief/);
    assert.ok(md.includes('Prepared for Maple Senior Center.'));
    assert.ok(!md.includes('<'));
    for (const r of ev.rows) assert.ok(md.includes(`| ${r.name} |`));
    assert.equal((md.match(/- \[ \]/g) || []).length, 6);
    assert.ok(md.includes('Synthetic planning evidence'));
    assert.ok(!/[\u2013\u2014]/.test(md));
  });

  test(`${city.id}: signed brief JSON digest covers the payload`, () => {
    const fit = fits.get(city.id);
    const ev = evaluateCoop(city, fit.plan, BASIC, { pickups: [ids(city)[1]], anchor: 'jobs' });
    const doc = JSON.parse(actionBriefJson(city, BASIC, ev));
    const { sha256, ...payload } = doc;
    assert.equal(sha256, sha256Hex(JSON.stringify(payload)));
    payload.capacity.weeklySeats += 1;
    assert.notEqual(sha256, sha256Hex(JSON.stringify(payload)));
  });
}

test('rural suggestion favors the hamlets far from the hospital', () => {
  const city = CITIES.find(c => c.id === 'rural');
  const ev = suggestCoop(city, fits.get('rural').plan, BASIC);
  assert.equal(ev.coop.anchor, 'hospital');
  assert.ok(ev.gains.hospitalCleared.length >= 1);
});

test('heat off shortens or keeps every walk to a pickup', () => {
  const city = CITIES[0];
  const coop = normalizeCoop(city, { pickups: ['arroyo'], anchor: 'hospital' });
  const hot = walkShed(city, coop, true);
  const mild = walkShed(city, coop, false);
  hot.forEach((h, i) => assert.ok(mild[i].seconds <= h.seconds));
});

test('timetable mode evaluates a co-op without error', () => {
  const city = CITIES[1];
  const options = { heat: false, mode: 'timetable', departure: 7 * 60 + 30 };
  const fit = optimize(city, options);
  const ev = evaluateCoop(city, fit.plan, options, { pickups: ['canal'], anchor: 'grocery' });
  assert.ok(Number.isFinite(ev.gains.meanAfter));
});

test('co-op map buttons report real pickup state to screen readers', () => {
  const city = CITIES[0];
  const ev = evaluateCoop(city, fits.get(city.id).plan, BASIC, { pickups: ['east'], anchor: 'grocery' });
  const wrap = { id: 'coop-map', innerHTML: '', querySelectorAll: () => [] };
  renderMap(wrap, { city: ev.city, layer: 'change', baseline: ev.before, result: ev.after,
    plan: ev.plan, pickups: ev.coop.pickups }, () => {});
  const stateOf = id => wrap.innerHTML
    .match(new RegExp(`data-neighborhood="${id}"[^>]*aria-pressed="(true|false)"`))?.[1];
  const nameOf = id => wrap.innerHTML.match(new RegExp('data-neighborhood="' + id + '"[^>]*aria-label="([^"]+)"'))?.[1];
  assert.equal(wrap.innerHTML.match(/data-neighborhood="/g).length, city.neighborhoods.length);
  for (const id of ev.coop.pickups) assert.equal(stateOf(id), 'true', `${id} must announce as a pickup`);
  for (const id of ids(city).filter(id => !ev.coop.pickups.includes(id))) {
    assert.equal(stateOf(id), 'false', `${id} must announce as not picked`);
  }
  assert.match(wrap.innerHTML, /toggle co-op pickups/);
  for (const id of ev.coop.pickups) assert.match(nameOf(id), /pickup stop/, id);
  for (const id of ids(city).filter(id => !ev.coop.pickups.includes(id))) {
    assert.doesNotMatch(nameOf(id), /pickup stop/, id + ' must not claim to be a pickup stop');
  }
});

test('co-op evaluations retain an independent snapshot of the waiting mode and departure', () => {
  const city = CITIES[0];
  const options = { ...BASIC, mode: 'timetable', departure: 481 };
  const ev = evaluateCoop(city, city.baseline, options, { pickups: ['east'], anchor: 'grocery' });
  assert.deepEqual(ev.options, options);
  options.mode = 'expected';
  options.departure = 600;
  assert.equal(ev.options.mode, 'timetable');
  assert.equal(ev.options.departure, 481);
  assert.deepEqual(JSON.parse(actionBriefJson(city, options, ev)).options, ev.options);
});

test('timetable co-op exports describe scheduled waits at the actual departure time', () => {
  const city = CITIES[0];
  const options = { ...BASIC, mode: 'timetable', departure: 481 };
  const input = { pickups: ['east'], anchor: 'grocery' };
  const scheduled = evaluateCoop(city, city.baseline, options, input);
  const expected = evaluateCoop(city, city.baseline, { ...options, mode: 'expected' }, input);
  assert.notEqual(scheduled.gains.meanAfter, expected.gains.meanAfter);
  const timetableBrief = actionBrief(city, scheduled);
  assert.match(timetableBrief, /scheduled timetable/i);
  assert.match(timetableBrief, /08:01/);
  assert.doesNotMatch(timetableBrief, /half the headway|half-headway/i);
  const expectedBrief = actionBrief(city, expected);
  assert.match(expectedBrief, /half the headway|half-headway/i);
  assert.match(expectedBrief, /expected wait/i);
  assert.doesNotMatch(expectedBrief, /scheduled timetable/i);
});
