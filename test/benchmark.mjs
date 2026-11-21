import { BASIC, CITIES } from '../src/cities.js';
import { assess, optimize } from '../src/model.js';

for (const city of CITIES) {
  const base = assess(city, city.baseline, BASIC);
  const { plan, result, evaluated, hospitalFloor } = optimize(city, BASIC);
  const describe = ({ metrics: m, rows }) => ({
    minutes: m.mean.toFixed(2), gini: m.inequality.toFixed(4),
    exposedMinutes: m.exposed.toFixed(2), accessPercent: (100 * m.coverage).toFixed(1),
    busHours: m.busHours, shelters: m.shadeCount,
    hospitalOver45: Object.fromEntries(rows.filter(r => m.hospitalOver.includes(r.id))
      .map(r => [city.neighborhoods.find(n => n.id === r.id).name, (r.times[0] / 60).toFixed(1)]))
  });
  const unavoidable = Object.fromEntries(city.neighborhoods.flatMap((n, i) =>
    hospitalFloor[i] > 2700 ? [[n.name, (hospitalFloor[i] / 60).toFixed(1)]] : []));
  console.log(JSON.stringify({ scenario: city.id, evaluated, plan, baseline: describe(base),
    optimized: describe(result), unavoidable }));
}
