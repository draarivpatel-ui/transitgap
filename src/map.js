import { key } from './model.js';

const markers = ['+', 'G', 'S', 'J'];
const diffClass = dx => dx < 0 ? 'loss' : dx > 0 ? 'gain' : 'same';
const delta = value => value > 0 ? `+${value}` : String(value);

export function renderMap(wrap, state, select) {
  const { city, layer, baseline, result, plan, selected, pickups } = state;
  const pressed = pickups == null ? new Set(selected == null ? [] : [selected]) : new Set(pickups);
  const shownPlan = layer === 'baseline' ? city.baseline : plan;
  const shade = new Set(shownPlan.shade.map(key));
  const x = i => 69 + i * 662 / (city.w - 1);
  const y = j => 47 + j * 230 / (city.h - 1);
  const xy = p => `${x(p[0])},${y(p[1])}`;
  const rects = [];
  for (let j = 0; j < city.h; j++) {
    for (let i = 0; i < city.w; i++) rects.push(`<rect class="parcel" x="${x(i) - 18}" y="${y(j) - 12}" width="36" height="24" rx="4"/>`);
  }
  const lines = city.lines.map(line => `
    <polyline class="line-casing" points="${line.stops.map(xy).join(' ')}"/>
    <polyline class="line-path${line.coop ? ' coop-path' : ''}" points="${line.stops.map(xy).join(' ')}" stroke="${line.color}" ${line.id === 'R' ? 'stroke-dasharray="7 4"' : line.coop ? 'stroke-dasharray="1 9"' : ''}/>`).join('');
  const stations = [...new Map(city.lines.flatMap(line => line.stops).map(p => [key(p), p])).values()];
  const homes = new Set(city.neighborhoods.map(n => key([n.x, n.y])));
  const stops = stations.map(p => {
    const isShaded = shade.has(key(p));
    const offset = homes.has(key(p)) ? -25 : 0;
    return `<circle class="map-stop${isShaded ? ' has-shelter' : ''}" cx="${x(p[0]) + offset}"
      cy="${y(p[1]) + (offset ? -16 : 0)}" r="${isShaded ? 6 : 3.6}"/>`;
  }).join('');
  const places = city.services.map(({ at }, i) => `
    <g transform="translate(${x(at[0]) + 13} ${y(at[1]) - 16})">
      <rect class="service-mark" x="-10" y="-10" width="20" height="20" rx="3"/>
      <text class="service-text" y="0" text-anchor="middle" dominant-baseline="central">${markers[i]}</text>
    </g>`).join('');
  const names = [];
  const neighborhoods = city.neighborhoods.map((n, i) => {
    const a = result.rows[i].within;
    const b = baseline.rows[i].within;
    const amount = layer === 'baseline' ? b : a;
    const chosen = pressed.has(n.id);
    const text = layer === 'change' ? delta(a - b) : `${amount}/4`;
    const label = (layer === 'change' ? `${n.name}, ${b} to ${a} services` : `${n.name}, ${amount} of 4 services`)
      + (pickups ? ', pickup stop' : '');
    names.push(`<text class="zone-name" x="${x(n.x)}" y="${y(n.y) + 38}" text-anchor="middle">${n.name}</text>`);
    return `<g class="neighborhood ${layer === 'change' ? diffClass(a - b) : `c${amount}`}"
      data-neighborhood="${n.id}" role="button" tabindex="0" aria-label="${label}" aria-pressed="${chosen}"
      transform="translate(${x(n.x)} ${y(n.y)})">
      <rect class="target" x="-37" y="-24" width="74" height="47" rx="8"/>
      <rect class="zone" x="-31" y="-22" width="62" height="44" rx="8"/>
      <text class="zone-number" text-anchor="middle" dominant-baseline="central">${text}</text>
    </g>`;
  }).join('');
  const gridX = Array.from({ length: city.w }, (_, i) => `<path d="M${x(i)} 29v271"/>`).join('');
  const gridY = Array.from({ length: city.h }, (_, j) => `<path d="M36 ${y(j)}h728"/>`).join('');
  const uid = (wrap.id || 'map').replace(/[^a-zA-Z0-9-]/g, '');
  wrap.innerHTML = `
    <svg viewBox="0 0 800 329" aria-labelledby="${uid}-title ${uid}-description" xmlns="http://www.w3.org/2000/svg">
      <title id="${uid}-title">${city.label} schematic</title>
      <desc id="${uid}-description">Synthetic street grid and transit lines. Neighborhood buttons ${pickups ? 'toggle co-op pickups' : 'open travel and equity details'}.</desc>
      <g class="grid">${gridX}${gridY}${rects.join('')}</g>
      <text x="28" y="22" class="map-note">${city.blockMeters} m per grid block</text>
      <text x="712" y="22" text-anchor="end" class="map-note">schematic · not to scale</text>
      <path d="M766 52v-18l-5 8m5-8 5 8" class="north-arrow"/>
      <text x="766" y="26" text-anchor="middle" class="map-note">N</text>
      ${lines}${neighborhoods}<g class="map-symbols">${stops}${places}</g><g class="map-names">${names.join('')}</g>
    </svg>`;
  const controls = wrap.querySelectorAll('[data-neighborhood]');
  controls.forEach(button => {
    const activate = () => select(button.dataset.neighborhood);
    button.addEventListener('click', activate);
    button.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
        event.preventDefault();
        activate();
      }
    });
  });
}

export function renderLegend(el, layer) {
  const items = layer === 'change' ? [['loss', 'Fewer'], ['same', 'Unchanged'], ['gain', 'More']]
    : [['c0', '0'], ['c1', '1'], ['c2', '2'], ['c3', '3'], ['c4', '4']];
  el.innerHTML = `<span class="legend-title">${layer === 'change' ? 'Services gained or lost' : 'Services reachable'}</span>
    ${items.map(([c, label]) => `<span><i class="swatch ${c}" aria-hidden="true"></i>${label}</span>`).join('')}`;
}
