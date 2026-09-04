import crypto from 'node:crypto';

import { createNote, createReminder } from './actions.js';
import { completeForDevice } from './ai.js';
import { nowIso, transaction } from './db.js';
import { HttpError } from './http.js';

const ACTION_TYPES = new Set(['create_note', 'create_reminder', 'forward_agent']);
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];

class ProcessingError extends Error {
  constructor(code, message, { transient = false } = {}) {
    super(message);
    this.name = 'ProcessingError';
    this.code = code;
    this.transient = transient;
  }
}

export function processingConfigView(row) {
  return {
    enabled: Boolean(row.enabled),
    confidenceThreshold: Number(row.confidence_threshold),
    agentAlias: row.agent_alias || null,
    revision: Number(row.revision),
    healthStatus: row.health_status,
    lastHealthAt: row.last_health_at || null,
    lastError: row.last_error || null,
    updatedAt: row.updated_at
  };
}

export function currentProcessingConfig(db) {
  return db.prepare('SELECT * FROM processing_config WHERE id = 1').get();
}

export function enqueueProcessingJob(db, recordingId) {
  const config = currentProcessingConfig(db);
  if (!config?.enabled) return false;
  const now = nowIso();
  const result = db.prepare(`INSERT OR IGNORE INTO processing_jobs
    (id, recording_id, transcript_id, transcript_source, status, attempts, next_attempt_at,
     lease_until, config_revision, confidence, proposed_action_json, last_error_code,
     last_error_message, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 'pending', 0, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`).run(
    crypto.randomUUID(), recordingId, now, config.revision, now, now
  );
  return Number(result.changes) === 1;
}

function processingEndpoint(config, route = '/v1/route') {
  let base;
  try { base = new URL(String(config.needleRouterUrl || 'http://needle:8090')); }
  catch { throw new ProcessingError('invalid_router_endpoint', 'The local intent router address is invalid'); }
  if (base.protocol !== 'http:' || base.username || base.password || base.search || base.hash) {
    throw new ProcessingError('invalid_router_endpoint', 'The local intent router address is invalid');
  }
  if (config.nodeEnv !== 'test' && (base.hostname !== 'needle' || base.port !== '8090')) {
    throw new ProcessingError('invalid_router_endpoint', 'The local intent router address is invalid');
  }
  base.pathname = `${base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')}${route}`;
  return base;
}

async function fetchWithTimeout(deps, endpoint, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timeout.unref?.();
  try {
    const response = await (deps.processingFetchImpl || globalThis.fetch)(endpoint, {
      ...options,
      redirect: 'error',
      signal: controller.signal
    });
    let disposed = false;
    return {
      response,
      signal: controller.signal,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try { await response.body?.cancel(); } catch {}
        clearTimeout(timeout);
      }
    };
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new ProcessingError('router_timeout', 'The local intent router timed out', { transient: true });
    }
    throw new ProcessingError('router_unavailable', 'The local intent router is unavailable', { transient: true });
  }
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch {}
    throw new ProcessingError('invalid_router_response', 'The local intent router response was too large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new ProcessingError('invalid_router_response', 'The local intent router response was too large');
  }
  try { return JSON.parse(text); }
  catch { throw new ProcessingError('invalid_router_response', 'The local intent router returned invalid JSON'); }
}

async function routeTranscript(deps, claim) {
  const fetched = await fetchWithTimeout(deps, processingEndpoint(deps.config), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: claim.transcript_text,
      context: {
        date: claim.recorded_at || claim.received_at || new Date().toISOString(),
        device: 'Pebble',
        trigger: claim.trigger || null
      }
    })
  }, deps.config.processingTimeoutMs || 30_000);
  const { response } = fetched;
  try {
    if (!response.ok) {
      throw new ProcessingError(
        response.status >= 500 ? 'router_unavailable' : 'router_rejected',
        response.status >= 500 ? 'The local intent router is unavailable' : 'The local intent router rejected the transcript',
        { transient: response.status >= 500 }
      );
    }
    try {
      return await boundedJson(response);
    } catch (error) {
      if (fetched.signal.aborted && !(error instanceof ProcessingError)) {
        throw new ProcessingError('router_timeout', 'The local intent router timed out', { transient: true });
      }
      throw error;
    }
  } finally {
    await fetched.dispose();
  }
}

function parseDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProcessingError('invalid_router_response', 'The local intent router returned an invalid decision');
  }
  if (value.success === false) {
    throw new ProcessingError('router_inference_failed', 'The local intent router could not classify the transcript');
  }
  const calls = Array.isArray(value.function_calls) ? value.function_calls : [];
  const confidence = typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    ? value.confidence
    : null;
  return { calls, confidence, raw: value };
}

function safeMessage(value, fallback = 'Transcript processing failed') {
  return String(value || fallback)
    .replace(/[\r\n\u0000]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

const REMINDER_COMMAND_PREFIX = /^\s*(?:(?:(?:could|can|would)\s+you\s+)?please\s+|(?:(?:could|can|would)\s+you\s+))?(?:remind\s+me\b|(?:(?:i\s+(?:need|want)\s+to\s+)?remember\s+to)\b|(?:(?:create|add|set|save)\s+(?:a\s+)?reminder)\b(?=(?:\s+\S|\s*[,;:\-.!?\u2013\u2014])))\s*[,;:\-.!?\u2013\u2014]?\s*/iu;
const NOTE_TITLE_PREFIX = /^\s*(?:please\s+)?(?:(?:(?:create|add|save|write|record|take|make)\s+(?:a\s+)?note)\b(?:\s+(?:that|about|saying)\b|\s*[.!?:,;\-\u2013\u2014]|\s+(?=\S))|note\b(?:\s+that\b|\s*[.:])|remember\s+that\b)\s*[,;:\-.!?\u2013\u2014]?\s*/iu;
const SECOND_CREATE_COMMAND = /\b(?:and(?:\s+then)?|then)\s+(?:(?:please\s+)?(?:remind\s+me|remember\s+to)\b|(?:(?:please\s+)?(?:create|add|set|save)\s+(?:a\s+)?reminder\b)|(?:(?:please\s+)?(?:create|add|save|write|record|take|make)\s+(?:a\s+)?note\b)|note\s*:)/iu;

function normalizedRemainder(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:\-\u2013\u2014]+/, '')
    .replace(/^(?:(?:to|that|about|for)\b[\s,;:\-\u2013\u2014]*)+/iu, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function defaultNoteParts(transcript) {
  const body = typeof transcript === 'string' ? transcript.trim() : '';
  const titleBody = body.replace(NOTE_TITLE_PREFIX, '').trim() || body;
  const titleSource = titleBody.split(/(?:\r?\n|(?<=[.!?])\s+)/u)[0].trim();
  const title = titleSource.length <= 120 ? titleSource : `${titleSource.slice(0, 119).trimEnd()}\u2026`;
  return { body, title };
}

function splitExplicitReminderRemainder(value) {
  const source = value.trim();
  const boundary = /\s+(?:to|that|about)\s+/giu;
  for (const match of source.matchAll(boundary)) {
    const timePhrase = source.slice(0, match.index).trim();
    if (!/^(?:(?:at|on|in|by|before|after|for)\b|today\b|tomorrow\b|tonight\b|next\b|this\b|every\b)/iu.test(timePhrase)) {
      continue;
    }
    const title = normalizedRemainder(source.slice(match.index + match[0].length));
    if (title) return { title, dueText: timePhrase };
  }
  return { title: normalizedRemainder(source), dueText: '' };
}

function explicitReminderParts(transcript, dateTimeHuman = null) {
  const source = typeof transcript === 'string' ? transcript : '';
  const prefix = REMINDER_COMMAND_PREFIX.exec(source);
  const searchFrom = prefix ? prefix[0].length : 0;
  const dateTextValid = dateTimeHuman == null || dateTimeHuman === ''
    ? false
    : typeof dateTimeHuman === 'string' && dateTimeHuman.trim().length > 0 && dateTimeHuman.length <= 120;
  const escapedDateText = dateTextValid
    ? dateTimeHuman.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '';
  const dateMatch = escapedDateText
    ? new RegExp(escapedDateText, 'iu').exec(source.slice(searchFrom))
    : null;
  const dateIndex = dateMatch ? searchFrom + dateMatch.index : -1;
  let groundedDateText = dateIndex >= 0
    ? source.slice(dateIndex, dateIndex + dateMatch[0].length)
    : '';
  const rawRemainder = prefix
    ? dateIndex >= searchFrom
      ? `${source.slice(prefix[0].length, dateIndex)} ${source.slice(dateIndex + dateMatch[0].length)}`
      : source.slice(prefix[0].length)
    : '';
  let title;
  if (prefix && !dateTimeHuman) {
    const split = splitExplicitReminderRemainder(rawRemainder);
    title = split.title;
    groundedDateText = split.dueText;
  } else {
    title = normalizedRemainder(rawRemainder);
  }
  return {
    prefix,
    title,
    groundedDateText,
    dateTimeValid: !dateTimeHuman || dateIndex >= searchFrom,
    hasSecondCommand: SECOND_CREATE_COMMAND.test(title)
  };
}

function explicitReminderVerification(decision, transcript) {
  const call = decision.calls.length === 1 ? decision.calls[0] : null;
  const validation = decision.raw?.validation;
  const ungrounded = validation?.ungrounded;
  const onlyExpectedValidation = Boolean(validation)
    && typeof validation === 'object'
    && !Array.isArray(validation)
    && Object.keys(validation).every((key) => key === 'ungrounded' || key === 'negation');
  const negationAcceptable = onlyExpectedValidation
    && (!Object.hasOwn(validation, 'negation') || validation.negation === false);
  const onlyMessageUngrounded = Array.isArray(ungrounded)
    && ungrounded.length === 1
    && ungrounded[0] === 'create_reminder.message'
    && negationAcceptable;
  const dateTimeHuman = call?.arguments?.date_time_human;
  const parts = explicitReminderParts(transcript, dateTimeHuman);
  const checks = {
    singleCreateReminder: call?.name === 'create_reminder',
    explicitCommandPrefix: Boolean(parts.prefix),
    onlyExpectedValidation,
    onlyMessageUngrounded,
    dateTimeExactSubstringOrOmitted: parts.dateTimeValid,
    noSecondExplicitCommand: !parts.hasSecondCommand,
    derivedTitleAvailable: parts.title.length <= 200 && /[\p{L}\p{N}]/u.test(parts.title)
  };
  const accepted = Object.values(checks).every(Boolean);
  return {
    policy: 'explicit_reminder_v1',
    accepted,
    checks,
    provenance: accepted ? {
      title_source: 'original_transcript_remainder',
      ...(parts.groundedDateText ? { due_text_source: 'exact_original_transcript_substring' } : {})
    } : {},
    action: accepted ? {
      name: 'create_reminder',
      arguments: { title: parts.title, ...(parts.groundedDateText ? { due_text: parts.groundedDateText } : {}) }
    } : null
  };
}

function exactOriginalSubstring(source, value, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) return '';
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped, 'iu').exec(source);
  return match ? source.slice(match.index, match.index + match[0].length) : '';
}

function groundedReminderVerification(decision, transcript) {
  const call = decision.calls.length === 1 ? decision.calls[0] : null;
  const args = call?.arguments;
  const source = typeof transcript === 'string' ? transcript : '';
  const validation = decision.raw?.validation;
  const onlyExpectedValidation = validation == null || (
    typeof validation === 'object'
    && !Array.isArray(validation)
    && Object.keys(validation).every((key) => key === 'ungrounded' || key === 'negation')
  );
  const negationAcceptable = onlyExpectedValidation
    && (validation == null || !Object.hasOwn(validation, 'negation') || validation.negation === false);
  const message = exactOriginalSubstring(source, args?.message, 200);
  const dateTimeHuman = args?.date_time_human;
  const dateTimeOmitted = dateTimeHuman == null || dateTimeHuman === '';
  const groundedDateText = dateTimeOmitted ? '' : exactOriginalSubstring(source, dateTimeHuman, 120);
  const checks = {
    singleCreateReminder: call?.name === 'create_reminder',
    validArguments: Boolean(args) && typeof args === 'object' && !Array.isArray(args),
    messageExactTranscriptSubstring: Boolean(message),
    dateTimeExactSubstringOrOmitted: dateTimeOmitted || Boolean(groundedDateText),
    onlyExpectedValidation,
    negationAcceptable,
    noSecondCreateCommand: !SECOND_CREATE_COMMAND.test(source)
  };
  const accepted = Object.values(checks).every(Boolean);
  return {
    policy: 'grounded_reminder_v1',
    accepted,
    checks,
    provenance: accepted ? {
      title_source: 'exact_original_transcript_substring',
      ...(groundedDateText ? { due_text_source: 'exact_original_transcript_substring' } : {})
    } : {},
    action: accepted ? {
      name: 'create_reminder',
      arguments: { title: message, ...(groundedDateText ? { due_text: groundedDateText } : {}) }
    } : null
  };
}

function defaultNoteVerification(decision, transcript) {
  const note = defaultNoteParts(transcript);
  const call = decision.calls.length === 1 ? decision.calls[0] : null;
  const checks = {
    noActionOrSingleCreateNote: decision.calls.length === 0 || call?.name === 'create_note',
    originalTranscriptAvailable: note.body.length <= 8000 && /[\p{L}\p{N}]/u.test(note.body),
    derivedTitleAvailable: note.title.length <= 120 && /[\p{L}\p{N}]/u.test(note.title)
  };
  const accepted = Object.values(checks).every(Boolean);
  return {
    policy: 'default_note_capture_v1',
    accepted,
    checks,
    provenance: accepted ? {
      action_source: call?.name === 'create_note' ? 'needle_note_intent' : 'default_note_fallback',
      body_source: 'complete_original_transcript',
      title_source: 'derived_from_original_transcript'
    } : {},
    action: accepted ? { name: 'create_note', arguments: { title: note.title, body: note.body } } : null
  };
}

function defaultCaptureVerification(decision, transcript) {
  const reminder = explicitReminderParts(transcript);
  const reminderValid = Boolean(reminder.prefix)
    && !reminder.hasSecondCommand
    && reminder.title.length <= 200
    && /[\p{L}\p{N}]/u.test(reminder.title);
  if (!reminderValid) return defaultNoteVerification(decision, transcript);
  const checks = {
    routerReturnedNoAction: decision.calls.length === 0,
    explicitReminderDetected: true,
    noSecondCreateCommand: !reminder.hasSecondCommand,
    originalTranscriptValuesAvailable: true
  };
  const accepted = Object.values(checks).every(Boolean);
  return {
    policy: 'default_capture_v1',
    accepted,
    checks,
    provenance: accepted ? {
      action_source: 'explicit_reminder_from_original_transcript',
      value_source: 'original_transcript_remainder',
      ...(reminder.groundedDateText ? { due_text_source: 'exact_original_transcript_substring' } : {})
    } : {},
    action: accepted ? {
      name: 'create_reminder',
      arguments: { title: reminder.title, ...(reminder.groundedDateText ? { due_text: reminder.groundedDateText } : {}) }
    } : null
  };
}

function lowConfidenceVerification(decision, transcript) {
  const call = decision.calls.length === 1 ? decision.calls[0] : null;
  if (decision.calls.length === 0) return defaultCaptureVerification(decision, transcript);
  if (call?.name === 'create_reminder') {
    const explicit = explicitReminderVerification(decision, transcript);
    return explicit.accepted ? explicit : groundedReminderVerification(decision, transcript);
  }
  if (call?.name === 'create_note') return defaultNoteVerification(decision, transcript);
  return {
    policy: 'explicit_create_action_v1',
    accepted: false,
    checks: { supportedExplicitAction: false },
    provenance: {},
    action: null
  };
}

function attachDecisionMetadata(decision, claim, threshold, verification = null) {
  decision.raw = {
    ...decision.raw,
    proxy_decision: {
      confidence_threshold: threshold,
      config_revision: Number(claim.processing_config.revision),
      verification: verification ? {
        policy: verification.policy,
        outcome: verification.accepted ? 'accepted' : 'rejected',
        checks: verification.checks,
        ...verification.provenance
      } : {
        policy: 'confidence_threshold_v1',
        outcome: 'not_required'
      }
    }
  };
}

function logProcessingDecision(deps, claim, decision, threshold, outcome, reasonCode = null) {
  const actionTypes = (decision?.calls || []).slice(0, 5).map((call) =>
    ACTION_TYPES.has(call?.name) ? call.name : 'unsupported'
  );
  deps.log?.(outcome === 'needs_review' || outcome === 'failed' ? 'warn' : 'info', 'processing_decision', {
    processingJobId: claim.id,
    recordingId: claim.recording_id,
    transcriptSource: claim.transcript_source,
    configRevision: Number(claim.processing_config.revision),
    confidence: decision?.confidence ?? null,
    confidenceThreshold: threshold,
    actionTypes,
    outcome,
    reasonCode
  });
}

function maxAttempts(config) {
  const value = Number(config.processingMaxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(10, value)) : DEFAULT_MAX_ATTEMPTS;
}

function retryDelay(config, attempt) {
  const configured = Array.isArray(config.processingRetryDelaysMs)
    ? config.processingRetryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  const value = Number(configured[Math.min(Math.max(0, attempt - 1), configured.length - 1)]);
  return Number.isFinite(value) ? Math.max(50, Math.min(3_600_000, value)) : 60_000;
}

function claimNextJob(db, leaseMs) {
  const now = new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  return transaction(db, () => {
    db.prepare(`UPDATE processing_jobs SET status = 'needs_review', lease_until = NULL,
      last_error_code = 'execution_interrupted',
      last_error_message = 'Action execution was interrupted and was not repeated automatically', updated_at = ?
      WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
        AND EXISTS (SELECT 1 FROM processing_actions a WHERE a.job_id = processing_jobs.id AND a.status = 'processing')`)
      .run(nowText, nowText);
    db.prepare(`UPDATE processing_actions SET status = 'needs_review', error_code = 'execution_interrupted',
      error_message = 'Action execution was interrupted and was not repeated automatically', updated_at = ?
      WHERE status = 'processing' AND job_id IN (
        SELECT id FROM processing_jobs WHERE status = 'needs_review' AND last_error_code = 'execution_interrupted'
      )`).run(nowText);
    db.prepare(`UPDATE processing_jobs SET status = 'pending', lease_until = NULL,
      next_attempt_at = ?, updated_at = ?
      WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
        AND NOT EXISTS (SELECT 1 FROM processing_actions a WHERE a.job_id = processing_jobs.id)`).run(nowText, nowText, nowText);

    const config = currentProcessingConfig(db);
    if (!config?.enabled) return null;
    const candidate = db.prepare(`SELECT j.*, r.device_id, r.trigger, r.recorded_at, r.received_at,
        t.id AS selected_transcript_id, t.source AS selected_transcript_source, t.text AS transcript_text
      FROM processing_jobs j
      JOIN recordings r ON r.id = j.recording_id
      JOIN transcripts t ON t.id = COALESCE(j.transcript_id, (
        SELECT tx.id FROM transcripts tx WHERE tx.recording_id = j.recording_id
        ORDER BY CASE tx.source WHEN 'pebble' THEN 0 ELSE 1 END, tx.created_at ASC LIMIT 1
      ))
      WHERE j.status = 'pending' AND j.next_attempt_at <= ?
      ORDER BY j.next_attempt_at ASC, j.created_at ASC LIMIT 1`).get(nowText);
    if (!candidate) return null;
    const changed = db.prepare(`UPDATE processing_jobs SET status = 'processing', attempts = attempts + 1,
      transcript_id = ?, transcript_source = ?, config_revision = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(
      candidate.selected_transcript_id,
      candidate.selected_transcript_source,
      config.revision,
      leaseUntil,
      nowText,
      candidate.id
    );
    if (Number(changed.changes) !== 1) return null;
    return {
      ...candidate,
      transcript_id: candidate.selected_transcript_id,
      transcript_source: candidate.selected_transcript_source,
      attempts: Number(candidate.attempts) + 1,
      lease_until: leaseUntil,
      processing_config: config
    };
  });
}

function markReview(db, claim, code, message, decision = null) {
  const now = nowIso();
  db.prepare(`UPDATE processing_jobs SET status = 'needs_review', lease_until = NULL,
    confidence = ?, proposed_action_json = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND attempts = ?`).run(
    decision?.confidence ?? null,
    decision ? JSON.stringify(decision.raw) : null,
    code,
    safeMessage(message),
    now,
    claim.id,
    claim.attempts
  );
}

function retryOrFail(db, claim, error, config) {
  const attempts = Number(claim.attempts);
  const shouldRetry = error?.transient && attempts < maxAttempts(config);
  const now = new Date();
  const next = new Date(now.getTime() + retryDelay(config, attempts)).toISOString();
  db.prepare(`UPDATE processing_jobs SET status = ?, next_attempt_at = ?, lease_until = NULL,
    last_error_code = ?, last_error_message = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND attempts = ?`).run(
    shouldRetry ? 'pending' : 'failed',
    next,
    error?.code || 'processing_failed',
    safeMessage(error?.message),
    now.toISOString(),
    claim.id,
    attempts
  );
}

function normalizeAction(decision, transcript) {
  if (decision.calls.length === 0) return { review: ['no_action', 'Needle did not identify a supported action'] };
  if (decision.calls.length !== 1) return { review: ['multiple_actions', 'Needle proposed more than one action'] };
  const call = decision.calls[0];
  if (!call || typeof call !== 'object' || !ACTION_TYPES.has(call.name)) {
    return { review: ['unsupported_action', 'Needle proposed an unsupported action'] };
  }
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return { review: ['invalid_arguments', 'Needle returned invalid action arguments'] };
  }
  if (call.name === 'create_note') {
    const note = defaultNoteParts(transcript);
    if (note.body.length > 8000 || !/[\p{L}\p{N}]/u.test(note.body)) {
      return { review: ['invalid_arguments', 'Needle returned invalid note arguments'] };
    }
    return {
      name: call.name,
      arguments: { title: note.title, body: note.body }
    };
  }
  if (call.name === 'create_reminder') {
    const dateTimeHuman = call.arguments.date_time_human;
    if (
      typeof call.arguments.message !== 'string'
      || (dateTimeHuman != null && typeof dateTimeHuman !== 'string')
    ) {
      return { review: ['invalid_arguments', 'Needle returned invalid reminder arguments'] };
    }
    return {
      name: call.name,
      arguments: {
        title: call.arguments.message,
        ...(dateTimeHuman?.trim() ? { due_text: dateTimeHuman } : {})
      }
    };
  }
  if (typeof call.arguments.request !== 'string' || !call.arguments.request.trim()) {
    return { review: ['invalid_arguments', 'Needle returned invalid forwarding arguments'] };
  }
  return { name: call.name, arguments: {} };
}

async function executeAction(deps, claim, decision, action) {
  const { db } = deps;
  const now = nowIso();
  const actionId = crypto.randomUUID();
  const device = db.prepare(`SELECT * FROM device_credentials
    WHERE id = ? AND revoked_at IS NULL AND deleted_at IS NULL`).get(claim.device_id);
  if (!device) {
    markReview(db, claim, 'device_unavailable', 'The recording device is no longer active', decision);
    return;
  }

  if (action.name === 'create_note' || action.name === 'create_reminder') {
    try {
      transaction(db, () => {
        db.prepare(`INSERT INTO processing_actions
          (id, job_id, action_type, arguments_json, status, result_json, error_code, error_message, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'processing', NULL, NULL, NULL, ?, ?)`).run(
          actionId, claim.id, action.name, JSON.stringify(action.arguments), now, now
        );
        const created = action.name === 'create_note'
          ? createNote(db, device.id, action.arguments)
          : createReminder(db, device.id, action.arguments);
        const result = { id: created.id, type: action.name };
        db.prepare(`UPDATE processing_actions SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(result), now, actionId);
        db.prepare(`UPDATE processing_jobs SET status = 'completed', lease_until = NULL, confidence = ?,
          proposed_action_json = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
          WHERE id = ? AND status = 'processing' AND attempts = ?`).run(
          decision.confidence, JSON.stringify(decision.raw), now, claim.id, claim.attempts
        );
      });
    } catch (error) {
      markReview(db, claim, error?.code || 'invalid_arguments', safeMessage(error?.message), decision);
    }
    return;
  }

  if (!claim.processing_config.agent_alias) {
    markReview(db, claim, 'agent_alias_required', 'Select an agent alias before enabling agent forwarding', decision);
    return;
  }
  db.prepare(`INSERT INTO processing_actions
    (id, job_id, action_type, arguments_json, status, result_json, error_code, error_message, created_at, updated_at)
    VALUES (?, ?, 'forward_agent', ?, 'processing', NULL, NULL, NULL, ?, ?)`).run(
    actionId, claim.id, JSON.stringify({}), now, now
  );
  try {
    const result = await completeForDevice(deps, {
      device,
      aliasName: claim.processing_config.agent_alias,
      text: claim.transcript_text
    });
    transaction(db, () => {
      db.prepare(`UPDATE processing_actions SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'`)
        .run(JSON.stringify(result), nowIso(), actionId);
      db.prepare(`UPDATE processing_jobs SET status = 'completed', lease_until = NULL, confidence = ?,
        proposed_action_json = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND attempts = ?`).run(
        decision.confidence, JSON.stringify(decision.raw), nowIso(), claim.id, claim.attempts
      );
    });
  } catch (error) {
    const finished = nowIso();
    transaction(db, () => {
      db.prepare(`UPDATE processing_actions SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`)
        .run(error?.code || 'agent_failed', safeMessage(error?.message), finished, actionId);
      db.prepare(`UPDATE processing_jobs SET status = 'failed', lease_until = NULL, confidence = ?, proposed_action_json = ?,
        last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`).run(
        decision.confidence, JSON.stringify(decision.raw), error?.code || 'agent_failed', safeMessage(error?.message), finished, claim.id
      );
    });
  }
}

async function processClaim(deps, claim) {
  try {
    const decision = parseDecision(await routeTranscript(deps, claim));
    markRouterHealth(deps.db, 'healthy');
    const threshold = Number(claim.processing_config.confidence_threshold);
    const captureVerification = decision.calls.length === 0
      ? defaultCaptureVerification(decision, claim.transcript_text)
      : decision.calls.length === 1 && decision.calls[0]?.name === 'create_note'
        ? defaultNoteVerification(decision, claim.transcript_text)
        : null;
    if (captureVerification?.accepted) {
      attachDecisionMetadata(decision, claim, threshold, captureVerification);
      const reason = captureVerification.action.name === 'create_note'
        ? 'default_note_capture'
        : 'verified_explicit_reminder';
      logProcessingDecision(deps, claim, decision, threshold, 'execution_allowed', reason);
      await executeAction(deps, claim, decision, captureVerification.action);
      return;
    }
    if (decision.confidence == null || decision.confidence < threshold) {
      const verification = decision.confidence == null
        ? {
            policy: 'confidence_required_v1',
            accepted: false,
            checks: { confidenceAvailable: false },
            provenance: {},
            action: null
          }
        : lowConfidenceVerification(decision, claim.transcript_text);
      attachDecisionMetadata(decision, claim, threshold, verification);
      if (!verification?.accepted) {
        logProcessingDecision(deps, claim, decision, threshold, 'needs_review', 'low_confidence');
        markReview(deps.db, claim, 'low_confidence', 'Needle confidence was below the configured threshold', decision);
        return;
      }
      const verifiedReason = verification.policy === 'default_note_capture_v1'
        ? 'default_note_capture'
        : verification.policy === 'explicit_reminder_v1'
          ? 'verified_explicit_reminder'
          : 'verified_explicit_transcript';
      logProcessingDecision(deps, claim, decision, threshold, 'execution_allowed', verifiedReason);
      await executeAction(deps, claim, decision, verification.action);
      return;
    }
    attachDecisionMetadata(decision, claim, threshold);
    const action = normalizeAction(decision, claim.transcript_text);
    if (action.review) {
      const verification = action.review[0] === 'no_action'
        ? defaultCaptureVerification(decision, claim.transcript_text)
        : null;
      if (verification) attachDecisionMetadata(decision, claim, threshold, verification);
      if (verification?.accepted) {
        logProcessingDecision(deps, claim, decision, threshold, 'execution_allowed', 'verified_explicit_transcript');
        await executeAction(deps, claim, decision, verification.action);
        return;
      }
      logProcessingDecision(deps, claim, decision, threshold, 'needs_review', action.review[0]);
      markReview(deps.db, claim, action.review[0], action.review[1], decision);
      return;
    }
    logProcessingDecision(deps, claim, decision, threshold, 'execution_allowed');
    await executeAction(deps, claim, decision, action);
  } catch (error) {
    const threshold = Number(claim.processing_config.confidence_threshold);
    logProcessingDecision(deps, claim, null, threshold, 'failed', error?.code || 'processing_failed');
    retryOrFail(deps.db, claim, error, deps.config);
    markRouterHealth(deps.db, 'unavailable', error?.message);
  }
}

function markRouterHealth(db, status, error = null) {
  const now = nowIso();
  db.prepare(`UPDATE processing_config SET health_status = ?, last_health_at = ?, last_error = ?, updated_at = ? WHERE id = 1`)
    .run(status, now, error ? safeMessage(error) : null, now);
}

export async function checkProcessingHealth(deps) {
  try {
    const fetched = await fetchWithTimeout(deps, processingEndpoint(deps.config, '/healthz'), {
      method: 'GET', headers: { Accept: 'application/json' }
    }, Math.min(10_000, deps.config.processingTimeoutMs || 30_000));
    const { response } = fetched;
    let value;
    try {
      if (!response.ok) throw new ProcessingError('router_unavailable', 'The local intent router is not ready', { transient: true });
      try {
        value = await boundedJson(response);
      } catch (error) {
        if (fetched.signal.aborted && !(error instanceof ProcessingError)) {
          throw new ProcessingError('router_timeout', 'The local intent router timed out', { transient: true });
        }
        throw error;
      }
    } finally {
      await fetched.dispose();
    }
    if (value?.status !== 'ok' || value?.ready !== true) {
      throw new ProcessingError('router_starting', 'Needle is still loading', { transient: true });
    }
    markRouterHealth(deps.db, 'healthy');
    return { ok: true, status: 'healthy' };
  } catch (error) {
    markRouterHealth(deps.db, 'unavailable', error?.message);
    return { ok: false, status: 'unavailable', error: safeMessage(error?.message) };
  }
}

export function startProcessingWorker(deps) {
  let stopped = false;
  let timer = null;
  let running = false;
  const pollMs = Math.max(250, Number(deps.config.workerPollMs) || 2000);
  const leaseMs = Math.max(60_000, (deps.config.processingTimeoutMs || 30_000) + 30_000);

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, pollMs);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const claim = claimNextJob(deps.db, leaseMs);
      if (claim) await processClaim(deps, claim);
    } catch (error) {
      deps.log?.('error', 'processing_worker_failed', { error: safeMessage(error?.message) });
    } finally {
      running = false;
      schedule();
    }
  };
  queueMicrotask(run);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  };
}

export function listProcessingJobs(db, limit = 100) {
  return db.prepare(`SELECT j.*, r.trigger, r.recorded_at, r.received_at, d.name AS device_name,
      d.connection_label, d.owner_device_id,
      t.id AS listed_transcript_id, t.source AS listed_transcript_source, t.text AS transcript_text,
      a.action_type, a.status AS action_status, a.arguments_json AS action_arguments_json,
      a.result_json, a.error_code AS action_error_code,
      a.error_message AS action_error_message
    FROM processing_jobs j
    JOIN recordings r ON r.id = j.recording_id
    JOIN device_credentials d ON d.id = r.device_id
    LEFT JOIN transcripts t ON t.id = COALESCE(j.transcript_id, (
      SELECT tx.id FROM transcripts tx WHERE tx.recording_id = j.recording_id
      ORDER BY CASE tx.source WHEN 'pebble' THEN 0 ELSE 1 END, tx.created_at ASC LIMIT 1
    ))
    LEFT JOIN processing_actions a ON a.job_id = j.id
    ORDER BY j.created_at DESC LIMIT ?`).all(limit).map((row) => {
      const proposedAction = row.proposed_action_json ? JSON.parse(row.proposed_action_json) : null;
      const proxyDecision = proposedAction?.proxy_decision || null;
      return {
        id: row.id,
        recordingId: row.recording_id,
        deviceName: row.device_name,
        connectionLabel: row.connection_label || null,
        ownerDeviceId: row.owner_device_id || row.device_id,
        trigger: row.trigger || null,
        transcriptId: row.transcript_id || row.listed_transcript_id || null,
        transcriptSource: row.transcript_source || row.listed_transcript_source || null,
        transcriptText: row.transcript_text || null,
        recordedAt: row.recorded_at || null,
        status: row.status,
        attempts: Number(row.attempts),
        configRevision: Number(row.config_revision),
        confidence: row.confidence == null ? null : Number(row.confidence),
        confidenceThreshold: proxyDecision?.confidence_threshold ?? null,
        router: proposedAction?.router || null,
        verification: proxyDecision?.verification || null,
        proposedAction,
        action: row.action_type ? {
          type: row.action_type,
          status: row.action_status,
          arguments: row.action_arguments_json ? JSON.parse(row.action_arguments_json) : null,
          result: row.result_json ? JSON.parse(row.result_json) : null,
          error: row.action_error_code ? { code: row.action_error_code, message: row.action_error_message } : null
        } : null,
        error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
        receivedAt: row.received_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
}

export function retryProcessingJob(db, id) {
  const now = nowIso();
  return transaction(db, () => {
    const job = db.prepare('SELECT id, status FROM processing_jobs WHERE id = ?').get(id);
    if (!job) throw new HttpError(404, 'processing_job_not_found', 'Processing job not found');
    if (job.status === 'processing') throw new HttpError(409, 'processing_job_busy', 'Processing job is already running');
    if (job.status === 'completed') throw new HttpError(409, 'processing_job_completed', 'Completed actions cannot be repeated');
    if (db.prepare('SELECT id FROM processing_actions WHERE job_id = ?').get(id)) {
      throw new HttpError(409, 'processing_action_attempted', 'An attempted action cannot be repeated automatically');
    }
    db.prepare(`UPDATE processing_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL,
      confidence = NULL, proposed_action_json = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE id = ?`).run(now, now, id);
    return true;
  });
}
