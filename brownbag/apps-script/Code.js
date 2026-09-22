/**
 * Applied Micro Brown Bag: Google glue around scheduler.js.
 *
 * This script is bound to the PUBLIC "Schedule" spreadsheet. It reads the
 * PRIVATE spreadsheet (sign-up responses, RSVP and title responses, ledger)
 * by id, so nothing with an email address ever sits in the published file.
 *
 * Functions Hadar runs from the editor:
 *   setup()          once, after pasting the code
 *   dryRun()         shows what dailyJob would do, writes nothing
 *   dailyJob()       the daily job (also installed as a 12:00 trigger)
 *   listTriggers()   shows the installed trigger
 */

// ---- fixed ids -----------------------------------------------------------
var SIGNUP_FORM_ID = '1n6CPnkBOPCMrWJ7WRAovjcy3FkdxwJ2JpYlAqaemMAM';
var PRIVATE_SHEET_ID = '1Q5JzJnDdLg5wwlLByaMv5FYDdSHgZpWzUOioJGJ0BB0';
var SIGNUP_TAB = 'Form Responses 1';
var MIN_LEAD_DAYS = 7;
var FIRST_SEMINAR_DATE = '2026-10-05';   // earlier Mondays are dropped from the schedule
var TZ = 'Europe/London';

var TAB = { schedule: 'Schedule', config: 'Config', ledger: 'Placements', unplaced: 'Unplaced', log: 'Log', rsvp: 'RSVP Responses', title: 'Title Responses' };
var SCHEDULE_HEADER = ['date', 'term', 'start', 'end', 'presenter', 'slot_min', 'title', 'rsvps', 'notes'];
var LEDGER_HEADER = ['email', 'name', 'date', 'slot_min', 'placed_at', 'source', 'signup_ts'];
var UNPLACED_HEADER = ['email', 'name', 'slot_min', 'dates_ticked', 'reason', 'first_seen'];
var LOG_HEADER = ['run_at', 'mode', 'placed', 'new_unplaced', 'titles_updated', 'dates_removed', 'summary_or_error'];

// ---- one-time setup -------------------------------------------------------
function setup() {
  var props = PropertiesService.getScriptProperties();
  var pub = SpreadsheetApp.getActive();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var existingConfig = readConfig(pub);
  if (props.getProperty('SETUP_DONE') || existingConfig.setup_at) {
    console.log('setup already ran on ' + (existingConfig.setup_at || props.getProperty('SETUP_DONE')) + '. Re-running safely: forms are reused, nothing is duplicated.');
  }
  removeEmptyFormTabs(priv);

  // 1. Schedule tab: rename the seeded sheet, fix header, plain-text formats.
  var sched = pub.getSheetByName(TAB.schedule) || pub.getSheets()[0].setName(TAB.schedule);
  var rows = readSchedule(sched);              // read first: the CSV import may hold real date/time cells
  sched.getRange(1, 1, 1, SCHEDULE_HEADER.length).setValues([SCHEDULE_HEADER]).setFontWeight('bold');
  sched.setFrozenRows(1);
  ['A:A', 'C:D', 'F:F', 'H:H'].forEach(function (r) { sched.getRange(r).setNumberFormat('@'); });
  writeSchedule(sched, sortSchedule(rows));    // write back as plain text
  sched.autoResizeColumns(1, SCHEDULE_HEADER.length);

  // 2. Private tabs.
  var ledger = getOrCreateTab(priv, TAB.ledger, LEDGER_HEADER);
  getOrCreateTab(priv, TAB.unplaced, UNPLACED_HEADER);
  getOrCreateTab(priv, TAB.log, LOG_HEADER);

  // 3. Seed the ledger from whoever is already on the schedule.
  var signups = readSignups(priv);
  var existing = ledger.getLastRow() > 1 ? ledger.getRange(2, 1, ledger.getLastRow() - 1, LEDGER_HEADER.length).getValues() : [];
  var seeded = [];
  var unresolved = [];
  rows.forEach(function (r) {
    if (!r.presenter) return;
    if (existing.some(function (e) { return namesMatch(e[1], r.presenter); }) || seeded.some(function (e) { return namesMatch(e[1], r.presenter); })) return;
    var match = signups.filter(function (s) { return namesMatch(s.name, r.presenter); })[0];
    if (!match) unresolved.push(r.presenter);
    seeded.push([match ? match.email : '', r.presenter, r.date, r.slot, todayIso(), 'seed']);
  });
  if (seeded.length) ledger.getRange(ledger.getLastRow() + 1, 1, seeded.length, LEDGER_HEADER.length).setValues(seeded);

  // 4. RSVP and Title forms, responses into the private spreadsheet (reused if they already exist).
  var rsvp = existingForm(existingConfig, 'rsvp', TAB.rsvp) || createForm(priv, 'Applied Micro Brown Bag: RSVP',
    'Let us know you are coming so we order enough lunch. Mondays 12-1pm, Room 321, Drayton House.',
    TAB.rsvp, [
      { type: 'text', title: 'Seminar date', required: true },
      { type: 'text', title: 'Presenter', required: true },
      { type: 'text', title: 'Your name', required: true },
      { type: 'text', title: 'Dietary requirements (optional)', required: false }
    ], 'Thanks, see you on Monday.');
  var title = existingForm(existingConfig, 'title', TAB.title) || createForm(priv, 'Applied Micro Brown Bag: talk title',
    'Presenters: add the title of your talk so it appears on the schedule. You can resubmit to change it.',
    TAB.title, [
      { type: 'text', title: 'Seminar date', required: true },
      { type: 'text', title: 'Presenter', required: true },
      { type: 'text', title: 'Paper title', required: true },
      { type: 'text', title: 'Co-authors (optional)', required: false },
      { type: 'paragraph', title: 'Abstract or link (optional)', required: false }
    ], 'Thanks, the schedule updates once a day at noon.');

  // 5. Optional title question on the sign-up form (responses land in a new column automatically).
  var signupForm = FormApp.openById(SIGNUP_FORM_ID);
  ensureSignupTitleQuestion(signupForm);

  // 6. Config tab in the public file (nothing sensitive).
  var config = [
    ['key', 'value'],
    ['signup_form_id', SIGNUP_FORM_ID],
    ['signup_form_url', signupForm.getPublishedUrl()],
    ['private_sheet_id', PRIVATE_SHEET_ID],
    ['rsvp_form_id', rsvp.id],
    ['rsvp_form_url', rsvp.url],
    ['rsvp_entry_date', rsvp.entries['Seminar date']],
    ['rsvp_entry_presenter', rsvp.entries['Presenter']],
    ['title_form_id', title.id],
    ['title_form_url', title.url],
    ['title_entry_date', title.entries['Seminar date']],
    ['title_entry_presenter', title.entries['Presenter']],
    ['min_lead_days', MIN_LEAD_DAYS],
    ['setup_at', new Date().toISOString()]
  ];
  var cfg = getOrCreateTab(pub, TAB.config, ['key', 'value']);
  cfg.clearContents();
  cfg.getRange(1, 1, config.length, 2).setValues(config);
  cfg.getRange('A:B').setNumberFormat('@');

  // 7. Daily trigger at 12:00 London.
  installTrigger();

  props.setProperties({ RSVP_FORM_ID: rsvp.id, TITLE_FORM_ID: title.id, SETUP_DONE: new Date().toISOString() });
  console.log('setup complete. Ledger seeded: ' + seeded.length + '. Names without a sign-up email (fine for faculty): ' + unresolved.join(', '));
  console.log('RSVP prefilled example: ' + rsvp.example);
  console.log('Title prefilled example: ' + title.example);
}

var SIGNUP_TITLE_QUESTION = 'Title of your talk (leave blank if you do not have one yet)';

function readConfig(pub) {
  var sh = pub.getSheetByName(TAB.config);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = String(r[1]); });
  return out;
}

/** Reuse a form recorded in Config if it still exists. */
function existingForm(cfg, prefix, tabName) {
  var id = cfg[prefix + '_form_id'];
  if (!id) return null;
  try { FormApp.openById(id); } catch (e) { return null; }
  var entries = {};
  entries['Seminar date'] = cfg[prefix + '_entry_date'];
  entries['Presenter'] = cfg[prefix + '_entry_presenter'];
  var base = cfg[prefix + '_form_url'];
  return { id: id, url: base, entries: entries, example: base + '?usp=pp_url&entry.' + entries['Seminar date'] + '=Mon+5+Oct+2026&entry.' + entries['Presenter'] + '=Test+Presenter' };
}

/** Delete empty "Form Responses N" tabs left behind by duplicate forms (never the sign-up tab). */
function removeEmptyFormTabs(priv) {
  priv.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === SIGNUP_TAB || name === TAB.rsvp || name === TAB.title) return;
    if (/^Form Responses \d+$/.test(name) && sh.getLastRow() <= 1) {
      try { priv.deleteSheet(sh); console.log('removed empty tab ' + name); }
      catch (e) { sh.hideSheet(); console.log('hid empty tab ' + name + ' (still linked to a binned form)'); }
    }
  });
}

function ensureSignupTitleQuestion(form) {
  var exists = form.getItems().some(function (i) { return i.getTitle().indexOf('Title of your talk') === 0; });
  if (exists) return;
  var item = form.addTextItem().setTitle(SIGNUP_TITLE_QUESTION).setRequired(false)
    .setHelpText('You can add or change it later through the link next to your name on the schedule page.');
  var slotIdx = form.getItems().map(function (i) { return i.getTitle(); }).findIndex(function (t) { return t.indexOf('How long') === 0; });
  if (slotIdx >= 0) form.moveItem(item.getIndex(), slotIdx + 1);
}

function createForm(priv, name, description, tabName, items, confirmation) {
  var f = FormApp.create(name);
  f.setDescription(description).setCollectEmail(false).setConfirmationMessage(confirmation).setAllowResponseEdits(false);
  var made = {};
  items.forEach(function (it) {
    var item = it.type === 'paragraph' ? f.addParagraphTextItem() : f.addTextItem();
    item.setTitle(it.title).setRequired(!!it.required);
    made[it.title] = item;
  });
  var before = priv.getSheets().map(function (s) { return s.getSheetId(); });
  f.setDestination(FormApp.DestinationType.SPREADSHEET, priv.getId());
  SpreadsheetApp.flush();
  var fresh = SpreadsheetApp.openById(priv.getId());
  var newSheet = fresh.getSheets().filter(function (s) { return before.indexOf(s.getSheetId()) < 0; })[0];
  if (newSheet) newSheet.setName(tabName);
  // Prefill entry ids: build a prefilled URL with sentinel values and read the ids back.
  var resp = f.createResponse()
    .withItemResponse(made['Seminar date'].createResponse('DATE_SENTINEL'))
    .withItemResponse(made['Presenter'].createResponse('PRESENTER_SENTINEL'));
  var url = resp.toPrefilledUrl();
  var entries = {};
  var re = /entry\.(\d+)=([^&]*)/g, m;
  while ((m = re.exec(url)) !== null) {
    var v = decodeURIComponent(m[2].replace(/\+/g, ' '));
    if (v === 'DATE_SENTINEL') entries['Seminar date'] = m[1];
    if (v === 'PRESENTER_SENTINEL') entries['Presenter'] = m[1];
  }
  var base = f.getPublishedUrl().split('?')[0];
  return { id: f.getId(), url: base, entries: entries, example: base + '?usp=pp_url&entry.' + entries['Seminar date'] + '=Mon+5+Oct+2026&entry.' + entries['Presenter'] + '=Test+Presenter' };
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(12).everyDays(1).inTimezone(TZ).create();
}

function listTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { console.log(t.getHandlerFunction() + ' ' + t.getEventType()); });
}

/** Rewrites the Schedule tab with repaired times; no placements, no email. */
function repairTimes() {
  var sched = SpreadsheetApp.getActive().getSheetByName(TAB.schedule);
  writeSchedule(sched, sortSchedule(readSchedule(sched)));
  console.log('times repaired');
}

// ---- daily job ------------------------------------------------------------
function dailyJob() { runJob(false); }
function dryRun() { runJob(true); }
function runNow() { runJob(false); }

function runJob(dry) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.log('another run is in progress'); return null; }
  var pub = SpreadsheetApp.getActive();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sched = pub.getSheetByName(TAB.schedule);
  var today = todayIso();
  var result;
  try {
    var input = {
      schedule: readSchedule(sched).filter(function (r) { return r.date >= FIRST_SEMINAR_DATE; }),
      ledger: readLedger(priv),
      signups: readSignups(priv),
      titles: readTitleResponses(priv),
      rsvps: readRsvpResponses(priv),
      prevUnplaced: readUnplaced(priv),
      today: today,
      minLeadDays: MIN_LEAD_DAYS
    };
    result = run(input);
    var removed = [];
    if (dry) {
      console.log('DRY RUN ' + JSON.stringify(result.changes));
      console.log('dates that would stay on the form: ' + result.keepChoiceDates.join(', '));
      console.log('unplaced: ' + JSON.stringify(result.unplaced));
      return result.changes;
    }
    writeSchedule(sched, result.schedule);
    writeLedger(priv, result.ledger);
    writeUnplaced(priv, result.unplaced);
    removed = pruneSignupChoices(result.keepChoiceDates, result.halfFullDates);
    var c = result.changes;
    var changed = c.placed.length || c.replaced.length || c.newUnplaced.length || c.titlesUpdated.length || c.titlesUnmatched.length || removed.length;
    appendLog(priv, [new Date(), 'daily', c.placed.length, c.newUnplaced.length, c.titlesUpdated.length, removed.join(' '), changed ? summaryText(c, removed, result.unplaced) : '']);
    console.log(JSON.stringify(c));
    return c;
  } catch (e) {
    console.error(e);
    if (!dry) appendLog(priv, [new Date(), 'daily', '', '', '', '', String(e && e.message || e)]);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function summaryText(c, removed, unplaced) {
  var lines = ['Applied Micro Brown Bag: daily update', ''];
  if (c.placed.length) {
    lines.push('Newly scheduled:');
    c.placed.forEach(function (p) { lines.push('  ' + labelForIso(p.date) + ' ' + p.start + '  ' + p.name + ' (' + p.slot + ' min)'); });
    lines.push('');
  }
  if (c.replaced.length) {
    lines.push('Re-submitted sign-ups (old slot released):');
    c.replaced.forEach(function (r) { lines.push('  ' + r.name + ': ' + r.from.map(labelForIso).join(', ') + ' -> ' + (r.to ? labelForIso(r.to) : 'could not be placed')); });
    lines.push('');
  }
  if (c.newUnplaced.length) {
    lines.push('Could not be placed (see the Unplaced tab):');
    c.newUnplaced.forEach(function (u) { lines.push('  ' + u.name + ' <' + u.email + '> ' + u.slot + ' min: ' + u.reason); });
    lines.push('');
  }
  if (c.titlesUpdated.length) {
    lines.push('Titles added or changed:');
    c.titlesUpdated.forEach(function (t) { lines.push('  ' + labelForIso(t.date) + ' ' + t.presenter + ': ' + t.title); });
    lines.push('');
  }
  if (c.titlesUnmatched.length) {
    lines.push('Title submissions that did not match a scheduled talk (fix in Title Responses):');
    c.titlesUnmatched.forEach(function (t) { lines.push('  ' + t.date + ' ' + t.presenter + ': ' + t.title); });
    lines.push('');
  }
  if (removed.length) lines.push('Dates removed from the sign-up form: ' + removed.join(', '), '');
  lines.push('Still unplaced in total: ' + unplaced.length);
  return lines.join('\n');
}

// ---- readers --------------------------------------------------------------
function todayIso() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/* Date/time cells are formatted in the spreadsheet's own time zone, so a cell showing 12:00
 * reads as 12:00 whatever the file's clock is set to. */
var CELL_TZ = null;
function tzOf(ss) { return ss.getSpreadsheetTimeZone() || TZ; }
function cellDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CELL_TZ || TZ, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return parseChoiceLabel(s) || s;
}
function cellTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CELL_TZ || TZ, 'HH:mm');
  var m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2] : String(v || '');
}

/* Repair rows whose times are not seminar times (e.g. after a time-zone mix-up):
 * within each date, keep the existing order and reassign 12:00 / 12:30 slots. */
function sanitizeTimes(rows) {
  var byDate = {};
  rows.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
  Object.keys(byDate).forEach(function (d) {
    var group = byDate[d];
    var ok = group.every(function (r) { return (r.start === '12:00' || r.start === '12:30') && (r.end === '12:30' || r.end === '13:00'); });
    if (ok) return;
    group.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
    var t = '12:00';
    group.forEach(function (r) {
      r.start = t;
      r.end = (r.slot === 30) ? (t === '12:00' ? '12:30' : '13:00') : '13:00';
      t = '12:30';
    });
  });
  return rows;
}
function cellStr(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function readSchedule(sheet) {
  if (sheet.getLastRow() < 2) return [];
  CELL_TZ = tzOf(sheet.getParent());
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SCHEDULE_HEADER.length).getValues();
  return sanitizeTimes(values.filter(function (r) { return cellStr(r[0]); }).map(function (r) {
    var presenter = cellStr(r[4]);
    if (/^(\(open\)|tbd|tba)$/i.test(presenter)) presenter = '';
    return { date: cellDate(r[0]), term: cellStr(r[1]), start: cellTime(r[2]) || '12:00', end: cellTime(r[3]) || '13:00',
      presenter: presenter, slot: parseSlot(r[5]), title: cellStr(r[6]), rsvps: cellStr(r[7]) === '' ? '' : Number(r[7]), notes: cellStr(r[8]) };
  }));
}

function headerIndex(headers, prefix) {
  for (var i = 0; i < headers.length; i++) if (String(headers[i]).toLowerCase().indexOf(prefix.toLowerCase()) === 0) return i;
  return -1;
}

function readSignups(priv) {
  var sh = priv.getSheetByName(SIGNUP_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iTs = headerIndex(h, 'Timestamp'), iName = headerIndex(h, 'Full name'), iEmail = headerIndex(h, 'Email'),
      iDates = headerIndex(h, 'Which Mondays'), iSlot = headerIndex(h, 'How long'), iAdv = headerIndex(h, 'If you are a PhD'), iDiet = headerIndex(h, 'Do you have any dietary'),
      iTitle = headerIndex(h, 'Title of your talk');
  return data.slice(1).filter(function (r) { return cellStr(r[iName]) || cellStr(r[iEmail]); }).map(function (r) {
    var dates = cellStr(r[iDates]).split(/,\s*/).map(parseChoiceLabel).filter(Boolean);
    return { ts: r[iTs] instanceof Date ? r[iTs].getTime() : Date.parse(r[iTs]) || 0, name: cellStr(r[iName]), email: normaliseEmail(r[iEmail]),
      dates: dates, slot: parseSlot(r[iSlot]), title: iTitle >= 0 ? cellStr(r[iTitle]) : '',
      advisors: iAdv >= 0 ? cellStr(r[iAdv]) : '', dietary: iDiet >= 0 ? cellStr(r[iDiet]) : '' };
  });
}

function readLedger(priv) {
  var sh = priv.getSheetByName(TAB.ledger);
  if (!sh || sh.getLastRow() < 2) return [];
  CELL_TZ = tzOf(priv);
  return sh.getRange(2, 1, sh.getLastRow() - 1, LEDGER_HEADER.length).getValues().filter(function (r) { return cellStr(r[0]) || cellStr(r[1]); })
    .map(function (r) { return { email: normaliseEmail(r[0]), name: cellStr(r[1]), date: cellDate(r[2]), slot: parseSlot(r[3]), placedAt: cellDate(r[4]), source: cellStr(r[5]), signupTs: r[6] ? Number(r[6]) : 0 }; });
}

function readUnplaced(priv) {
  var sh = priv.getSheetByName(TAB.unplaced);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, UNPLACED_HEADER.length).getValues().map(function (r) { return { email: normaliseEmail(r[0]), name: cellStr(r[1]) }; });
}

function readFormTab(priv, tabName, fields) {
  var sh = priv.getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var idx = {};
  Object.keys(fields).forEach(function (k) { idx[k] = headerIndex(h, fields[k]); });
  var iTs = headerIndex(h, 'Timestamp');
  return data.slice(1).map(function (r) {
    var o = { ts: r[iTs] instanceof Date ? r[iTs].getTime() : 0 };
    Object.keys(idx).forEach(function (k) { o[k] = idx[k] >= 0 ? cellStr(r[idx[k]]) : ''; });
    return o;
  });
}
function readTitleResponses(priv) { return readFormTab(priv, TAB.title, { date: 'Seminar date', presenter: 'Presenter', title: 'Paper title' }); }
function readRsvpResponses(priv) { return readFormTab(priv, TAB.rsvp, { date: 'Seminar date', presenter: 'Presenter', name: 'Your name' }); }

// ---- writers --------------------------------------------------------------
function writeSchedule(sheet, rows) {
  var n = Math.max(sheet.getLastRow() - 1, 0);
  if (n > 0) sheet.getRange(2, 1, n, SCHEDULE_HEADER.length).clearContent();
  if (!rows.length) return;
  var values = rows.map(function (r) { return [r.date, r.term, r.start, r.end, r.presenter, r.slot || '', r.title, r.rsvps === undefined ? '' : r.rsvps, r.notes]; });
  sheet.getRange(2, 1, values.length, SCHEDULE_HEADER.length).setValues(values);
}

function writeLedger(priv, rows) {
  var sh = getOrCreateTab(priv, TAB.ledger, LEDGER_HEADER);
  sh.getRange(1, 1, 1, LEDGER_HEADER.length).setValues([LEDGER_HEADER]).setFontWeight('bold');
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n > 0) sh.getRange(2, 1, n, LEDGER_HEADER.length).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, LEDGER_HEADER.length).setValues(rows.map(function (l) { return [l.email, l.name, l.date, l.slot, l.placedAt, l.source, l.signupTs || '']; }));
}

function writeUnplaced(priv, rows) {
  var sh = getOrCreateTab(priv, TAB.unplaced, UNPLACED_HEADER);
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n > 0) sh.getRange(2, 1, n, UNPLACED_HEADER.length).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, UNPLACED_HEADER.length).setValues(rows.map(function (u) {
    return [u.email, u.name, u.slot || '', u.dates.join(', '), u.reason, u.firstSeen ? new Date(u.firstSeen) : ''];
  }));
}

function appendLog(priv, row) {
  var sh = getOrCreateTab(priv, TAB.log, LOG_HEADER);
  sh.appendRow(row);
}

function getOrCreateTab(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---- sign-up form pruning -------------------------------------------------
function pruneSignupChoices(keepDates, halfFull) {
  var form = FormApp.openById(SIGNUP_FORM_ID);
  var items = form.getItems(FormApp.ItemType.CHECKBOX).filter(function (i) { return i.getTitle().indexOf('Which Mondays') === 0; });
  if (!items.length) throw new Error('Sign-up form: checkbox question starting "Which Mondays" not found');
  var item = items[0].asCheckboxItem();
  var current = item.getChoices().map(function (c) { return c.getValue(); });
  var keep = current.filter(function (label) { return keepDates.indexOf(parseChoiceLabel(label)) >= 0; });
  var removed = current.filter(function (label) { return keep.indexOf(label) < 0; }).map(function (l) { return parseChoiceLabel(l) || l; });
  if (keep.length === 0) {
    if (form.isAcceptingResponses()) {
      form.setAcceptingResponses(false);
      form.setCustomClosedMessage('All slots for this year are taken. Email the organisers if you would like to present.');
    }
    return removed;
  }
  if (keep.length !== current.length) item.setChoiceValues(keep);
  if (!form.isAcceptingResponses()) form.setAcceptingResponses(true);
  var help = halfFull.length ? 'These dates have one 30-minute slot left: ' + halfFull.map(labelForIso).join(', ') + '.' : '';
  if (item.getHelpText() !== help) item.setHelpText(help);
  return removed;
}

// ---- web app: the page reads the schedule here and presenters submit titles here ----
var PUBLIC_COLUMNS = ['date', 'term', 'start', 'end', 'presenter', 'slot', 'title'];

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function publicSchedule() {
  var sched = SpreadsheetApp.getActive().getSheetByName(TAB.schedule);
  return sortSchedule(readSchedule(sched)).filter(function (r) { return r.date >= FIRST_SEMINAR_DATE; }).map(function (r) {
    var o = {};
    PUBLIC_COLUMNS.forEach(function (k) { o[k] = r[k] === undefined || r[k] === null ? '' : r[k]; });
    return o;
  });
}

/**
 * GET ?action=schedule -> { ok, generatedAt, rows: [...] }
 * GET ?action=run      -> runs the daily job now (same as the noon trigger), at most once every 10 minutes
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'schedule';
  if (action === 'schedule') return jsonOut({ ok: true, generatedAt: new Date().toISOString(), rows: publicSchedule() });
  if (action === 'run') {
    var cache = CacheService.getScriptCache();
    if (cache.get('lastManualRun')) return jsonOut({ ok: false, error: 'the job ran in the last 10 minutes; try again later' });
    cache.put('lastManualRun', String(Date.now()), 600);
    var changes = runJob(false);
    if (!changes) return jsonOut({ ok: false, error: 'another run is in progress' });
    return jsonOut({ ok: true, placed: changes.placed.length, replaced: changes.replaced.length, unplaced: changes.newUnplaced.length, titles: changes.titlesUpdated.length });
  }
  return jsonOut({ ok: false, error: 'unknown action' });
}

/**
 * POST body (JSON, sent as text/plain to avoid a CORS preflight):
 *   { action: 'title', date: 'yyyy-mm-dd', presenter: 'Name', email: 'sign-up email', title: '...', coauthors: '...', test: false }
 * The email must be one the presenter signed up with. Writes the title into the Schedule tab
 * immediately and records the submission in Title Responses.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData && e.postData.contents || '{}'); } catch (err) { return jsonOut({ ok: false, error: 'bad JSON' }); }
  if (body.action !== 'title') return jsonOut({ ok: false, error: 'unknown action' });
  var date = parseChoiceLabel(body.date);
  var presenter = cellStr(body.presenter);
  var email = cellStr(body.email).slice(0, 200);
  var title = cellStr(body.title).slice(0, 300);
  var coauthors = cellStr(body.coauthors).slice(0, 300);
  if (!date || !presenter) return jsonOut({ ok: false, error: 'date and presenter are required' });
  if (!title) return jsonOut({ ok: false, error: 'please enter a title' });
  if (!email) return jsonOut({ ok: false, error: 'please enter the email you used to sign up' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return jsonOut({ ok: false, error: 'busy, please try again' });
  try {
    var pub = SpreadsheetApp.getActive();
    var sched = pub.getSheetByName(TAB.schedule);
    var rows = sortSchedule(readSchedule(sched));
    var row = rows.filter(function (r) { return r.date === date && hasPresenter(r) && namesMatch(r.presenter, presenter); })[0];
    if (!row) return jsonOut({ ok: false, error: 'no talk found for ' + presenter + ' on ' + labelForIso(date) });
    var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
    if (!presenterEmailOk(email, row.presenter, readSignups(priv), readLedger(priv))) {
      return jsonOut({ ok: false, error: 'that email does not match the one used to sign up' });
    }
    if (body.test) return jsonOut({ ok: true, test: true, date: date, presenter: row.presenter, title: title });
    row.title = title;
    writeSchedule(sched, rows);
    var tab = getOrCreateTab(priv, TAB.title, ['Timestamp', 'Seminar date', 'Presenter', 'Paper title', 'Co-authors (optional)', 'Abstract or link (optional)']);
    tab.appendRow([new Date(), labelForIso(date), row.presenter, title, coauthors, 'via website']);
    return jsonOut({ ok: true, date: date, presenter: row.presenter, title: title });
  } catch (err) {
    console.error(err);
    return jsonOut({ ok: false, error: 'server error' });
  } finally {
    lock.releaseLock();
  }
}
