import { operatingBudget } from './model.js';

const words = {
  en: {
    title: 'Transit equity brief', synthetic: 'Synthetic planning evidence. Not a forecast or a real jurisdiction.',
    baseline: 'Baseline', plan: 'Plan', metric: 'Measure', coverage: 'Resident and service pairs within 30 min',
    mean: 'Average trip, population weighted', inequality: 'Access Gini (lower means more equal)',
    exposed: 'Average heat-exposed wait', network: 'Service plan', mins: 'min',
    caution: 'Hospital access under the budget ceiling',
    noGaps: 'No neighborhood is more than 45 minutes from a hospital in this plan.',
    gapIntro: 'Neighborhoods still above 45 minutes in this plan',
    floorIntro: 'Best possible minimum across all feasible schedules, by neighborhood',
    method: 'How to read this brief',
    methodCopy: 'Trips start from neighborhood centroids and go to the hospital, grocery store, high school and job center. Walking, waiting and riding count. The access score is 1 divided by (1 + average trip minutes / 30). The plan score combines travel time, access Gini and heat-exposed wait, so one measure may worsen as the combined score falls.',
    uncertainty: 'The network, populations, operating conditions and heat response are illustrative. This brief does not estimate the effect of a real service change.',
    hours: (used, cap, shade, max) => `${used} of ${cap} bus-hours per day; ${shade} of ${max} shelters.`,
    assumptions: (heat, exact, time) => `${heat ? 'Heat advisory' : 'Mild weather'} · ${exact ? `Timetable departure at ${time}` : 'Expected wait (half the headway)'}`,
    optimized: 'Optimized allocation', custom: 'Manual allocation'
  },
  es: {
    title: 'Informe de equidad del transporte', synthetic: 'Datos sintéticos de planificación. No representan un lugar real ni una predicción.',
    baseline: 'Base', plan: 'Plan', metric: 'Indicador', coverage: 'Pares residente y servicio a 30 min o menos',
    mean: 'Viaje medio, ponderado por población', inequality: 'Gini de acceso (menor indica más igualdad)',
    exposed: 'Espera media expuesta al calor', network: 'Plan de servicio', mins: 'min',
    caution: 'Acceso al hospital con el límite presupuestario',
    noGaps: 'Ningún barrio queda a más de 45 minutos del hospital con este plan.',
    gapIntro: 'Barrios que aún superan los 45 minutos con este plan',
    floorIntro: 'Menor tiempo posible entre todos los horarios viables, para cada barrio',
    method: 'Cómo interpretar este informe',
    methodCopy: 'Los viajes parten del centro de cada barrio hacia el hospital, el supermercado, la escuela secundaria y el centro de empleo. Se cuentan la caminata, la espera y el viaje a bordo. El acceso equivale a 1 dividido por (1 + minutos medios de viaje / 30). La puntuación combina tiempo de viaje, Gini de acceso y espera expuesta al calor. Un indicador puede empeorar aunque la puntuación total baje.',
    uncertainty: 'La red, la población, el servicio y los efectos del calor son ilustrativos. El informe no estima el efecto de un cambio de servicio real.',
    hours: (used, cap, shade, max) => `${used} de ${cap} horas de autobús al día; ${shade} de ${max} refugios.`,
    assumptions: (heat, exact, time) => `${heat ? 'Alerta de calor' : 'Clima templado'} · ${exact ? `Salida a las ${time} según el horario` : 'Espera estimada (mitad del intervalo)'}`,
    optimized: 'Asignación optimizada', custom: 'Asignación manual'
  }
};

const place = { sunbelt: 'Suburbio del cinturón solar', rail: 'Tren y autobuses alimentadores', rural: 'Condado rural' };
export const formatTime = departure =>
  `${String(Math.floor(departure / 60)).padStart(2, '0')}:${String(departure % 60).padStart(2, '0')}`;

export function renderBrief(el, state) {
  const { city, language, options, baseline, result, fit, plan, kind } = state;
  const t = words[language];
  const locale = language === 'es' ? 'es-ES' : 'en-US';
  const number = (n, digits = 1) => n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pct = n => n.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 });
  const minutes = n => `${number(n)} ${t.mins}`;
  const metrics = [
    [t.coverage, 'coverage', pct], [t.mean, 'mean', minutes],
    [t.inequality, 'inequality', n => number(n, 4)], [t.exposed, 'exposed', minutes]
  ];
  const pairs = fn => city.neighborhoods.flatMap((n, i) => {
    const seconds = fn(i);
    return seconds > 2700 ? [`${n.name} (${minutes(seconds / 60)})`] : [];
  });
  const gaps = pairs(i => result.rows[i].times[0]);
  const unavoidable = pairs(i => fit.hospitalFloor[i]);
  el.lang = language;
  el.innerHTML = `
    <header class="brief-head"><span>TransitGap</span><h3>${t.title}</h3></header>
    <p class="brief-place"><strong>${language === 'es' ? place[city.id] : city.label}</strong>
    <span>${t.assumptions(options.heat, options.mode === 'timetable', formatTime(options.departure))}</span></p>
    <table><thead><tr><th scope="col">${t.metric}</th><th scope="col">${t.baseline}</th><th scope="col">${t.plan}</th></tr></thead>
    <tbody>${metrics.map(([label, k, f]) => `<tr><th scope="row">${label}</th><td>${f(baseline.metrics[k])}</td><td>${f(result.metrics[k])}</td></tr>`).join('')}</tbody></table>
    <h4>${t.network}</h4>
    <p>${t[kind]} · ${t.hours(result.metrics.busHours, operatingBudget(city), result.metrics.shadeCount, city.shadeBudget)}</p>
    <p class="brief-lines">${city.lines.map((line, i) => `${line.id} &nbsp; ${number(line.cycle / city.baseline.fleet[i]).replace(/[.,]0$/, '')} &rarr; ${number(line.cycle / plan.fleet[i]).replace(/[.,]0$/, '')} ${t.mins}`).join(' &nbsp; / &nbsp; ')}</p>
    <h4>${t.caution}</h4>
    <p>${gaps.length ? `${t.gapIntro}. ${gaps.join('; ')}.` : t.noGaps}</p>
    ${unavoidable.length ? `<p>${t.floorIntro}. ${unavoidable.join('; ')}.</p>` : ''}
    <h4>${t.method}</h4><p>${t.methodCopy}</p>
    <p class="brief-note"><strong>${t.synthetic}</strong> ${t.uncertainty}</p>`;
}
