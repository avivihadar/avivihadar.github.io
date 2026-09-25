/**
 * Pure scheduling logic for the Applied Micro Brown Bag.
 * No Google Apps Script calls in this file, so the same code runs in Node
 * (for tests) and inside the Apps Script project (as a plain global file).
 *
 * Shapes
 *   Signup      { ts, name, email, dates, slot, title, role, affiliation, advisors, dietary }
 *   known       { normalised name -> {role, affiliation} } for people who signed up before
 *                those questions existed
 *   ScheduleRow { date, term, start, end, presenter, slot, title, rsvps, notes }
 *   LedgerRow   { email, name, date, slot, placedAt, source, signupTs }
 *                 signupTs = timestamp of the sign-up response the placement was based on;
 *                 a newer response from the same person replaces their placement.
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
      byKey[key] = { ts: s.ts, name: s.name, email: normaliseEmail(s.email), dates: s.dates.slice(), slot: s.slot, title: s.title || '', advisors: s.advisors, dietary: s.dietary, latestTs: s.ts };
      order.push(key);
    } else {
      var p = byKey[key];
      if (s.ts < p.ts) p.ts = s.ts;
      if (s.ts >= p.latestTs) {
        p.latestTs = s.ts; p.name = s.name || p.name; p.dates = s.dates.slice(); p.slot = s.slot || p.slot;
        p.title = s.title || p.title; p.advisors = s.advisors || p.advisors; p.dietary = s.dietary || p.dietary;
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

function ledgerRowsFor(person, ledger) {
  var email = normaliseEmail(person.email);
  return ledger.filter(function (l) { return (email && normaliseEmail(l.email) === email) || namesMatch(l.name, person.name); });
}

function isPlaced(person, ledger, schedule) {
  if (ledgerRowsFor(person, ledger).length) return true;
  return schedule.some(function (r) { return hasPresenter(r) && namesMatch(r.presenter, person.name); });
}

/** Person sent a newer sign-up than the one their placement was based on. */
function hasResubmitted(person, ledgerRows) {
  var ref = Math.max.apply(null, ledgerRows.map(function (l) { return l.signupTs || person.ts; }));
  return person.latestTs > ref;
}

/** Remove a person's placements (schedule rows on their ledger dates + ledger rows). Keeps the date on the schedule. */
function removePlacement(person, ledgerRows, schedule, ledger) {
  var dates = ledgerRows.map(function (l) { return l.date; });
  var removedDates = [];
  for (var i = schedule.length - 1; i >= 0; i--) {
    var r = schedule[i];
    if (dates.indexOf(r.date) >= 0 && hasPresenter(r) && namesMatch(r.presenter, person.name)) {
      removedDates.push(r.date);
      schedule.splice(i, 1);
      if (!scheduleHasDate(schedule, r.date)) schedule.push({ date: r.date, term: r.term, start: '12:00', end: '13:00', presenter: '', slot: null, title: '', rsvps: '', notes: r.notes || '' });
    }
  }
  ledgerRows.forEach(function (l) { var k = ledger.indexOf(l); if (k >= 0) ledger.splice(k, 1); });
  return removedDates.sort();
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
 * Chooses where to put a set of people so that as many as possible get a slot.
 * Greedy "earliest date first" fails when an early sign-up with flexible dates takes
 * the only date a later, less flexible person can use, so this searches instead:
 * most people placed wins; ties go to the earlier dates and to the earlier sign-ups.
 * Returns an array, one entry per person: {date, start} or null.
 */
function bestAssignment(people, schedule, cutoff) {
  var dates = [];
  schedule.forEach(function (r) { if (r.date >= cutoff && dates.indexOf(r.date) < 0) dates.push(r.date); });
  dates.sort();
  var index = {}, used = {}, halfTaken = {};
  dates.forEach(function (d, i) {
    index[d] = i;
    used[d] = usedMinutes(schedule, d);
    halfTaken[d] = {};
    schedule.forEach(function (r) { if (r.date === d && hasPresenter(r)) halfTaken[d][r.start] = true; });
  });

  function slotFor(d, slot) {
    if (used[d] === undefined) return null;
    if (slot === 60) return used[d] === 0 ? '12:00' : null;
    if (slot === 30) {
      if (used[d] === 0) return '12:00';
      if (used[d] === 30) return halfTaken[d]['12:00'] ? '12:30' : '12:00';
    }
    return null;
  }

  var best = { count: -1, score: Infinity, assign: null };
  var current = new Array(people.length);
  var nodes = 0;

  function dfs(i, count, score) {
    if (++nodes > 200000) return;                       // give up searching, keep the best found
    if (count + (people.length - i) < best.count) return;
    if (i === people.length) {
      if (count > best.count || (count === best.count && score < best.score)) {
        best = { count: count, score: score, assign: current.slice() };
      }
      return;
    }
    var p = people[i];
    var options = (p.slot ? p.dates.filter(function (d) { return d >= cutoff && used[d] !== undefined; }).sort() : []);
    for (var k = 0; k < options.length; k++) {
      var d = options[k];
      var start = slotFor(d, p.slot);
      if (!start) continue;
      used[d] += p.slot; halfTaken[d][start] = true;
      current[i] = { date: d, start: start };
      dfs(i + 1, count + 1, score + index[d]);
      used[d] -= p.slot; delete halfTaken[d][start];
    }
    current[i] = null;
    dfs(i + 1, count, score);
  }

  dfs(0, 0, 0);
  return best.assign || new Array(people.length).fill(null);
}

/**
 * Place people who are not yet on the schedule. Mutates nothing in `input`;
 * returns { schedule, newLedger, unplaced, placed }.
 */
function placeSignups(input) {
  var schedule = input.schedule.map(cloneRow);
  var ledger = input.ledger.map(function (l) { var c = {}; Object.keys(l).forEach(function (k) { c[k] = l[k]; }); return c; });
  var today = input.today;
  var lead = input.minLeadDays === undefined ? 7 : input.minLeadDays;
  var cutoff = addDays(today, lead);
  var people = dedupeSignups(input.signups).people;
  var placed = [], unplaced = [], newLedger = [], replaced = [];

  // 1. Who needs a slot: anyone not on the ledger, plus anyone who has sent a newer sign-up.
  var toPlace = [], movedFromOf = {};
  people.forEach(function (p, i) {
    var mine = ledgerRowsFor(p, ledger);
    if (mine.length) {
      if (!hasResubmitted(p, mine)) return;
      movedFromOf[i] = removePlacement(p, mine, schedule, ledger);
    } else if (isPlaced(p, ledger, schedule)) {
      return;
    }
    p._idx = i;
    toPlace.push(p);
  });

  // 2. Choose the assignment that places the most of them.
  var assignment = bestAssignment(toPlace, schedule, cutoff);

  // 3. Write it down, earliest date first so the 12:00 half is filled before 12:30.
  var order = toPlace.map(function (p, i) { return i; }).filter(function (i) { return assignment[i]; });
  order.sort(function (a, b) {
    var da = assignment[a], db = assignment[b];
    if (da.date !== db.date) return da.date < db.date ? -1 : 1;
    return da.start < db.start ? -1 : 1;
  });
  order.forEach(function (i) {
    var p = toPlace[i], a = assignment[i];
    var blank = schedule.filter(function (r) { return r.date === a.date && !hasPresenter(r); })[0];
    if (blank) {
      blank.presenter = p.name; blank.slot = p.slot; blank.start = a.start; blank.end = endFor(a.start, p.slot);
    } else {
      schedule.push({ date: a.date, term: termOf(a.date), start: a.start, end: endFor(a.start, p.slot),
        presenter: p.name, slot: p.slot, title: '', rsvps: '', notes: '' });
    }
    var l = { email: p.email, name: p.name, date: a.date, slot: p.slot, placedAt: today, source: 'auto', signupTs: p.latestTs };
    ledger.push(l); newLedger.push(l);
    var from = movedFromOf[p._idx];
    if (from) replaced.push({ name: p.name, email: p.email, from: from, to: a.date });
    else placed.push({ name: p.name, email: p.email, date: a.date, start: a.start, slot: p.slot });
  });

  // 4. Anyone left over.
  toPlace.forEach(function (p, i) {
    if (assignment[i]) return;
    var reason = !p.slot ? 'slot length missing'
      : (p.dates.filter(function (d) { return d >= cutoff && scheduleHasDate(schedule, d); }).length === 0
          ? 'no future dates ticked' : 'no capacity on ticked dates');
    unplaced.push(unplacedRow(p, reason));
    var from = movedFromOf[p._idx];
    if (from) replaced.push({ name: p.name, email: p.email, from: from, to: null });
  });

  return { schedule: sortSchedule(schedule), ledger: ledger, newLedger: newLedger, unplaced: unplaced, placed: placed, replaced: replaced };
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
    if (!scheduleHasDate(schedule, date)) return;   // date no longer on the schedule: nothing to attach it to
    var row = schedule.filter(function (r) { return r.date === date && hasPresenter(r) && namesMatch(r.presenter, t.presenter); })[0];
    if (!row) { unmatched.push({ date: t.date, presenter: t.presenter, title: t.title }); return; }
    var title = String(t.title || '').trim();
    if (title && title !== row.title) { row.title = title; updated.push({ date: date, presenter: row.presenter, title: title }); }
  });
  return { updated: updated, unmatched: unmatched };
}

/** Titles given on the sign-up form fill blank titles of that person's rows (the title form still wins). */
function applySignupTitles(schedule, signups) {
  var updated = [];
  dedupeSignups(signups).people.forEach(function (p) {
    var title = String(p.title || '').trim();
    if (!title) return;
    schedule.forEach(function (row) {
      if (hasPresenter(row) && !row.title && namesMatch(row.presenter, p.name)) {
        row.title = title;
        updated.push({ date: row.date, presenter: row.presenter, title: title });
      }
    });
  });
  return updated;
}

/** True when `email` is one this presenter signed up with (sign-up responses or ledger). */
function presenterEmailOk(email, presenter, signups, ledger) {
  var e = normaliseEmail(email);
  if (!e) return false;
  var known = {};
  (signups || []).forEach(function (s) { if (namesMatch(s.name, presenter) && normaliseEmail(s.email)) known[normaliseEmail(s.email)] = true; });
  (ledger || []).forEach(function (l) { if (namesMatch(l.name, presenter) && normaliseEmail(l.email)) known[normaliseEmail(l.email)] = true; });
  return !!known[e];
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
  var signupTitles = applySignupTitles(schedule, input.signups || []);
  var titleRes = applyTitles(schedule, input.titles || []);
  var rsvpChanged = applyRsvps(schedule, input.rsvps || []);
  var keep = choiceDatesToKeep(schedule, input.today, input.minLeadDays);
  var prevUnplacedKeys = {};
  (input.prevUnplaced || []).forEach(function (u) { prevUnplacedKeys[normaliseEmail(u.email) || normaliseName(u.name)] = true; });
  var newUnplaced = placedRes.unplaced.filter(function (u) { return !prevUnplacedKeys[normaliseEmail(u.email) || normaliseName(u.name)]; });
  return {
    schedule: schedule,
    ledger: placedRes.ledger,
    newLedger: placedRes.newLedger,
    unplaced: placedRes.unplaced,
    keepChoiceDates: keep,
    halfFullDates: halfFullDates(schedule, input.today, input.minLeadDays),
    changes: {
      placed: placedRes.placed,
      replaced: placedRes.replaced,
      newUnplaced: newUnplaced,
      titlesUpdated: signupTitles.concat(titleRes.updated),
      titlesUnmatched: titleRes.unmatched,
      rsvpChanged: rsvpChanged
    }
  };
}

// ---- emails -------------------------------------------------------------
var PAGE_URL = 'https://avivihadar.github.io/brownbag/';
var ROOM = 'Room 321, Drayton House';
var UNSUB_LINE = 'To stop receiving these, reply with "unsubscribe".';
/* A short note added to the end of the announcement. Set to '' when it is no longer needed. */
var ANNOUNCEMENT_PS = 'PS: please bring your own lunch. We are sorry we cannot provide it this year, ' +
  'but we hope to see you anyway.';

function firstName(full) {
  var n = String(full || '').trim().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  return n ? n.split(' ')[0] : '';
}

/** Monday of the week after `today` (today itself never counts). */
function nextMonday(today) {
  var p = today.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  var delta = (8 - d.getUTCDay()) % 7 || 7;
  return addDays(today, delta);
}

function talksOn(schedule, date) {
  return schedule.filter(function (r) { return r.date === date && hasPresenter(r); })
    .sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
}

function longDate(iso) {
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var p = iso.split('-').map(Number);
  return p[2] + ' ' + MONTHS_LONG[p[1] - 1];
}

/** A presenter counts as a student when their sign-up lists advisors other than NA. */
function isStudent(presenter, signups, known) {
  var role = roleOf(presenter, signups, known);
  if (role) return /student/i.test(role);
  var s = (signups || []).filter(function (x) { return namesMatch(x.name, presenter); })[0];
  if (!s) return false;
  var adv = String(s.advisors || '').trim();
  return !!adv && !/^n\.?\/?a\.?$/i.test(adv);
}

/** Affiliation for a presenter, from their sign-up or the `known` fallback. */
function affiliationOf(presenter, signups, known) {
  var s = (signups || []).filter(function (x) { return namesMatch(x.name, presenter) && x.affiliation; })[0];
  if (s) return String(s.affiliation).trim();
  var k = (known || {})[normaliseName(presenter)];
  return k && k.affiliation ? k.affiliation : '';
}

function roleOf(presenter, signups, known) {
  var s = (signups || []).filter(function (x) { return namesMatch(x.name, presenter) && x.role; })[0];
  if (s) return String(s.role).trim();
  var k = (known || {})[normaliseName(presenter)];
  return k && k.role ? k.role : '';
}

/** "Hao Hu (UCL)" when the affiliation is known, otherwise just the name. */
function nameWithAffiliation(presenter, signups, known) {
  var a = affiliationOf(presenter, signups, known);
  return a ? presenter + ' (' + a + ')' : presenter;
}

function emailOf(presenter, signups, ledger) {
  var s = (signups || []).filter(function (x) { return namesMatch(x.name, presenter) && x.email; })[0];
  if (s) return normaliseEmail(s.email);
  var l = (ledger || []).filter(function (x) { return namesMatch(x.name, presenter) && x.email; })[0];
  return l ? normaliseEmail(l.email) : '';
}

function timeRange(talks) {
  if (talks.length === 1 && talks[0].slot === 30) return talks[0].start + ' to ' + talks[0].end;
  return '12:00 to 13:00';
}

/** Reminder to each presenter of `date`. One message per presenter. */
function presenterReminders(input, date) {
  var talks = talksOn(input.schedule, date);
  return talks.map(function (t) {
    var to = emailOf(t.presenter, input.signups, input.ledger);
    var lines = ['Dear ' + firstName(t.presenter) + ',', ''];
    lines.push('A reminder that you are presenting at the Applied Micro Brown Bag next Monday, ' +
      longDate(date) + ', ' + t.start + ' to ' + t.end + ', ' + ROOM + '.');
    lines.push('Schedule: ' + PAGE_URL, '');
    if (!t.title) {
      lines.push('We do not have a title for your talk yet. Please add it today so it can go into ' +
        'Thursday’s announcement: open the schedule page, click "Add title" under your name, ' +
        'enter the email address you used on the sign-up form, and type the title.', '');
    }
    if (isStudent(t.presenter, input.signups, input.known)) {
      lines.push('Feel free to invite faculty and visitors to your talk.', '');
    }
    lines.push('See you on Monday,', 'Hadar and Gabriel');
    return { kind: 'presenter', to: to ? [to] : [], presenter: t.presenter, date: date,
      subject: 'Your brown bag talk on ' + labelForIso(date), body: lines.join('\n') };
  }).filter(function (m) { return m.to.length; });
}

/** Thursday announcement. Returns null when the coming Monday has no presenter. */
function weeklyAnnouncement(input, date) {
  var talks = talksOn(input.schedule, date);
  if (!talks.length) return null;
  var lines = ['Dear all,', ''];
  lines.push('Next Monday at the Applied Micro Brown Bag, ' + longDate(date) + ', ' +
    timeRange(talks) + ', ' + ROOM + ':', '');
  talks.forEach(function (t) {
    lines.push('  ' + nameWithAffiliation(t.presenter, input.signups, input.known) +
      (talks.length > 1 ? '  (' + t.start + '–' + t.end + ')' : ''));
    lines.push('  ' + (t.title || 'Title to be announced'), '');
  });
  var open = choiceDatesToKeep(input.schedule, input.today, input.minLeadDays);
  if (open.length) {
    lines.push('There are still open slots this year. To present, sign up here:');
    lines.push(input.signupUrl, '');
  }
  lines.push('Full schedule: ' + PAGE_URL, '');
  lines.push('Best wishes,', 'Hadar and Gabriel');
  if (ANNOUNCEMENT_PS) lines.push('', ANNOUNCEMENT_PS);
  lines.push('', UNSUB_LINE);
  var subject = 'Brown bag on Monday ' + labelForIso(date).replace(/^Mon /, '') + ': ' +
    talks.map(function (t) { return nameWithAffiliation(t.presenter, input.signups, input.known); }).join(' and ');
  return { kind: 'announcement', to: [], bcc: mailingListAddresses(input.mailingList), date: date,
    subject: subject, body: lines.join('\n') };
}

function mailingListAddresses(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (m) {
    var e = normaliseEmail(m.email);
    if (!e || m.unsubscribed) return;
    if (seen[e]) return;
    seen[e] = true; out.push(e);
  });
  return out;
}

/** Friday lunch count to the organisers. Returns null when nobody presents. */
function rsvpReport(input, date) {
  var talks = talksOn(input.schedule, date);
  if (!talks.length) return null;
  var people = [];
  var seen = {};
  (input.rsvps || []).forEach(function (r) {
    if (parseChoiceLabel(r.date) !== date) return;
    var key = normaliseName(r.name) || String(r.ts);
    if (seen[key]) return;
    seen[key] = true;
    people.push({ name: String(r.name || '').trim(), dietary: String(r.dietary || '').trim() });
  });
  people.sort(function (a, b) { return normaliseName(a.name) < normaliseName(b.name) ? -1 : 1; });
  var lines = ['Presenter: ' + talks.map(function (t) { return nameWithAffiliation(t.presenter, input.signups, input.known); }).join(', ')];
  lines.push('RSVPs received: ' + people.length, '');
  people.forEach(function (p) { lines.push('  ' + p.name + (p.dietary ? '   [' + p.dietary + ']' : '')); });
  if (!people.length) lines.push('  (nobody has signed up yet)');
  lines.push('');
  var open = choiceDatesToKeep(input.schedule, input.today, input.minLeadDays);
  if (open.length) {
    lines.push('Sign-up form still open for: ' + open.map(function (d) {
      var used = usedMinutes(input.schedule, d);
      return labelForIso(d) + (used === 30 ? ' (30 min)' : '');
    }).join(', '));
  }
  return { kind: 'rsvpReport', to: [], date: date,
    subject: 'Lunch count for Monday ' + labelForIso(date).replace(/^Mon /, '') + ': ' + people.length + ' ' + (people.length === 1 ? 'person' : 'people'),
    body: lines.join('\n') };
}

/**
 * Messages due today. `weekday`: 0=Sun..6=Sat, derived from input.today.
 * Monday -> presenter reminders; Thursday -> announcement; Friday -> lunch count.
 */
function emailsFor(input) {
  var p = input.today.split('-').map(Number);
  var weekday = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  var target = nextMonday(input.today);
  if (weekday === 1) return presenterReminders(input, target);
  if (weekday === 4) { var a = weeklyAnnouncement(input, target); return a ? [a] : []; }
  return [];   // no Friday lunch count: lunch is not provided
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseChoiceLabel: parseChoiceLabel, labelForIso: labelForIso, addDays: addDays, termOf: termOf,
    normaliseName: normaliseName, namesMatch: namesMatch, normaliseEmail: normaliseEmail, parseSlot: parseSlot,
    dedupeSignups: dedupeSignups, usedMinutes: usedMinutes, freeStart: freeStart, isPlaced: isPlaced,
    bestAssignment: bestAssignment,
    placeSignups: placeSignups, choiceDatesToKeep: choiceDatesToKeep, halfFullDates: halfFullDates,
    applyTitles: applyTitles, applySignupTitles: applySignupTitles, presenterEmailOk: presenterEmailOk,
    firstName: firstName, nextMonday: nextMonday, isStudent: isStudent, emailOf: emailOf, longDate: longDate,
    affiliationOf: affiliationOf, roleOf: roleOf, nameWithAffiliation: nameWithAffiliation,
    presenterReminders: presenterReminders, weeklyAnnouncement: weeklyAnnouncement, rsvpReport: rsvpReport,
    mailingListAddresses: mailingListAddresses, emailsFor: emailsFor, applyRsvps: applyRsvps, sortSchedule: sortSchedule, run: run
  };
}
