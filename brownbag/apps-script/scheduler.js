/**
 * Pure scheduling logic for the Applied Micro Brown Bag.
 * No Google Apps Script calls in this file, so the same code runs in Node
 * (for tests) and inside the Apps Script project (as a plain global file).
 *
 * Shapes
 *   Signup      { ts, name, email, dates: ['yyyy-mm-dd'], slot: 30|60|null, advisors, dietary }
 *   ScheduleRow { date, term, start, end, presenter, slot, title, rsvps, notes }
 *   LedgerRow   { email, name, date, slot, placedAt, source }
 *   TitleResp   { ts, date, presenter, title }
 *   RsvpResp    { ts, date, presenter, name }
 */

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var SLOT_TOTAL = 60;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** "Mon 5 Oct 2026" | "5 October 2026" | "2026-10-05" -> "2026-10-05", else null. */
function parseChoiceLabel(label) {
  if (label === null || label === undefined) return null;
  var s = String(label).trim();
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  var m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})/);
  if (!m) return null;
  var mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return m[3] + '-' + pad2(mon) + '-' + pad2(parseInt(m[1], 10));
}

/** "2026-10-05" -> "Mon 5 Oct 2026" (UTC based, so no timezone drift). */
function labelForIso(iso) {
  var p = iso.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return DAY_NAMES[d.getUTCDay()] + ' ' + p[2] + ' ' + MONTH_NAMES[p[1] - 1] + ' ' + p[0];
}

function addDays(iso, n) {
  var p = iso.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Term label for a new row: Sep-Dec = Term 1, Jan-Mar = Term 2, Apr-Aug = Term 3. */
function termOf(iso) {
  var m = parseInt(iso.split('-')[1], 10);
  if (m >= 9) return 'Term 1';
  if (m <= 3) return 'Term 2';
  return 'Term 3';
}

function normaliseName(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same normalised name, or same first and last token. */
function namesMatch(a, b) {
  var x = normaliseName(a), y = normaliseName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  var xt = x.split(' '), yt = y.split(' ');
  return xt[0] === yt[0] && xt[xt.length - 1] === yt[yt.length - 1];
}

function normaliseEmail(e) { return e ? String(e).trim().toLowerCase() : ''; }

function parseSlot(s) {
  if (s === 30 || s === 60) return s;
  var t = String(s || '');
  if (/60/.test(t)) return 60;
  if (/30/.test(t)) return 30;
  return null;
}

/** One person per email (fallback: normalised name). Earliest ts = priority, latest response = details. */
function dedupeSignups(signups) {
  var byKey = {};
  var order = [];
  signups.forEach(function (s) {
    var key = normaliseEmail(s.email) || ('name:' + normaliseName(s.name));
    if (!byKey[key]) {
      byKey[key] = { ts: s.ts, name: s.name, email: normaliseEmail(s.email), dates: s.dates.slice(), slot: s.slot, advisors: s.advisors, dietary: s.dietary, latestTs: s.ts };
      order.push(key);
    } else {
      var p = byKey[key];
      if (s.ts < p.ts) p.ts = s.ts;
      if (s.ts >= p.latestTs) {
        p.latestTs = s.ts; p.name = s.name || p.name; p.dates = s.dates.slice(); p.slot = s.slot || p.slot;
        p.advisors = s.advisors || p.advisors; p.dietary = s.dietary || p.dietary;
      }
    }
  });
  var people = order.map(function (k) { return byKey[k]; });
  people.sort(function (a, b) { return a.ts - b.ts; });
  return { people: people, duplicatesIgnored: signups.length - people.length };
}

function hasPresenter(row) { return !!(row.presenter && String(row.presenter).trim()); }

function usedMinutes(schedule, date) {
  return schedule.reduce(function (sum, r) {
    return sum + ((r.date === date && hasPresenter(r)) ? (r.slot || 0) : 0);
  }, 0);
}

function scheduleHasDate(schedule, date) {
  return schedule.some(function (r) { return r.date === date; });
}

/** Start time for a new talk of `slot` minutes on `date`, or null if it does not fit. */
function freeStart(schedule, date, slot) {
  var used = usedMinutes(schedule, date);
  if (slot === 60) return used === 0 ? '12:00' : null;
  if (slot === 30) {
    if (used === 0) return '12:00';
    if (used === 30) {
      var taken = schedule.filter(function (r) { return r.date === date && hasPresenter(r); })[0];
      return taken.start === '12:30' ? '12:00' : '12:30';
    }
  }
  return null;
}

function endFor(start, slot) {
  if (start === '12:30') return '13:00';
  return slot === 60 ? '13:00' : '12:30';
}

function isPlaced(person, ledger, schedule) {
  var email = normaliseEmail(person.email);
  if (email && ledger.some(function (l) { return normaliseEmail(l.email) === email; })) return true;
  if (ledger.some(function (l) { return namesMatch(l.name, person.name); })) return true;
  return schedule.some(function (r) { return hasPresenter(r) && namesMatch(r.presenter, person.name); });
}

function cloneRow(r) {
  return { date: r.date, term: r.term || termOf(r.date), start: r.start, end: r.end, presenter: r.presenter || '', slot: r.slot || null, title: r.title || '', rsvps: r.rsvps === undefined ? '' : r.rsvps, notes: r.notes || '' };
}

function sortSchedule(schedule) {
  schedule.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.start || '') < (b.start || '') ? -1 : (a.start === b.start ? 0 : 1);
  });
  return schedule;
}

/**
 * Place people who are not yet on the schedule. Mutates nothing in `input`;
 * returns { schedule, newLedger, unplaced, placed }.
 */
function placeSignups(input) {
  var schedule = input.schedule.map(cloneRow);
  var ledger = input.ledger.slice();
  var today = input.today;
  var lead = input.minLeadDays === undefined ? 7 : input.minLeadDays;
  var cutoff = addDays(today, lead);
  var people = dedupeSignups(input.signups).people;
  var placed = [], unplaced = [], newLedger = [];

  people.forEach(function (p) {
    if (isPlaced(p, ledger, schedule)) return;
    if (!p.slot) { unplaced.push(unplacedRow(p, 'slot length missing')); return; }
    var candidates = p.dates.filter(function (d) { return d && d >= cutoff && scheduleHasDate(schedule, d); }).sort();
    if (candidates.length === 0) { unplaced.push(unplacedRow(p, 'no future dates ticked')); return; }
    var done = false;
    for (var i = 0; i < candidates.length && !done; i++) {
      var d = candidates[i];
      var start = freeStart(schedule, d, p.slot);
      if (!start) continue;
      var blank = schedule.filter(function (r) { return r.date === d && !hasPresenter(r); })[0];
      var row;
      if (blank) {
        row = blank;
        row.presenter = p.name; row.slot = p.slot; row.start = start; row.end = endFor(start, p.slot);
      } else {
        row = { date: d, term: termOf(d), start: start, end: endFor(start, p.slot), presenter: p.name, slot: p.slot, title: '', rsvps: '', notes: '' };
        schedule.push(row);
      }
      var l = { email: p.email, name: p.name, date: d, slot: p.slot, placedAt: today, source: 'auto' };
      ledger.push(l); newLedger.push(l);
      placed.push({ name: p.name, email: p.email, date: d, start: start, slot: p.slot });
      done = true;
    }
    if (!done) unplaced.push(unplacedRow(p, 'no capacity on ticked dates'));
  });

  return { schedule: sortSchedule(schedule), newLedger: newLedger, unplaced: unplaced, placed: placed };
}

function unplacedRow(p, reason) {
  return { email: p.email, name: p.name, slot: p.slot, dates: p.dates.slice().sort(), reason: reason, firstSeen: p.ts };
}

/** Dates to keep on the sign-up form: on the schedule, beyond the lead time, under 60 minutes used. */
function choiceDatesToKeep(schedule, today, minLeadDays) {
  var lead = minLeadDays === undefined ? 7 : minLeadDays;
  var cutoff = addDays(today, lead);
  var keep = {};
  schedule.forEach(function (r) {
    if (r.date >= cutoff && usedMinutes(schedule, r.date) < SLOT_TOTAL) keep[r.date] = true;
  });
  return Object.keys(keep).sort();
}

/** Half-full dates (one 30-minute slot left). */
function halfFullDates(schedule, today, minLeadDays) {
  return choiceDatesToKeep(schedule, today, minLeadDays).filter(function (d) { return usedMinutes(schedule, d) === 30; });
}

/** Latest title response per (date, presenter) wins. Mutates schedule rows. */
function applyTitles(schedule, titles) {
  var updated = [], unmatched = [];
  titles.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (t) {
    var date = parseChoiceLabel(t.date);
    var row = schedule.filter(function (r) { return r.date === date && hasPresenter(r) && namesMatch(r.presenter, t.presenter); })[0];
    if (!row) { unmatched.push({ date: t.date, presenter: t.presenter, title: t.title }); return; }
    var title = String(t.title || '').trim();
    if (title && title !== row.title) { row.title = title; updated.push({ date: date, presenter: row.presenter, title: title }); }
  });
  return { updated: updated, unmatched: unmatched };
}

/** Count distinct attendees per date; write to every row of that date. */
function applyRsvps(schedule, rsvps) {
  var seen = {};
  rsvps.forEach(function (r) {
    var date = parseChoiceLabel(r.date);
    if (!date) return;
    var who = normaliseName(r.name) || String(r.ts);
    seen[date] = seen[date] || {};
    seen[date][who] = true;
  });
  var changed = false;
  schedule.forEach(function (row) {
    var n = seen[row.date] ? Object.keys(seen[row.date]).length : '';
    var current = row.rsvps === '' || row.rsvps === undefined || row.rsvps === null ? '' : Number(row.rsvps);
    if (current !== n) { row.rsvps = n; changed = true; }
  });
  return changed;
}

/** One daily run. Pure: returns new objects, never mutates `input`. */
function run(input) {
  var placedRes = placeSignups(input);
  var schedule = placedRes.schedule;
  var titleRes = applyTitles(schedule, input.titles || []);
  var rsvpChanged = applyRsvps(schedule, input.rsvps || []);
  var keep = choiceDatesToKeep(schedule, input.today, input.minLeadDays);
  var prevUnplacedKeys = {};
  (input.prevUnplaced || []).forEach(function (u) { prevUnplacedKeys[normaliseEmail(u.email) || normaliseName(u.name)] = true; });
  var newUnplaced = placedRes.unplaced.filter(function (u) { return !prevUnplacedKeys[normaliseEmail(u.email) || normaliseName(u.name)]; });
  return {
    schedule: schedule,
    newLedger: placedRes.newLedger,
    unplaced: placedRes.unplaced,
    keepChoiceDates: keep,
    halfFullDates: halfFullDates(schedule, input.today, input.minLeadDays),
    changes: {
      placed: placedRes.placed,
      newUnplaced: newUnplaced,
      titlesUpdated: titleRes.updated,
      titlesUnmatched: titleRes.unmatched,
      rsvpChanged: rsvpChanged
    }
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseChoiceLabel: parseChoiceLabel, labelForIso: labelForIso, addDays: addDays, termOf: termOf,
    normaliseName: normaliseName, namesMatch: namesMatch, normaliseEmail: normaliseEmail, parseSlot: parseSlot,
    dedupeSignups: dedupeSignups, usedMinutes: usedMinutes, freeStart: freeStart, isPlaced: isPlaced,
    placeSignups: placeSignups, choiceDatesToKeep: choiceDatesToKeep, halfFullDates: halfFullDates,
    applyTitles: applyTitles, applyRsvps: applyRsvps, sortSchedule: sortSchedule, run: run
  };
}
