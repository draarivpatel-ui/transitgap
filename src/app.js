import { BASIC, CITIES } from './cities.js';
import { assess, key, operatingBudget, optimize, shadeCandidates } from './model.js';
import { buildAudit, csv, geojson, MAX_AUDIT_BYTES, verifyAudit } from './audit.js';
import { renderBrief } from './brief.js';
import { renderLegend, renderMap } from './map.js';
import { applyCustom, applyPreset, clampCustom, corridorLeverage, CUSTOM_DEFAULTS,
  evaluateIntervention, PRESETS } from './interventions.js';
import { buildPolicyJson, decodeScenario, encodeScenario, MAX_POLICY_BYTES,
  policyCsv, policyMarkdown, verifyPolicyJson } from './policy.js';
import { runSelfTests } from './selftest.js';
import { customOutputs, renderBands, renderCompare, renderLeverage, renderPresets,
  renderScenarioMaps, renderVerify } from './policyview.js';

const $ = id => document.getElementById(id);
const services = ['Hospital', 'Grocery', 'High school', 'Job center'];
const defaultSelected = cityId => cityId === 'rural' ? 'mesa' : cityId === 'rail' ? 'canal' : 'east';
const state = {
  city: CITIES[0], options: { ...BASIC }, plan: null, result: null, baseline: null, fit: null,
  kind: 'optimized', layer: 'plan', selected: 'east', language: 'en',
  policy: { preset: 'baseline', custom: { ...CUSTOM_DEFAULTS }, evals: null, leverage: null, dirty: true }
};
const n = (value, digits = 1) => value.toFixed(digits);
const pct = value => `${n(value * 100, 0)}%`;
const signed = (value, digits = 1) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${n(Math.abs(value), digits)}`;
const short = value => n(value).replace(/\.0$/, '');

function setSelected(id) {
  state.selected = id;
  $('neighborhood').value = id;
  document.querySelectorAll('[data-neighborhood]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.neighborhood === id)));
  renderDetail();
  renderPolicySelection();
}

function renderDetail() {
  const { city, baseline, result, fit } = state;
  const i = city.neighborhoods.findIndex(entry => entry.id === state.selected);
  const entry = city.neighborhoods[i];
  const b = baseline.rows[i];
  const a = result.rows[i];
  $('detail').innerHTML = `
    <div class="population"><strong>${entry.pop.toLocaleString('en-US')}</strong> residents</div>
    <dl class="shares">
      <div><dt>Transit-dependent</dt><dd>${pct(entry.dependent)}</dd></div>
      <div><dt>Senior</dt><dd>${pct(entry.senior)}</dd></div>
      <div><dt>Student</dt><dd>${pct(entry.student)}</dd></div>
    </dl>
    <table aria-label="Travel times from ${entry.name}">
      <thead><tr><th scope="col">Trip minutes</th><th scope="col">Base</th><th scope="col">Plan</th></tr></thead>
      <tbody>${services.map((name, j) => `<tr><th scope="row">${name}</th><td>${n(b.times[j] / 60)}</td>
        <td class="${a.times[j] <= 1800 ? 'within' : j === 0 && a.times[j] > 2700 ? 'outside' : ''}">${n(a.times[j] / 60)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="exposure-row"><span>Heat-exposed wait</span><strong>${n(b.exposed)} &rarr; ${n(a.exposed)} min</strong></div>
    ${fit.hospitalFloor[i] > 2700 ? `<p class="local-gap">Best hospital time within budget: <strong>${n(fit.hospitalFloor[i] / 60)} min</strong></p>` : ''}`;
}

function renderMetrics() {
  const before = state.baseline.metrics;
  const after = state.result.metrics;
  const cards = [
    ['30-min access', 'coverage', 100, 1, '%', ' pp', true], ['Mean trip', 'mean', 1, 1, ' min', ' min', false],
    ['Access Gini', 'inequality', 1, 3, '', '', false], ['Heat-exposed wait', 'exposed', 1, 1, ' min', ' min', false]
  ];
  $('metrics').innerHTML = cards.map(([label, key, scale, precision, unit, changeUnit, up]) => {
    const left = n(scale * before[key], precision);
    const right = n(scale * after[key], precision);
    const d = Number((Number(right) - Number(left)).toFixed(precision));
    const css = !d ? 'flat' : (d > 0) === up ? 'better' : 'worse';
    return `<div><dt>${label}</dt><dd><strong>${right}${unit}</strong><span class="delta ${css}">${signed(d, precision)}${changeUnit}</span></dd>
      <span class="baseline-label">Baseline ${left}${unit}</span></div>`;
  }).join('');
}

function renderLayers() {
  document.querySelectorAll('[data-layer]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.layer === state.layer)));
  renderMap($('map-wrap'), state, setSelected);
  renderLegend($('legend'), state.layer);
}

function renderResults() {
  const { city, fit, result, kind, options } = state;
  $('city-title').textContent = city.label;
  $('capacity').textContent = `${operatingBudget(city)} bus-hours/day · ${city.shadeBudget} ${city.shadeBudget === 1 ? 'shelter' : 'shelters'} allowed`;
  $('temperature').textContent = `${options.heat ? city.heat : 26} °C`;
  $('departure-field').hidden = options.mode !== 'timetable';
  $('map-title').textContent = state.layer === 'change' ? 'Change in 30-minute access' : '30-minute access';
  renderMetrics();
  renderLayers();
  renderDetail();
  const gap = city.neighborhoods.filter((_, i) => fit.hospitalFloor[i] > 2700);
  const alert = $('hospital-alert');
  alert.hidden = !result.metrics.hospitalOver.length;
  const count = result.metrics.hospitalOver.length;
  alert.textContent = `${count} ${count === 1 ? 'neighborhood is' : 'neighborhoods are'} more than 45 minutes from the hospital in this plan.`
    + (gap.length ? ` ${gap.length} cannot reach it within 45 minutes under any feasible allocation.` : '');
  $('budget').textContent = `${result.metrics.busHours} of ${operatingBudget(city)} bus-hours/day used · ${result.metrics.shadeCount} of ${city.shadeBudget} shelters · ${kind === 'optimized' ? `Exact search of ${fit.evaluated} fleet allocations` : 'Manual plan'}`;
  renderBrief($('brief'), state);
}

function syncRoutes() {
  const { city, plan } = state;
  const left = city.fleetBudget - plan.fleet.reduce((a, b) => a + b, 0);
  const live = $('routes').querySelectorAll('input');
  live.forEach(input => {
    const i = Number(input.dataset.line);
    const route = city.lines[i];
    input.max = Math.min(route.max, plan.fleet[i] + left);
    input.value = plan.fleet[i];
    input.setAttribute('aria-valuetext', `${plan.fleet[i]} buses, ${short(route.cycle / plan.fleet[i])} minute headway`);
  });
  city.lines.forEach((line, i) =>
    $(`headway-${i}`).textContent = `${short(line.cycle / plan.fleet[i])} min`);
  const used = new Set(plan.shade.map(key));
  $('shades').querySelectorAll('input').forEach(input => {
    input.checked = used.has(input.value);
    input.disabled = !input.checked && used.size >= city.shadeBudget;
  });
}

function buildControls() {
  const { city } = state;
  $('neighborhood').replaceChildren(...city.neighborhoods.map(entry => new Option(entry.name, entry.id)));
  $('neighborhood').value = state.selected;
  $('routes').innerHTML = city.lines.map((route, i) => `
    <div class="route-row">
      <label for="${route.min === route.max ? `headway-${i}` : `line-${i}`}"><strong>${route.id}</strong> ${route.name}</label>
      ${route.min === route.max ? '<span class="fixed-rail">Fixed rail service</span>'
        : `<input type="range" id="line-${i}" data-line="${i}" min="${route.min}" max="${route.max}" step="1">`}
      <output id="headway-${i}"></output>
    </div>`).join('');
  $('shades').replaceChildren(...shadeCandidates(city).map(at => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = key(at);
    const routes = city.lines.filter(r => r.stops.some(p => key(p) === key(at))).map(r => r.id).join('/');
    const place = city.neighborhoods.find(n => n.x === at[0] && n.y === at[1])?.name;
    label.append(input, place ? ` ${place} (${routes})` : ` ${routes} stop at ${at[0] + 1}, ${at[1] + 1}`);
    return label;
  }));
}

const customActive = custom =>
  Object.keys(CUSTOM_DEFAULTS).some(k => clampCustom(custom)[k] !== CUSTOM_DEFAULTS[k]);

function computePolicy() {
  const { city, options, policy } = state;
  policy.evals = PRESETS.map(p => evaluateIntervention(city, options, applyPreset(city, options, p.id)));
  if (policy.preset === 'custom' || customActive(policy.custom))
    policy.evals.push(evaluateIntervention(city, options, applyCustom(city, options, policy.custom)));
  policy.leverage = corridorLeverage(city, options);
  policy.dirty = false;
}

function refreshCustomEval() {
  const { city, options, policy } = state;
  const i = policy.evals.findIndex(e => e.id === 'custom');
  if (customActive(policy.custom) || policy.preset === 'custom') {
    const ev = evaluateIntervention(city, options, applyCustom(city, options, policy.custom));
    if (i < 0) policy.evals.push(ev); else policy.evals[i] = ev;
  } else if (i >= 0) policy.evals.splice(i, 1);
}

const currentEval = () =>
  state.policy.evals.find(e => e.id === state.policy.preset) ?? state.policy.evals[0];

function renderPolicy() {
  const { policy } = state;
  if (policy.dirty) computePolicy();
  const current = currentEval();
  renderPresets($('presets'), policy.preset);
  $('custom-panel').hidden = policy.preset !== 'custom';
  renderCompare($('compare'), policy.evals, current.id);
  renderScenarioMaps($('map-before'), $('map-after'), $('map-after-cap'), state, current, setSelected);
  renderBands($('bands'), current, state.city, state.selected);
  renderLeverage($('leverage'), policy.leverage);
  $('policy-status').textContent = 'Unit costs are planning-model rates, not real-agency figures. The address-bar hash stores this scenario for a deterministic reload.'
    + (current.meta?.capped ? ' Budget cap reached: the package wanted more service than the cap allowed.' : '');
}

function renderPolicySelection() {
  if (!state.policy.evals) return;
  renderBands($('bands'), currentEval(), state.city, state.selected);
}

function syncCustomInputs() {
  const c = state.policy.custom;
  $('c-hw').value = c.headwayScale;
  $('c-sg').value = c.speedGain;
  $('c-fs').value = c.subsidy;
  $('c-cap').value = c.cap;
  for (const [id, text] of Object.entries(customOutputs(c))) $(id).textContent = text;
}

function updateHash() {
  const encoded = encodeScenario({
    preset: state.policy.preset, custom: state.policy.custom, cityId: state.city.id
  }, CITIES[0].id);
  history.replaceState(null, '', `#${encoded}`);
}

function applyHash() {
  const selection = decodeScenario(location.hash);
  if (!selection) return;
  state.policy.preset = selection.preset;
  state.policy.custom = selection.custom;
  syncCustomInputs();
  if (selection.cityId && selection.cityId !== state.city.id) {
    state.city = CITIES.find(c => c.id === selection.cityId);
    $('scenario').value = selection.cityId;
    state.selected = defaultSelected(selection.cityId);
    run({ reset: true, controls: true });
    return;
  }
  state.policy.dirty = true;
  renderPolicy();
}

function run({ reset = false, controls = false, recalculate = true } = {}) {
  if (reset) state.kind = 'optimized';
  if (recalculate) {
    state.baseline = assess(state.city, state.city.baseline, state.options);
    state.fit = optimize(state.city, state.options);
    state.policy.dirty = true;
  }
  if (state.kind === 'optimized') {
    state.plan = structuredClone(state.fit.plan);
    state.result = state.fit.result;
  } else {
    state.result = assess(state.city, state.plan, state.options);
  }
  if (controls) buildControls();
  syncRoutes();
  renderResults();
  if (recalculate) renderPolicy();
}

$('scenario').replaceChildren(...CITIES.map(city => new Option(city.label, city.id)));
$('scenario').addEventListener('change', () => {
  state.city = CITIES.find(city => city.id === $('scenario').value);
  state.selected = defaultSelected(state.city.id);
  run({ reset: true, controls: true });
  updateHash();
});
$('neighborhood').addEventListener('change', event => setSelected(event.target.value));
$('heat').addEventListener('change', event => {
  state.options.heat = event.target.checked;
  run();
});
$('mode').addEventListener('change', event => {
  state.options.mode = event.target.value;
  run();
});
$('departure').addEventListener('change', event => {
  if (!event.target.validity.valid) return;
  const [h, m] = event.target.value.split(':').map(Number);
  state.options.departure = h * 60 + m;
  run();
});
$('routes').addEventListener('input', event => {
  if (!event.target.matches('input[type=range]')) return;
  const index = Number(event.target.dataset.line);
  const value = Number(event.target.value);
  if (value === state.plan.fleet[index]) return;
  state.plan.fleet[index] = value;
  state.kind = 'custom';
  run({ recalculate: false });
});
$('shades').addEventListener('change', event => {
  if (!event.target.matches('input[type=checkbox]')) return;
  const stop = event.target.value;
  if (event.target.checked) state.plan.shade.push(stop.split(',').map(Number));
  else state.plan.shade = state.plan.shade.filter(at => key(at) !== stop);
  state.kind = 'custom';
  run({ recalculate: false });
});
$('optimize').addEventListener('click', () => run({ reset: true, recalculate: false }));
document.querySelectorAll('[data-layer]').forEach(button => button.addEventListener('click', () => {
  state.layer = button.dataset.layer;
  $('map-title').textContent = state.layer === 'change' ? 'Change in 30-minute access' : '30-minute access';
  renderLayers();
}));
$('language').addEventListener('change', event => {
  state.language = event.target.value;
  renderBrief($('brief'), state);
});
$('print').addEventListener('click', () => window.print());

function download(content, extension, type, city) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `transitgap-${city}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

let auditAction = 0;
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', async () => {
  const ticket = ++auditAction;
  const { city, baseline, result, options, plan, kind } = state;
  const extension = button.dataset.export;
  const type = { csv: 'text/csv;charset=utf-8', geojson: 'application/geo+json', json: 'application/json' };
  try {
    const content = extension === 'csv' ? csv(city, baseline, result)
      : extension === 'geojson' ? JSON.stringify(geojson(city, baseline, result))
        : await buildAudit(city, options, kind, plan);
    download(content, extension, type[extension], city.id);
    if (ticket === auditAction) $('audit-status').textContent = `Prepared ${extension.toUpperCase()} download.`;
  } catch {
    if (ticket === auditAction) $('audit-status').textContent = 'Could not prepare the download. Audit JSON requires HTTPS or local hosting.';
  }
}));
$('audit-file').addEventListener('change', async event => {
  const ticket = ++auditAction;
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  try {
    const result = file.size <= MAX_AUDIT_BYTES ? await verifyAudit(await file.text()) : { ok: false, reason: 'size' };
    if (ticket === auditAction) $('audit-status').textContent = result.ok
      ? `Verified SHA-256 digest and deterministic replay for ${CITIES.find(c => c.id === result.city).label}.`
      : `Audit verification failed (${result.reason}). Choose an unchanged TransitGap audit JSON file.`;
  } catch {
    if (ticket === auditAction) $('audit-status').textContent = 'Could not read the audit file.';
  }
});

const CUSTOM_INPUTS = { 'c-hw': 'headwayScale', 'c-sg': 'speedGain', 'c-fs': 'subsidy', 'c-cap': 'cap' };
function choosePreset(id) {
  if (state.policy.preset === id && id !== 'custom') return;
  state.policy.preset = id;
  refreshCustomEval();
  renderPolicy();
  updateHash();
}
$('presets').addEventListener('click', event => {
  const button = event.target.closest('[data-preset]');
  if (button) choosePreset(button.dataset.preset);
});
$('compare').addEventListener('click', event => {
  const button = event.target.closest('[data-pick]');
  if (button) choosePreset(button.dataset.pick);
});
for (const [id, name] of Object.entries(CUSTOM_INPUTS)) {
  $(id).addEventListener('input', event => {
    state.policy.custom = clampCustom({ ...state.policy.custom, [name]: Number(event.target.value) });
    for (const [out, text] of Object.entries(customOutputs(state.policy.custom))) $(out).textContent = text;
    refreshCustomEval();
    renderPolicy();
  });
  $(id).addEventListener('change', updateHash);
}
let policyAction = 0;
document.querySelectorAll('[data-policy-export]').forEach(button => button.addEventListener('click', async () => {
  const ticket = ++policyAction;
  const ext = button.dataset.policyExport;
  const type = { csv: 'text/csv;charset=utf-8', md: 'text/markdown;charset=utf-8', json: 'application/json' };
  const selection = { preset: state.policy.preset, custom: state.policy.custom };
  try {
    const content = ext === 'csv' ? policyCsv(state.city, state.options, state.policy.custom)
      : ext === 'md' ? policyMarkdown(state.city, state.options, selection)
        : buildPolicyJson(state.city, state.options, selection);
    download(content, ext, type[ext], `${state.city.id}-policy`);
    if (ticket === policyAction) $('policy-status').textContent =
      `Prepared ${ext.toUpperCase()} download. The JSON carries a SHA-256 digest over the canonical payload.`;
  } catch {
    if (ticket === policyAction) $('policy-status').textContent = 'Could not prepare the policy download.';
  }
}));
$('policy-file').addEventListener('change', async event => {
  const ticket = ++policyAction;
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  try {
    const result = file.size <= MAX_POLICY_BYTES ? await verifyPolicyJson(await file.text()) : { ok: false, reason: 'size' };
    if (ticket === policyAction) $('policy-status').textContent = result.ok
      ? `Verified SHA-256 digest and deterministic replay for ${CITIES.find(c => c.id === result.city).label}.`
      : `Policy file verification failed (${result.reason}). Choose an unchanged TransitGap impact JSON file.`;
  } catch {
    if (ticket === policyAction) $('policy-status').textContent = 'Could not read the policy file.';
  }
});
$('verify-open').addEventListener('click', async () => {
  const panel = $('verify');
  const opening = panel.hidden;
  panel.hidden = !opening;
  $('verify-open').setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  $('verify-badge').textContent = 'Running deterministic checks…';
  $('verify-badge').classList.remove('vbad');
  const outcome = await runSelfTests();
  renderVerify($('verify-results'), $('verify-badge'), outcome);
});
window.addEventListener('hashchange', applyHash);

{
  const selection = decodeScenario(location.hash);
  if (selection) {
    if (selection.cityId && CITIES.some(c => c.id === selection.cityId)) {
      state.city = CITIES.find(c => c.id === selection.cityId);
      $('scenario').value = selection.cityId;
      state.selected = defaultSelected(selection.cityId);
    }
    state.policy.preset = selection.preset;
    state.policy.custom = selection.custom;
    syncCustomInputs();
  }
}
run({ reset: true, controls: true });
if ('serviceWorker' in navigator && window.isSecureContext) {
  const ready = () => { $('offline').textContent = 'Offline ready'; };
  navigator.serviceWorker.addEventListener('controllerchange', ready);
  navigator.serviceWorker.register('./sw.js').then(() => {
    if (navigator.serviceWorker.controller) ready();
  }).catch(() => { $('offline').textContent = 'Offline setup unavailable'; });
} else {
  $('offline').textContent = 'Offline needs HTTPS or localhost';
}
