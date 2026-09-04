import crypto from 'node:crypto';

import { nowIso } from './db.js';
import { HttpError } from './http.js';

function object(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_params', `${name} must be an object`);
  }
  return value;
}

function text(value, name, max, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, 'invalid_params', `${name} is invalid`);
  }
  return value.trim();
}

function limit(value) {
  return Number.isInteger(value) ? Math.min(50, Math.max(1, value)) : 20;
}

function isoDate(value, name, optional = true) {
  if ((value == null || value === '') && optional) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, 'invalid_params', `${name} must be a valid ISO date-time`);
  }
  return date.toISOString();
}

function result(value, message) {
  return {
    content: [{ type: 'text', text: message || JSON.stringify(value) }],
    structuredContent: value
  };
}

function ownedChange(change, noun) {
  if (!change.changes) throw new HttpError(404, 'not_found', `${noun} not found`);
}

const PARENT_DEVICE_CREDENTIALS = `device_id IN (
  SELECT id FROM device_credentials
  WHERE owner_device_id = ? OR (owner_device_id IS NULL AND id = ?)
)`;

function parentDeviceId(db, device) {
  const credential = db.prepare('SELECT id, owner_device_id FROM device_credentials WHERE id = ?').get(device.id);
  return credential ? (credential.owner_device_id || credential.id) : null;
}

export function createNote(db, deviceId, rawArgs) {
  const args = object(rawArgs ?? {});
  const id = crypto.randomUUID();
  const now = nowIso();
  const titleValue = args.title == null || args.title === '' ? null : text(args.title, 'title', 120);
  const body = text(args.body, 'body', 8000);
  db.prepare('INSERT INTO notes (id, device_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, deviceId, titleValue, body, now, now);
  return db.prepare('SELECT id, device_id, title, body, archived, created_at, updated_at FROM notes WHERE id = ?').get(id);
}

export function createReminder(db, deviceId, rawArgs) {
  const args = object(rawArgs ?? {});
  const id = crypto.randomUUID();
  const now = nowIso();
  const titleValue = text(args.title, 'title', 200);
  const dueAt = isoDate(args.due_at ?? args.dueAt, 'due_at');
  const dueText = args.due_text == null || args.due_text === '' ? null : text(args.due_text, 'due_text', 120);
  const timezone = args.timezone == null || args.timezone === '' ? null : text(args.timezone, 'timezone', 80);
  db.prepare('INSERT INTO reminders (id, device_id, title, due_at, due_text, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, deviceId, titleValue, dueAt, dueText, timezone, now, now);
  return db.prepare('SELECT id, device_id, title, due_at, due_text, timezone, completed_at, created_at, updated_at FROM reminders WHERE id = ?').get(id);
}

export function executeMcpTool(db, device, name, rawArgs) {
  const args = object(rawArgs ?? {});
  const now = nowIso();
  if (name === 'notes_create') {
    const note = createNote(db, device.id, args);
    return result(note, `Note created: ${note.title || note.body.slice(0, 80)}`);
  }
  if (name === 'notes_list') {
    const ownerId = parentDeviceId(db, device);
    const includeArchived = args.include_archived === true;
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
    const queryLike = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = query
      ? db.prepare(`SELECT id, title, body, archived, created_at, updated_at FROM notes
          WHERE ${PARENT_DEVICE_CREDENTIALS} AND (? OR archived = 0) AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT ?`).all(ownerId, ownerId, includeArchived ? 1 : 0, queryLike, queryLike, limit(args.limit))
      : db.prepare(`SELECT id, title, body, archived, created_at, updated_at FROM notes
          WHERE ${PARENT_DEVICE_CREDENTIALS} AND (? OR archived = 0) ORDER BY updated_at DESC LIMIT ?`)
        .all(ownerId, ownerId, includeArchived ? 1 : 0, limit(args.limit));
    return result({ notes: rows }, rows.length ? `${rows.length} note${rows.length === 1 ? '' : 's'} found.` : 'No notes found.');
  }
  if (name === 'notes_update') {
    const ownerId = parentDeviceId(db, device);
    const id = text(args.id, 'id', 100);
    const current = db.prepare(`SELECT * FROM notes WHERE id = ? AND ${PARENT_DEVICE_CREDENTIALS}`)
      .get(id, ownerId, ownerId);
    if (!current) throw new HttpError(404, 'not_found', 'Note not found');
    const titleValue = Object.hasOwn(args, 'title') ? (args.title == null || args.title === '' ? null : text(args.title, 'title', 120)) : current.title;
    const body = Object.hasOwn(args, 'body') ? text(args.body, 'body', 8000) : current.body;
    const archived = Object.hasOwn(args, 'archived') ? (args.archived === true ? 1 : 0) : current.archived;
    db.prepare(`UPDATE notes SET title = ?, body = ?, archived = ?, updated_at = ?
      WHERE id = ? AND ${PARENT_DEVICE_CREDENTIALS}`)
      .run(titleValue, body, archived, now, id, ownerId, ownerId);
    const note = db.prepare('SELECT id, title, body, archived, created_at, updated_at FROM notes WHERE id = ?').get(id);
    return result(note, 'Note updated.');
  }
  if (name === 'notes_delete') {
    const ownerId = parentDeviceId(db, device);
    const id = text(args.id, 'id', 100);
    if (args.confirm !== true) throw new HttpError(400, 'confirmation_required', 'Explicit confirmation is required before deleting a note');
    ownedChange(db.prepare(`DELETE FROM notes WHERE id = ? AND ${PARENT_DEVICE_CREDENTIALS}`)
      .run(id, ownerId, ownerId), 'Note');
    return result({ id, deleted: true }, 'Note deleted.');
  }
  if (name === 'reminders_create') {
    const reminder = createReminder(db, device.id, args);
    return result(reminder, `Reminder created: ${reminder.title}`);
  }
  if (name === 'reminders_list') {
    const ownerId = parentDeviceId(db, device);
    const rows = db.prepare(`SELECT id, title, due_at, due_text, timezone, completed_at, created_at, updated_at FROM reminders
      WHERE ${PARENT_DEVICE_CREDENTIALS} AND (? OR completed_at IS NULL)
      ORDER BY completed_at IS NOT NULL, due_at IS NULL, due_at, created_at DESC LIMIT ?`)
      .all(ownerId, ownerId, args.include_completed === true ? 1 : 0, limit(args.limit));
    return result({ reminders: rows }, rows.length ? `${rows.length} reminder${rows.length === 1 ? '' : 's'} found.` : 'No reminders found.');
  }
  if (name === 'reminders_complete') {
    const ownerId = parentDeviceId(db, device);
    const id = text(args.id, 'id', 100);
    ownedChange(db.prepare(`UPDATE reminders SET completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ? AND ${PARENT_DEVICE_CREDENTIALS}`)
      .run(now, now, id, ownerId, ownerId), 'Reminder');
    return result({ id, completed_at: now }, 'Reminder completed.');
  }
  if (name === 'reminders_delete') {
    const ownerId = parentDeviceId(db, device);
    const id = text(args.id, 'id', 100);
    if (args.confirm !== true) throw new HttpError(400, 'confirmation_required', 'Explicit confirmation is required before deleting a reminder');
    ownedChange(db.prepare(`DELETE FROM reminders WHERE id = ? AND ${PARENT_DEVICE_CREDENTIALS}`)
      .run(id, ownerId, ownerId), 'Reminder');
    return result({ id, deleted: true }, 'Reminder deleted.');
  }
  throw new HttpError(404, 'tool_not_found', 'Tool not found');
}
