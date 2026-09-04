import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('every form dialog has non-submit dismiss controls', () => {
  for (const id of ['processing-form', 'device-form', 'connection-form', 'backend-form', 'alias-form', 'note-form', 'reminder-form']) {
    const form = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?<\\/form>`))?.[0] || '';
    const dismissControls = form.match(/<button\b[^>]*\bdata-dialog-dismiss\b[^>]*>/g) || [];
    assert.equal(dismissControls.length, 2, `${id} must have × and Cancel dismiss controls`);
    for (const control of dismissControls) {
      assert.match(control, /\btype="button"/, `${id} dismiss controls must not submit the form`);
    }
  }
  assert.doesNotMatch(html, /<button\b[^>]*\bvalue="cancel"[^>]*>/);
});

test('admin interface avoids tiny fixed-size text', () => {
  const pixelSizes = [...styles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1]));
  assert.ok(pixelSizes.length > 0, 'Expected fixed typography sizes');
  assert.ok(Math.min(...pixelSizes) >= 12, 'Fixed text must be at least 12px');
  assert.match(styles, /\.nav-item\s*\{[\s\S]*?font-size:\s*16px/);
  assert.match(styles, /\.panel small,[\s\S]*?font-size:\s*14px/);
  assert.match(styles, /\.helper,[\s\S]*?font-size:\s*14\.5px/);
});

test('device and Needle diagnostics UI use the nested API contracts', () => {
  assert.match(html, /name="deviceType" value="index"/);
  assert.match(html, /name="connectionType" value="webhook"/);
  assert.match(html, /name="connectionType" value="mcp"/);
  assert.match(html, /Streamable HTTP/);
  assert.match(html, /id="new-device-authorization-value"/);
  assert.match(html, /id="connection-form"/);
  assert.match(script, /api\("\/device-groups"\)/);
  assert.match(script, /\/device-groups\/\$\{safeId\(id\)\}\/connections/);
  assert.match(script, /api\(`\/device-groups\/\$\{safeId\(id\)\}`,[\s\S]*?method: "DELETE"/);
  assert.match(script, /\/device-groups\/\$\{safeId\(deviceId\)\}\/connections\/\$\{safeId\(connectionId\)\}/);
  assert.match(script, /text: inactive \? "Delete" : "Revoke"/);
  assert.match(script, /connections\.every\(\(connection\) => connectionState\(connection\)\.inactive\)/);
  assert.match(script, /Recordings, notes, and reminders are kept\./);
  assert.match(script, /Its recordings, notes, and reminders are kept\./);
  assert.doesNotMatch(script, /Retained recordings, notes, or reminders must be deleted first\./);
  assert.match(script, /body\.connectionType = plainText\(data\.get\("connectionType"\), "webhook"\)/);
  assert.match(script, /if \(body\.connectionType === "webhook"\) body\.indexTrigger/);
  assert.match(script, /Pebble Index custom MCP server/);
  assert.match(script, /\["proxy_decision"\]/);
  assert.match(script, /\["verification"\]/);
  assert.match(script, /Raw router response/);
});

test('transcript actions keep decisions near the top and move settings behind a persistent compact control', () => {
  const processingPage = html.match(/<section class="page" id="page-processing"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(processingPage, /id="processing-enabled"/);
  assert.match(processingPage, /id="open-processing-settings"/);
  assert.match(processingPage, /id="dismiss-processing-info"/);
  assert.match(processingPage, /Recent decisions/);
  assert.doesNotMatch(processingPage, /Reminders are stored/);
  assert.doesNotMatch(processingPage, /processing-health-orb/);
  assert.match(html, /<dialog class="modal" id="processing-dialog">[\s\S]*?id="processing-form"/);
  assert.match(script, /localStorage\.setItem\(PROCESSING_INFO_DISMISSED_KEY, "1"\)/);
  assert.match(script, /textContent = "Healthy"/);
});

test('one-time token fields are scrubbed on every permitted dialog close path', () => {
  const cleanup = script.match(/function clearCreatedTokenDialog\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  for (const id of [
    'new-device-token',
    'new-device-webhook-url',
    'new-device-header-name',
    'new-device-header-value',
    'new-device-authorization-value'
  ]) {
    assert.match(cleanup, new RegExp(`\\$\\("#${id}"\\)\\.value = ""`), `${id} must be cleared`);
  }
  assert.match(script, /close-token-dialog[\s\S]*?clearCreatedTokenDialog\(\);[\s\S]*?closeDialog/);
  assert.match(script, /tokenDialog\.addEventListener\("cancel",[\s\S]*?else \{\s*clearCreatedTokenDialog\(\);/);
  assert.match(script, /tokenDialog\.addEventListener\("close", clearCreatedTokenDialog\)/);
});
