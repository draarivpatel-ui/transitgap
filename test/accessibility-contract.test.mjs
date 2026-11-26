import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

test('mobile-sized controls keep a 44px target contract', () => {
  assert.match(css, /button, select, input\[type="time"\], input\[type="text"\], input\[type="number"\] \{\s*min-height: 44px; min-width: 44px;/);
  assert.match(css, /nav a \{[^}]*min-height: 44px; min-width: 44px;/);
  assert.match(css, /\.segmented button \{[^}]*min-height: 44px; min-width: 44px;/);
  assert.match(css, /\.preset-row button \{[^}]*min-height: 44px; min-width: 44px;/);
  assert.match(css, /\.coop-actions button \{[^}]*min-height: 44px; min-width: 44px;/);
  assert.match(css, /\.row-pick \{[^}]*min-height: 44px; min-width: 44px;/);
  assert.match(css, /input\[type="range"\] \{ min-height: 44px; \}/);
  assert.match(css, /\.route-row input \{[^}]*min-height: 44px;/);
  assert.match(css, /\.shade-options label \{[^}]*min-height: 44px;/);
});

test('textual form controls use a WCAG non-text contrast border', () => {
  assert.match(css, /border: 1px solid #6f7c70; background: var\(--white\);/);
  assert.doesNotMatch(css, /border: 1px solid #a0ad9f/);
  assert.match(css, /\.row-pick \{[^}]*border-bottom: 1px solid #6f7c70/);
  assert.match(css, /\.verify-label \{[^}]*border: 1px solid #6f7c70/);
  assert.match(css, /#policy-file, #audit-file \{[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /\.zi0 \{ fill: #fffcf3; \}/);
  assert.doesNotMatch(css, /\.zi0, \.zi1 \{ fill: #fffcf3; \}/);
});

test('the offline shell version advances with the control stylesheet', () => {
  assert.ok(sw.includes("const VERSION = `${PREFIX}v8`;"));
});
