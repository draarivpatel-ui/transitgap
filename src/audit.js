import { CITIES } from './cities.js';
import { assess, key, normalizeOptions, optimize, validatePlan } from './model.js';
import { sha256Hex } from './sha256.js';

const VERSION = 'transitgap/v1';
export const MAX_AUDIT_BYTES = 256_000;

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError('Non-JSON value');
}

export async function sha256(text) {
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
  }
  return sha256Hex(text);
}

function payloadFor(city, options, kind, plan) {
  const baseline = assess(city, city.baseline, options);
  const choice = kind === 'optimized'
    ? optimize(city, options)
    : { plan: validatePlan(city, plan), result: assess(city, plan, options), evaluated: null };
  return { version: VERSION, city, options, kind, baseline, ...choice };
}

export async function buildAudit(city, input, kind, plan) {
  if (!['optimized', 'custom'].includes(kind)) throw new RangeError('Unknown plan type');
  const payload = payloadFor(city, normalizeOptions(input), kind, plan);
  return canonical({ payload, sha256: await sha256(canonical(payload)) });
}

export async function verifyAudit(text) {
  let reason = 'format';
  try {
    if (typeof text !== 'string' || text.length > MAX_AUDIT_BYTES ||
        new TextEncoder().encode(text).length > MAX_AUDIT_BYTES) return { ok: false, reason };
    const { payload, sha256: hash, ...rest } = JSON.parse(text);
    if (Object.keys(rest).length || !/^[a-f0-9]{64}$/.test(hash) || payload?.version !== VERSION ||
        !['optimized', 'custom'].includes(payload.kind)) return { ok: false, reason };
    reason = 'digest';
    if (await sha256(canonical(payload)) !== hash) return { ok: false, reason };
    reason = 'replay';
    const city = CITIES.find(c => c.id === payload.city?.id);
    if (!city || canonical(city) !== canonical(payload.city)) return { ok: false, reason };
    const replay = payloadFor(city, normalizeOptions(payload.options), payload.kind, payload.plan);
    if (canonical(replay) !== canonical(payload)) return { ok: false, reason };
    return { ok: true, city: city.id, sha256: hash };
  } catch {
    return { ok: false, reason };
  }
}

export function csvCell(input) {
  let text = String(input ?? '');
  if (typeof input !== 'number' &&
      (/^[\t\r\n]/.test(text) || /^[\s\p{Cc}\p{Cf}\p{M}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowProperties(city, i, before, after) {
  const n = city.neighborhoods[i];
  const b = before.rows[i];
  const a = after.rows[i];
  return {
    id: n.id, neighborhood: n.name, population: n.pop, transit_dependent_share: n.dependent,
    senior_share: n.senior, student_share: n.student,
    baseline_services_30m: b.within, plan_services_30m: a.within,
    baseline_mean_min: b.mean, plan_mean_min: a.mean,
    baseline_access_score: b.access, plan_access_score: a.access,
    baseline_exposed_wait_min: b.exposed, plan_exposed_wait_min: a.exposed,
    ...Object.fromEntries(city.services.flatMap(({ id }, j) => [
      [`baseline_${id}_min`, b.times[j] / 60], [`plan_${id}_min`, a.times[j] / 60]
    ]))
  };
}

export function csv(city, before, after) {
  const rows = city.neighborhoods.map((_, i) => rowProperties(city, i, before, after));
  return [Object.keys(rows[0]), ...rows.map(Object.values)].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function geojson(city, before, after) {
  const degrees = city.blockMeters / 111_320;
  return {
    type: 'FeatureCollection', synthetic: true, scenario: city.id,
    features: city.neighborhoods.map((n, i) => {
      const ring = [[-0.43, -0.43], [0.43, -0.43], [0.43, 0.43], [-0.43, 0.43], [-0.43, -0.43]];
      return {
        type: 'Feature', id: n.id,
        geometry: { type: 'Polygon', coordinates: [ring.map(([dx, dy]) => [
          -145 + (n.x + dx) * degrees, (-n.y + dy) * degrees
        ])] },
        properties: { ...rowProperties(city, i, before, after), grid_cell: key([n.x, n.y]), synthetic: true }
      };
    })
  };
}
