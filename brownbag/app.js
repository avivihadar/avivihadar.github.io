/* Applied Micro Brown Bag schedule page.
 * Pure helpers are exported for Node tests; DOM code runs only in a browser. */
(function (root) {
  'use strict';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** RFC 4180-ish CSV parser: quoted fields, embedded commas/newlines, "" escapes, CRLF, BOM. */
  function parseCsv(text) {
    var rows = [], row = [], field = '', inQuotes = false;
    var s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else { field += c; }
      } else if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else { field += c; }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (f) { return f.trim() !== ''; }); });
  }

  function rowsToObjects(table) {
    if (!table.length) return [];
    var header = table[0].map(function (h) { return h.trim().toLowerCase(); });
    return table.slice(1).map(function (r) {
      var o = {};
      header.forEach(function (h, i) { o[h] = (r[i] === undefined ? '' : r[i]).trim(); });
      return o;
    });
  }

  function isoFromLoose(s) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);       // d/m/yyyy as Sheets may emit in the UK locale
    if (m) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})/);
    if (m) {
      var mon = MONTH_NAMES.map(function (x) { return x.toLowerCase(); }).indexOf(m[2].toLowerCase().slice(0, 3));
      if (mon >= 0) return m[3] + '-' + pad2(mon + 1) + '-' + pad2(+m[1]);
    }
    return null;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(s) { var m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? pad2(+m[1]) + ':' + m[2] : ''; }

  function normaliseRow(o) {
    var presenter = (o.presenter || '').trim();
    if (/^(\(open\)|tbd|tba)$/i.test(presenter)) presenter = '';
    return {
      date: isoFromLoose(o.date || ''),
      term: o.term || '',
      start: hhmm(o.start) || '12:00',
      end: hhmm(o.end) || '13:00',
      presenter: presenter,
      slot: /60/.test(o.slot_min || '') ? 60 : (/30/.test(o.slot_min || '') ? 30 : null),
      title: (o.title || '').trim()
    };
  }

  /** Rows from the script's JSON endpoint -> same shape as CSV rows. */
  function rowsFromApi(rows) {
    return (rows || []).map(function (r) {
      return normaliseRow({ date: String(r.date || ''), term: r.term || '', start: String(r.start || ''), end: String(r.end || ''),
        presenter: r.presenter || '', slot_min: String(r.slot || ''), title: r.title || '' });
    });
  }

  /** Group rows by date; talks sorted by start; compute the free half when 30 of 60 minutes are used. */
  function groupByDate(rows) {
    var byDate = {};
    rows.forEach(function (r) {
      if (!r.date) return;
      if (!byDate[r.date]) byDate[r.date] = { date: r.date, term: r.term, talks: [] };
      if (r.presenter) byDate[r.date].talks.push(r);
      if (!byDate[r.date].term && r.term) byDate[r.date].term = r.term;
    });
    return Object.keys(byDate).sort().map(function (d) {
      var g = byDate[d];
      g.talks.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
      var used = g.talks.reduce(function (s, t) { return s + (t.slot || 0); }, 0);
      g.usedMin = used;
      g.freeHalf = used === 30 ? (g.talks[0].start === '12:00' ? '12:30' : '12:00') : null;
      return g;
    });
  }

  function labelForIso(iso) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return DAY_NAMES[d.getUTCDay()] + ' ' + p[2] + ' ' + MONTH_NAMES[p[1] - 1] + ' ' + p[0];
  }
  function dayParts(iso) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return { weekday: DAY_NAMES[d.getUTCDay()], short: p[2] + ' ' + MONTH_NAMES[p[1] - 1] };
  }

  /** Form link when the form exists; otherwise an email to the organiser with the details prefilled. */
  function actionUrl(kind, cfg, date, presenter, organiserEmail) {
    var url = prefilledUrl(cfg, date, presenter);
    if (url) return url;
    if (!organiserEmail) return null;
    var subject = (kind === 'rsvp' ? 'Brown bag RSVP: ' : 'Brown bag title: ') + presenter + ', ' + labelForIso(date);
    var body = kind === 'rsvp' ? 'I will attend the brown bag on ' + labelForIso(date) + ' (' + presenter + ').\n\nName:\nDietary requirements (optional):'
                               : 'Talk on ' + labelForIso(date) + '\nPresenter: ' + presenter + '\n\nTitle:\nCo-authors (optional):';
    return 'mailto:' + organiserEmail + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function prefilledUrl(cfg, date, presenter) {
    if (!cfg || !cfg.base) return null;
    return cfg.base + '?usp=pp_url&entry.' + cfg.dateEntry + '=' + encodeURIComponent(labelForIso(date)) +
      '&entry.' + cfg.presenterEntry + '=' + encodeURIComponent(presenter);
  }

  function todayIso(tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) {
      var d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
  }

  var helpers = { parseCsv: parseCsv, rowsToObjects: rowsToObjects, normaliseRow: normaliseRow, rowsFromApi: rowsFromApi, groupByDate: groupByDate,
    labelForIso: labelForIso, prefilledUrl: prefilledUrl, actionUrl: actionUrl, todayIso: todayIso, isoFromLoose: isoFromLoose };
  if (typeof module !== 'undefined') module.exports = helpers;
  if (typeof window === 'undefined') return;

  // ---- browser only -------------------------------------------------------
  var CFG = root.BROWNBAG_CONFIG || {};
  var ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6h4"></path></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg>';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function link(href, text) { var a = el('a', null, text); a.href = href; if (href.indexOf('mailto:') !== 0) { a.target = '_blank'; a.rel = 'noopener'; } return a; }

  function renderTalk(group, talk, isPast) {
    var box = el('div', 'talk');
    var slotText = talk.slot === 60 ? '60-minute talk' : '30-minute talk';
    box.appendChild(el('p', 'tag', slotText + (talk.slot === 30 ? ' · ' + talk.start + '–' + talk.end : '')));
    box.appendChild(el('h2', 'speaker', talk.presenter));
    var paper = el('p', 'paper');
    if (talk.title) paper.textContent = talk.title; else paper.appendChild(el('span', 'tba', 'Title TBD'));
    box.appendChild(paper);
    if (!isPast) {
      var actions = el('p', 'actions');
      if (CFG.apiUrl) {
        var toggle = el('a', null, talk.title ? 'Change title' : 'Add title');
        toggle.href = '#';
        toggle.addEventListener('click', function (ev) { ev.preventDefault(); openTitleForm(box, paper, group.date, talk); });
        actions.appendChild(toggle);
      } else {
        var titleUrl = actionUrl('title', CFG.title, group.date, talk.presenter, CFG.organiserEmail);
        if (titleUrl) actions.appendChild(link(titleUrl, 'Add title'));
      }
      if (actions.childNodes.length) box.appendChild(actions);
    }
    return box;
  }

  /** Small form under the talk; submits to the script and shows the title at once. */
  function openTitleForm(box, paper, date, talk) {
    var existing = box.querySelector('.title-form');
    if (existing) { existing.querySelector('input').focus(); return; }
    var form = el('form', 'title-form');
    var titleIn = el('input'); titleIn.type = 'text'; titleIn.required = true; titleIn.maxLength = 300;
    titleIn.placeholder = 'Title of your talk'; titleIn.value = talk.title || ''; titleIn.setAttribute('aria-label', 'Title of your talk');
    var coIn = el('input'); coIn.type = 'text'; coIn.maxLength = 300; coIn.placeholder = 'Co-authors (optional)'; coIn.setAttribute('aria-label', 'Co-authors');
    var emailIn = el('input'); emailIn.type = 'email'; emailIn.required = true; emailIn.maxLength = 200; emailIn.autocomplete = 'email';
    emailIn.placeholder = 'Email you used to sign up'; emailIn.setAttribute('aria-label', 'Email you used to sign up');
    var emailNote = el('p', 'title-form__required', 'Required: enter the email address you used on the sign-up form');
    var row = el('div', 'title-form__row');
    var save = el('button', 'btn', 'Save title'); save.type = 'submit';
    var cancel = el('button', 'btn btn--ghost', 'Cancel'); cancel.type = 'button';
    row.appendChild(save); row.appendChild(cancel);
    var msg = el('p', 'title-form__msg');
    form.appendChild(emailNote); form.appendChild(emailIn); form.appendChild(titleIn); form.appendChild(coIn); form.appendChild(row); form.appendChild(msg);
    cancel.addEventListener('click', function () { form.remove(); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      save.disabled = true; msg.className = 'title-form__msg'; msg.textContent = 'Saving\u2026';
      submitTitle({ action: 'title', date: date, presenter: talk.presenter, email: emailIn.value.trim(), title: titleIn.value.trim(), coauthors: coIn.value.trim() })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || 'not saved');
          talk.title = res.title;
          paper.textContent = res.title;
          form.remove();
          var toggles = box.querySelectorAll('.actions a');
          for (var i = 0; i < toggles.length; i++) if (/title/i.test(toggles[i].textContent)) toggles[i].textContent = 'Change title';
        })
        .catch(function (err) {
          save.disabled = false;
          msg.className = 'title-form__msg is-error';
          msg.textContent = 'Could not save (' + err.message + '). ';
          var backup = actionUrl('title', CFG.title, date, talk.presenter, CFG.organiserEmail);
          if (backup) msg.appendChild(link(backup, 'Send it another way'));
        });
    });
    box.appendChild(form);
    emailIn.focus();
  }

  function submitTitle(payload) {
    return fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' })
      .then(function (res) { return res.json(); });
  }

  function renderOpen(group, start, end, isPast, showLink) {
    var box = el('div', 'talk');
    box.appendChild(el('p', 'tag', (start === '12:00' && end === '13:00') ? 'Open slot' : 'Open 30-minute slot · ' + start + '–' + end));
    box.appendChild(el('h2', 'speaker tbd', 'TBD'));
    if (!isPast && showLink && CFG.signupFormUrl) {
      var actions = el('p', 'actions');
      actions.appendChild(link(CFG.signupFormUrl, 'Sign up for this slot'));
      box.appendChild(actions);
    }
    return box;
  }

  var SIGNUP_LINKS_MAX = 2;   // "Sign up for this slot" only on the earliest open slots

  function renderGroup(group, today, counter) {
    var isPast = group.date < today;
    function openSlot(start, end) {
      var show = !isPast && counter.openLinks < SIGNUP_LINKS_MAX;
      if (show) counter.openLinks++;
      return renderOpen(group, start, end, isPast, show);
    }
    var art = el('article', isPast ? 'is-past' : '');
    var time = el('time');
    time.setAttribute('datetime', group.date);
    var parts = dayParts(group.date);
    time.appendChild(el('strong', null, parts.weekday));
    time.appendChild(el('span', null, parts.short));
    art.appendChild(time);

    var main = el('div');
    if (group.talks.length === 0) main.appendChild(openSlot('12:00', '13:00'));
    group.talks.forEach(function (t) { main.appendChild(renderTalk(group, t, isPast)); });
    if (group.freeHalf) main.appendChild(openSlot(group.freeHalf, group.freeHalf === '12:00' ? '12:30' : '13:00'));
    art.appendChild(main);

    var meta = el('div', 'meta');
    var t = el('span'); t.innerHTML = ICON_CLOCK; t.appendChild(document.createTextNode('12:00–13:00'));
    var p = el('span'); p.innerHTML = ICON_PIN; p.appendChild(document.createTextNode(CFG.room || 'Room 321, Drayton House'));
    meta.appendChild(t); meta.appendChild(p);
    art.appendChild(meta);
    return art;
  }

  function render(groups, today) {
    var frag = document.createDocumentFragment();
    var upcoming = groups.filter(function (g) { return g.date >= today; });
    var past = groups.filter(function (g) { return g.date < today; });
    var lastTerm = null;
    var counter = { openLinks: 0 };
    upcoming.forEach(function (g) {
      if (g.term && g.term !== lastTerm) { frag.appendChild(el('h2', 'term', g.term)); lastTerm = g.term; }
      frag.appendChild(renderGroup(g, today, counter));
    });
    if (!upcoming.length) frag.appendChild(el('p', 'status', 'No upcoming sessions are scheduled yet.'));
    if (past.length) {
      frag.appendChild(el('h2', 'past-heading', 'Past talks'));
      past.forEach(function (g) { frag.appendChild(renderGroup(g, today, counter)); });
    }
    return frag;
  }

  function fetchText(url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      if (text.trimStart().charAt(0) === '<') throw new Error('not CSV');
      if (!/date/i.test(text.split('\n')[0]) || !/presenter/i.test(text.split('\n')[0])) throw new Error('unexpected header');
      return text;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function main() {
    var status = document.getElementById('status');
    var list = document.getElementById('list');
    var signup = document.getElementById('signup-link');
    if (signup && CFG.signupFormUrl) { signup.href = CFG.signupFormUrl; signup.target = '_blank'; signup.rel = 'noopener'; }
    var today = todayIso(CFG.timeZone || 'Europe/London');

    function show(text) {
      var rows = rowsToObjects(parseCsv(text)).map(normaliseRow);
      list.textContent = '';
      list.appendChild(render(groupByDate(rows), today));
    }

    var fallbackUrl = '/brownbag/fallback.csv?_=' + Date.now();
    function showRows(rows) {
      list.textContent = '';
      list.appendChild(render(groupByDate(rows), today));
    }
    var live;
    if (CFG.apiUrl) {
      live = fetch(CFG.apiUrl + '?action=schedule&_=' + Date.now(), { cache: 'no-store', redirect: 'follow' })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (data) { if (!data.ok || !data.rows) throw new Error(data.error || 'bad response'); return rowsFromApi(data.rows); });
    } else if (CFG.csvUrl) {
      live = fetchText(CFG.csvUrl + (CFG.csvUrl.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), 10000).then(function (t) { return rowsToObjects(parseCsv(t)).map(normaliseRow); });
    } else {
      live = fetchText(fallbackUrl, 10000).then(function (t) { return rowsToObjects(parseCsv(t)).map(normaliseRow); });
    }
    live.then(function (rows) {
      showRows(rows); status.textContent = ''; status.className = 'status';
    }).catch(function (err) {
      return fetchText(fallbackUrl, 10000).then(function (text) {
        show(text);
        status.className = 'status warn';
        status.textContent = 'The live schedule could not be loaded. Showing the last saved copy.';
      });
    }).catch(function (err) {
      status.className = 'status error';
      status.textContent = 'The schedule could not be loaded. ';
      if (CFG.sheetUrl) status.appendChild(link(CFG.sheetUrl, 'Open the schedule spreadsheet instead.'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else main();
})(typeof window !== 'undefined' ? window : globalThis);
