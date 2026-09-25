# Applied Micro Brown Bag: how this all works

UCL Applied Micro Brown Bag seminar, Mondays 12:00 to 13:00, Room 321, Drayton House, lunch
provided. Organised by Hadar Avivi and Gabriel Ulyssea. Built September 2026.

---

## Rule that overrides everything else

**Never send, read, or search email from Hadar's personal Gmail (avivihadar@gmail.com), and never
from their UCL mailbox.** All seminar email goes through the dedicated account
**appliedmicrobrownbag@gmail.com**, which is the only account holding a mail permission.

- Hadar's account authorises the *scheduler* script, which has no mail permission at all. It can
  reach the mailer over the web and nothing else.
- The *mailer* script, in the seminar account, is the only code that can send. It also forwards
  anything arriving in that inbox to Hadar and Gabriel.
- Do not add a Gmail or Mail scope to the scheduler's `appsscript.json`.
- Do not use the Gmail connector on Hadar's account for anything to do with this seminar.
- Before sending anything new, show Hadar the exact text first and wait for their word.

## Always work from live data

**Before answering any question about who is presenting, who has signed up, how many people are on
the mailing list, or what dates are free, fetch the current state first.** Never answer from what
was true earlier in the conversation. The daily job runs at noon and people submit forms all day,
so anything more than a few minutes old is probably wrong.

Cheapest ways to look:

- `?action=schedule` on the scheduler's web address returns the whole schedule as JSON.
- `?action=admin&secret=<secret>&task=stats` returns mailing-list, sign-up and RSVP counts.
- `?action=admin&secret=<secret>&task=findSignup&q=<name>` looks one person up and says whether
  they have a slot.

This happened once already: Claude told Hadar that 19 October had a free half hour, from data
read the day before, when the noon job had since filled it. Hadar had to correct it.

## Working agreements

- Hadar is an economist, not a developer. Explain in plain words; never ask them to hunt through
  logs or paste secrets if a script can do it.
- Do as much as possible without handing Hadar manual steps. Only a first authorisation click
  genuinely requires them; everything else runs through the admin actions below.
- Do not run `setup()` again. It is written to be safe, but the maintenance actions are better.

---

## The pieces

| What | Where |
|---|---|
| Public schedule page | https://avivihadar.github.io/brownbag/ (noindex, not linked from the rest of the site) |
| Page source | `~/Library/CloudStorage/Dropbox/Berkeley/avivihadar.github.io/brownbag/` on branch `master` |
| Schedule spreadsheet (public-ish, Hadar's account) | id `1FrSTTmb1R0YVlutTZnPVyiFJUjh6wYJrH_EHCxTHRg8`, tabs **Schedule**, **Config** |
| Responses spreadsheet (private, holds emails) | id `1Q5JzJnDdLg5wwlLByaMv5FYDdSHgZpWzUOioJGJ0BB0`, tabs **Form Responses 1**, **RSVP Responses**, **Title Responses**, **Mailing list**, **People**, **Placements**, **Unplaced**, **Log** |
| Scheduler script (Hadar's account) | id `1Jos6LVlbCYb7GCl9Mngq5uvw9_Ndlu7rz-RwlV2JcOGoozumiyew7wsY`, sources in `brownbag/apps-script/` |
| Mailer script (seminar account) | id `1Qc5dDSoCRt10ItUYkaiyC1_JC4dPM4vN4x-JUexam2R1kSlFDNDbT1vS`, sources in `brownbag/apps-script-mailer/` |

### Forms

| Form | Link |
|---|---|
| Sign up to present | https://docs.google.com/forms/d/e/1FAIpQLSfdBgTn2Ln4IKRCTGZX0hZfnHl9VnV4VkI3GKJek_HyDbyhzQ/viewform |
| RSVP for lunch | https://docs.google.com/forms/d/e/1FAIpQLSdukYj3saIX5hNFU8EnkDCwHfXcNOgT4MPUa8zB76wJJsqO7w/viewform |
| Add a talk title | https://docs.google.com/forms/d/e/1FAIpQLSdHPYqarvUvaGP7Rw8H5oQTNbjryGpXJ93zWxNeYfIZZ0o_nQ/viewform |
| Join the mailing list | https://docs.google.com/forms/d/e/1FAIpQLSexb298J0nS1EHHr6TFDm1Mb7_p__6jrb1cM3ELMC7F1MR3jA/viewform |

The sign-up form asks: full name, email, position (PhD student / Postdoc / Visiting student /
Visiting faculty / Faculty), affiliation, which Mondays, slot length, advisors, dietary needs and
an optional talk title. Its list of Mondays is maintained by the job, never by hand.

### Web addresses of the scripts

- Scheduler: `https://script.google.com/macros/s/AKfycbxeGbFJ73Pc5G48M6j99deH7JyHIXKf0fRw6ikPyWLOJBcz_JqQY2PBXBNVwYt53X1W/exec`
- Mailer: `https://script.google.com/macros/s/AKfycbwoCFygglt_F7IF9L86djMmfKnxDw6dIOo_D39n5fWNQI0MO1LzXVpHb_RqD_9YWA0oiQ/exec`

The shared secret lives in `Secret.js` inside each Apps Script project. It is **not** in the git
repo (`.gitignore` excludes `brownbag/**/Secret.js`). Never print it in chat or commit it.

---

## Scheduled tasks (all Europe/London)

| When | What happens |
|---|---|
| Every day, 12:00 | `dailyJob`: places new sign-ups, merges titles, counts RSVPs, adds or drops Mondays to match `SEMINAR_DATES`, prunes the sign-up form's dates, writes a summary to the **Log** tab |
| Monday, 09:00 | Reminder to next Monday's presenter(s). Asks for a title if none is on file. Students are told they may invite faculty to their talk. |
| Thursday, 12:00 | The exact draft of the 13:00 announcement goes to Hadar alone. Silence means it goes out as it stands. To stop it, set `pause_emails` to `yes` on the Config tab. |
| Thursday, 13:00 | Announcement to the mailing list in Bcc: presenter with affiliation, title, lunch RSVP link, Friday noon deadline, open slots if any, unsubscribe line. **Nothing is sent when the coming Monday has no presenter.** |
| Friday, 12:00 | Lunch count and the list of names, to Hadar and Gabriel |
| Every 15 minutes (mailer) | Forwards new mail in the seminar inbox to Hadar and Gabriel unless both are already on it |

Every email is cc'd to Hadar and Gabriel and has its reply-to set to the seminar inbox.

**Approval and failures.** No email goes to the mailing list without Hadar seeing it first: the draft
arrives an hour ahead. If a send fails, Hadar gets an email saying which one, the error and the full
text that was not sent, and the failure is written to the Log tab. The Log records the recipient
count of every successful send, so a send can be confirmed after the fact.

## Scheduling rules

- Each Monday holds 60 minutes: one 60-minute talk, or two 30-minute talks at 12:00 and 12:30.
- Placement **maximises the number of people seated**, not first-come order. Ties go to earlier
  dates and earlier sign-ups. This stops a flexible early sign-up from blocking an inflexible one.
- Placements are sticky. A person already on the **Placements** ledger is never moved automatically,
  unless they submit a newer sign-up, in which case their old slot is released and they are placed
  again from the new answers.
- A date leaves the sign-up form `MIN_LEAD_DAYS` (currently 3) before it happens, or when full.
- The Schedule tab is the source of truth and can be hand-edited. The job never deletes or moves a
  presenter row.

## Maintenance actions

Call the scheduler's web address with `?action=admin&secret=<secret>&task=<task>`:

`updateSignupForm`, `seedPeopleTab`, `setPerson` (name, role, affiliation), `fixSignup` (match,
name, email), `clearPlacement` (name, optional date), `createMailingListForm`, `removeFormQuestion`,
`renameFormQuestion`, `sendPresenterReminder` (date), `previewFor` (date, returns the drafts as
text), `installTriggers`, `listTriggers`, `stats` (quick counts),
`addToMailingList` (people as "Name <email>; ..."), `addPresentersToMailingList`.

The mailer refuses more than 90 recipients in one message, and a free Gmail account can send to
about 100 a day. When the mailing list passes roughly 85, move it to a Google Group address.

`?action=run` runs the daily job immediately, at most once every ten minutes.
`?action=schedule` returns the schedule as JSON; this is what the web page reads.

## Changing the code

Sources live in the site repo. After editing:

```
cd brownbag/apps-script && npm test          # 46 tests, no Google account needed
# then push and redeploy with clasp (Hadar is logged in as both accounts)
```

`scheduler.js` holds all the rules as pure functions and is covered by tests. `Code.js` is the
Google glue. Changes to the web app need a new deployment version; the address stays the same.

## Things that have gone wrong before

- A presenter typed their surname into the email box, which created a duplicate booking. The job
  now logs a warning when a sign-up's email is not an address. Repair with `fixSignup`.
- Permissions must be granted by the account that owns the script, one click in the editor, and
  only when the code actually uses the permission.
- Sheets can turn `2026-10-05` and `12:00` into date and time values. The columns are formatted as
  plain text and the code re-reads them in the spreadsheet's own time zone.
