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
var MIN_LEAD_DAYS = 3;   // a date leaves the sign-up form this many days before it happens
var FIRST_SEMINAR_DATE = '2026-09-28';   // earlier Mondays are dropped from the schedule

/* Every Monday the seminar can run. Add or remove dates here: the daily job creates a row for any
 * future date that is missing from the Schedule tab, and the sign-up form follows the schedule. */
var SEMINAR_DATES = [
  '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-16', '2026-11-23',
  '2026-11-30', '2026-12-07', '2026-12-14',
  '2027-02-22',
  '2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22',
  '2027-04-26', '2027-05-10', '2027-05-17', '2027-05-24', '2027-06-07'
];

/** Keeps the schedule in step with SEMINAR_DATES: adds missing future dates, drops empty ones that
 *  are no longer listed. A date with a presenter is never removed automatically. */
function ensureDates(schedule, today) {
  for (var i = schedule.length - 1; i >= 0; i--) {
    var r = schedule[i];
    if (r.date >= today && !r.presenter && SEMINAR_DATES.indexOf(r.date) < 0) schedule.splice(i, 1);
  }
  SEMINAR_DATES.forEach(function (d) {
    if (d < today) return;
    if (schedule.some(function (r) { return r.date === d; })) return;
    schedule.push({ date: d, term: termOf(d), start: '12:00', end: '13:00', presenter: '', slot: null, title: '', rsvps: '', notes: '' });
  });
  return sortSchedule(schedule);
}
var TZ = 'Europe/London';

var TAB = { schedule: 'Schedule', config: 'Config', ledger: 'Placements', unplaced: 'Unplaced', log: 'Log', rsvp: 'RSVP Responses', title: 'Title Responses', mailing: 'Mailing list' };
var ORGANISERS = ['avivihadar@gmail.com', 'g.ulyssea@ucl.ac.uk'];
var SCHEDULE_HEADER = ['date', 'term', 'start', 'end', 'presenter', 'slot_min', 'title', 'rsvps', 'notes'];
var LEDGER_HEADER = ['email', 'name', 'date', 'slot_min', 'placed_at', 'source', 'signup_ts'];
var UNPLACED_HEADER = ['email', 'name', 'slot_min', 'dates_ticked', 'reason', 'first_seen'];
var LOG_HEADER = ['run_at', 'mode', 'placed_or_kind', 'unplaced_or_to', 'titles_or_subject', 'dates_removed', 'summary_or_error'];

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
  ensureSignupProfileQuestions(signupForm);

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
var SIGNUP_ROLE_QUESTION = 'What is your position?';
var SIGNUP_ROLES = ['PhD student', 'Postdoc', 'Visiting student', 'Visiting faculty', 'Faculty'];
var SIGNUP_AFFILIATION_QUESTION = 'Affiliation';

/** Adds the position and affiliation questions if they are not on the form yet. */
function ensureSignupProfileQuestions(form) {
  var titles = form.getItems().map(function (i) { return i.getTitle(); });
  var after = titles.map(function (t, i) { return t.indexOf('Email') === 0 ? i : -1; }).filter(function (i) { return i >= 0; })[0];
  if (titles.indexOf(SIGNUP_ROLE_QUESTION) < 0) {
    var role = form.addMultipleChoiceItem().setTitle(SIGNUP_ROLE_QUESTION).setChoiceValues(SIGNUP_ROLES).setRequired(true);
    if (after !== undefined) form.moveItem(role.getIndex(), after + 1);
  }
  if (titles.indexOf(SIGNUP_AFFILIATION_QUESTION) < 0) {
    var aff = form.addTextItem().setTitle(SIGNUP_AFFILIATION_QUESTION).setRequired(true)
      .setHelpText('For example: UCL, LSE, IFS.');
    if (after !== undefined) form.moveItem(aff.getIndex(), after + 2);
  }
}

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
  var out = ScriptApp.getProjectTriggers().map(function (t) {
    return { fn: t.getHandlerFunction(), type: String(t.getEventType()) };
  });
  console.log(JSON.stringify(out));
  return out;
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
      schedule: ensureDates(readSchedule(sched).filter(function (r) { return r.date >= FIRST_SEMINAR_DATE; }), today),
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
    var badEmails = input.signups.filter(function (x) { return x.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email); })
      .map(function (x) { return x.name + ' <' + x.email + '>'; });
    if (badEmails.length) {
      console.log('sign-ups with an address that is not an email: ' + badEmails.join('; '));
      appendLog(priv, [new Date(), 'check', '', '', '', '', 'sign-ups with an address that is not an email: ' + badEmails.join('; ')]);
    }
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
      iTitle = headerIndex(h, 'Title of your talk'), iRole = headerIndex(h, 'What is your position'), iAff = headerIndex(h, 'Affiliation');
  return data.slice(1).filter(function (r) { return cellStr(r[iName]) || cellStr(r[iEmail]); }).map(function (r) {
    var dates = cellStr(r[iDates]).split(/,\s*/).map(parseChoiceLabel).filter(Boolean);
    return { ts: r[iTs] instanceof Date ? r[iTs].getTime() : Date.parse(r[iTs]) || 0, name: cellStr(r[iName]), email: normaliseEmail(r[iEmail]),
      dates: dates, slot: parseSlot(r[iSlot]), title: iTitle >= 0 ? cellStr(r[iTitle]) : '',
      role: iRole >= 0 ? cellStr(r[iRole]) : '', affiliation: iAff >= 0 ? cellStr(r[iAff]) : '',
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
function readRsvpResponses(priv) { return readFormTab(priv, TAB.rsvp, { date: 'Seminar date', presenter: 'Presenter', name: 'Your name', dietary: 'Dietary' }); }

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
  var byDate = {};
  current.forEach(function (label) { var d = parseChoiceLabel(label); if (d) byDate[d] = label; });
  // one label per open date, in date order, reusing the wording already on the form
  var keep = keepDates.slice().sort().map(function (d) { return byDate[d] || labelForIso(d); });
  var removed = current.filter(function (label) { return keep.indexOf(label) < 0; }).map(function (l) { return parseChoiceLabel(l) || l; });
  var added = keep.filter(function (label) { return current.indexOf(label) < 0; }).map(function (l) { return parseChoiceLabel(l) || l; });
  if (added.length) console.log('dates added to the sign-up form: ' + added.join(', '));
  if (keep.length === 0) {
    if (form.isAcceptingResponses()) {
      form.setAcceptingResponses(false);
      form.setCustomClosedMessage('All slots for this year are taken. Email the organisers if you would like to present.');
    }
    return removed;
  }
  if (keep.join('|') !== current.join('|')) item.setChoiceValues(keep);
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
  if (action === 'admin') {
    // Maintenance actions, protected by the same secret the mailer uses.
    var pp = PropertiesService.getScriptProperties();
    var secret = pp.getProperty('MAILER_SECRET') || (typeof MAILER_SECRET_FILE !== 'undefined' ? MAILER_SECRET_FILE : '');
    if (!secret || (e.parameter.secret || '') !== secret) return jsonOut({ ok: false, error: 'not authorised' });
    var task = e.parameter.task || '';
    var allowed = { updateSignupForm: updateSignupForm, seedPeopleTab: seedPeopleTab, previewFor: null,
      setPerson: null, fixSignup: null, clearPlacement: null, createMailingListForm: createMailingListForm,
      removeFormQuestion: null, renameFormQuestion: null, sendPresenterReminder: null,
      installTriggers: installTriggers, listTriggers: null, stats: null, addToMailingList: null,
      addPresentersToMailingList: null, findSignup: null, placePerson: null };
    if (task === 'previewFor') return jsonOut({ ok: true, task: task, output: previewText(e.parameter.date) });
    if (task === 'setPerson') return jsonOut(setPerson(e.parameter.name, e.parameter.role, e.parameter.affiliation));
    if (task === 'fixSignup') return jsonOut(fixSignup(e.parameter.match, e.parameter.name, e.parameter.email));
    if (task === 'clearPlacement') return jsonOut(clearPlacement(e.parameter.name, e.parameter.date));
    if (task === 'removeFormQuestion') return jsonOut(removeFormQuestion(e.parameter.form, e.parameter.title));
    if (task === 'renameFormQuestion') return jsonOut(renameFormQuestion(e.parameter.form, e.parameter.title, e.parameter.to));
    if (task === 'sendPresenterReminder') return jsonOut(sendPresenterReminder(e.parameter.date));
    if (task === 'listTriggers') return jsonOut({ ok: true, triggers: listTriggers() });
    if (task === 'stats') return jsonOut(stats());
    if (task === 'addToMailingList') return jsonOut(addToMailingList(e.parameter.people));
    if (task === 'addPresentersToMailingList') return jsonOut(addPresentersToMailingList());
    if (task === 'findSignup') return jsonOut(findSignup(e.parameter.q));
    if (task === 'placePerson') return jsonOut(placePerson(e.parameter.name, e.parameter.date, e.parameter.slot, e.parameter.start));
    if (!allowed[task]) return jsonOut({ ok: false, error: 'unknown task' });
    try { allowed[task](); return jsonOut({ ok: true, task: task }); }
    catch (err) { return jsonOut({ ok: false, task: task, error: String(err && err.message || err) }); }
  }
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


// ---- emails ---------------------------------------------------------------
/** Everything the pure email functions need. */
function emailInput() {
  var pub = SpreadsheetApp.getActive();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var cfg = readConfig(pub);
  var rsvpBase = cfg.rsvp_form_url, rsvpDate = cfg.rsvp_entry_date, rsvpPres = cfg.rsvp_entry_presenter;
  return {
    schedule: readSchedule(pub.getSheetByName(TAB.schedule)).filter(function (r) { return r.date >= FIRST_SEMINAR_DATE; }),
    signups: readSignups(priv),
    ledger: readLedger(priv),
    rsvps: readRsvpResponses(priv),
    mailingList: readMailingList(priv),
    known: readKnownPeople(priv),
    today: todayIso(),
    minLeadDays: MIN_LEAD_DAYS,
    signupUrl: cfg.signup_form_url,
    rsvpUrl: function (date, presenter) {
      return rsvpBase + '?usp=pp_url&entry.' + rsvpDate + '=' + encodeURIComponent(labelForIso(date)) +
        '&entry.' + rsvpPres + '=' + encodeURIComponent(presenter);
    }
  };
}

/** Role and affiliation for people who signed up before those questions existed.
 *  Kept in a "People" tab of the private spreadsheet: name | role | affiliation. */
function readKnownPeople(priv) {
  var sh = priv.getSheetByName('People');
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var name = cellStr(r[0]);
    if (!name) return;
    out[normaliseName(name)] = { role: cellStr(r[1]), affiliation: cellStr(r[2]) };
  });
  return out;
}

/** Fills the People tab from the current schedule, defaulting everyone to UCL. */
function seedPeopleTab() {
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sh = getOrCreateTab(priv, 'People', ['name', 'role', 'affiliation']);
  var have = readKnownPeople(priv);
  var signups = readSignups(priv);
  var rows = [];
  readSchedule(SpreadsheetApp.getActive().getSheetByName(TAB.schedule)).forEach(function (r) {
    if (!r.presenter || have[normaliseName(r.presenter)]) return;
    if (rows.some(function (x) { return namesMatch(x[0], r.presenter); })) return;
    var s = signups.filter(function (x) { return namesMatch(x.name, r.presenter); })[0];
    var role = s && s.role ? s.role : (s && s.advisors && !/^n\.?\/?a\.?$/i.test(s.advisors) ? 'PhD student' : '');
    rows.push([r.presenter, role, (s && s.affiliation) || 'UCL']);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  console.log('People tab: added ' + rows.length + ' row(s). Edit roles and affiliations there.');
}

/** Sets one person's role and affiliation in the People tab, adding the row if needed. */
function setPerson(name, role, affiliation) {
  if (!name) return { ok: false, error: 'name is required' };
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sh = getOrCreateTab(priv, 'People', ['name', 'role', 'affiliation']);
  var n = Math.max(sh.getLastRow() - 1, 0);
  var rows = n ? sh.getRange(2, 1, n, 3).getValues() : [];
  for (var i = 0; i < rows.length; i++) {
    if (namesMatch(rows[i][0], name)) {
      sh.getRange(i + 2, 2, 1, 2).setValues([[role || rows[i][1], affiliation || rows[i][2]]]);
      return { ok: true, updated: cellStr(rows[i][0]), role: role, affiliation: affiliation };
    }
  }
  sh.appendRow([name, role || '', affiliation || '']);
  return { ok: true, added: name, role: role, affiliation: affiliation };
}

/** Corrects the name and email on a sign-up response (used when someone mis-types a field).
 *  `match` is matched against the existing name or email of the row. */
function fixSignup(match, name, email) {
  if (!match) return { ok: false, error: 'match is required' };
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sh = priv.getSheetByName(SIGNUP_TAB);
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iName = headerIndex(h, 'Full name'), iEmail = headerIndex(h, 'Email');
  var fixed = [];
  for (var i = 1; i < data.length; i++) {
    var rowName = cellStr(data[i][iName]), rowEmail = cellStr(data[i][iEmail]);
    if (rowName !== match && rowEmail !== match) continue;
    if (name) sh.getRange(i + 1, iName + 1).setValue(name);
    if (email) sh.getRange(i + 1, iEmail + 1).setValue(email);
    fixed.push({ row: i + 1, was: rowName + ' <' + rowEmail + '>' });
  }
  return fixed.length ? { ok: true, fixed: fixed } : { ok: false, error: 'no response matched ' + match };
}

/** Removes a placement: the schedule row(s) and the ledger row(s) for that person.
 *  The date itself stays on the schedule as an open slot. With `date`, only that date is cleared. */
function clearPlacement(name, date) {
  if (!name) return { ok: false, error: 'name is required' };
  var pub = SpreadsheetApp.getActive();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sched = pub.getSheetByName(TAB.schedule);
  var rows = sortSchedule(readSchedule(sched));
  var removedDates = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (!hasPresenter(r) || !namesMatch(r.presenter, name)) continue;
    if (date && r.date !== date) continue;
    removedDates.push(r.date);
    rows.splice(i, 1);
    if (!rows.some(function (x) { return x.date === r.date; })) {
      rows.push({ date: r.date, term: r.term, start: '12:00', end: '13:00', presenter: '', slot: null, title: '', rsvps: '', notes: r.notes || '' });
    }
  }
  writeSchedule(sched, sortSchedule(rows));
  var lsh = getOrCreateTab(priv, TAB.ledger, LEDGER_HEADER);
  var ledger = readLedger(priv).filter(function (l) {
    return !(namesMatch(l.name, name) && (!date || l.date === date));
  });
  writeLedger(priv, ledger);
  return { ok: true, clearedDates: removedDates.sort(), ledgerRowsLeft: ledger.length };
}

/** Deletes a question from one of the forms. `form` is a Config key such as mailing_form_id. */
function removeFormQuestion(formKey, titlePrefix) {
  if (!formKey || !titlePrefix) return { ok: false, error: 'form and title are required' };
  var cfg = readConfig(SpreadsheetApp.getActive());
  var id = cfg[formKey] || formKey;
  var form = FormApp.openById(id);
  var removed = [];
  form.getItems().forEach(function (item) {
    if (item.getTitle().indexOf(titlePrefix) === 0) { removed.push(item.getTitle()); form.deleteItem(item); }
  });
  return removed.length ? { ok: true, removed: removed } : { ok: false, error: 'no question starts with ' + titlePrefix };
}

/** Renames a question on one of the forms (exact current title). */
function renameFormQuestion(formKey, title, to) {
  if (!formKey || !title || !to) return { ok: false, error: 'form, title and to are required' };
  var cfg = readConfig(SpreadsheetApp.getActive());
  var form = FormApp.openById(cfg[formKey] || formKey);
  var done = [];
  form.getItems().forEach(function (item) {
    if (item.getTitle() === title) { item.setTitle(to); done.push(title + ' -> ' + to); }
  });
  return done.length ? { ok: true, renamed: done } : { ok: false, error: 'no question titled ' + title };
}

function readMailingList(priv) {
  var sh = priv.getSheetByName(TAB.mailing);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iEmail = headerIndex(h, 'Email');
  var iName = headerIndex(h, 'Full name');
  if (iName < 0) iName = headerIndex(h, 'Name');
  var iUnsub = headerIndex(h, 'Unsubscribed');
  if (iEmail < 0) iEmail = 1;
  return data.slice(1).map(function (r) {
    return { email: cellStr(r[iEmail]), name: iName >= 0 ? cellStr(r[iName]) : '',
      unsubscribed: iUnsub >= 0 && /^(y|yes|true|1|x)$/i.test(cellStr(r[iUnsub])) };
  }).filter(function (m) { return m.email; });
}

/** POSTs to the mailer and returns its JSON reply, following the redirect Apps Script issues. */
function postToMailer(payload) {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('MAILER_URL') || (typeof MAILER_URL_FILE !== 'undefined' ? MAILER_URL_FILE : '');
  var secret = p.getProperty('MAILER_SECRET') || (typeof MAILER_SECRET_FILE !== 'undefined' ? MAILER_SECRET_FILE : '');
  if (!url || !secret) throw new Error('mailer not configured: set MAILER_URL and MAILER_SECRET');
  payload.secret = secret;
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false });
  var code = res.getResponseCode();
  if (code === 301 || code === 302 || code === 307) {
    var to = res.getHeaders()['Location'] || res.getHeaders()['location'];
    if (!to) throw new Error('mailer redirected without a destination');
    res = UrlFetchApp.fetch(to, { muteHttpExceptions: true, followRedirects: true });
  }
  var text = res.getContentText();
  var out;
  try { out = JSON.parse(text); }
  catch (e) { throw new Error('mailer replied with ' + res.getResponseCode() + ': ' + text.slice(0, 120)); }
  if (!out.ok) throw new Error('mailer: ' + out.error);
  return out;
}

/** Sends an already-addressed message through the mailer script. */
function callMailerRaw(msg, test) {
  return postToMailer({ to: msg.to || [], cc: msg.cc || [], bcc: msg.bcc || [],
    subject: msg.subject, body: msg.body, test: !!test });
}

/** Sends one composed message through the mailer script, cc'ing the organisers. */
function callMailer(msg, test) {
  return postToMailer({ subject: msg.subject, body: msg.body, test: !!test,
    to: (msg.to && msg.to.length) ? msg.to : ORGANISERS,
    cc: (msg.to && msg.to.length) ? ORGANISERS : [],
    bcc: msg.bcc || [] });
}

function runEmails(test) {
  var input = emailInput();
  var msgs = emailsFor(input);
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  if (!msgs.length) { console.log('nothing to send today'); appendLog(priv, [new Date(), test ? 'emails-preview' : 'emails', 0, '', '', '', 'nothing to send']); return []; }
  msgs.forEach(function (m) {
    var recipients = (m.to && m.to.length ? m.to : ORGANISERS).join(', ') + (m.bcc && m.bcc.length ? ' + ' + m.bcc.length + ' bcc' : '');
    try {
      callMailer(m, test);
      appendLog(priv, [new Date(), test ? 'emails-preview' : 'emails', m.kind, recipients, m.subject, '', test ? m.body : '']);
      console.log((test ? 'PREVIEW ' : 'SENT ') + m.kind + ' -> ' + recipients + ' | ' + m.subject);
      if (test) console.log(m.body);
    } catch (err) {
      console.error(err);
      appendLog(priv, [new Date(), 'emails', m.kind, recipients, m.subject, '', String(err && err.message || err)]);
    }
  });
  return msgs;
}

/** Scheduled entry points. Each checks the weekday itself, so a stray run does nothing. */
function sendScheduledEmails() { runEmails(false); }
function previewEmails() { runEmails(true); }

/** The drafts for a date, as text. */
function previewText(dateIso) {
  var input = emailInput();
  if (dateIso) input.today = dateIso;
  var msgs = emailsFor(input);
  if (!msgs.length) return 'nothing would be sent on ' + input.today;
  return msgs.map(function (m) {
    return '--- ' + m.kind + ' -> ' + ((m.to && m.to.length ? m.to : ORGANISERS).join(', ')) +
      (m.bcc && m.bcc.length ? ' + ' + m.bcc.length + ' bcc' : '') +
      '\nSubject: ' + m.subject + '\n\n' + m.body;
  }).join('\n\n');
}

/** Shows what would go out on a given weekday without touching the mailer, e.g. previewFor('2026-10-01'). */
function previewFor(dateIso) {
  var input = emailInput();
  input.today = dateIso || input.today;
  var msgs = emailsFor(input);
  if (!msgs.length) { console.log('nothing would be sent on ' + input.today); return; }
  msgs.forEach(function (m) {
    console.log('--- ' + m.kind + ' -> ' + ((m.to && m.to.length ? m.to : ORGANISERS).join(', ')) + (m.bcc && m.bcc.length ? ' + ' + m.bcc.length + ' bcc' : ''));
    console.log('Subject: ' + m.subject);
    console.log(m.body);
  });
}

/** Installs the daily job and the three email triggers. Run once after setting the mailer properties. */
/** Adds the new sign-up questions without re-running setup. */
function updateSignupForm() {
  var form = FormApp.openById(SIGNUP_FORM_ID);
  ensureSignupTitleQuestion(form);
  ensureSignupProfileQuestions(form);
  console.log('sign-up form questions: ' + form.getItems().map(function (i) { return i.getTitle(); }).join(' | '));
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailyJob', 'sendScheduledEmails'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(12).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendScheduledEmails').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendScheduledEmails').timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(13).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendScheduledEmails').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(12).inTimezone(TZ).create();
  console.log('triggers installed: daily 12:00, emails Mon 09:00 / Thu 13:00 / Fri 12:00');
}

/** Stores the mailer address and secret. */
function setMailer(url, secret) {
  if (!url || !secret) throw new Error('usage: setMailer("https://script.google.com/macros/s/.../exec", "secret")');
  PropertiesService.getScriptProperties().setProperties({ MAILER_URL: url, MAILER_SECRET: secret });
  console.log('mailer configured');
}

/** Creates the mailing-list form (once) and records it in Config. */
function createMailingListForm() {
  var pub = SpreadsheetApp.getActive();
  var cfg = readConfig(pub);
  if (cfg.mailing_form_id) {
    try { FormApp.openById(cfg.mailing_form_id); console.log('mailing list form already exists: ' + cfg.mailing_form_url); return; }
    catch (e) { /* recreate below */ }
  }
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var f = FormApp.create('Applied Micro Brown Bag: mailing list');
  f.setDescription('Get a weekly email with the next brown bag talk. Mondays 12-1pm, Room 321, Drayton House.')
   .setCollectEmail(false).setConfirmationMessage('Thanks, you are on the list.').setAllowResponseEdits(false);
  f.addTextItem().setTitle('Full name').setRequired(true);
  f.addTextItem().setTitle('Email address').setRequired(true);
  var before = priv.getSheets().map(function (sh) { return sh.getSheetId(); });
  f.setDestination(FormApp.DestinationType.SPREADSHEET, priv.getId());
  SpreadsheetApp.flush();
  var fresh = SpreadsheetApp.openById(priv.getId());
  var made = fresh.getSheets().filter(function (sh) { return before.indexOf(sh.getSheetId()) < 0; })[0];
  if (made) {
    made.setName(TAB.mailing);
    var h = made.getRange(1, 1, 1, made.getLastColumn()).getValues()[0];
    made.getRange(1, made.getLastColumn() + 1).setValue('Unsubscribed').setFontWeight('bold');
  }
  var url = f.getPublishedUrl().split('?')[0];
  var sh = getOrCreateTab(pub, TAB.config, ['key', 'value']);
  sh.appendRow(['mailing_form_id', f.getId()]);
  sh.appendRow(['mailing_form_url', url]);
  console.log('mailing list form: ' + url);
}

/**
 * Sends Hadar one email containing the three weekly drafts exactly as they would go out
 * for the coming Monday, so they can be checked before anything real is sent.
 * Nothing goes to the mailing list or to the presenters.
 */
function emailMeTheDrafts() {
  var input = emailInput();
  var monday = nextMonday(input.today);
  var sets = [
    ['Monday 09:00 to the presenter(s)', presenterReminders(input, monday)],
    ['Thursday 13:00 to the mailing list', [weeklyAnnouncement(input, monday)]],
    ['Friday 12:00 to the organisers', [rsvpReport(input, monday)]]
  ];
  var out = ['Drafts for the seminar on ' + labelForIso(monday) + '.',
             'These are previews only: nothing has been sent to anyone else.', ''];
  sets.forEach(function (pair) {
    out.push('==================================================');
    out.push(pair[0]);
    out.push('==================================================', '');
    var msgs = (pair[1] || []).filter(Boolean);
    if (!msgs.length) { out.push('(nothing would be sent)', ''); return; }
    msgs.forEach(function (m) {
      var to = (m.to && m.to.length ? m.to : ORGANISERS).join(', ');
      out.push('To:      ' + to);
      out.push('Cc:      ' + ((m.to && m.to.length) ? ORGANISERS.join(', ') : '(none)'));
      if (m.bcc && m.bcc.length) out.push('Bcc:     ' + m.bcc.length + ' mailing list address(es)');
      out.push('Subject: ' + m.subject, '', m.body, '', '--------------------------------------------------', '');
    });
  });
  callMailerRaw({ to: [ORGANISERS[0]], cc: [], bcc: [],
    subject: 'Brown bag: drafts of the weekly emails for ' + labelForIso(monday),
    body: out.join('\n') }, false);
  console.log('drafts sent to ' + ORGANISERS[0]);
}

/** Sends the presenter reminder for one specific seminar date, outside the Monday schedule. */
function sendPresenterReminder(dateIso) {
  var input = emailInput();
  var date = parseChoiceLabel(dateIso) || dateIso;
  var msgs = presenterReminders(input, date);
  if (!msgs.length) return { ok: false, error: 'no presenter with a known email on ' + date };
  var sent = [];
  msgs.forEach(function (m) { callMailer(m, false); sent.push({ to: m.to, subject: m.subject }); });
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  appendLog(priv, [new Date(), 'emails', 'presenter', sent.map(function (x) { return x.to.join(','); }).join('; '),
    sent[0].subject, '', 'sent by hand for ' + date]);
  return { ok: true, sent: sent };
}

/** Small counts for a quick check, without pulling whole sheets around. */
function stats() {
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var list = readMailingList(priv);
  var signups = readSignups(priv);
  var rsvps = readRsvpResponses(priv);
  var monday = nextMonday(todayIso());
  var forMonday = rsvps.filter(function (r) { return parseChoiceLabel(r.date) === monday; });
  var people = {};
  signups.forEach(function (s) { people[normaliseEmail(s.email) || normaliseName(s.name)] = s.name; });
  return { ok: true, today: todayIso(), nextMonday: monday,
    mailingList: { count: list.length, latest: list.slice(-6).map(function (m) { return m.name || m.email; }) },
    signups: { responses: signups.length, people: Object.keys(people).length,
               latest: signups.slice(-4).map(function (s) { return s.name + ' (' + (s.affiliation || '?') + ')'; }) },
    rsvps: { total: rsvps.length, forNextMonday: forMonday.length,
             names: forMonday.map(function (r) { return r.name; }) } };
}

/**
 * Adds people to the Mailing list tab, skipping addresses already there.
 * `people` is "Name <email>; Name <email>; plain@address" in any mixture.
 */
function addToMailingList(people) {
  if (!people) return { ok: false, error: 'people is required' };
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sh = priv.getSheetByName(TAB.mailing);
  if (!sh) return { ok: false, error: 'no Mailing list tab' };
  var have = {};
  readMailingList(priv).forEach(function (m) { have[normaliseEmail(m.email)] = true; });

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var iTs = headerIndex(header, 'Timestamp');
  var iName = headerIndex(header, 'Full name'); if (iName < 0) iName = headerIndex(header, 'Name');
  var iEmail = headerIndex(header, 'Email');

  var added = [], skipped = [];
  String(people).split(/\s*;\s*/).forEach(function (entry) {
    entry = entry.trim();
    if (!entry) return;
    var m = entry.match(/^(.*?)\s*<\s*([^>]+)\s*>$/);
    var name = m ? m[1].trim() : '';
    var email = normaliseEmail(m ? m[2] : entry);
    if (!email || email.indexOf('@') < 0) { skipped.push({ entry: entry, why: 'not an email' }); return; }
    if (have[email]) { skipped.push({ entry: name || email, why: 'already on the list' }); return; }
    var row = new Array(sh.getLastColumn()).fill('');
    if (iTs >= 0) row[iTs] = new Date();
    if (iName >= 0) row[iName] = name || email.split('@')[0];
    if (iEmail >= 0) row[iEmail] = email; else row[1] = email;
    sh.appendRow(row);
    have[email] = true;
    added.push(name || email);
  });
  return { ok: true, added: added, addedCount: added.length, skipped: skipped, total: readMailingList(priv).length };
}

/** Puts every scheduled presenter on the mailing list, if their address is known and not there yet. */
function addPresentersToMailingList() {
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var signups = readSignups(priv);
  var ledger = readLedger(priv);
  var schedule = readSchedule(SpreadsheetApp.getActive().getSheetByName(TAB.schedule));
  var entries = [], seen = {};
  schedule.forEach(function (r) {
    if (!r.presenter) return;
    var email = emailOf(r.presenter, signups, ledger);
    if (!email || seen[email]) return;
    seen[email] = true;
    entries.push(r.presenter + ' <' + email + '>');
  });
  var missing = schedule.filter(function (r) { return r.presenter && !emailOf(r.presenter, signups, ledger); })
    .map(function (r) { return r.presenter; });
  var res = addToMailingList(entries.join('; '));
  res.noEmailKnown = missing;
  return res;
}

/** Looks up sign-ups whose name or email contains `q`, and says whether they have a slot. */
function findSignup(q) {
  if (!q) return { ok: false, error: 'q is required' };
  var needle = String(q).toLowerCase();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var ledger = readLedger(priv);
  var schedule = readSchedule(SpreadsheetApp.getActive().getSheetByName(TAB.schedule));
  var hits = readSignups(priv).filter(function (s) {
    return (s.name || '').toLowerCase().indexOf(needle) >= 0 || (s.email || '').indexOf(needle) >= 0;
  }).map(function (s) {
    var row = schedule.filter(function (r) { return hasPresenter(r) && namesMatch(r.presenter, s.name); })[0];
    return { when: new Date(s.ts).toISOString(), name: s.name, email: s.email, slot: s.slot,
      dates: s.dates, position: s.role, affiliation: s.affiliation, title: s.title,
      scheduled: row ? row.date + ' ' + row.start : null,
      onLedger: ledger.some(function (l) { return normaliseEmail(l.email) === normaliseEmail(s.email); }) };
  });
  return { ok: true, count: hits.length, hits: hits };
}

/**
 * Puts someone on a date by hand and records it, so the daily job leaves them alone.
 * The name is matched against the sign-ups to pick up their email and title.
 */
function placePerson(name, date, slot, start) {
  if (!name || !date) return { ok: false, error: 'name and date are required' };
  var iso = parseChoiceLabel(date) || date;
  var mins = parseSlot(slot) || 60;
  var pub = SpreadsheetApp.getActive();
  var priv = SpreadsheetApp.openById(PRIVATE_SHEET_ID);
  var sched = pub.getSheetByName(TAB.schedule);
  var rows = sortSchedule(readSchedule(sched));
  if (!scheduleHasDate(rows, iso)) return { ok: false, error: iso + ' is not on the schedule' };
  var at = start || freeStart(rows, iso, mins);
  if (!at) return { ok: false, error: iso + ' has no room for ' + mins + ' minutes' };

  var signup = readSignups(priv).filter(function (s) { return namesMatch(s.name, name); })
    .sort(function (a, b) { return b.ts - a.ts; })[0];
  var fullName = signup ? signup.name : name;

  var blank = rows.filter(function (r) { return r.date === iso && !hasPresenter(r); })[0];
  if (blank) {
    blank.presenter = fullName; blank.slot = mins; blank.start = at; blank.end = endFor(at, mins);
    if (signup && signup.title) blank.title = signup.title;
  } else {
    rows.push({ date: iso, term: termOf(iso), start: at, end: endFor(at, mins), presenter: fullName,
      slot: mins, title: (signup && signup.title) || '', rsvps: '', notes: '' });
  }
  writeSchedule(sched, sortSchedule(rows));

  var ledger = readLedger(priv);
  ledger = ledger.filter(function (l) { return !namesMatch(l.name, fullName); });
  ledger.push({ email: signup ? signup.email : '', name: fullName, date: iso, slot: mins,
    placedAt: todayIso(), source: 'manual', signupTs: signup ? signup.ts : Date.now() });
  writeLedger(priv, ledger);
  appendLog(priv, [new Date(), 'manual', 'placed', fullName, iso + ' ' + at, '', 'placed by hand']);
  return { ok: true, placed: { name: fullName, date: iso, start: at, slot: mins, title: (signup && signup.title) || '' } };
}
