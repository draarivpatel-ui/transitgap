import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAudit } from '../src/audit.js';
import { verifyPolicyJson } from '../src/policy.js';
import { sha256Hex } from '../src/sha256.js';
import { serve } from './serve.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
const check = label => { passed++; console.log(`PASS ${label}`); };

async function until(get, title, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (value) return value;
    await pause(55);
  }
  throw new Error(`Timed out: ${title}`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map();
    this.listeners = new Map();
    this.counter = 0;
    this.ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timeout);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timeout);
        p.reject(new Error('Chrome disconnected'));
      }
      this.pending.clear();
    });
  }
  async call(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    const callbacks = this.listeners.get(method) ?? [];
    callbacks.push(fn);
    this.listeners.set(method, callbacks);
  }
  async evaluate(expression) {
    const value = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  }
}

let server, chrome, cdp, scratch, chromeExit;
try {
  server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = `${origin}/transitgap/`;
  scratch = await mkdtemp(join(ROOT, '.browser-'));
  const downloads = join(scratch, 'downloads');
  await mkdir(downloads);
  let launchError;
  chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    `--user-data-dir=${join(scratch, 'profile')}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  chromeExit = once(chrome, 'exit').catch(() => {});
  chrome.on('error', error => { launchError = error; });
  const portFile = join(scratch, 'profile', 'DevToolsActivePort');
  const port = await until(async () => {
    if (launchError) throw launchError;
    return readFile(portFile, 'utf8').then(text => text.split('\n')[0], () => null);
  }, 'Chrome debugging port');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  cdp = new CDP(target.webSocketDebuggerUrl);
  await once(cdp.ws, 'open');
  const errors = { console: [], page: [], resource: [] };
  const requests = [];
  cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.console.push(e.args.map(a => a.value)); });
  cdp.on('Runtime.exceptionThrown', e => errors.page.push(e.exceptionDetails.text));
  cdp.on('Log.entryAdded', e => { if (e.entry.level === 'error') errors.resource.push(e.entry.text); });
  cdp.on('Network.requestWillBeSent', e => requests.push(e.request.url));
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map(method => cdp.call(method)));
  assert.match((await fetch(home)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const setSize = (width, height) => cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  const loaded = () => until(() => cdp.evaluate(`document.querySelectorAll('#map-wrap [data-neighborhood]').length === 8`), 'workbench');
  const save = async name => {
    await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(join(ROOT, 'docs', `${name}.png`), Buffer.from(data, 'base64'));
  };
  const click = async selector => {
    const point = await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!el.contains(document.elementFromPoint(x, y))) throw Error('not a hit target');
      return { x, y };
    })()`);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const select = (id, value) => cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const text = id => cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const noOverflow = async (width, height) => {
    assert.equal(await cdp.evaluate(`innerWidth === ${width} && innerHeight === ${height}
      && document.documentElement.scrollWidth === ${width}`), true);
    check(`${width}×${height} without horizontal overflow`);
  };
  await setSize(1440, 900);
  await cdp.call('Page.navigate', { url: home });
  await loaded();
  await noOverflow(1440, 900);
  await until(() => cdp.evaluate(`navigator.serviceWorker.controller && document.querySelector('#offline').textContent === 'Offline ready'`), 'offline cache installed');
  await save('desktop');
  await click('[data-layer="change"]');
  assert.match(await text('map-title'), /^Change/);
  await click('[data-neighborhood="citrus"] .zone');
  assert.equal(await cdp.evaluate(`document.querySelector('#neighborhood').value`), 'citrus');
  await cdp.evaluate(`document.querySelector('[data-neighborhood="east"]').focus()`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  assert.equal(await cdp.evaluate(`document.querySelector('#neighborhood').value`), 'east');
  check('Real pointer and keyboard selection update the equity inspector');
  await cdp.evaluate(`document.querySelector('#line-0').focus()`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  assert.match(await text('budget'), /72 of 84.*Manual plan/);
  await click('#optimize');
  assert.match(await text('budget'), /84 of 84.*Exact search/);
  check('Headway edit preserves budget and exact allocation can be restored');
  await click('#heat');
  assert.match(await text('temperature'), /26/);
  await select('mode', 'timetable');
  assert.equal(await cdp.evaluate(`document.querySelector('#departure-field').hidden`), false);
  await select('departure', '08:17');
  assert.match(await text('brief'), /08:17/);
  await select('mode', 'expected');
  await click('#heat');
  await select('scenario', 'rural');
  assert.match(await text('hospital-alert'), /cannot reach/);
  assert.match(await text('detail'), /Best hospital time within budget/);
  await cdp.evaluate('window.scrollTo(0, 0)');
  await save('equity');
  check('Heat, timetable departure and rural hospital minimum update end to end');

  await cdp.call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  for (const extension of ['csv', 'geojson', 'json']) {
    const name = `transitgap-rural.${extension}`;
    await click(`[data-export="${extension}"]`);
    await until(async () => (await readdir(downloads)).includes(name), name);
    const content = await readFile(join(downloads, name), 'utf8');
    if (extension === 'csv') assert.match(content, /plan_hospital_min.*\r\n/);
    else if (extension === 'geojson') assert.equal(JSON.parse(content).features.length, 8);
    else {
      assert.equal((await verifyAudit(content)).ok, true);
      const { root } = await cdp.call('DOM.getDocument');
      const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#audit-file' });
      await cdp.call('DOM.setFileInputFiles', { nodeId, files: [join(downloads, name)] });
      await until(async () => /Verified SHA-256/.test(await text('audit-status')), 'browser replay');
    }
  }
  check('Browser downloads CSV, GeoJSON and JSON and verifies the uploaded audit');

  await until(() => cdp.evaluate(`document.querySelectorAll('#presets [data-preset]').length === 7
    && document.querySelectorAll('#compare tbody tr').length === 6
    && document.querySelectorAll('#leverage tbody tr').length > 3
    && document.querySelectorAll('#map-before [data-neighborhood]').length === 8
    && document.querySelectorAll('#map-after [data-neighborhood]').length === 8
    && document.querySelectorAll('#bands svg').length === 2`), 'policy lab renders');
  assert.match(await text('map-after-cap'), /Baseline today/);
  check('Policy lab renders presets, comparator, paired maps, bands and leverage table');

  for (const id of ['brt', 'floor', 'shuttle', 'express']) {
    await click(`#presets [data-preset="${id}"]`);
    await until(() => cdp.evaluate(`document.querySelector('#compare tr.current')?.dataset.scenario === '${id}'
      && location.hash.includes('scenario=${id}')`), `preset ${id}`);
  }
  await click('#compare [data-pick="headway"]');
  await until(() => cdp.evaluate(`document.querySelector('#compare tr.current')?.dataset.scenario === 'headway'`), 'row pick');
  await click('#presets [data-preset="baseline"]');
  check('Every intervention preset and comparator row select the scenario and update the hash');

  await click('#presets [data-preset="custom"]');
  await until(() => cdp.evaluate(`document.querySelector('#custom-panel').hidden === false`), 'custom panel');
  await cdp.evaluate(`(() => {
    const hw = document.getElementById('c-hw');
    hw.value = '0.7'; hw.dispatchEvent(new Event('input', { bubbles: true }));
    const fs = document.getElementById('c-fs');
    fs.value = '400000'; fs.dispatchEvent(new Event('input', { bubbles: true }));
    hw.dispatchEvent(new Event('change', { bubbles: true }));
    fs.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => cdp.evaluate(`document.querySelector('#compare tr.current')?.dataset.scenario === 'custom'
    && location.hash.includes('scenario=custom') && location.hash.includes('hw=0.7')
    && location.hash.includes('fs=400000')`), 'custom scenario');
  check('Custom sliders recompute the package live and bookmark it in the hash');

  await cdp.call('Page.navigate', { url: `${home}#scenario=headway&city=rural` });
  await until(() => cdp.evaluate(`document.querySelector('#compare tr.current')?.dataset.scenario === 'headway'
    && document.querySelector('#scenario').value === 'rural'`), 'hash reload');
  assert.match(await text('map-after-cap'), /Peak headway halving/);
  check('A hash bookmark reloads the same scenario and city deterministically');

  await click('#verify-open');
  const selfTotal = await until(() => cdp.evaluate(`document.querySelectorAll('#verify-results li').length`), 'self tests');
  assert.equal(await cdp.evaluate(`document.querySelectorAll('#verify-results li.vfail').length`), 0);
  assert.match(await text('verify-badge'), new RegExp(`^${selfTotal}/${selfTotal} deterministic checks passed$`));
  check(`In-page self-test runner reports ${selfTotal}/${selfTotal} checks passing`);

  for (const ext of ['csv', 'md', 'json']) {
    const name = `transitgap-rural-policy.${ext}`;
    await click(`[data-policy-export="${ext}"]`);
    await until(async () => (await readdir(downloads)).includes(name), name);
    const content = await readFile(join(downloads, name), 'utf8');
    if (ext === 'csv') assert.match(content, /equity_lift_per_1m/);
    else if (ext === 'md') assert.match(content, /not real-agency figures/);
    else {
      assert.equal((await verifyPolicyJson(content)).ok, true);
      const { root } = await cdp.call('DOM.getDocument');
      const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#policy-file' });
      await cdp.call('DOM.setFileInputFiles', { nodeId, files: [join(downloads, name)] });
      await until(async () => /Verified SHA-256/.test(await text('policy-status')), 'policy replay');
      const tampered = content.replace('"serviceDays":365', '"serviceDays":366');
      assert.notEqual(tampered, content);
      const bad = join(scratch, 'tampered.json');
      await writeFile(bad, tampered);
      await cdp.call('DOM.setFileInputFiles', { nodeId, files: [bad] });
      await until(async () => /failed \(digest\)/.test(await text('policy-status')), 'tamper detection');
    }
  }
  check('Signed policy exports download, verify in page and detect tampering');

  await until(() => cdp.evaluate(`/Searched 144 loops for Rural county/.test(document.querySelector('#coop-status').textContent)
    && document.querySelectorAll('#coop-map [data-neighborhood]').length === 8
    && document.querySelectorAll('#coop-pickups input').length === 8
    && document.querySelectorAll('#coop-metrics > div').length === 4`), 'co-op planner renders');
  assert.match(await text('coop-route'), /Hospital, every/);
  check('Co-op planner suggests a rural loop to the hospital on load');
  const unchecked = await cdp.evaluate(`document.querySelector('#coop-pickups input:not(:checked):not(:disabled)').value`);
  await click(`#coop-pickups input[value="${unchecked}"]`);
  await until(() => cdp.evaluate(`document.querySelector('#coop-pickups input[value="${unchecked}"]').checked
    && /Loop now runs/.test(document.querySelector('#coop-status').textContent)`), 'pickup toggle');
  await click(`#coop-map [data-neighborhood="${unchecked}"] .zone`);
  await until(() => cdp.evaluate(`!document.querySelector('#coop-pickups input[value="${unchecked}"]').checked`), 'map pickup toggle');
  await select('coop-anchor', 'grocery');
  await until(async () => /Grocery, every/.test(await text('coop-route')), 'anchor change');
  await select('coop-vehicles', '4');
  await until(async () => /Grocery trip/.test(await text('coop-table')), 'vehicles change');
  await click('#coop-suggest');
  await until(async () => /Searched 144 loops/.test(await text('coop-status')), 'suggest again');
  assert.ok((await text('coop-status')).includes((await text('coop-route')).split(', every')[0]));
  check('Pickup chips, map zones, destination and vehicle count re-plan the loop with real input');
  await cdp.evaluate(`(() => { const h = document.getElementById('coop-host'); h.value = 'Willow <b>Senior</b> Center'; h.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (const ext of ['md', 'json']) {
    const name = `transitgap-rural-coop-brief.${ext}`;
    await click(`#coop-${ext}`);
    await until(async () => (await readdir(downloads)).includes(name), name);
    const content = await readFile(join(downloads, name), 'utf8');
    if (ext === 'md') {
      assert.match(content, /^# Community Action Brief: Rural county/);
      assert.ok(content.includes('Prepared for Willow bSenior/b Center.'));
    } else {
      const { sha256, ...payload } = JSON.parse(content);
      assert.equal(sha256, sha256Hex(JSON.stringify(payload)));
      assert.equal(payload.coop.vehicles, 4);
    }
  }
  check('Community Action Brief downloads as Markdown and signed JSON with an escaped host name');
  await click('#coop-copy');
  await until(async () => /Copied|blocked/.test(await text('coop-status')), 'copy status');
  await click('#coop-learn');
  assert.equal(await cdp.evaluate(`document.querySelector('#learn-drawer').open
    && document.querySelectorAll('#learn-drawer .equations li').length === 6`), true);
  await until(async () => {
    await cdp.call('Page.captureScreenshot', { format: 'png' });
    return cdp.evaluate(`document.getAnimations().every(a => a.playState === 'finished')`);
  }, 'drawer settles');
  await click('#learn-close');
  await cdp.call('Page.captureScreenshot', { format: 'png' });
  assert.equal(await cdp.evaluate(`document.querySelector('#learn-drawer').open`), false);
  check('Copy brief reports its result and the methodology drawer opens and closes');
  await cdp.evaluate(`(() => { const h = document.getElementById('coop-host'); h.value = ''; h.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#coop').scrollIntoView(); })()`);
  await save('coop');

  for (const language of ['en', 'es']) {
    await select('language', language);
    await cdp.call('Emulation.setEmulatedMedia', { media: 'print' });
    assert.equal(await cdp.evaluate(`(() => {
      const b = document.querySelector('#brief');
      return b.lang === '${language}' && b.querySelector('h3').textContent === '${language === 'en'
        ? 'Transit equity brief' : 'Informe de equidad del transporte'}' && b.getBoundingClientRect().height > 200
        && getComputedStyle(document.querySelector('#workbench')).display === 'none';
    })()`), true);
    const { data } = await cdp.call('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
    const pdf = Buffer.from(data, 'base64').toString('latin1');
    assert.ok(pdf.startsWith('%PDF-'));
    assert.equal([...pdf.matchAll(/\/Type\s*\/Page\b/g)].length, 1);
    check(`One-page printed rural brief in ${language.toUpperCase()}`);
  }
  await cdp.call('Emulation.setEmulatedMedia', { media: '' });
  await setSize(390, 844);
  await noOverflow(390, 844);
  await click('#presets [data-preset="shuttle"]');
  await until(() => cdp.evaluate(`document.querySelector('#compare tr.current')?.dataset.scenario === 'shuttle'`), 'mobile preset');
  await noOverflow(390, 844);
  check('Mobile preset switching keeps the layout inside the viewport');
  await click('#coop-learn');
  assert.equal(await cdp.evaluate(`(() => { const r = document.querySelector('#learn-drawer').getBoundingClientRect(); return r.width <= 390 && r.left >= 0; })()`), true);
  await until(async () => {
    await cdp.call('Page.captureScreenshot', { format: 'png' });
    return cdp.evaluate(`document.getAnimations().every(a => a.playState === 'finished')`);
  }, 'drawer settles');
  await click('#learn-close');
  await cdp.call('Page.captureScreenshot', { format: 'png' });
  await noOverflow(390, 844);
  check('Mobile methodology drawer fits the viewport');
  if (process.env.CAPTURE_MOBILE === '1') {
    await cdp.evaluate('window.scrollTo(0, 0)');
    await save('mobile');
  }
  await click('[data-layer="baseline"]');
  await click('[data-neighborhood="hollow"] .zone');
  assert.equal(await cdp.evaluate(`document.querySelector('#neighborhood').value`), 'hollow');
  check('Mobile map hit targets reach their neighborhood details');
  await click('#presets [data-preset="baseline"]');
  await select('scenario', 'sunbelt');
  const openServer = server;
  await new Promise(resolve => openServer.close(resolve));
  server = null;
  await assert.rejects(fetch(`${home}?outside-chrome-cache=1`));
  await cdp.call('Page.reload');
  await loaded();
  await until(() => cdp.evaluate(`document.querySelector('#offline').textContent === 'Offline ready'`), 'offline reload');
  assert.match(await text('city-title'), /Sunbelt suburb/);
  await select('scenario', 'rail');
  assert.match(await text('city-title'), /Rail and feeders/);
  check('Offline reload and recalculation with the HTTP server stopped');
  assert.deepEqual(errors, { console: [], page: [], resource: [] });
  assert.deepEqual(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== origin), []);
  check('Zero console errors, page errors, failed resources and external requests');
  console.log(`${passed} browser checks passed`);
} finally {
  cdp?.ws.close();
  if (chrome?.pid && chrome.exitCode === null) {
    chrome.kill();
    await chromeExit;
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
