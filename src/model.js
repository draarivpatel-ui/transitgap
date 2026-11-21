export const OBJECTIVE = Object.freeze({ gini: 25, wait: 0.45 });
export const SHADE_EFFECT = 0.8;
export const ACCESS_LIMIT = 1800;
export const HOSPITAL_LIMIT = 2700;
export const key = ([x, y]) => `${x},${y}`;

export function walkSeconds(meters, exposure, temp) {
  if (!Number.isFinite(meters) || meters < 0 || !(exposure >= 0 && exposure <= 1) || !Number.isFinite(temp)) {
    throw new RangeError('Invalid walking parameters');
  }
  const excess = temp >= 35 ? Math.min(temp - 32, 18) : 0;
  const speed = 1.25 * (1 - 0.0175 * excess);
  return Math.ceil(meters / speed * (1 + 0.035 * excess * exposure));
}

export function waitSeconds(headway, phase, arrival) {
  if (!(headway > 0) || ![headway, phase, arrival].every(Number.isFinite)) {
    throw new RangeError('Invalid timetable parameters');
  }
  return ((phase - arrival) % headway + headway) % headway;
}

export function gini(values, weights) {
  if (values.length !== weights.length || !values.every(x => Number.isFinite(x) && x >= 0) ||
      !weights.every(x => Number.isFinite(x) && x >= 0)) throw new RangeError('Invalid Gini inputs');
  const count = weights.reduce((sum, x) => sum + x, 0);
  const value = values.reduce((sum, x, i) => sum + x * weights[i], 0);
  if (!count || !value) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) sum += weights[i] * weights[j] * Math.abs(values[i] - values[j]);
  }
  return sum / (count * value);
}

class Heap {
  items = [];
  static less(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  push(item) {
    const a = this.items;
    let pos = a.length;
    a.push(item);
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (!Heap.less(item, a[parent])) break;
      a[pos] = a[parent];
      pos = parent;
    }
    a[pos] = item;
  }
  pop() {
    const a = this.items;
    const first = a[0];
    const tail = a.pop();
    if (!a.length) return first;
    let pos = 0;
    while (pos * 2 + 1 < a.length) {
      let child = pos * 2 + 1;
      if (child + 1 < a.length && Heap.less(a[child + 1], a[child])) child++;
      if (!Heap.less(a[child], tail)) break;
      a[pos] = a[child];
      pos = child;
    }
    a[pos] = tail;
    return first;
  }
}

export function dijkstra(graph, source, start = 0, timetable = false) {
  if (!Number.isInteger(source) || !graph[source] || !Number.isFinite(start)) throw new RangeError('Invalid origin');
  const arrival = new Float64Array(graph.length).fill(Infinity);
  const previous = Array(graph.length).fill(null);
  const queue = new Heap();
  arrival[source] = start;
  queue.push([start, source]);
  while (queue.items.length) {
    const [time, node] = queue.pop();
    if (time !== arrival[node]) continue;
    for (const edge of graph[node]) {
      const wait = edge.headway ? (timetable ? waitSeconds(edge.headway, edge.phase, time) : edge.headway / 2) : 0;
      const next = time + edge.seconds + wait;
      if (next < arrival[edge.to]) {
        arrival[edge.to] = next;
        previous[edge.to] = { node, wait, edge };
        queue.push([next, edge.to]);
      }
    }
  }
  return { arrival, previous };
}

export function normalizeOptions(input) {
  if (!input || typeof input.heat !== 'boolean' ||
      !['expected', 'timetable'].includes(input.mode) ||
      !Number.isInteger(input.departure) || input.departure < 0 || input.departure >= 1440) {
    throw new RangeError('Invalid model settings');
  }
  return { heat: input.heat, mode: input.mode, departure: input.departure };
}

export function shadeCandidates(city) {
  return [...new Map(city.lines.filter(line => line.id !== 'R')
    .flatMap(line => line.stops).map(at => [key(at), at])).values()];
}

export function operatingBudget(city) {
  return (city.fleetBudget - city.lines.filter(line => line.min === line.max)
    .reduce((total, line) => total + line.min, 0)) * city.hours;
}

export function validatePlan(city, plan) {
  if (!plan || !Array.isArray(plan.fleet) || plan.fleet.length !== city.lines.length ||
      !city.lines.every((line, i) => Number.isInteger(plan.fleet[i]) &&
        plan.fleet[i] >= line.min && plan.fleet[i] <= line.max) ||
      plan.fleet.reduce((sum, n) => sum + n, 0) > city.fleetBudget ||
      !Array.isArray(plan.shade) || plan.shade.length > city.shadeBudget) throw new RangeError('Plan exceeds its limits');
  const candidates = new Set(shadeCandidates(city).map(key));
  const selected = new Set();
  for (const stop of plan.shade) {
    if (!Array.isArray(stop) || stop.length !== 2 || !stop.every(Number.isInteger) ||
        !candidates.has(key(stop)) || selected.has(key(stop))) throw new RangeError('Invalid shade stop');
    selected.add(key(stop));
  }
  return { fleet: [...plan.fleet], shade: plan.shade.map(stop => [...stop]) };
}

export function streetSun(x, y, nx, ny) {
  return (3 + ((Math.min(x, nx) * 13 + Math.min(y, ny) * 5 + (x === nx ? 2 : 0)) % 7)) / 10;
}

export function buildGraph(city, fleet, heat) {
  const graph = Array.from({ length: city.w * city.h }, () => []);
  const at = ([x, y]) => y * city.w + x;
  const temp = heat ? city.heat : 26;
  const join = (from, to, data) => graph[from].push({ to, ...data });
  for (let y = 0; y < city.h; y++) {
    for (let x = 0; x < city.w; x++) {
      for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
        if (nx >= city.w || ny >= city.h) continue;
        const seconds = walkSeconds(city.blockMeters, streetSun(x, y, nx, ny), temp);
        join(at([x, y]), at([nx, ny]), { seconds });
        join(at([nx, ny]), at([x, y]), { seconds });
      }
    }
  }
  city.lines.forEach((line, index) => {
    const headway = line.cycle * 60 / fleet[index];
    const offset = index * 120;
    for (const reverse of [false, true]) {
      const stops = reverse ? line.stops.slice().reverse() : line.stops;
      const runs = reverse ? line.run.slice().reverse() : line.run;
      const base = graph.length;
      let phase = offset + (reverse ? line.cycle * 30 : 0);
      for (let i = 0; i < stops.length; i++) {
        const station = at(stops[i]);
        graph.push([]);
        join(base + i, station, { seconds: 0 });
        if (i < runs.length) {
          join(station, base + i, { seconds: 0, headway, phase, station: key(stops[i]) });
          join(base + i, base + i + 1, { seconds: runs[i] * 60 });
          phase += runs[i] * 60;
        }
      }
    }
  });
  return { graph, at };
}

function routeProfiles(city, fleet, options) {
  const { graph, at } = buildGraph(city, fleet, options.heat);
  const start = options.departure * 60;
  return city.neighborhoods.map(n => {
    const { arrival, previous } = dijkstra(graph, at([n.x, n.y]), start, options.mode === 'timetable');
    const journeys = city.services.map(service => {
      const target = at(service.at);
      const waits = Object.create(null);
      for (let node = target; previous[node]; node = previous[node].node) {
        const step = previous[node];
        if (step.edge.station && step.wait) waits[step.edge.station] = (waits[step.edge.station] ?? 0) + step.wait;
      }
      return { seconds: arrival[target] - start, waits };
    });
    return { n, journeys };
  });
}

function fromProfiles(city, fleet, shade, options, profiles) {
  const shaded = new Set(shade.map(key));
  const rows = profiles.map(({ n, journeys }) => {
    const times = journeys.map(j => j.seconds);
    const mean = times.reduce((a, b) => a + b, 0) / times.length / 60;
    let exposed = 0;
    if (options.heat) {
      for (const journey of journeys) {
        for (const [stop, seconds] of Object.entries(journey.waits)) {
          exposed += seconds * (shaded.has(stop) ? 1 - SHADE_EFFECT : 1);
        }
      }
    }
    return { id: n.id, times, mean, access: 1 / (1 + mean / 30),
      within: times.filter(t => t <= ACCESS_LIMIT).length, exposed: exposed / journeys.length / 60 };
  });
  const weights = city.neighborhoods.map(n => n.pop);
  const total = weights.reduce((a, b) => a + b, 0);
  const meanOf = field => rows.reduce((sum, row, i) => sum + row[field] * weights[i], 0) / total;
  const mean = meanOf('mean');
  const inequality = gini(rows.map(r => r.access), weights);
  const exposed = meanOf('exposed');
  const metrics = {
    mean, inequality, exposed, coverage: meanOf('within') / city.services.length,
    hospitalOver: rows.filter(r => r.times[0] > HOSPITAL_LIMIT).map(r => r.id),
    busHours: fleet.reduce((sum, buses, i) => sum + (city.lines[i].min === city.lines[i].max ? 0 : buses), 0) * city.hours,
    shadeCount: shade.length, score: mean + OBJECTIVE.gini * inequality + OBJECTIVE.wait * exposed
  };
  return { rows, metrics };
}

export function assess(city, plan, input) {
  const options = normalizeOptions(input);
  const { fleet, shade } = validatePlan(city, plan);
  return fromProfiles(city, fleet, shade, options, routeProfiles(city, fleet, options));
}

export function optimize(city, input) {
  const options = normalizeOptions(input);
  const shades = shadeCandidates(city);
  const fleet = [];
  const mandatory = city.lines.map((_, i) => city.lines.slice(i + 1).reduce((sum, line) => sum + line.min, 0));
  let best = null;
  let evaluated = 0;
  const hospitalFloor = city.neighborhoods.map(() => Infinity);
  function visit(i, left) {
    if (i < city.lines.length) {
      const { min, max } = city.lines[i];
      for (let n = min; n <= max && n <= left - mandatory[i]; n++) {
        fleet[i] = n;
        visit(i + 1, left - n);
      }
      return;
    }
    const profiles = routeProfiles(city, fleet, options);
    profiles.forEach(({ journeys }, i) => {
      hospitalFloor[i] = Math.min(hospitalFloor[i], journeys[0].seconds);
    });
    const exposures = new Map();
    if (options.heat) {
      for (const { n, journeys } of profiles) {
        for (const { waits } of journeys) {
          for (const [stop, seconds] of Object.entries(waits)) {
            exposures.set(stop, (exposures.get(stop) ?? 0) + seconds * n.pop);
          }
        }
      }
    }
    // Shade changes only the exposure of the chosen fastest journeys, so savings are additive.
    const impact = at => exposures.get(key(at)) ?? 0;
    const shade = shades.filter(at => impact(at) > 0).sort((a, b) => impact(b) - impact(a))
      .slice(0, city.shadeBudget);
    const result = fromProfiles(city, fleet, shade, options, profiles);
    evaluated++;
    if (!best || result.metrics.score < best.result.metrics.score) {
      best = { plan: { fleet: [...fleet], shade }, result };
    }
  }
  visit(0, city.fleetBudget);
  return { ...best, evaluated, hospitalFloor };
}
