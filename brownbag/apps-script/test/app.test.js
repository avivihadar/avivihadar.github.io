const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../../app.js');

test('parseCsv handles quotes, embedded commas and newlines, CRLF and BOM', () => {
  const text = '﻿a,b,c\r\n1,"x, y","line1\nline2"\r\n2,"say ""hi""",\r\n';
  const rows = A.parseCsv(text);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'line1\nline2'], ['2', 'say "hi"', '']]);
});

test('fallback.csv parses into the expected groups', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'fallback.csv'), 'utf8');
  const rows = A.rowsToObjects(A.parseCsv(text)).map(A.normaliseRow);
  const groups = A.groupByDate(rows);
  assert.equal(groups.length, 20);
  const nov30 = groups.find(g => g.date === '2026-11-30');
  assert.deepEqual(nov30.talks.map(t => t.presenter), ['Chiara Giannetto', 'Pedro Cubillos']);
  assert.equal(nov30.freeHalf, null);
  const sep28 = groups.find(g => g.date === '2026-09-28');
  assert.equal(sep28.freeHalf, '12:30');
  const dec14 = groups.find(g => g.date === '2026-12-14');
  assert.equal(dec14.talks.length, 0);
  assert.equal(dec14.term, 'Term 1');
});

test('normaliseRow tolerates Sheets date and time leaks', () => {
  const r = A.normaliseRow({ date: '05/10/2026', start: '12:00:00', end: '13:00:00', presenter: '(open)', slot_min: '' });
  assert.equal(r.date, '2026-10-05');
  assert.equal(r.start, '12:00');
  assert.equal(r.presenter, '');
  assert.equal(A.normaliseRow({ date: 'Mon 5 Oct 2026' }).date, '2026-10-05');
});

test('groupByDate: hand-edited 12:30 talk leaves 12:00 free', () => {
  const g = A.groupByDate([{ date: '2026-10-05', term: 'Term 1', start: '12:30', end: '13:00', presenter: 'X', slot: 30, title: '' }]);
  assert.equal(g[0].freeHalf, '12:00');
});

test('prefilledUrl encodes label and presenter', () => {
  const url = A.prefilledUrl({ base: 'https://docs.google.com/forms/d/e/ABC/viewform', dateEntry: '11', presenterEntry: '22' }, '2026-10-05', 'Tianrui (Edwin) Mu');
  assert.equal(url, 'https://docs.google.com/forms/d/e/ABC/viewform?usp=pp_url&entry.11=Mon%205%20Oct%202026&entry.22=Tianrui%20(Edwin)%20Mu');
  assert.equal(A.prefilledUrl({ base: '' }, '2026-10-05', 'X'), null);
});

test('todayIso returns yyyy-mm-dd', () => {
  assert.match(A.todayIso('Europe/London'), /^\d{4}-\d{2}-\d{2}$/);
});
