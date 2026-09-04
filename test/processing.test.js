import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCryptoService } from '../src/crypto.js';
import { createDatabase, nowIso } from '../src/db.js';
import { enqueueProcessingJob, listProcessingJobs, startProcessingWorker } from '../src/processing.js';

test('Needle follows Index default-capture routing and permits reminders without a time', () => {
  const source = fs.readFileSync(new URL('../needle-sidecar/server.py', import.meta.url), 'utf8');
  const note = source.match(/"name": "create_note",[\s\S]*?(?=\n    \{\n        "name": "create_reminder")/)?.[0] || '';
  const reminder = source.match(/"name": "create_reminder",[\s\S]*?(?=\n    \{\n        "name": "forward_agent")/)?.[0] || '';
  assert.match(source, /"tool_schema_version": "3"/);
  assert.match(source, /ambiguous thoughts and observations default to create_note/);
  assert.match(source, /without requiring action words such as 'create a note'/);
  assert.match(source, /future date or time paired with a task/);
  assert.match(source, /always choose an action, falling back to create_note/);
  assert.match(source, /"maxLength": 8000/);
  assert.match(note, /The user's complete input/);
  assert.doesNotMatch(note, /"title"/);
  assert.match(reminder, /"required": \["message"\]/);
  assert.doesNotMatch(reminder, /"required": \["message", "date_time_human"\]/);
  assert.doesNotMatch(source, /never fire alerts|needs both a message and a time phrase/i);
});

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

function fixture(t, decision, transcript = 'Remember the blue door code is 4815', recordedAt = '2026-09-04T08:30:00.000Z') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-processing-'));
  const db = createDatabase(path.join(directory, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'processing-test-seed' });
  const now = nowIso();
  db.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json,
     requests_per_minute, max_concurrency, session_epoch, created_at, updated_at)
    VALUES ('device-1', 'Test Pebble', 'hash', 'pp_test', '["webhook:write"]', '[]', 30, 2, 1, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO recordings
    (id, device_id, client, trigger, recorded_at, received_at, stt_state, idempotency_key, created_at, updated_at)
    VALUES ('recording-1', 'device-1', 'Pebble Index', 'double-click-hold', ?, ?, 'received', 'key-1', ?, ?)`).run(recordedAt, now, now, now);
  db.prepare(`INSERT INTO transcripts (id, recording_id, source, text, created_at)
    VALUES ('transcript-1', 'recording-1', 'pebble', ?, ?)`).run(transcript, now);
  db.prepare(`UPDATE processing_config SET enabled = 1, confidence_threshold = 0.2,
    revision = revision + 1, updated_at = ? WHERE id = 1`).run(now);
  assert.equal(enqueueProcessingJob(db, 'recording-1'), true);

  const requests = [];
  const logs = [];
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
    log(level, message, fields) { logs.push({ level, message, fields }); }
  };
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, deps, requests, logs, transcript, recordedAt };
}

test('Needle processing creates one device-scoped note and records the decision', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{ name: 'create_note', arguments: { title: 'Door code', text: 'The blue door code is 4815' } }],
    confidence: 0.94
  });
  const [queuedJob] = listProcessingJobs(app.db);
  assert.equal(queuedJob.transcriptText, app.transcript);
  assert.equal(queuedJob.recordedAt, app.recordedAt);
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].body.text, app.transcript);
  assert.equal(app.requests[0].body.context.trigger, 'double-click-hold');
  assert.equal(app.requests[0].body.context.date, app.recordedAt);
  assert.equal(app.db.prepare('SELECT body FROM notes').get().body, app.transcript);
  const job = app.db.prepare('SELECT transcript_source, confidence, status FROM processing_jobs').get();
  assert.deepEqual({ ...job }, { transcript_source: 'pebble', confidence: 0.94, status: 'completed' });
  const action = app.db.prepare('SELECT action_type, status FROM processing_actions').get();
  assert.deepEqual({ ...action }, { action_type: 'create_note', status: 'completed' });
});

test('Needle context falls back to the receipt time when the recording time is unavailable', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{ name: 'create_note', arguments: { text: 'Fallback timestamp test' } }],
    confidence: 0.94
  }, 'Remember this fallback timestamp test', null);
  const receivedAt = app.db.prepare('SELECT received_at FROM recordings').get().received_at;
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.equal(app.requests[0].body.context.date, receivedAt);
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

test('Needle processing accepts a reminder without a spoken time', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{
      name: 'create_reminder',
      arguments: { message: 'email the project update to the team' }
    }],
    confidence: 0.91
  }, 'Remind me to email the project update to the team');
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  const reminder = app.db.prepare('SELECT title, due_at, due_text FROM reminders').get();
  assert.deepEqual({ ...reminder }, {
    title: 'email the project update to the team',
    due_at: null,
    due_text: null
  });
});

test('a verified explicit reminder can safely recover from low Needle confidence', async (t) => {
  const transcript = 'Remind me in five days from now that there is still an open discount at the neighborhood bookstore.';
  const app = fixture(t, {
    type: 'call',
    function_calls: [{
      name: 'create_reminder',
      arguments: {
        message: 'A rewritten message that must never be trusted',
        date_time_human: 'IN FIVE DAYS FROM NOW'
      }
    }],
    confidence: 0,
    validation: { ungrounded: ['create_reminder.message'] },
    reasoning: 'The time phrase is grounded but the message was rewritten.',
    router: {
      engine: 'needle2', engine_version: '2.0.4', model: 'needle2-base', package_version: '2.0.12'
    }
  }, transcript);

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  const reminder = app.db.prepare('SELECT title, due_at, due_text FROM reminders').get();
  assert.deepEqual({ ...reminder }, {
    title: 'there is still an open discount at the neighborhood bookstore.',
    due_at: null,
    due_text: 'in five days from now'
  });
  assert.equal(reminder.title.includes('rewritten'), false);

  const [job] = listProcessingJobs(app.db);
  assert.equal(job.transcriptText, transcript);
  assert.equal(job.recordedAt, app.recordedAt);
  assert.equal(job.confidence, 0);
  assert.equal(job.confidenceThreshold, 0.2);
  assert.equal(job.configRevision, 2);
  assert.equal(job.router.model, 'needle2-base');
  assert.deepEqual(job.action.arguments, {
    title: 'there is still an open discount at the neighborhood bookstore.',
    due_text: 'in five days from now'
  });
  assert.deepEqual(job.verification, {
    policy: 'explicit_reminder_v1',
    outcome: 'accepted',
    checks: {
      singleCreateReminder: true,
      explicitCommandPrefix: true,
      onlyExpectedValidation: true,
      onlyMessageUngrounded: true,
      dateTimeExactSubstringOrOmitted: true,
      noSecondExplicitCommand: true,
      derivedTitleAvailable: true
    },
    title_source: 'original_transcript_remainder',
    due_text_source: 'exact_original_transcript_substring'
  });
  const decisionLog = app.logs.find((entry) => entry.message === 'processing_decision');
  assert.equal(decisionLog.fields.outcome, 'execution_allowed');
  assert.equal(decisionLog.fields.reasonCode, 'verified_explicit_reminder');
  assert.equal(JSON.stringify(decisionLog).includes(transcript), false);
  assert.equal(JSON.stringify(decisionLog).includes('bookstore'), false);
});

test('a low-confidence note intent uses only the original transcript', async (t) => {
  const transcript = 'Take a note that the blue bicycle lock code is 4815.';
  const app = fixture(t, {
    type: 'call',
    function_calls: [{
      name: 'create_note',
      arguments: { title: 'Invented title', text: 'A rewritten note that must not be trusted' }
    }],
    confidence: 0,
    validation: { ungrounded: ['create_note.title', 'create_note.text'], negation: false }
  }, transcript);

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  const note = app.db.prepare('SELECT title, body FROM notes').get();
  assert.deepEqual({ ...note }, {
    title: 'the blue bicycle lock code is 4815.',
    body: transcript
  });
  assert.equal(JSON.stringify(note).includes('rewritten'), false);
  const [job] = listProcessingJobs(app.db);
  assert.equal(job.verification.policy, 'default_note_capture_v1');
  assert.equal(job.verification.outcome, 'accepted');
  assert.deepEqual(job.action.arguments, { ...note });
  assert.equal(app.logs.find((entry) => entry.message === 'processing_decision').fields.reasonCode, 'default_note_capture');
});

test('Create a note followed by sentence punctuation is recovered from the original transcript', async (t) => {
  const transcript = 'Create a note. The community garden opens in April. Volunteers meet on Saturday mornings.';
  const app = fixture(t, {
    type: 'call',
    success: true,
    function_calls: [{
      name: 'create_note',
      arguments: { text: 'garden opens April' }
    }],
    confidence: 0.0002,
    validation: { ungrounded: ['create_note.text'], negation: false }
  }, transcript);

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  const note = app.db.prepare('SELECT title, body FROM notes').get();
  assert.deepEqual({ ...note }, {
    title: 'The community garden opens in April.',
    body: transcript
  });
  assert.equal(note.body.includes('Volunteers meet on Saturday mornings.'), true);
  assert.notEqual(note.body, 'garden opens April');
});

test('a clear Create note command still works when speech transcription omits punctuation', async (t) => {
  const app = fixture(t, {
    type: 'call',
    success: true,
    function_calls: [],
    confidence: 0.9
  }, 'Create a note the community garden gate code is 4815');

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.deepEqual({ ...app.db.prepare('SELECT title, body FROM notes').get() }, {
    title: 'the community garden gate code is 4815',
    body: 'Create a note the community garden gate code is 4815'
  });
});

test('an explicit reminder is stored when Needle incorrectly returns no action', async (t) => {
  const transcript = 'Remind me in five days from now to email the project update to the team.';
  const app = fixture(t, {
    type: 'call',
    success: true,
    function_calls: [],
    reasoning: 'The available reminder action was not selected.',
    confidence: 0.9491
  }, transcript);

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  const reminder = app.db.prepare('SELECT title, due_at, due_text FROM reminders').get();
  assert.deepEqual({ ...reminder }, {
    title: 'email the project update to the team.',
    due_at: null,
    due_text: 'in five days from now'
  });
  const [job] = listProcessingJobs(app.db);
  assert.equal(job.verification.policy, 'default_capture_v1');
  assert.equal(job.verification.outcome, 'accepted');
  assert.deepEqual(job.action.arguments, {
    title: 'email the project update to the team.',
    due_text: 'in five days from now'
  });
  assert.equal(app.logs.find((entry) => entry.message === 'processing_decision').fields.reasonCode, 'verified_explicit_reminder');
});

test('Create a reminder phrasing is recovered from a no-action response', async (t) => {
  const app = fixture(t, {
    type: 'call',
    success: true,
    function_calls: [],
    confidence: 0.92
  }, 'Create a reminder for tomorrow to buy oat milk.');

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.deepEqual({ ...app.db.prepare('SELECT title, due_at, due_text FROM reminders').get() }, {
    title: 'buy oat milk.',
    due_at: null,
    due_text: 'for tomorrow'
  });
});

test('a no-action response falls back to a note without requiring command words', async (t) => {
  const transcript = 'The blue door at the community center sticks during wet weather.';
  const app = fixture(t, {
    type: 'call',
    success: true,
    function_calls: [],
    reasoning: 'No supported action identified.',
    confidence: 0.95
  }, transcript);

  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
  await stop();

  assert.deepEqual({ ...app.db.prepare('SELECT title, body FROM notes').get() }, {
    title: transcript,
    body: transcript
  });
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);
  const [job] = listProcessingJobs(app.db);
  assert.equal(job.verification.policy, 'default_note_capture_v1');
  assert.equal(job.verification.outcome, 'accepted');
  assert.equal(job.verification.action_source, 'default_note_fallback');
});

test('default note capture keeps the complete transcript without trusting Needle note fields', async (t) => {
  const cases = [
    ['plain thought', 'The community garden gate sticks after rain.', { ungrounded: ['create_note.text'] }],
    ['spoken note wording', 'Take a note that the studio key is in the blue drawer.', { ungrounded: ['create_note.text'] }],
    ['unexpected validation metadata', 'The project is waiting on final artwork.', { ungrounded: ['create_note.text'], unsafe: true }]
  ];
  for (const [name, transcript, validation] of cases) {
    await t.test(name, async (t) => {
      const app = fixture(t, {
        type: 'call',
        function_calls: [{ name: 'create_note', arguments: { text: 'rewritten' } }],
        confidence: 0,
        validation
      }, transcript);
      const stop = startProcessingWorker(app.deps);
      await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
      await stop();
      const note = app.db.prepare('SELECT body FROM notes').get();
      assert.equal(note.body, transcript);
      assert.equal(note.body.includes('rewritten'), false);
      const [job] = listProcessingJobs(app.db);
      assert.equal(job.verification.policy, 'default_note_capture_v1');
      assert.equal(job.verification.outcome, 'accepted');
    });
  }
});

test('default note capture still rejects a transcript that exceeds organizer limits', async (t) => {
  const app = fixture(t, {
    type: 'call',
    function_calls: [{ name: 'create_note', arguments: { text: 'shortened' } }],
    confidence: 0,
    validation: { ungrounded: ['create_note.text'] }
  }, `A${'a'.repeat(8000)}`);
  const stop = startProcessingWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'needs_review');
  await stop();
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
});

test('reminder intent does not depend on exact command words', async (t) => {
  const cases = [
    {
      name: 'polite reminder request',
      transcript: 'Could you remind me in five days to check the sale?',
      decision: {
        type: 'call',
        function_calls: [{
          name: 'create_reminder',
          arguments: { message: 'check the sale', date_time_human: 'in five days' }
        }],
        confidence: 0,
        validation: { ungrounded: ['create_reminder.message'] }
      },
      title: 'check the sale?',
      dueText: 'in five days'
    },
    {
      name: 'future time and task',
      transcript: 'Tomorrow at 2 PM, call the bank.',
      decision: {
        type: 'call',
        function_calls: [{
          name: 'create_reminder',
          arguments: { message: 'call the bank', date_time_human: 'Tomorrow at 2 PM' }
        }],
        confidence: 0,
        validation: { ungrounded: ['create_reminder.message', 'create_reminder.date_time_human'] }
      },
      title: 'call the bank',
      dueText: 'Tomorrow at 2 PM'
    },
    {
      name: 'remember to task with no time',
      transcript: 'Remember to send the project update.',
      decision: { type: 'call', function_calls: [], confidence: 0.9 },
      title: 'send the project update.',
      dueText: null
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const app = fixture(t, item.decision, item.transcript);
      const stop = startProcessingWorker(app.deps);
      await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
      await stop();
      assert.deepEqual({ ...app.db.prepare('SELECT title, due_text FROM reminders').get() }, {
        title: item.title,
        due_text: item.dueText
      });
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
    });
  }
});

test('unsafe low-confidence reminder proposals still require review', async (t) => {
  const cases = [
    {
      name: 'the returned time is not an exact transcript substring',
      transcript: 'Remind me in five days to check the sale.',
      date: 'in six days',
      validation: { ungrounded: ['create_reminder.message'] }
    },
    {
      name: 'there is no reminder title after removing the time phrase',
      transcript: 'Remind me tomorrow.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'] }
    },
    {
      name: 'validation includes an unexpected safety field',
      transcript: 'Remind me tomorrow to check the sale.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'], unsafe: true }
    },
    {
      name: 'validation has string negation',
      transcript: 'Remind me tomorrow to check the sale.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'], negation: 'false' }
    },
    {
      name: 'validation has numeric negation',
      transcript: 'Remind me tomorrow to check the sale.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'], negation: 0 }
    },
    {
      name: 'validation has object negation',
      transcript: 'Remind me tomorrow to check the sale.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'], negation: {} }
    },
    {
      name: 'transcript contains a second explicit command',
      transcript: 'Remind me tomorrow to check the sale and then make a note that milk is low.',
      date: 'tomorrow',
      validation: { ungrounded: ['create_reminder.message'] }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const app = fixture(t, {
        type: 'call',
        function_calls: [{
          name: 'create_reminder',
          arguments: { message: 'check the sale', date_time_human: item.date }
        }],
        confidence: 0,
        validation: item.validation
      }, item.transcript);
      const stop = startProcessingWorker(app.deps);
      await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'needs_review');
      await stop();
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM reminders').get().count, 0);
      const [job] = listProcessingJobs(app.db);
      assert.equal(job.error.code, 'low_confidence');
      assert.equal(job.verification.outcome, 'rejected');
    });
  }
});

test('note capture is confidence-independent while ambiguous multiple actions still require review', async (t) => {
  await t.test('low-confidence note', async (t) => {
    const app = fixture(t, {
      type: 'call',
      function_calls: [{ name: 'create_note', arguments: { text: 'Uncertain' } }],
      confidence: 0.1
    });
    const stop = startProcessingWorker(app.deps);
    await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
    await stop();
    assert.equal(app.db.prepare('SELECT body FROM notes').get().body, app.transcript);
  });

  await t.test('missing confidence', async (t) => {
    const app = fixture(t, {
      type: 'call',
      function_calls: [{ name: 'create_note', arguments: { text: 'Unscored' } }]
    });
    const stop = startProcessingWorker(app.deps);
    await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
    await stop();
    assert.equal(app.db.prepare('SELECT body FROM notes').get().body, app.transcript);
    const [job] = listProcessingJobs(app.db);
    assert.equal(job.confidence, null);
    assert.equal(job.verification.policy, 'default_note_capture_v1');
    assert.equal(job.verification.outcome, 'accepted');
  });

  for (const confidence of [-0.01, 1.01]) {
    await t.test(`out-of-range confidence ${confidence}`, async (t) => {
      const app = fixture(t, {
        type: 'call',
        function_calls: [{ name: 'create_note', arguments: { text: 'Must not execute' } }],
        confidence,
        validation: { ungrounded: ['create_note.text'], negation: false }
      }, 'Note: this thought should still be captured verbatim.');
      const stop = startProcessingWorker(app.deps);
      await waitFor(() => app.db.prepare('SELECT status FROM processing_jobs').get()?.status === 'completed');
      await stop();
      assert.equal(app.db.prepare('SELECT body FROM notes').get().body, app.transcript);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM processing_actions').get().count, 1);
      const [job] = listProcessingJobs(app.db);
      assert.equal(job.confidence, null);
      assert.equal(job.verification.policy, 'default_note_capture_v1');
      assert.equal(job.verification.outcome, 'accepted');
    });
  }

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
