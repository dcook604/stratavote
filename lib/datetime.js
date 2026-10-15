'use strict';

// Motion open/close times are stored as UTC ISO strings, but admins enter them
// as local wall-clock values in <input type="datetime-local"> (e.g.
// "2026-03-01T09:00", with no timezone attached). Something has to decide which
// zone that wall time belongs to.
//
// Previously the answer was "whatever zone the server process happens to be in",
// which differs between a dev box (America/Vancouver) and the production
// container (UTC, since the Dockerfile sets no TZ) -- the same 09:00 input
// produced voting windows 7-8 hours apart. APP_TIMEZONE names an IANA zone
// explicitly so both environments agree.
//
// APP_TIMEZONE_OFFSET_MINUTES is still honoured when set, so an existing
// deployment that configured it does not change behaviour on upgrade. Note it
// is a *fixed* offset and therefore drifts by an hour across DST; prefer
// APP_TIMEZONE.

const DEFAULT_TIMEZONE = 'America/Vancouver';

function getTimezone() {
  const tz = process.env.APP_TIMEZONE;
  return tz && String(tz).trim() ? String(tz).trim() : DEFAULT_TIMEZONE;
}

// Is APP_TIMEZONE a zone this Node build actually knows about?
function isTimezoneValid(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (e) {
    return false;
  }
}

function legacyOffsetMinutes() {
  const raw = process.env.APP_TIMEZONE_OFFSET_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

// Wall-clock fields of `date` as observed in `timeZone`.
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second)
  };
}

// Minutes to add to UTC to get local time in `timeZone` at that instant
// (e.g. -480 for PST, -420 for PDT).
function zoneOffsetMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Interpret wall-clock fields as a time in `timeZone`, return the UTC instant.
function wallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = zoneOffsetMinutes(new Date(asIfUtc), timeZone);
  let ts = asIfUtc - firstOffset * 60000;

  // Near a DST transition the offset at the *candidate* instant can differ from
  // the offset we assumed; recompute once using the corrected instant.
  const secondOffset = zoneOffsetMinutes(new Date(ts), timeZone);
  if (secondOffset !== firstOffset) {
    ts = asIfUtc - secondOffset * 60000;
  }

  return new Date(ts);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Parse an <input type="datetime-local"> value (or anything else Date accepts)
// into a UTC Date.
function parseMotionDateTime(value) {
  if (!value) return new Date(NaN);
  if (typeof value !== 'string') return new Date(value);

  const m = value.match(LOCAL_DATETIME_RE);
  if (!m) return new Date(value);

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;

  // Explicit fixed offset wins (legacy deployments).
  const offset = legacyOffsetMinutes();
  if (offset !== null) {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000);
  }

  const timeZone = getTimezone();
  if (isTimezoneValid(timeZone)) {
    return wallTimeToUtc(year, month, day, hour, minute, second, timeZone);
  }

  // Unknown zone name -- fall back to server-local interpretation rather than
  // throwing, but this is logged loudly at startup (see validateTimezone).
  return new Date(value);
}

// Convert a stored UTC ISO string back into a value suitable for
// <input type="datetime-local"> in the configured zone.
function toDatetimeLocalValue(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const offset = legacyOffsetMinutes();
  if (offset !== null) {
    const shifted = new Date(date.getTime() + offset * 60000);
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
      `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  }

  const timeZone = getTimezone();
  if (isTimezoneValid(timeZone)) {
    const p = zonedParts(date, timeZone);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Human-readable description of the active zone configuration, for startup logs.
function describeTimezone() {
  const offset = legacyOffsetMinutes();
  if (offset !== null) {
    return { mode: 'fixed-offset', offsetMinutes: offset, timeZone: null };
  }
  return { mode: 'iana', timeZone: getTimezone(), offsetMinutes: null };
}

module.exports = {
  DEFAULT_TIMEZONE,
  getTimezone,
  isTimezoneValid,
  parseMotionDateTime,
  toDatetimeLocalValue,
  describeTimezone
};
