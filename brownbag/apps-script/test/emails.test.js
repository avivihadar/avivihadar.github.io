const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scheduler.js');

const RSVP = (d, p) => `https://rsvp.example/?d=${d}&p=${encodeURIComponent(p)}`;
const SIGNUP = 'https://signup.example/form';

function row(date, presenter, slot, start, title) {
  return { date, term: S.termOf(date), start: start || '12:00',
    end: start === '12:30' ? '13:00' : (slot === 60 ? '13:00' : '12:30'),
    presenter, slot, title: title || '', rsvps: '', notes: '' };
}
function baseInput(over) {
  return Object.assign({
    schedule: [row('2026-10-05', 'Attila Lindner', 60), row('2026-10-12', 'Hao Hu', 60)],
    signups: [{ ts: 1, name: 'Attila Lindner', email: 'a.lindner@ucl.ac.uk', dates: [], slot: 60, advisors: 'NA' },
              { ts: 2, name: 'Hao Hu', email: 'hao.hu.21@ucl.ac.uk', dates: [], slot: 60, advisors: 'Jonas Hjort, Suphanit Piyapromdee' }],
    ledger: [], rsvps: [], mailingList: [{ email: 'a@x.com' }, { email: 'B@x.com' }],
    today: '2026-09-28', minLeadDays: 7, rsvpUrl: RSVP, signupUrl: SIGNUP
  }, over || {});
}

test('nextMonday always looks past today', () => {
  assert.equal(S.nextMonday('2026-09-28'), '2026-10-05');   // a Monday -> the following one
  assert.equal(S.nextMonday('2026-10-01'), '2026-10-05');   // Thursday
  assert.equal(S.nextMonday('2026-10-02'), '2026-10-05');   // Friday
  assert.equal(S.nextMonday('2026-10-04'), '2026-10-05');   // Sunday
});

test('presenter reminder: faculty gets no student line, missing title gets the how-to', () => {
  const m = S.presenterReminders(baseInput(), '2026-10-05');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, ['a.lindner@ucl.ac.uk']);
  assert.equal(m[0].subject, 'Your brown bag talk on Mon 5 Oct 2026');
  assert.match(m[0].body, /^Dear Attila,/);
  assert.match(m[0].body, /5 October, 12:00 to 13:00, Room 321, Drayton House/);
  assert.match(m[0].body, /We do not have a title/);
  assert.ok(!/invite faculty/.test(m[0].body));
});

test('presenter reminder: student with a title gets the nudge and no how-to', () => {
  const input = baseInput({ schedule: [row('2026-10-12', 'Hao Hu', 60, '12:00', 'Firms and trade')] });
  const m = S.presenterReminders(input, '2026-10-12');
  assert.match(m[0].body, /Feel free to invite faculty and visitors to your talk\./);
  assert.ok(!/We do not have a title/.test(m[0].body));
});

test('presenter reminder: two 30-minute talks produce two emails with their own times', () => {
  const input = baseInput({
    schedule: [row('2026-11-30', 'Chiara Giannetto', 30, '12:00'), row('2026-11-30', 'Pedro Cubillos', 30, '12:30')],
    signups: [{ ts: 1, name: 'Chiara Giannetto', email: 'c@ucl.ac.uk', advisors: 'Dustmann' },
              { ts: 2, name: 'Pedro Cubillos', email: 'p@ucl.ac.uk', advisors: 'Hjort' }]
  });
  const m = S.presenterReminders(input, '2026-11-30');
  assert.equal(m.length, 2);
  assert.match(m[0].body, /12:00 to 12:30/);
  assert.match(m[1].body, /12:30 to 13:00/);
});

test('presenter with no known email is skipped', () => {
  const input = baseInput({ schedule: [row('2026-10-05', 'Unknown Visitor', 60)], signups: [], ledger: [] });
  assert.equal(S.presenterReminders(input, '2026-10-05').length, 0);
});

test('announcement: title, RSVP link, open-slots line, unsubscribe, deduped bcc', () => {
  const input = baseInput({ schedule: [row('2026-10-05', 'Attila Lindner', 60, '12:00', 'Minimum wages'),
                                       row('2027-06-07', '', null)],
                            mailingList: [{ email: 'A@x.com' }, { email: 'a@x.com' }, { email: 'c@x.com', unsubscribed: true }] });
  const a = S.weeklyAnnouncement(input, '2026-10-05');
  assert.equal(a.subject, 'Brown bag on Monday 5 Oct 2026: Attila Lindner');
  assert.deepEqual(a.bcc, ['a@x.com']);
  assert.match(a.body, /Minimum wages/);
  assert.match(a.body, /Next Monday at the Applied Micro Brown Bag, 5 October/);
  assert.ok(!/sign up for lunch|Lunch is provided/i.test(a.body));   // no lunch is offered any more
  assert.match(a.body, /not able to provide lunch/);                  // only the postscript mentions it
  assert.match(a.body, /There are still open slots/);
  assert.match(a.body, /signup\.example/);
  assert.match(a.body, /unsubscribe/);
});

test('announcement: no open slots means no sign-up paragraph; missing title says so', () => {
  const input = baseInput({ schedule: [row('2026-10-05', 'Attila Lindner', 60)] });
  const a = S.weeklyAnnouncement(input, '2026-10-05');
  assert.match(a.body, /Title to be announced/);
  assert.ok(!/still open slots/.test(a.body));
});

test('announcement: nothing at all when the Monday has no presenter', () => {
  const input = baseInput({ schedule: [row('2026-10-05', '', null)] });
  assert.equal(S.weeklyAnnouncement(input, '2026-10-05'), null);
  assert.equal(S.rsvpReport(input, '2026-10-05'), null);
});

test('lunch count: dedupes attendees, lists dietary notes, counts', () => {
  const input = baseInput({ rsvps: [
    { ts: 1, date: 'Mon 5 Oct 2026', name: 'Zed Smith', dietary: '' },
    { ts: 2, date: 'Mon 5 Oct 2026', name: 'zed smith ', dietary: '' },
    { ts: 3, date: 'Mon 5 Oct 2026', name: 'Ann Lee', dietary: 'vegetarian' },
    { ts: 4, date: 'Mon 12 Oct 2026', name: 'Other Week', dietary: '' }] });
  const r = S.rsvpReport(input, '2026-10-05');
  assert.equal(r.subject, 'Lunch count for Monday 5 Oct 2026: 2 people');
  assert.match(r.body, /RSVPs received: 2/);
  assert.match(r.body, /Ann Lee/);
  assert.match(r.body, /\[vegetarian\]/);
  assert.ok(!/Other Week/.test(r.body));
});

test('lunch count with nobody signed up still sends', () => {
  const r = S.rsvpReport(baseInput(), '2026-10-05');
  assert.match(r.subject, /0 people/);
  assert.match(r.body, /nobody has signed up yet/);
});

test('emailsFor picks the right message for each weekday', () => {
  const mon = S.emailsFor(baseInput({ today: '2026-09-28' }));
  assert.equal(mon.length, 1); assert.equal(mon[0].kind, 'presenter');
  const thu = S.emailsFor(baseInput({ today: '2026-10-01' }));
  assert.equal(thu[0].kind, 'announcement');
  const fri = S.emailsFor(baseInput({ today: '2026-10-02' }));
  assert.equal(fri[0].kind, 'rsvpReport');
  assert.deepEqual(S.emailsFor(baseInput({ today: '2026-09-30' })), []);   // Wednesday
  assert.deepEqual(S.emailsFor(baseInput({ today: '2026-10-03' })), []);   // Saturday
});

test('emailsFor sends nothing in a week with no presenter', () => {
  const quiet = baseInput({ today: '2027-01-07', schedule: [row('2027-01-11', '', null)] });
  assert.deepEqual(S.emailsFor(quiet), []);
  assert.deepEqual(S.emailsFor(Object.assign({}, quiet, { today: '2027-01-04' })), []);
});

test('affiliation appears in the announcement and the lunch count', () => {
  const sched = [{ date: '2026-10-12', term: 'Term 1', start: '12:00', end: '13:00', presenter: 'Hao Hu', slot: 60, title: 'Firms', rsvps: '', notes: '' }];
  const input = { schedule: sched, ledger: [], rsvps: [], mailingList: [{ email: 'a@x.com' }],
    today: '2026-10-08', minLeadDays: 7, signupUrl: SIGNUP, rsvpUrl: RSVP,
    signups: [{ ts: 1, name: 'Hao Hu', email: 'h@ucl.ac.uk', advisors: 'Hjort', role: 'PhD student', affiliation: 'UCL' }] };
  const a = S.weeklyAnnouncement(input, '2026-10-12');
  assert.equal(a.subject, 'Brown bag on Monday 12 Oct 2026: Hao Hu (UCL)');
  assert.match(a.body, /Hao Hu \(UCL\)/);
  assert.match(S.rsvpReport(input, '2026-10-12').body, /Presenter: Hao Hu \(UCL\)/);
});

test('affiliation falls back to the People tab; role decides student status', () => {
  const sched = [{ date: '2026-10-12', term: 'Term 1', start: '12:00', end: '13:00', presenter: 'Attila Lindner', slot: 60, title: '', rsvps: '', notes: '' }];
  const known = { 'attila lindner': { role: 'Faculty', affiliation: 'UCL' } };
  const input = { schedule: sched, ledger: [{ name: 'Attila Lindner', email: 'a@ucl.ac.uk' }], rsvps: [], mailingList: [],
    today: '2026-10-08', minLeadDays: 7, signupUrl: SIGNUP, rsvpUrl: RSVP, signups: [], known };
  assert.match(S.weeklyAnnouncement(input, '2026-10-12').body, /Attila Lindner \(UCL\)/);
  const rem = S.presenterReminders(input, '2026-10-12');
  assert.ok(!/invite faculty/.test(rem[0].body));
  known['attila lindner'].role = 'Visiting student';
  assert.match(S.presenterReminders(input, '2026-10-12')[0].body, /invite faculty and visitors/);
});
