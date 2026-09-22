const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scheduler.js');

const DATES = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-16',
  '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22',
  '2027-04-26', '2027-05-10', '2027-05-17', '2027-05-24', '2027-06-07'];
const LABELS = ['Mon 28 Sep 2026', 'Mon 5 Oct 2026', 'Mon 12 Oct 2026', 'Mon 19 Oct 2026', 'Mon 26 Oct 2026',
  'Mon 2 Nov 2026', 'Mon 16 Nov 2026', 'Mon 23 Nov 2026', 'Mon 30 Nov 2026', 'Mon 7 Dec 2026', 'Mon 14 Dec 2026',
  'Mon 1 Mar 2027', 'Mon 8 Mar 2027', 'Mon 15 Mar 2027', 'Mon 22 Mar 2027', 'Mon 26 Apr 2027', 'Mon 10 May 2027',
  'Mon 17 May 2027', 'Mon 24 May 2027', 'Mon 7 Jun 2027'];

function blankSchedule() {
  return DATES.map(d => ({ date: d, term: S.termOf(d), start: '12:00', end: '13:00', presenter: '', slot: null, title: '', rsvps: '', notes: '' }));
}
function row(date, presenter, slot, start) {
  return { date, term: S.termOf(date), start: start || '12:00', end: start === '12:30' ? '13:00' : (slot === 60 ? '13:00' : '12:30'), presenter, slot, title: '', rsvps: '', notes: '' };
}
function signup(ts, name, email, dates, slot) { return { ts, name, email, dates, slot, advisors: '', dietary: '' }; }
const TODAY = '2026-09-22';

test('parseChoiceLabel round-trips all real labels', () => {
  LABELS.forEach((l, i) => {
    assert.equal(S.parseChoiceLabel(l), DATES[i]);
    assert.equal(S.labelForIso(DATES[i]), l);
  });
  assert.equal(S.parseChoiceLabel('5 October 2026'), '2026-10-05');
  assert.equal(S.parseChoiceLabel('2026-10-05'), '2026-10-05');
  assert.equal(S.parseChoiceLabel('garbage'), null);
  assert.equal(S.parseChoiceLabel(''), null);
});

test('termOf and addDays', () => {
  assert.equal(S.termOf('2026-12-14'), 'Term 1');
  assert.equal(S.termOf('2027-03-01'), 'Term 2');
  assert.equal(S.termOf('2027-04-26'), 'Term 3');
  assert.equal(S.addDays('2026-12-30', 5), '2027-01-04');
});

test('normaliseName and namesMatch', () => {
  assert.equal(S.normaliseName('Áureo de Paula'), 'aureo de paula');
  assert.ok(S.namesMatch('Tianrui (Edwin) Mu', 'Tianrui Mu'));
  assert.ok(S.namesMatch('Yue  Li', 'yue li'));
  assert.ok(S.namesMatch('François Gerard', 'Francois Gerard'));
  assert.ok(!S.namesMatch('Yue Li', 'Yikai Li'));
  assert.ok(!S.namesMatch('', 'Yikai Li'));
});

test('parseSlot', () => {
  assert.equal(S.parseSlot('30 minutes'), 30);
  assert.equal(S.parseSlot('60 minutes'), 60);
  assert.equal(S.parseSlot(''), null);
});

test('dedupeSignups keeps earliest priority and latest details', () => {
  const r = S.dedupeSignups([
    signup(100, 'A B', 'a@x.com', ['2026-10-05'], 30),
    signup(50, 'C D', 'c@x.com', ['2026-10-12'], 60),
    signup(200, 'A B', 'A@x.com', ['2026-10-19'], 60),
  ]);
  assert.equal(r.people.length, 2);
  assert.equal(r.duplicatesIgnored, 1);
  assert.equal(r.people[0].name, 'C D');
  assert.equal(r.people[1].ts, 100);
  assert.deepEqual(r.people[1].dates, ['2026-10-19']);
  assert.equal(r.people[1].slot, 60);
});

test('freeStart and usedMinutes', () => {
  const sched = [row('2026-10-05', 'X', 30, '12:30'), row('2026-10-12', 'Y', 60)];
  assert.equal(S.usedMinutes(sched, '2026-10-05'), 30);
  assert.equal(S.freeStart(sched, '2026-10-05', 30), '12:00');
  assert.equal(S.freeStart(sched, '2026-10-05', 60), null);
  assert.equal(S.freeStart(sched, '2026-10-12', 30), null);
  assert.equal(S.freeStart(sched, '2026-10-19', 60), '12:00');
});

test('placeSignups: 60 into empty date fills the blank row', () => {
  const res = S.placeSignups({ schedule: blankSchedule(), ledger: [], signups: [signup(1, 'Ann Lee', 'ann@x.com', ['2026-10-12', '2026-10-05'], 60)], today: TODAY, minLeadDays: 7 });
  const r = res.schedule.filter(x => x.date === '2026-10-05');
  assert.equal(r.length, 1);
  assert.equal(r[0].presenter, 'Ann Lee');
  assert.equal(r[0].end, '13:00');
  assert.equal(res.newLedger.length, 1);
  assert.equal(res.newLedger[0].source, 'auto');
  assert.equal(res.schedule.length, DATES.length);
});

test('placeSignups: two 30s share a date, third goes to next date', () => {
  const res = S.placeSignups({
    schedule: blankSchedule(), ledger: [], today: TODAY, minLeadDays: 7,
    signups: [
      signup(1, 'P One', 'p1@x.com', ['2026-10-05', '2026-10-12'], 30),
      signup(2, 'P Two', 'p2@x.com', ['2026-10-05', '2026-10-12'], 30),
      signup(3, 'P Three', 'p3@x.com', ['2026-10-05', '2026-10-12'], 30),
    ]
  });
  const oct5 = res.schedule.filter(x => x.date === '2026-10-05');
  assert.deepEqual(oct5.map(x => [x.presenter, x.start, x.end]), [['P One', '12:00', '12:30'], ['P Two', '12:30', '13:00']]);
  const oct12 = res.schedule.filter(x => x.date === '2026-10-12');
  assert.deepEqual(oct12.map(x => [x.presenter, x.start]), [['P Three', '12:00']]);
});

test('placeSignups: hand-edited 12:30 row leaves 12:00 free; 60 skips half-full date', () => {
  const sched = blankSchedule();
  sched[1] = row('2026-10-05', 'Hand Edit', 30, '12:30');
  const res = S.placeSignups({
    schedule: sched, ledger: [], today: TODAY, minLeadDays: 7,
    signups: [signup(1, 'Long Talk', 'l@x.com', ['2026-10-05', '2026-10-12'], 60), signup(2, 'Short Talk', 's@x.com', ['2026-10-05'], 30)]
  });
  assert.equal(res.schedule.find(x => x.presenter === 'Long Talk').date, '2026-10-12');
  const st = res.schedule.find(x => x.presenter === 'Short Talk');
  assert.equal(st.date, '2026-10-05');
  assert.equal(st.start, '12:00');
  assert.equal(st.end, '12:30');
});

test('placeSignups: timestamp priority beats form order', () => {
  const res = S.placeSignups({
    schedule: blankSchedule(), ledger: [], today: TODAY, minLeadDays: 7,
    signups: [signup(20, 'Later', 'l@x.com', ['2026-10-05', '2026-10-12'], 60), signup(10, 'Earlier', 'e@x.com', ['2026-10-05', '2026-10-12'], 60)]
  });
  assert.equal(res.schedule.find(x => x.date === '2026-10-05').presenter, 'Earlier');
  assert.equal(res.schedule.find(x => x.date === '2026-10-12').presenter, 'Later');
});

test('placeSignups: sticky via ledger email, ledger name, schedule name (renamed)', () => {
  const sched = blankSchedule();
  sched[2] = row('2026-10-12', 'Tianrui (Edwin) Mu', 30);
  const ledger = [{ email: 'ann@x.com', name: 'Ann Lee', date: '2026-10-05', slot: 60, placedAt: TODAY, source: 'seed' },
                  { email: '', name: 'Bob Ray', date: '2026-10-19', slot: 60, placedAt: TODAY, source: 'seed' }];
  const res = S.placeSignups({
    schedule: sched, ledger, today: TODAY, minLeadDays: 7,
    signups: [signup(1, 'Ann Lee', 'ANN@x.com', ['2026-10-26'], 60), signup(2, 'Bob Ray', 'bob@x.com', ['2026-10-26'], 60),
              signup(3, 'Tianrui Mu', 't@x.com', ['2026-10-26'], 30)]
  });
  assert.equal(res.newLedger.length, 0);
  assert.equal(res.placed.length, 0);
  assert.equal(res.schedule.find(x => x.date === '2026-10-26').presenter, '');
});

test('placeSignups: lead time excludes near dates; unplaced reasons', () => {
  const res = S.placeSignups({
    schedule: blankSchedule(), ledger: [], today: '2026-09-30', minLeadDays: 7,
    signups: [signup(1, 'Near', 'n@x.com', ['2026-10-05'], 60), signup(2, 'No Slot', 'ns@x.com', ['2026-10-12'], null),
              signup(3, 'Off Date', 'od@x.com', ['2026-10-06'], 30)]
  });
  assert.equal(res.placed.length, 0);
  assert.deepEqual(res.unplaced.map(u => u.reason), ['no future dates ticked', 'slot length missing', 'no future dates ticked']);
});

test('placeSignups: no capacity reason and appended row when no blank exists', () => {
  const sched = [row('2026-10-05', 'X', 30)];
  const res = S.placeSignups({
    schedule: sched, ledger: [], today: TODAY, minLeadDays: 7,
    signups: [signup(1, 'Big', 'b@x.com', ['2026-10-05'], 60), signup(2, 'Small', 's@x.com', ['2026-10-05'], 30)]
  });
  assert.equal(res.unplaced[0].reason, 'no capacity on ticked dates');
  assert.equal(res.schedule.length, 2);
  assert.equal(res.schedule[1].presenter, 'Small');
  assert.equal(res.schedule[1].start, '12:30');
});

test('choiceDatesToKeep drops past and full, keeps half-full', () => {
  const sched = blankSchedule();
  sched[1] = row('2026-10-05', 'Full', 60);
  sched[2] = row('2026-10-12', 'Half', 30);
  const keep = S.choiceDatesToKeep(sched, '2026-09-30', 7);
  assert.ok(!keep.includes('2026-09-28'));
  assert.ok(!keep.includes('2026-10-05'));
  assert.ok(keep.includes('2026-10-12'));
  assert.ok(keep.includes('2026-10-19'));
  assert.deepEqual(S.halfFullDates(sched, '2026-09-30', 7), ['2026-10-12']);
});

test('applyTitles: latest wins, unmatched reported, manual title kept when response blank', () => {
  const sched = [row('2026-10-05', 'Ann Lee', 60)];
  const r = S.applyTitles(sched, [
    { ts: 2, date: 'Mon 5 Oct 2026', presenter: 'ann lee', title: 'Second' },
    { ts: 1, date: 'Mon 5 Oct 2026', presenter: 'Ann Lee', title: 'First' },
    { ts: 3, date: 'Mon 12 Oct 2026', presenter: 'Nobody', title: 'Lost' },
  ]);
  assert.equal(sched[0].title, 'Second');
  assert.equal(r.updated.length, 2);
  assert.equal(r.unmatched.length, 1);
});

test('applyRsvps counts distinct names per date', () => {
  const sched = [row('2026-10-05', 'A', 30), row('2026-10-05', 'B', 30, '12:30'), row('2026-10-12', 'C', 60)];
  const changed = S.applyRsvps(sched, [
    { ts: 1, date: 'Mon 5 Oct 2026', presenter: 'A', name: 'Zed' },
    { ts: 2, date: 'Mon 5 Oct 2026', presenter: 'A', name: 'zed ' },
    { ts: 3, date: 'Mon 5 Oct 2026', presenter: 'B', name: 'Yan' },
  ]);
  assert.ok(changed);
  assert.equal(sched[0].rsvps, 2);
  assert.equal(sched[1].rsvps, 2);
  assert.equal(sched[2].rsvps, '');
  assert.ok(!S.applyRsvps(sched, [{ ts: 1, date: 'Mon 5 Oct 2026', presenter: 'A', name: 'Zed' }, { ts: 3, date: 'Mon 5 Oct 2026', presenter: 'B', name: 'Yan' }]));
});

test('run is idempotent and does not mutate input', () => {
  const input = {
    schedule: blankSchedule(), ledger: [], today: TODAY, minLeadDays: 7, titles: [], rsvps: [], prevUnplaced: [],
    signups: [signup(1, 'Ann Lee', 'ann@x.com', ['2026-10-05'], 60), signup(2, 'Stuck', 'st@x.com', ['2026-10-05'], 60)]
  };
  const snapshot = JSON.stringify(input);
  const first = S.run(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(first.changes.placed.length, 1);
  assert.equal(first.changes.newUnplaced.length, 1);
  const second = S.run({ ...input, schedule: first.schedule, ledger: first.newLedger, prevUnplaced: first.unplaced });
  assert.equal(second.changes.placed.length, 0);
  assert.equal(second.changes.newUnplaced.length, 0);
  assert.equal(second.newLedger.length, 0);
  assert.deepEqual(second.schedule, first.schedule);
});
