import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCryptoService } from '../src/crypto.js';
import { createDatabase, nowIso } from '../src/db.js';
import { enqueueProcessingJob, startProcessingWorker } from '../src/processing.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for processing result');
}

function fixture(t, decision, transcript = 'Remember the blue door code is 4815') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-processing-'));
  const db = createDatabase(path.join(directory, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'processing-test-seed' });
  const now = nowIso();
  db.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json,
     requests_per_minute, max_concurrency, session_epoch, created_at, updated_at)
    VALUES ('device-1', 'Test Pebble', 'hash', 'pp_test', '["webhook:write"]', '[]', 30, 2, 1, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO recordings
    (id, device_id, client, trigger, received_at, stt_state, idempotency_key, created_at, updated_at)
    VALUES ('recording-1', 'device-1', 'Pebble Index', 'double-click-hold', ?, 'received', 'key-1', ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO transcripts (id, recording_id, source, text, created_at)
    VALUES ('transcript-1', 'recording-1', 'pebble', ?, ?)`).run(transcript, now);
  db.prepare(`UPDATE processing_config SET enabled = 1, confidence_threshold = 0.2,
    revision = revision + 1, updated_at = ? WHERE id = 1`).run(now);
  assert.equal(enqueueProcessingJob(db, 'recording-1'), true);

  const requests = [];
  const deps = {
    db,
    cryptoService,
    config: {
      nodeEnv: 'test',
      needleRouterUrl: 'http://needle:8090',
      processingTimeoutMs: 1000,
      processingMaxAttempts: 2,
      processingRetryDelaysMs: [20, 20],
      workerPollMs: 10,
      aiTimeoutMs: 1000,
      aiMaxMessages: 64,
      aiMaxMessageChars: 16384,
      aiMaxInputChars: 65536,
      aiMaxResponseBytes: 1024 * 1024,
      aiMaxResponseChars: 65536
    },
    processingFetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse(decision);
    },
    log() {}
  };
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, deps, requests, transcript };
}

test('Needle processing creates one device-scoped note and records the decision', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{ name: 'create_note', arguments: { title: 'Door code', text: 'The blue door code is 4815' } }],
    confidence: 0.94
  });
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].body.text, app.transcript);
  assert.equal(app.requests[0].body.context.trigger, 'double-click-hold');
  assert.equal(app.db.prepare('SELECT body FROM notes').get().body, 'The blue door code is 4815');
  const job = app.db.prepare('SELECT transcript_source, confidence, status FROM processing_jobs').get();
  assert.deepEqual({ ...job }, { transcript_source: 'pebble', confidence: 0.94, status: 'completed' });
  const action = app.db.prepare('SELECT action_type, status FROM processing_actions').get();
  assert.deepEqual({ ...action }, { action_type: 'create_note', status: 'completed' });
});

test('Needle processing preserves a reminder time phrase without inventing a timestamp', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{
      name: 'create_reminder',
      arguments: { message: 'call Sam', date_time_human: '4 PM on September 8 2026' }
    }],
    confidence: 0.31
  }, 'Remind me at 4 PM on September 8 2026 to call Sam');
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();
  const reminder = app.db.prepare('SELECT title, due_at, due_text FROM reminders').get();
  assert.deepEqual({ ...reminder }, {
    title: 'call Sam',
    due_at: null,
    due_text: '4 PM on September 8 2026'
  });
});

test('low-confidence and multiple Needle calls require review without executing actions', async (t) => {
  await t.test('low confidence', async (t) => {
    const app = fixture(t, {
      type: 'call',
      function_calls: [{ name: 'create_note', arguments: { text: 'Uncertain' } }],
      confidence: 0.1
    });
    const stop = startProcessingWorker(app.deps);
    await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'needs_review');
    await stop();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
    assert.equal(app.db.prepare('SELECT last_error_code FROM processing_jobs').get().last_error_code, 'low_confidence');
  });

  await t.test('multiple calls', async (t) => {
    const app = fixture(t, {
      type: 'call',
      function_calls: [
        { name: 'create_note', arguments: { text: 'One' } },
        { name: 'create_reminder', arguments: { message: 'Two', date_time_human: 'tomorrow' } }
      ],
      confidence: 0.95
    });
    const stop = startProcessingWorker(app.deps);
    await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'needs_review');
    await stop();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);
    assert.equal(app.db.prepare('SELECT last_error_code FROM processing_jobs').get().last_error_code, 'multiple_actions');
  });
});

test('agent forwarding sends the original transcript through the configured device alias', async (t) => {
  const app = fixture(t, {
    type: 'call', function_calls: [{ name: 'forward_agent', arguments: { request: 'What is on my calendar tomorrow?' } }], confidence: 0.92
  }, 'What is on my calendar tomorrow?');
  const now = nowIso();
  app.db.prepare(`INSERT INTO ai_providers
    (id, name, type, base_url, chat_path, models_path, health_path, enabled, config_json, created_at, updated_at)
    VALUES ('provider-1', 'Private agent', 'generic', 'http://agent_api_1:8080', '/v1/chat/completions', '/v1/models', '/healthz', 1, '{}', ?, ?)`).run(now, now);
  app.db.prepare(`INSERT INTO model_aliases
    (alias, provider_id, upstream_model, agent_profile_id, enabled, max_output_tokens, timeout_ms, created_at, updated_at)
    VALUES ('private-agent', 'provider-1', 'private/model', 'pebble', 1, 256, 1000, ?, ?)`).run(now, now);
  app.db.prepare(`UPDATE processing_config SET agent_alias = 'private-agent', revision = revision + 1, updated_at = ? WHERE id = 1`).run(now);
  let forwarded;
  app.deps.aiFetchImpl = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return jsonResponse({
      id: 'upstream', object: 'chat.completion', created: 1, model: 'private/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'You have no events.' }, finish_reason: 'stop' }]
    });
  };

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();
  assert.equal(forwarded.messages.at(-1).content, app.transcript);
  const result = JSON.parse(app.db.prepare('SELECT result_json FROM processing_actions').get().result_json);
  assert.equal(result.alias, 'private-agent');
  assert.equal(result.content, 'You have no events.');
});
