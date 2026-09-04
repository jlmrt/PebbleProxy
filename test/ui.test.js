import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

test('dialog cancel controls bypass validation for unfinished forms', () => {
  const cancelControls = html.match(/<button\b[^>]*\bvalue="cancel"[^>]*>/g) || [];
  assert.ok(cancelControls.length >= 2, 'Expected dialog cancel controls');
  for (const control of cancelControls) {
    assert.match(control, /\bformnovalidate\b/, `Cancel control must bypass validation: ${control}`);
  }
});

test('admin interface avoids tiny fixed-size text', () => {
  const pixelSizes = [...styles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1]));
  assert.ok(pixelSizes.length > 0, 'Expected fixed typography sizes');
  assert.ok(Math.min(...pixelSizes) >= 11, 'Fixed text must be at least 11px');
  assert.match(styles, /\.nav-item\s*\{[\s\S]*?font-size:\s*16px/);
  assert.match(styles, /\.helper\s*\{[\s\S]*?font-size:\s*12\.5px/);
});
