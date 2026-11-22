import { CITIES } from './cities.js';
import { canonical, csvCell } from './audit.js';
import { sha256Hex } from './sha256.js';
import { normalizeOptions } from './model.js';
import { applyCustom, applyPreset, clampCustom, corridorLeverage, CUSTOM_DEFAULTS,
  evaluateAll, evaluateIntervention, PRESET_IDS, UNIT_COSTS } from './interventions.js';

const VERSION = 'transitgap-policy/v1';
export const MAX_POLICY_BYTES = 2_000_000;
export const LEVERAGE_ROWS = 8;
const HASH_KEYS = Object.freeze({ headwayScale: 'hw', speedGain: 'sg', subsidy: 'fs', cap: 'cap' });

// Deterministic scenario bookmark: '#scenario=<preset>[&hw=&sg=&fs=&cap=][&city=]'
export function encodeScenario(selection, defaultCityId) {
  const preset = PRESET_IDS.has(selection?.preset) || selection?.preset === 'custom'
    ? selection.preset : 'baseline';
  const params = new URLSearchParams();
  params.set('scenario', preset);
  if (preset === 'custom') {
    const custom = clampCustom(selection.custom);
    for (const [name, key] of Object.entries(HASH_KEYS)) {
      const value = custom[name];
      if (value !== CUSTOM_DEFAULTS[name]) {
        params.set(key, name === 'subsidy' || name === 'cap' ? String(Math.round(value)) : String(Number(value.toFixed(4))));
      }
    }
  }
  if (selection?.cityId && selection.cityId !== defaultCityId) params.set('city', selection.cityId);
  return params.toString();
}

export function decodeScenario(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text) return null;
  let params;
  try {
    params = new URLSearchParams(text);
  } catch {
    return null;
  }
  const raw = params.get('scenario');
  if (raw === null) return null;
  const preset = PRESET_IDS.has(raw) || raw === 'custom' ? raw : 'baseline';
  const custom = { ...CUSTOM_DEFAULTS };
  for (const [name, key] of Object.entries(HASH_KEYS)) {
    if (params.has(key)) custom[name] = Number(params.get(key));
  }
  const cityId = params.get('city');
  return { preset, custom: clampCustom(custom),
    cityId: CITIES.some(c => c.id === cityId) ? cityId : null };
}

export function selectionFor(city, options, selection) {
  const applied = selection.preset === 'custom'
    ? applyCustom(city, options, selection.custom)
    : applyPreset(city, options, selection.preset);
  return evaluateIntervention(city, options, applied);
}

function payloadFor(city, options, selection) {
  const normalized = normalizeOptions(options);
  const scenarios = evaluateAll(city, normalized,
    selection.preset === 'custom' || customActive(selection.custom) ? selection.custom : null)
    .map(({ id, label, detail, city: network, plan, cost, meta, metrics, bands, neighborhoods }) =>
      ({ id, label, detail, network, plan, cost, meta, metrics, bands, neighborhoods }));
  return {
    version: VERSION, synthetic: true,
    disclaimer: 'Synthetic planning model output. Planning-model unit costs, not real-agency figures.',
    city, options: normalized,
    selection: { preset: selection.preset, custom: clampCustom(selection.custom) },
    scenarios,
    leverage: corridorLeverage(city, normalized).slice(0, LEVERAGE_ROWS),
    unitCosts: UNIT_COSTS
  };
}

export function buildPolicyJson(city, options, selection) {
  const payload = payloadFor(city, options, selection);
  return canonical({ payload, sha256: sha256Hex(canonical(payload)) });
}

export async function verifyPolicyJson(text) {
  let reason = 'format';
  try {
    if (typeof text !== 'string' || !text.length ||
        new TextEncoder().encode(text).length > MAX_POLICY_BYTES) return { ok: false, reason };
    const { payload, sha256: hash, ...rest } = JSON.parse(text);
    if (Object.keys(rest).length || !/^[a-f0-9]{64}$/.test(hash) ||
        payload?.version !== VERSION || payload.synthetic !== true) return { ok: false, reason };
    reason = 'digest';
    if (sha256Hex(canonical(payload)) !== hash) return { ok: false, reason };
    reason = 'replay';
    const city = CITIES.find(c => c.id === payload.city?.id);
    if (!city || canonical(city) !== canonical(payload.city)) return { ok: false, reason };
    const replay = payloadFor(city, normalizeOptions(payload.options), payload.selection);
    if (canonical(replay) !== canonical(payload)) return { ok: false, reason };
    return { ok: true, city: city.id, sha256: hash };
  } catch {
    return { ok: false, reason };
  }
}

const COLUMNS = [
  ['scenario', e => e.id], ['label', e => e.label],
  ['annual_cost_planning_model', e => e.cost.annual],
  ['service_cost', e => e.cost.service], ['capital_cost', e => e.cost.capital],
  ['fare_subsidy', e => e.cost.subsidy], ['service_savings', e => e.cost.savings],
  ['access_delta', e => e.metrics.accessDelta],
  ['gini_before', e => e.metrics.gini.before], ['gini_after', e => e.metrics.gini.after],
  ['atkinson_before', e => e.metrics.atkinson.before], ['atkinson_after', e => e.metrics.atkinson.after],
  ['ratio_2020_before', e => e.metrics.ratio.before], ['ratio_2020_after', e => e.metrics.ratio.after],
  ['palma_before', e => e.metrics.palma.before], ['palma_after', e => e.metrics.palma.after],
  ['dependent_coverage_before', e => e.metrics.dependentCoverage.before],
  ['dependent_coverage_after', e => e.metrics.dependentCoverage.after],
  ['coverage_before', e => e.metrics.coverage.before], ['coverage_after', e => e.metrics.coverage.after],
  ['jobs_30min_before', e => e.metrics.jobs30.before], ['jobs_30min_after', e => e.metrics.jobs30.after],
  ['jobs_45min_before', e => e.metrics.jobs45.before], ['jobs_45min_after', e => e.metrics.jobs45.after],
  ['mean_trip_before_min', e => e.metrics.mean.before], ['mean_trip_after_min', e => e.metrics.mean.after],
  ['equity_lift', e => e.metrics.equityLift],
  ['equity_lift_per_1m', e => e.metrics.liftPerMillion ?? '']
];

export function policyCsv(city, options, custom) {
  const rows = evaluateAll(city, normalizeOptions(options), customActive(custom) ? custom : null);
  const lines = [
    `# TransitGap comparator, synthetic ${city.id} scenario. Planning-model unit costs, not real-agency figures.`,
    COLUMNS.map(([name]) => csvCell(name)).join(','),
    ...rows.map(e => COLUMNS.map(([, f]) => csvCell(typeof f(e) === 'number' ? Number(f(e).toFixed(10)) : f(e))).join(','))
  ];
  return lines.join('\r\n') + '\r\n';
}

const dollars = value => {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '\u2212' : ''}\`$${Math.abs(rounded).toLocaleString('en-US')}\``;
};
const point = value => Number(value.toFixed(4));
const f4 = value => value.toFixed(4);
const signed = value => `${value >= 0 ? '+' : '\u2212'}${point(Math.abs(value))}`;
const customActive = custom => custom && Object.keys(CUSTOM_DEFAULTS)
  .some(k => clampCustom(custom)[k] !== CUSTOM_DEFAULTS[k]);

export function policyMarkdown(city, options, selection) {
  const normalized = normalizeOptions(options);
  const payload = payloadFor(city, normalized, selection);
  const hash = sha256Hex(canonical(payload));
  const rows = payload.scenarios;
  const chosen = rows.find(r => r.id === payload.selection.preset) ?? rows.at(-1);
  const cells = (list) => `| ${list.join(' | ')} |`;
  const metricRow = (label, pick) =>
    `| ${label} | ${f4(chosen.metrics[pick].before)} | ${f4(chosen.metrics[pick].after)} | ${signed(chosen.metrics[pick].after - chosen.metrics[pick].before)} |`;
  const comparison = rows.map(e => [
    e.label,
    signed(e.metrics.accessDelta),
    `${f4(e.metrics.gini.before)} \u2192 ${f4(e.metrics.gini.after)}`,
    `${f4(e.metrics.ratio.before)} \u2192 ${f4(e.metrics.ratio.after)}`,
    signed(e.metrics.dependentCoverage.after - e.metrics.dependentCoverage.before),
    `${(100 * e.metrics.jobs30.before).toFixed(0)}% \u2192 ${(100 * e.metrics.jobs30.after).toFixed(0)}%`,
    e.cost.annual <= 0 ? `${dollars(e.cost.annual)} net` : dollars(e.cost.annual),
    e.metrics.liftPerMillion === null ? 'n/a' : point(e.metrics.liftPerMillion)
  ]);
  const lines = [
    `# TransitGap policy impact brief`,
    ``,
    `Synthetic planning model output for a fictional city. Not a forecast, a cost estimate, or a claim about a real jurisdiction.`,
    ``,
    `Scenario: ${chosen.label}  \u00b7  City: ${city.label}  \u00b7  ${normalized.heat ? 'Heat advisory' : 'Mild weather'}  \u00b7  ${normalized.mode === 'timetable' ? `Timetable departure ${String(Math.floor(normalized.departure / 60)).padStart(2, '0')}:${String(normalized.departure % 60).padStart(2, '0')}` : 'Expected wait'}`,
    ``,
    `## Selected scenario`,
    ``,
    cells(['Measure', 'Baseline', 'Scenario', 'Change']),
    cells(['---', '---:', '---:', '---:']),
    metricRow('Weighted access score', 'access'),
    metricRow('Access Gini', 'gini'),
    metricRow('Atkinson index (e = 0.5)', 'atkinson'),
    metricRow('20:20 access ratio', 'ratio'),
    metricRow('Palma ratio', 'palma'),
    metricRow('Bottom-quintile access', 'q20'),
    metricRow('Dependent coverage', 'dependentCoverage'),
    metricRow('30-min coverage', 'coverage'),
    metricRow('Mean trip in minutes', 'mean'),
    metricRow('Jobs within 30 min', 'jobs30'),
    metricRow('Jobs within 45 min', 'jobs45'),
    ``,
    `## Scenario comparison`,
    ``,
    cells(['Scenario', 'Access delta', 'Gini', '20:20 ratio', 'Dependent lift', 'Jobs 30 min', 'Annual cost', 'Equity lift per ' + '`$1M`']),
    cells(['---', '---:', '---', '---', '---:', '---', '---:', '---:']),
    ...comparison.map(cells),
    ``,
    `## Cost basis`,
    ``,
    `Annual package cost ${dollars(chosen.cost.annual)}. Added service ${dollars(chosen.cost.service)}, lane capital ${dollars(chosen.cost.capital)}, fare subsidy ${dollars(chosen.cost.subsidy)}, service savings ${dollars(chosen.cost.savings)}.`,
    ``,
    `Planning-model unit costs, illustrative only, not real-agency figures. ${dollars(UNIT_COSTS.busHour)} per bus-hour, ${UNIT_COSTS.serviceDays} service days per year, ${dollars(UNIT_COSTS.laneKmYear)} per lane-kilometre per year, ${dollars(UNIT_COSTS.newLineOverhead)} fixed cost per new line, ${dollars(UNIT_COSTS.shelterYear)} per added shelter per year.`,
    ``,
    `## Highest-leverage corridors`,
    ``,
    cells(['Candidate', 'Kind', 'Annual cost', 'Equity lift', 'Lift per ' + '`$1M`']),
    cells(['---', '---', '---:', '---:', '---:']),
    ...payload.leverage.map(c => cells([c.label, c.kind, dollars(c.annualCost), point(c.equityLift), c.liftPerMillion === null ? 'n/a' : point(c.liftPerMillion)])),
    ``,
    `## Reproducibility`,
    ``,
    `SHA-256 over canonical payload: \`${hash}\``,
    ``,
    `Bookmark: \`#${encodeScenario({ preset: payload.selection.preset, custom: payload.selection.custom, cityId: city.id }, CITIES[0].id)}\``,
    ``,
    `Replaying the exported JSON recomputes every metric from the network definition. The digest detects edits but is not a signature.`
  ];
  return lines.join('\n') + '\n';
}
