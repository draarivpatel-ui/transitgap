import { renderMap } from './map.js';
import { PRESETS, UNIT_COSTS } from './interventions.js';

const MARKS = ['+', 'G', 'S', 'J'];
const BAND_LABELS = ['15', '30', '45', '60', '60+'];
const n = (v, d = 1) => v.toFixed(d);
const signed = (v, d = 4) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const pct = v => `${Math.round(v * 100)}%`;
const pp = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n(Math.abs(v) * 100)} pp`;
const money = v => {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  return a >= 1e6 ? `${sign}$${n(a / 1e6, 2)}M` : `${sign}$${Math.round(a / 1000)}k`;
};
const liftCls = v => v > 1e-12 ? 'better' : v < -1e-12 ? 'worse' : 'flat';

export function renderPresets(el, selected) {
  el.innerHTML = [...PRESETS.map(p =>
    `<button type="button" data-preset="${p.id}" aria-pressed="${p.id === selected}">${p.label}</button>`),
    `<button type="button" data-preset="custom" aria-pressed="${selected === 'custom'}">Custom package</button>`
  ].join('');
}

export function renderCompare(table, evals, currentId) {
  table.innerHTML = `
    <thead><tr>
      <th scope="col">Scenario</th><th scope="col">Access &#916;</th><th scope="col">Gini</th>
      <th scope="col">20:20 ratio</th><th scope="col">Dep. coverage</th><th scope="col">Jobs 30 min</th>
      <th scope="col">Annual cost</th><th scope="col">Lift per $1M</th>
    </tr></thead>
    <tbody>${evals.map(e => {
      const m = e.metrics;
      const gd = m.gini.after - m.gini.before;
      return `<tr data-scenario="${e.id}"${e.id === currentId ? ' class="current"' : ''}>
        <th scope="row"><button type="button" class="row-pick" data-pick="${e.id}">${e.label}</button></th>
        <td>${signed(m.accessDelta)}</td>
        <td>${n(m.gini.before, 4)} &#8594; ${n(m.gini.after, 4)} <span class="delta ${liftCls(-gd)}">${signed(gd)}</span></td>
        <td>${n(m.ratio.before, 2)} &#8594; ${n(m.ratio.after, 2)}</td>
        <td>${pp(m.dependentCoverage.after - m.dependentCoverage.before)}</td>
        <td>${pct(m.jobs30.before)} &#8594; ${pct(m.jobs30.after)}</td>
        <td>${money(e.cost.annual)}</td>
        <td>${m.liftPerMillion === null ? 'n/a' : n(m.liftPerMillion, 3)}</td>
      </tr>`;
    }).join('')}</tbody>`;
}

export function renderScenarioMaps(beforeEl, afterEl, caption, state, current, select) {
  const sel = state.selected;
  renderMap(beforeEl, {
    city: state.city, layer: 'baseline', baseline: current.baseline,
    result: current.baseline, plan: state.city.baseline, selected: sel
  }, select);
  renderMap(afterEl, {
    city: current.city, layer: 'plan', baseline: current.baseline,
    result: current.result, plan: current.plan, selected: sel
  }, select);
  caption.textContent = `${current.label} network`;
}

const bandX = t => 96 + Math.min(t, 75) * 640 / 75;

function zoneRects(y, h, prefix) {
  let out = '';
  for (let k = 0; k < 5; k++) {
    const lo = k === 0 ? 0 : [15, 30, 45, 60][k - 1];
    const hi = [15, 30, 45, 60, 75][k];
    out += `<rect class="band-zone z${k}" x="${n(bandX(lo))}" y="${y}" width="${n(bandX(hi) - bandX(lo))}" height="${h}"/>
      <text class="band-tick" x="${n(bandX(hi))}" y="${y + h + 13}" text-anchor="${k === 4 ? 'end' : 'middle'}">${BAND_LABELS[k]} min</text>`;
  }
  return out;
}

export function renderBands(el, current, city, selectedId) {
  const index = Math.max(0, city.neighborhoods.findIndex(x => x.id === selectedId));
  const hood = city.neighborhoods[index];
  const bar = (shares, y, label) => {
    let x = 96;
    const segs = shares.map((s, k) => {
      const w = s * 640;
      const rect = s > 0.0005 ? `<rect class="band-zone z${k}" x="${n(x)}" y="${y}" width="${n(w)}" height="20"/>` : '';
      const label2 = s >= 0.055 ? `<text class="band-share zi${k}" x="${n(x + w / 2)}" y="${y + 14}" text-anchor="middle">${Math.round(s * 100)}%</text>` : '';
      x += w;
      return rect + label2;
    }).join('');
    return `<text class="band-row-label" x="88" y="${y + 15}" text-anchor="end">${label}</text>${segs}`;
  };
  const ruler = (times, y, klass, label) => {
    const marks = times.map((t, j) => {
      const min = t / 60;
      const cx = bandX(min);
      const clamp = min > 75;
      return `<g class="svc-mark ${klass}" transform="translate(${n(cx)} ${y})">
        ${klass === 'before'
          ? `<rect x="-9" y="-9" width="18" height="18" rx="4"/>`
          : `<circle r="9.5"/>`}
        <text y="0" text-anchor="middle" dominant-baseline="central">${MARKS[j]}</text>
        ${clamp ? '<path d="M13 0l5-4v8z" class="clamp-arrow"/>' : ''}
      </g>`;
    }).join('');
    return `<text class="band-row-label" x="88" y="${y + 4}" text-anchor="end">${label}</text>${marks}`;
  };
  const b = current.baseline.rows[index];
  const a = current.result.rows[index];
  el.innerHTML = `
    <h3>Reach-time bands</h3>
    <div class="bands-charts">
      <svg viewBox="0 0 800 86" role="img" aria-label="Share of resident and service trips inside each time band, baseline versus scenario">
        ${bar(current.bands.before, 10, 'Baseline')}
        ${bar(current.bands.after, 44, 'Scenario')}
        <text class="band-tick" x="96" y="80">Share of resident&#8211;service trips: &#8804;15, &#8804;30, &#8804;45, &#8804;60, over 60 min</text>
      </svg>
      <svg viewBox="0 0 800 148" role="img" aria-label="Travel time to each service from ${hood.name}, baseline versus scenario">
        ${zoneRects(34, 62)}
        ${ruler(b.times, 52, 'before', 'Baseline')}
        ${ruler(a.times, 80, 'after', 'Scenario')}
        <text class="band-row-label hood" x="20" y="24">${hood.name}</text>
      </svg>
    </div>
    <div class="legend band-legend">
      <span class="legend-title">Bands</span>
      ${BAND_LABELS.map((l, k) => `<span><i class="swatch z${k}" aria-hidden="true"></i>&#8804;${l}${k === 4 ? '+' : ''} min</span>`).join('')}
      <span class="legend-title">Marks</span><span>+ hospital, G grocery, S school, J jobs</span>
    </div>
    <details class="hood-delta"><summary>Neighborhood access detail</summary>
      <div class="compare-scroll hood-delta-scroll"><table>
        <thead><tr><th scope="col">Neighborhood</th><th scope="col">Access</th><th scope="col">Change</th><th scope="col">30-min services</th></tr></thead>
        <tbody>${current.neighborhoods.map(e => {
          const name = city.neighborhoods.find(x => x.id === e.id).name;
          return `<tr${e.id === selectedId ? ' class="current"' : ''}><th scope="row">${name}</th>
            <td>${n(e.accessBefore, 4)} &#8594; ${n(e.accessAfter, 4)}</td>
            <td class="${liftCls(e.delta)}">${signed(e.delta)}</td>
            <td>${e.withinBefore} &#8594; ${e.withinAfter} of 4</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </details>`;
}

export function renderLeverage(table, candidates) {
  table.innerHTML = `
    <thead><tr><th scope="col">Rank</th><th scope="col">Candidate corridor</th><th scope="col">Kind</th>
      <th scope="col">Annual cost</th><th scope="col">Equity lift</th><th scope="col">Lift per $1M</th></tr></thead>
    <tbody>${candidates.map((c, i) => `<tr>
      <td>${i + 1}</td><th scope="row">${c.label}</th><td>${c.kind}</td>
      <td>${money(c.annualCost)}</td>
      <td class="${liftCls(c.equityLift)}">${signed(c.equityLift)}</td>
      <td>${c.liftPerMillion === null ? 'n/a' : n(c.liftPerMillion, 3)}</td>
    </tr>`).join('')}</tbody>`;
}

export function renderVerify(list, badge, outcome) {
  list.innerHTML = outcome.results.map(r =>
    `<li class="${r.ok ? 'vpass' : 'vfail'}"><strong>${r.name}</strong><span>${r.ok ? 'pass' : `fail${r.detail ? `, ${r.detail}` : ''}`}</span></li>`).join('');
  badge.textContent = outcome.passed === outcome.total
    ? `${outcome.passed}/${outcome.total} deterministic checks passed`
    : `${outcome.passed}/${outcome.total} checks passed, ${outcome.total - outcome.passed} failed`;
  badge.classList.toggle('vbad', outcome.passed !== outcome.total);
}

export function customOutputs(custom) {
  return {
    'c-hw-out': `${Number(custom.headwayScale).toFixed(2)}\u00d7`,
    'c-sg-out': `+${Math.round(custom.speedGain * 100)}%`,
    'c-fs-out': `${money(custom.subsidy)}/yr`,
    'c-cap-out': `${money(custom.cap)}/yr`
  };
}
