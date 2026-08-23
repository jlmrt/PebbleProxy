import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'web/clipboard.js'), 'utf8');

function clipboardHelper() {
  const context = {};
  vm.runInNewContext(source, context, { filename: 'web/clipboard.js' });
  return context.PebbleClipboard;
}

function selectable(value) {
  return {
    value,
    focused: false,
    selection: null,
    focus() { this.focused = true; },
    setSelectionRange(start, end) { this.selection = [start, end]; }
  };
}

test('clipboard helper uses the asynchronous API in a secure context', async () => {
  const helper = clipboardHelper();
  const writes = [];
  const result = await helper.copyText({
    text: 'pp_one-time-token',
    secureContext: true,
    navigatorObject: { clipboard: { writeText: async (value) => writes.push(value) } },
    documentObject: {}
  });
  assert.deepEqual(writes, ['pp_one-time-token']);
  assert.equal(result.copied, true);
  assert.equal(result.method, 'clipboard');
});

test('clipboard helper verifies the HTTP fallback and preserves manual selection on failure', async () => {
  const helper = clipboardHelper();
  const control = selectable('pp_visible-token');
  const failed = await helper.copyText({
    control,
    secureContext: false,
    navigatorObject: {},
    documentObject: { execCommand: () => false }
  });
  assert.equal(failed.copied, false);
  assert.equal(failed.selected, true);
  assert.equal(control.focused, true);
  assert.deepEqual(control.selection, [0, 'pp_visible-token'.length]);

  const copied = await helper.copyText({
    control,
    secureContext: false,
    navigatorObject: {},
    documentObject: { execCommand: () => true }
  });
  assert.equal(copied.copied, true);
  assert.equal(copied.method, 'legacy');
});

test('clipboard helper falls back after Clipboard API rejection', async () => {
  const helper = clipboardHelper();
  const control = selectable('https://voice.example/webhooks/index');
  const result = await helper.copyText({
    control,
    secureContext: true,
    navigatorObject: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    documentObject: { execCommand: () => true }
  });
  assert.equal(result.copied, true);
  assert.equal(result.method, 'legacy');
});

test('temporary fallback controls stay inside an open modal', async () => {
  const helper = clipboardHelper();
  const area = selectable('');
  area.style = {};
  area.setAttribute = () => {};
  area.remove = () => { area.removed = true; };
  const modal = { append(control) { this.appended = control; } };
  const result = await helper.copyText({
    text: 'transcript text',
    secureContext: false,
    navigatorObject: {},
    documentObject: {
      body: { append() { throw new Error('should use the open modal'); } },
      createElement: () => area,
      querySelector: () => modal,
      execCommand: () => true
    }
  });
  assert.equal(modal.appended, area);
  assert.equal(area.value, 'transcript text');
  assert.equal(area.removed, true);
  assert.equal(result.copied, true);
});
