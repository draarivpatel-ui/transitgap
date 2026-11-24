// Neighborhood ride-share and community shuttle co-op planner.
// A volunteer loop is modeled as one more two-way line in the same street and
// transit graph the bus plan uses, so walking to a pickup, waiting, riding and
// transferring to a bus all come out of the existing Dijkstra search.
import { ACCESS_LIMIT, HOSPITAL_LIMIT, assess, key, normalizeOptions, walkSeconds } from './model.js';
import { sha256Hex } from './sha256.js';
import { formatTime } from './brief.js';

export const COOP_LIMITS = Object.freeze({
  vehicles: [1, 4], seats: [4, 14], hours: [1, 8], days: [1, 7], pickups: [1, 3]
});
export const COOP_DEFAULTS = Object.freeze({ vehicles: 2, seats: 6, hours: 3, days: 5 });
export const DRIVE_METERS_PER_MIN = 450;  // 27 km/h door to door, including curb stops
export const DWELL_MIN = 1;               // boarding time at each pickup
export const LAYOVER_MIN = 4;             // turnaround at both ends of the loop
export const WALK_SHED_SECONDS = 600;     // a ten-minute walk to the pickup point
export const COOP_COLOR = '#b5571c';
export const SERVICE_IDS = Object.freeze(['hospital', 'grocery', 'school', 'jobs']);
export const SERVICE_NAMES = Object.freeze({ hospital: 'Hospital', grocery: 'Grocery', school: 'High school', jobs: 'Job center' });
export const MAX_HOST = 60;

const clampInt = (value, [lo, hi], fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function cleanHost(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>`*_[\]#|\\]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_HOST);
}

export function normalizeCoop(city, input = {}) {
  const ids = new Set(city.neighborhoods.map(n => n.id));
  const pickups = [...new Set(Array.isArray(input.pickups) ? input.pickups : [])].filter(id => ids.has(id))
    .slice(0, COOP_LIMITS.pickups[1]);
  if (pickups.length < COOP_LIMITS.pickups[0]) throw new RangeError('Choose at least one pickup neighborhood');
  const anchor = SERVICE_IDS.includes(input.anchor) ? input.anchor : null;
  if (!anchor) throw new RangeError('Choose a destination for the loop');
  return {
    pickups, anchor,
    vehicles: clampInt(input.vehicles, COOP_LIMITS.vehicles, COOP_DEFAULTS.vehicles),
    seats: clampInt(input.seats, COOP_LIMITS.seats, COOP_DEFAULTS.seats),
    hours: clampInt(input.hours, COOP_LIMITS.hours, COOP_DEFAULTS.hours),
    days: clampInt(input.days, COOP_LIMITS.days, COOP_DEFAULTS.days),
    host: cleanHost(input.host)
  };
}

const blocks = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

// Visit pickups farthest-first from the destination, then each nearest next, so the
// loop sweeps inward and ends at the anchor service.
export function orderStops(city, pickups, anchor) {
  const dest = city.services.find(s => s.id === anchor).at;
  const points = pickups.map(id => city.neighborhoods.find(n => n.id === id)).map(n => ({ id: n.id, at: [n.x, n.y] }));
  points.sort((a, b) => blocks(b.at, dest) - blocks(a.at, dest) || a.id.localeCompare(b.id));
  const ordered = [points.shift()];
  while (points.length) {
    const last = ordered.at(-1).at;
    points.sort((a, b) => blocks(a.at, last) - blocks(b.at, last) || a.id.localeCompare(b.id));
    ordered.push(points.shift());
  }
  const stops = ordered.map(p => p.at);
  if (key(stops.at(-1)) !== key(dest)) stops.push(dest);
  return { order: ordered.map(p => p.id), stops };
}

export function coopLine(city, coop) {
  const { order, stops } = orderStops(city, coop.pickups, coop.anchor);
  const run = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const meters = blocks(stops[i], stops[i + 1]) * city.blockMeters;
    run.push(Math.max(1, Math.ceil(meters / DRIVE_METERS_PER_MIN) + DWELL_MIN));
  }
  if (!run.length) run.push(DWELL_MIN);
  const oneWay = run.reduce((a, b) => a + b, 0);
  const cycle = 2 * oneWay + 2 * LAYOVER_MIN;
  return {
    order, oneWay, cycle, headway: cycle / coop.vehicles,
    line: { id: 'V', name: 'Volunteer co-op loop', color: COOP_COLOR, coop: true, cycle, run,
      stops: stops.length > 1 ? stops : [stops[0], stops[0]], min: coop.vehicles, max: coop.vehicles }
  };
}

export function withCoop(city, plan, coop) {
  const built = coopLine(city, coop);
  return {
    ...built,
    city: { ...city, lines: [...city.lines, built.line], fleetBudget: city.fleetBudget + coop.vehicles },
    plan: { fleet: [...plan.fleet, coop.vehicles], shade: plan.shade.map(s => [...s]) }
  };
}

// Residents whose centroid is within a ten-minute walk of a pickup point.
export function walkShed(city, coop, heat = true) {
  const temp = heat ? city.heat : 26;
  const pickupAt = coop.pickups.map(id => city.neighborhoods.find(n => n.id === id)).map(n => [n.x, n.y]);
  return city.neighborhoods.map(n => {
    const seconds = Math.min(...pickupAt.map(p => walkSeconds(blocks([n.x, n.y], p) * city.blockMeters, 0.5, temp)));
    return { id: n.id, seconds, inside: seconds <= WALK_SHED_SECONDS };
  });
}

export function needRanking(city, result) {
  return city.neighborhoods.map((n, i) => {
    const row = result.rows[i];
    const missing = SERVICE_IDS.filter((_, j) => row.times[j] > ACCESS_LIMIT);
    const priority = Math.round(n.pop * Math.max(n.dependent, n.senior));
    const hospitalFar = row.times[0] > HOSPITAL_LIMIT;
    return { id: n.id, name: n.name, pop: n.pop, priority, missing, hospitalFar,
      score: priority * missing.length + (hospitalFar ? priority : 0) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const priorityOf = n => n.pop * Math.max(n.dependent, n.senior);

export function evaluateCoop(city, plan, options, input, before = assess(city, plan, options)) {
  const coop = normalizeCoop(city, input);
  const built = withCoop(city, plan, coop);
  const after = assess(built.city, built.plan, options);
  const shed = walkShed(city, coop, options.heat);
  const anchorIndex = SERVICE_IDS.indexOf(coop.anchor);
  const rows = city.neighborhoods.map((n, i) => {
    const b = before.rows[i], a = after.rows[i];
    const gained = SERVICE_IDS.filter((_, j) => b.times[j] > ACCESS_LIMIT && a.times[j] <= ACCESS_LIMIT);
    return { id: n.id, name: n.name, pop: n.pop, priority: Math.round(priorityOf(n)),
      beforeWithin: b.within, afterWithin: a.within, gained,
      anchorBefore: b.times[anchorIndex] / 60, anchorAfter: a.times[anchorIndex] / 60,
      walkMin: shed[i].seconds / 60, inShed: shed[i].inside };
  });
  const total = city.neighborhoods.reduce((s, n) => s + n.pop, 0);
  const pairs = r => r.rows.reduce((s, row, i) => s + row.within * city.neighborhoods[i].pop, 0);
  const priorityPairs = r => r.rows.reduce((s, row, i) => s + row.within * priorityOf(city.neighborhoods[i]), 0);
  const tripsPerVehicle = Math.floor(coop.hours * 60 / built.cycle) * 2;
  const weeklySeats = tripsPerVehicle * coop.vehicles * coop.seats * coop.days;
  const eligible = rows.filter(r => r.inShed).reduce((s, r) => s + r.priority, 0);
  const shiftsPerWeek = coop.vehicles * coop.days;
  return {
    coop, order: built.order, cycle: built.cycle, oneWay: built.oneWay, headway: built.headway, line: built.line,
    city: built.city, plan: built.plan, options: normalizeOptions(options), before, after, rows,
    gains: {
      coverageBefore: before.metrics.coverage, coverageAfter: after.metrics.coverage,
      coveragePP: (after.metrics.coverage - before.metrics.coverage) * 100,
      newPairs: pairs(after) - pairs(before),
      priorityPairs: Math.round(priorityPairs(after) - priorityPairs(before)),
      giniBefore: before.metrics.inequality, giniAfter: after.metrics.inequality,
      meanBefore: before.metrics.mean, meanAfter: after.metrics.mean,
      hospitalCleared: before.metrics.hospitalOver.filter(id => !after.metrics.hospitalOver.includes(id)),
      hospitalStill: after.metrics.hospitalOver,
      shedResidents: rows.filter(r => r.inShed).reduce((s, r) => s + r.pop, 0),
      shedShare: rows.filter(r => r.inShed).reduce((s, r) => s + r.pop, 0) / total,
      reached: rows.filter(r => r.gained.length).map(r => r.id)
    },
    capacity: { tripsPerVehicle, weeklySeats, eligible, seatsPerEligible: eligible ? weeklySeats / eligible : 0,
      shiftsPerWeek, driverHoursPerWeek: shiftsPerWeek * coop.hours }
  };
}

// Exhaustive search over every anchor and every pair of pickups (plus singles);
// the score counts priority residents' service pairs newly inside 30 minutes and
// adds a heavy weight for each neighborhood brought back inside the hospital limit.
export function suggestCoop(city, plan, options, settings = {}) {
  const before = assess(city, plan, options);
  const ids = city.neighborhoods.map(n => n.id);
  const candidates = [];
  for (const anchor of SERVICE_IDS) {
    for (let a = 0; a < ids.length; a++) {
      candidates.push([anchor, [ids[a]]]);
      for (let b = a + 1; b < ids.length; b++) candidates.push([anchor, [ids[a], ids[b]]]);
    }
  }
  let best = null;
  for (const [anchor, pickups] of candidates) {
    const ev = evaluateCoop(city, plan, options, { ...COOP_DEFAULTS, ...settings, anchor, pickups }, before);
    const score = ev.gains.priorityPairs + 2500 * ev.gains.hospitalCleared.length - ev.cycle;
    if (!best || score > best.score) best = { score, ev };
  }
  return { ...best.ev, searched: candidates.length };
}

const fmt = (v, d = 1) => Number(v).toFixed(d);
const names = (city, list) => list.map(id => city.neighborhoods.find(n => n.id === id).name);

export function actionBrief(city, ev) {
  const { coop, gains, capacity } = ev;
  const waiting = ev.options.mode === 'timetable'
    ? 'Waiting follows the scheduled timetable for trips departing at ' + formatTime(ev.options.departure) + '.'
    : 'Waiting is half the headway (expected wait).';
  const host = coop.host || 'Host organization (school, senior center or faith group)';
  const stops = [...names(city, ev.order), SERVICE_NAMES[coop.anchor]];
  const lines = [
    `# Community Action Brief: ${city.label} volunteer shuttle co-op`,
    '',
    `Prepared for ${host}. Synthetic planning evidence from TransitGap; not a forecast for a real place.`,
    '',
    '## The loop',
    '',
    `- Route: ${stops.join(' to ')}, then back the same way`,
    `- Vehicles: ${coop.vehicles}, ${coop.seats} seats each`,
    `- Round trip: ${ev.cycle} min, a pickup every ${fmt(ev.headway)} min`,
    `- Service window: ${coop.hours} h a day, ${coop.days} days a week`,
    '',
    '## Modeled access gains',
    '',
    '| Measure | Bus plan | With co-op |',
    '| --- | --- | --- |',
    `| Resident and service pairs within 30 min | ${fmt(gains.coverageBefore * 100)}% | ${fmt(gains.coverageAfter * 100)}% |`,
    `| Average trip, population weighted | ${fmt(gains.meanBefore)} min | ${fmt(gains.meanAfter)} min |`,
    `| Access Gini (lower is more equal) | ${fmt(gains.giniBefore, 4)} | ${fmt(gains.giniAfter, 4)} |`,
    `| Neighborhoods over 45 min from hospital | ${ev.before.metrics.hospitalOver.length} | ${gains.hospitalStill.length} |`,
    '',
    `Residents within a ten-minute walk of a pickup: ${gains.shedResidents.toLocaleString('en-US')} (${fmt(gains.shedShare * 100, 0)}%).`,
    '',
    '## Neighborhoods',
    '',
    '| Neighborhood | Walk to pickup | Services within 30 min | Newly reached |',
    '| --- | --- | --- | --- |',
    ...ev.rows.map(r => `| ${r.name} | ${fmt(r.walkMin)} min | ${r.beforeWithin} to ${r.afterWithin} | ${r.gained.map(s => SERVICE_NAMES[s]).join(', ') || 'none'} |`),
    '',
    '## Volunteer plan',
    '',
    `- Driver shifts each week: ${capacity.shiftsPerWeek} (${capacity.driverHoursPerWeek} driver hours)`,
    `- One-way trips per vehicle per day: ${capacity.tripsPerVehicle}`,
    `- Seats offered each week: ${capacity.weeklySeats.toLocaleString('en-US')}`,
    `- Priority residents (transit-dependent or senior) inside the walk shed: ${capacity.eligible.toLocaleString('en-US')}`,
    '',
    '## Before the first ride',
    '',
    '- [ ] Confirm vehicle insurance covers volunteer passengers',
    '- [ ] Run background checks and a short safety briefing for every driver',
    '- [ ] Arrange at least one vehicle that can carry a wheelchair or walker',
    '- [ ] Pick a shaded, well lit pickup point in each neighborhood',
    '- [ ] Publish the schedule in print and by phone, not only online',
    '- [ ] Share this brief with the local transit agency so the loop feeds its buses',
    '',
    '## Method',
    '',
    `The loop is added as one more two-way line in the same street and transit graph the bus plan uses. Driving runs at ${DRIVE_METERS_PER_MIN} m per minute with ${DWELL_MIN} min at each pickup and ${LAYOVER_MIN} min turnaround at each end. ${waiting} Gains hold only during the service window. Fares, booking, detours and driver availability are not modeled.`,
    ''
  ];
  return lines.join('\n');
}

export function actionBriefJson(city, options, ev) {
  const payload = {
    tool: 'TransitGap community shuttle co-op', version: 1, city: city.id, options: ev.options,
    coop: ev.coop, order: ev.order, cycle: ev.cycle,
    gains: { ...ev.gains, coveragePP: Number(ev.gains.coveragePP.toFixed(6)) },
    capacity: ev.capacity
  };
  const body = JSON.stringify(payload);
  return JSON.stringify({ ...payload, sha256: sha256Hex(body) }, null, 2);
}
