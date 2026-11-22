import { assess } from './model.js';

// Planning-model unit costs. Illustrative figures for comparing scenarios on a
// common scale, not cost estimates for any real agency.
export const UNIT_COSTS = Object.freeze({
  busHour: 90,             // dollars per scheduled bus-hour
  serviceDays: 365,        // equivalent service days per year
  laneKmYear: 42000,       // annualized capital and upkeep per dedicated lane-kilometre
  newLineOverhead: 150000, // fixed annual cost to introduce a new line
  shelterYear: 6000        // annualized capital and upkeep per added shelter
});

export const SPEED_GAIN = 0.25;    // dedicated-lane running-time saving
export const FLOOR_HEADWAY = 30;   // minutes of waiting guaranteed by the service floor
export const SHUTTLE_SPEED = 5.2;  // metres per second, shuttle running including dwell
export const SHUTTLE_BUSES = 2;
export const EXPRESS_SPEED = 6.9;  // metres per second, express running
export const EXPRESS_BUSES = 3;
export const SHUTTLE_LAYOVER = 4;  // minutes of terminal slack per direction pair
export const EXPRESS_LAYOVER = 6;
export const ACCESS_BANDS = Object.freeze([15, 30, 45, 60]);
export const EPSILON = 0.5;        // inequality aversion for the Atkinson index

export const PRESETS = Object.freeze([
  { id: 'baseline', label: 'Baseline today',
    detail: 'Current fleet and shelters, unchanged.' },
  { id: 'brt', label: 'Dedicated bus rapid lane',
    detail: 'The peak-corridor line gets a dedicated lane, cutting its running time.' },
  { id: 'headway', label: 'Peak headway halving',
    detail: 'Double the scheduled buses on every flexible bus line.' },
  { id: 'floor', label: 'Late-night service floor',
    detail: 'Guarantee every flexible line at least a 30-minute headway.' },
  { id: 'shuttle', label: 'Feeder micro-shuttle bridge',
    detail: 'A two-bus shuttle links the lowest-access neighborhood to the nearest stop.' },
  { id: 'express', label: 'Cross-town express link',
    detail: 'A three-bus express joins the two lowest-access neighborhoods.' }
]);
export const PRESET_IDS = new Set(PRESETS.map(p => p.id));

export const CUSTOM_DEFAULTS = Object.freeze({ headwayScale: 1, speedGain: 0, subsidy: 0, cap: 0 });
export const CUSTOM_LIMITS = Object.freeze({
  headwayScale: [0.5, 1.5], speedGain: [0, 0.4], subsidy: [0, 3_000_000], cap: [0, 8_000_000]
});

export function clampCustom(input) {
  const safe = { ...CUSTOM_DEFAULTS };
  if (!input || typeof input !== 'object') return safe;
  for (const [name, [lo, hi]] of Object.entries(CUSTOM_LIMITS)) {
    const value = Number(input[name]);
    safe[name] = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : CUSTOM_DEFAULTS[name];
  }
  return safe;
}

const flexible = city => city.lines.map((line, i) => i).filter(i => city.lines[i].min !== city.lines[i].max);
const busAnnual = (buses, hours) => buses * hours * UNIT_COSTS.serviceDays * UNIT_COSTS.busHour;
const cost = (service = 0, capital = 0, subsidy = 0, savings = 0) =>
  ({ service, capital, subsidy, savings, annual: service + capital + subsidy - savings });
const clone = city => structuredClone(city);

function checkPairs(values, weights) {
  if (!Array.isArray(values) || !Array.isArray(weights) || !values.length ||
      values.length !== weights.length ||
      !values.every(x => Number.isFinite(x) && x >= 0) ||
      !weights.every(x => Number.isFinite(x) && x >= 0)) throw new RangeError('Invalid weighted inputs');
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) throw new RangeError('Weights sum to zero');
  return total;
}

export function weightedMean(values, weights) {
  const total = checkPairs(values, weights);
  return values.reduce((sum, x, i) => sum + x * weights[i], 0) / total;
}

// Mean of the bottom share p of weight, ordered by value ascending.
export function quantileMean(values, weights, p) {
  const total = checkPairs(values, weights);
  if (!(p > 0 && p <= 1)) throw new RangeError('Quantile share outside (0, 1]');
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  return edgeMean(order, values, weights, p * total);
}

function edgeMean(order, values, weights, target) {
  let taken = 0;
  let sum = 0;
  for (const i of order) {
    const slice = Math.min(weights[i], target - taken);
    sum += values[i] * slice;
    taken += slice;
    if (taken >= target) break;
  }
  return sum / target;
}

// Share of the weighted value total held by the bottom share p of weight.
function quantileShare(values, weights, p) {
  const total = checkPairs(values, weights);
  const grand = values.reduce((sum, x, i) => sum + x * weights[i], 0);
  if (!grand) return 0;
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const target = p * total;
  let taken = 0;
  let sum = 0;
  for (const i of order) {
    const slice = Math.min(weights[i], target - taken);
    sum += values[i] * slice;
    taken += slice;
    if (taken >= target) break;
  }
  return sum / grand;
}

export function atkinson(values, weights, epsilon = EPSILON) {
  const total = checkPairs(values, weights);
  if (!(epsilon > 0)) throw new RangeError('Epsilon must be positive');
  const mean = values.reduce((sum, x, i) => sum + x * weights[i], 0) / total;
  if (!mean) return 0;
  const ede = epsilon === 1
    ? Math.exp(values.reduce((sum, x, i) => sum + (weights[i] / total) * Math.log(x), 0))
    : values.reduce((sum, x, i) => sum + (weights[i] / total) * x ** (1 - epsilon), 0)
      ** (1 / (1 - epsilon));
  return Math.min(1, Math.max(0, 1 - ede / mean));
}

// Ratio of top-quintile mean to bottom-quintile mean (the 20:20 equity ratio).
export function topBottomRatio(values, weights) {
  const total = checkPairs(values, weights);
  const bottom = quantileMean(values, weights, 0.2);
  if (!bottom) return Infinity;
  const desc = values.map((v, i) => i).sort((a, b) => values[b] - values[a] || a - b);
  return edgeMean(desc, values, weights, 0.2 * total) / bottom;
}

// Palma ratio: top-decile share over bottom-40-percent share of weighted value.
export function palmaRatio(values, weights) {
  const bottom = quantileShare(values, weights, 0.4);
  if (!bottom) return Infinity;
  return (1 - quantileShare(values, weights, 0.9)) / bottom;
}

// Corridor length along the stop sequence, in kilometres.
export function lineKm(line, blockMeters) {
  let blocks = 0;
  for (let i = 1; i < line.stops.length; i++) {
    blocks += Math.abs(line.stops[i][0] - line.stops[i - 1][0])
      + Math.abs(line.stops[i][1] - line.stops[i - 1][1]);
  }
  return blocks * blockMeters / 1000;
}

// Neighborhoods ordered by ascending baseline access (deterministic ties by index).
function worstAccess(result) {
  return result.rows.map((row, i) => i).sort((a, b) => result.rows[a].access - result.rows[b].access || a - b);
}

function shuttleLine(city, from, to, label) {
  const distance = Math.abs(from[0] - to[0]) + Math.abs(from[1] - to[1]);
  const run = Math.max(1, Math.ceil(distance * city.blockMeters / SHUTTLE_SPEED / 60));
  return { id: label, name: 'Micro-shuttle bridge', color: '#6d5390',
    cycle: 2 * run + SHUTTLE_LAYOVER, run: [run], stops: [from, to], min: 1, max: SHUTTLE_BUSES };
}

function expressLine(city, legs) {
  const run = legs.map(([from, to]) => {
    const distance = Math.abs(from[0] - to[0]) + Math.abs(from[1] - to[1]);
    return Math.max(1, Math.ceil(distance * city.blockMeters / EXPRESS_SPEED / 60));
  });
  return { id: 'X1', name: 'Cross-town express', color: '#2f6d8a',
    cycle: 2 * run.reduce((a, b) => a + b, 0) + EXPRESS_LAYOVER,
    run, stops: legs.map(leg => leg[0]).concat([legs.at(-1)[1]]), min: 1, max: EXPRESS_BUSES };
}

function finishPlan(c, fleet) {
  c.fleetBudget = fleet.reduce((a, b) => a + b, 0);
  c.lines.forEach((line, i) => { line.max = Math.max(line.max, fleet[i]); });
  return { fleet, shade: c.baseline.shade.map(stop => [...stop]) };
}

export function applyPreset(city, options, preset) {
  if (!PRESET_IDS.has(preset) || preset === 'custom') throw new RangeError('Unknown intervention preset');
  const base = assess(city, city.baseline, options);
  const flex = flexible(city);
  if (preset === 'baseline') {
    return { preset, city, plan: { fleet: [...city.baseline.fleet], shade: city.baseline.shade.map(s => [...s]) },
      cost: cost(), meta: {} };
  }
  if (preset === 'brt') {
    const target = flex.reduce((best, i) => city.baseline.fleet[i] > city.baseline.fleet[best] ? i : best, flex[0]);
    const c = clone(city);
    const line = c.lines[target];
    const runSum = line.run.reduce((a, b) => a + b, 0);
    line.run = line.run.map(m => m * (1 - SPEED_GAIN));
    line.cycle -= SPEED_GAIN * 2 * runSum;
    const km = lineKm(line, c.blockMeters);
    return { preset, city: c, plan: finishPlan(c, [...c.baseline.fleet]),
      cost: cost(0, km * UNIT_COSTS.laneKmYear), meta: { line: line.id, km } };
  }
  if (preset === 'headway') {
    const c = clone(city);
    const fleet = c.baseline.fleet.map((n, i) => flex.includes(i) ? 2 * n : n);
    const added = fleet.reduce((sum, n, i) => sum + n - c.baseline.fleet[i], 0);
    return { preset, city: c, plan: finishPlan(c, fleet),
      cost: cost(busAnnual(added, c.hours)), meta: { addedBuses: added } };
  }
  if (preset === 'floor') {
    const c = clone(city);
    const fleet = c.baseline.fleet.map((n, i) =>
      flex.includes(i) ? Math.max(n, Math.ceil(c.lines[i].cycle / FLOOR_HEADWAY)) : n);
    const added = fleet.reduce((sum, n, i) => sum + n - c.baseline.fleet[i], 0);
    return { preset, city: c, plan: finishPlan(c, fleet),
      cost: cost(busAnnual(added, c.hours)), meta: { addedBuses: added, floorHeadway: FLOOR_HEADWAY } };
  }
  if (preset === 'shuttle' || preset === 'express') {
    const c = clone(city);
    const order = worstAccess(base);
    const first = city.neighborhoods[order[0]];
    let line;
    let buses;
    if (preset === 'shuttle') {
      let best = null;
      for (const l of city.lines) {
        for (const stop of l.stops) {
          const d = Math.abs(stop[0] - first.x) + Math.abs(stop[1] - first.y);
          if (d >= 1 && (!best || d < best.d)) best = { stop, d };
        }
      }
      line = shuttleLine(c, [first.x, first.y], best.stop, 'S1');
      buses = SHUTTLE_BUSES;
      line.name = `${line.name} to ${first.name}`;
    } else {
      const second = city.neighborhoods[order[1]];
      const jobs = city.services.find(s => s.id === 'jobs')?.at ?? city.services[0].at;
      line = expressLine(c, [[[first.x, first.y], jobs], [jobs, [second.x, second.y]]]);
      buses = EXPRESS_BUSES;
    }
    c.lines.push(line);
    const fleet = [...c.baseline.fleet, buses];
    return { preset, city: c, plan: finishPlan(c, fleet),
      cost: cost(busAnnual(buses, c.hours) + UNIT_COSTS.newLineOverhead), meta: { line: line.id } };
  }
  throw new RangeError('Unknown intervention preset');
}

export function applyCustom(city, options, input) {
  const params = clampCustom(input);
  const c = clone(city);
  const flex = flexible(c);
  const fleet = [...c.baseline.fleet];
  const meta = { params: { ...params }, addedBuses: 0, cutBuses: 0, capped: false };
  let capital = 0;
  if (params.speedGain > 0) {
    for (const i of flex) {
      const line = c.lines[i];
      const runSum = line.run.reduce((a, b) => a + b, 0);
      line.run = line.run.map(m => m * (1 - params.speedGain));
      line.cycle -= params.speedGain * 2 * runSum;
      capital += lineKm(line, c.blockMeters) * UNIT_COSTS.laneKmYear * (params.speedGain / SPEED_GAIN);
    }
  }
  if (params.headwayScale > 1) {
    for (const i of flex) {
      const target = Math.max(c.lines[i].min, Math.round(c.baseline.fleet[i] / params.headwayScale));
      meta.cutBuses += c.baseline.fleet[i] - target;
      fleet[i] = target;
    }
  }
  if (params.headwayScale < 1) {
    const targets = c.baseline.fleet.map((n, i) =>
      flex.includes(i) ? Math.max(fleet[i], Math.round(n / params.headwayScale)) : fleet[i]);
    targets.forEach((n, i) => { c.lines[i].max = Math.max(c.lines[i].max, n); });
    c.fleetBudget = Math.max(c.fleetBudget, targets.reduce((a, b) => a + b, 0));
    meta.wantedBuses = targets.reduce((sum, n, i) => sum + Math.max(0, n - c.baseline.fleet[i]), 0);
    const rate = busAnnual(1, c.hours);
    let spent = 0;
    const score = f => assess(c, { fleet: f, shade: c.baseline.shade }, options).metrics.score;
    let current = score(fleet);
    for (;;) {
      let best = null;
      for (const i of flex) {
        if (fleet[i] >= targets[i] || spent + rate > params.cap) continue;
        const trial = fleet.map((n, j) => j === i ? n + 1 : n);
        const gain = current - score(trial);
        if (!best || gain > best.gain) best = { i, gain, trial };
      }
      if (!best || best.gain <= 0) break;
      fleet.splice(0, fleet.length, ...best.trial);
      current -= best.gain;
      spent += rate;
      meta.addedBuses++;
    }
    meta.serviceSpent = spent;
    meta.capped = flex.some(i => fleet[i] < targets[i]) && spent + rate > params.cap;
  }
  return { preset: 'custom', city: c, plan: finishPlan(c, fleet),
    cost: cost(meta.serviceSpent ?? 0, capital, params.subsidy, meta.cutBuses * busAnnual(1, c.hours)), meta };
}

// Population-weighted metrics pairing a baseline result with a scenario result.
export function evaluateIntervention(city, options, applied) {
  const before = assess(city, city.baseline, options);
  const after = assess(applied.city, applied.plan, options);
  const hoods = city.neighborhoods;
  const weights = hoods.map(n => n.pop);
  const accessOf = result => result.rows.map(r => r.access);
  const a0 = accessOf(before);
  const a1 = accessOf(after);
  const depTotal = hoods.reduce((s, n) => s + n.pop * n.dependent, 0);
  const depCoverage = result => depTotal ? result.rows.reduce((s, r, i) =>
    s + hoods[i].pop * hoods[i].dependent * (r.within / r.times.length), 0) / depTotal : 0;
  const jobsIndex = city.services.findIndex(s => s.id === 'jobs');
  const reach = (result, serviceIndex, limit) => result.rows.reduce((s, r, i) =>
    s + weights[i] * (r.times[serviceIndex] <= limit ? 1 : 0), 0) / weights.reduce((a, b) => a + b, 0);
  const bands = result => {
    const counts = [0, 0, 0, 0, 0];
    let total = 0;
    result.rows.forEach((row, i) => row.times.forEach(t => {
      const m = t / 60;
      counts[m <= 15 ? 0 : m <= 30 ? 1 : m <= 45 ? 2 : m <= 60 ? 3 : 4] += weights[i];
      total += weights[i];
    }));
    return counts.map(n => n / total);
  };
  const q20Before = quantileMean(a0, weights, 0.2);
  const q20After = quantileMean(a1, weights, 0.2);
  const giniBefore = before.metrics.inequality;
  const giniAfter = after.metrics.inequality;
  const equityLift = (giniBefore - giniAfter) + (q20After - q20Before);
  const annual = applied.cost.annual;
  return {
    id: applied.preset,
    label: PRESETS.find(p => p.id === applied.preset)?.label ?? 'Custom package',
    detail: PRESETS.find(p => p.id === applied.preset)?.detail ?? 'Slider-driven service package.',
    city: applied.city, plan: applied.plan, cost: applied.cost, meta: applied.meta,
    baseline: before, result: after,
    bands: { before: bands(before), after: bands(after) },
    metrics: {
      access: { before: weightedMean(a0, weights), after: weightedMean(a1, weights) },
      accessDelta: weightedMean(a1, weights) - weightedMean(a0, weights),
      gini: { before: giniBefore, after: giniAfter },
      atkinson: { before: atkinson(a0, weights), after: atkinson(a1, weights) },
      ratio: { before: topBottomRatio(a0, weights), after: topBottomRatio(a1, weights) },
      palma: { before: palmaRatio(a0, weights), after: palmaRatio(a1, weights) },
      q20: { before: q20Before, after: q20After },
      dependentCoverage: { before: depCoverage(before), after: depCoverage(after) },
      coverage: { before: before.metrics.coverage, after: after.metrics.coverage },
      mean: { before: before.metrics.mean, after: after.metrics.mean },
      jobs30: { before: reach(before, jobsIndex, 1800), after: reach(after, jobsIndex, 1800) },
      jobs45: { before: reach(before, jobsIndex, 2700), after: reach(after, jobsIndex, 2700) },
      equityLift,
      liftPerMillion: annual > 0 ? equityLift * 1e6 / annual : null
    },
    busHoursAdded: after.metrics.busHours - before.metrics.busHours,
    neighborhoods: hoods.map((n, i) => ({
      id: n.id, accessBefore: a0[i], accessAfter: a1[i], delta: a1[i] - a0[i],
      withinBefore: before.rows[i].within, withinAfter: after.rows[i].within
    }))
  };
}

export function evaluateAll(city, options, custom) {
  const list = PRESETS.map(p => evaluateIntervention(city, options, applyPreset(city, options, p.id)));
  if (custom) list.push(evaluateIntervention(city, options, applyCustom(city, options, custom)));
  return list;
}

// Candidate single-corridor upgrades ranked by equity gain per annual dollar.
export function corridorLeverage(city, options) {
  const base = assess(city, city.baseline, options);
  const weights = city.neighborhoods.map(n => n.pop);
  const baseAccess = base.rows.map(r => r.access);
  const gini0 = base.metrics.inequality;
  const q0 = quantileMean(baseAccess, weights, 0.2);
  const rate = busAnnual(1, city.hours);
  const candidates = [];
  const push = (label, kind, c2, plan, annual) => {
    const after = assess(c2, plan, options);
    const a1 = after.rows.map(r => r.access);
    const lift = (gini0 - after.metrics.inequality) + (quantileMean(a1, weights, 0.2) - q0);
    candidates.push({ label, kind, annualCost: annual, equityLift: lift,
      liftPerMillion: annual > 0 ? lift * 1e6 / annual : null });
  };
  for (const i of flexible(city)) {
    const line = city.lines[i];
    const c = clone(city);
    const fleet = [...c.baseline.fleet];
    fleet[i] += 1;
    push(`One more bus on ${line.id} ${line.name}`, 'frequency',
      c, finishPlan(c, fleet), rate);
    const cbrt = clone(city);
    const l2 = cbrt.lines[i];
    const runSum = l2.run.reduce((a, b) => a + b, 0);
    l2.run = l2.run.map(m => m * (1 - SPEED_GAIN));
    l2.cycle -= SPEED_GAIN * 2 * runSum;
    const km = lineKm(l2, cbrt.blockMeters);
    push(`Dedicated lane on ${line.id} ${line.name}`, 'lane',
      cbrt, finishPlan(cbrt, [...cbrt.baseline.fleet]), km * UNIT_COSTS.laneKmYear);
  }
  const order = worstAccess(base);
  const stops = city.lines.flatMap(l => l.stops);
  city.neighborhoods.forEach((n, i) => {
    if (!order.slice(0, 3).includes(i)) return;
    let best = null;
    for (const stop of stops) {
      const d = Math.abs(stop[0] - n.x) + Math.abs(stop[1] - n.y);
      if (d >= 1 && (!best || d < best.d)) best = { stop, d };
    }
    if (!best) return;
    const c = clone(city);
    c.lines.push(shuttleLine(c, [n.x, n.y], best.stop, `S${i}`));
    push(`Micro-shuttle bridge to ${n.name}`, 'bridge',
      c, finishPlan(c, [...c.baseline.fleet, SHUTTLE_BUSES]),
      busAnnual(SHUTTLE_BUSES, city.hours) + UNIT_COSTS.newLineOverhead);
  });
  candidates.sort((a, b) => (b.liftPerMillion ?? -Infinity) - (a.liftPerMillion ?? -Infinity));
  return candidates;
}
