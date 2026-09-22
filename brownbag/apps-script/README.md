# Brown bag scheduler (Apps Script)

The schedule page at `https://avivihadar.github.io/brownbag/` reads the **Schedule** tab of the
public spreadsheet *Applied Micro Brown Bag Schedule 2026/27* through the script's web app
(`doGet`), and presenters' titles typed on the page go straight into that tab (`doPost`), so a
title shows on the page immediately. The same Apps Script runs every day at 12:00 London time and:

1. places new sign-ups from the sign-up form into the earliest date they ticked that still has room
   (60-minute talks need an empty Monday; 30-minute talks take 12:00, then 12:30);
2. fills in titles: first from the optional title question on the sign-up form, then from the
   "talk title" form (the latest submission there wins);
3. counts RSVPs per date (for lunch ordering);
4. removes past and fully booked dates from the sign-up form;
5. writes a summary of what changed to the **Log** tab of the private spreadsheet (the script
   sends no email and has no email permission).

Everything with an email address stays in the private sign-up spreadsheet
(*Applied Micro Brown Bag Sign-up 2026/27 (Responses)*): the form responses, the **Placements**
ledger, the **Unplaced** list and the **Log**.

## One-time setup (about 10 minutes)

1. Open the public spreadsheet *Applied Micro Brown Bag Schedule 2026/27*.
2. Extensions > Apps Script. In the editor:
   - Project Settings (gear icon) > tick "Show appsscript.json manifest file in editor".
   - Replace the contents of `appsscript.json` with the file here.
   - Replace `Code.gs` with `Code.js` from this folder.
   - Add a file (+ > Script) named `scheduler` and paste `scheduler.js`.
   - Save (Ctrl/Cmd+S).
3. Pick `setup` in the function dropdown and press Run. Approve the permissions
   (Advanced > Go to project if Google warns the app is unverified: it is your own script).
   This creates the RSVP and title forms, adds an optional "Title of your talk" question to the
   sign-up form, creates the private tabs, the Config tab and the daily trigger.
4. Run `dryRun` to see what the job would do, then `dailyJob` to do it. Check the Log tab and
   the sign-up form (only future, open dates should remain).

The script was in fact uploaded with `clasp` (script id in `.clasp.json`). To update it after editing
the files here: `cd brownbag/apps-script && npx @google/clasp push -f`. Changes to `doGet`/`doPost`
also need a new version of the web app deployment:
`npx @google/clasp deploy -i AKfycbxeGbFJ73Pc5G48M6j99deH7JyHIXKf0fRw6ikPyWLOJBcz_JqQY2PBXBNVwYt53X1W --description "update"`.
The deployment URL (in `brownbag/config.js` as `apiUrl`) stays the same.

## Who is who

The sign-up form asks for **position** (PhD student, Postdoc, Visiting student, Visiting faculty,
Faculty) and **affiliation**. Both appear in the emails: the announcement and the lunch count show
"Name (Affiliation)", and only presenters whose position contains "student" get the line about
inviting faculty to their talk.

People who signed up before those questions existed are covered by a **People** tab in the private
spreadsheet (`name | role | affiliation`). `seedPeopleTab()` fills it from the current schedule,
defaulting everyone to UCL; edit it there when someone is not at UCL.

## Emails

The scheduler never sends email itself. It asks the **mailer** script, which runs under
appliedmicrobrownbag@gmail.com (see `brownbag/apps-script-mailer/`), over https with a shared
secret. Three messages, all cc'ing Hadar and Gabriel, with replies directed to Hadar:

| When | What |
|---|---|
| Monday 09:00 | reminder to next Monday's presenter(s); asks for a title if we have none; students are told they may invite faculty in their field |
| Thursday 13:00 | announcement to the mailing list (Bcc) with the talk, the lunch RSVP link and the Friday noon deadline; mentions open slots when there are any |
| Friday 12:00 | lunch count and the list of names to the organisers |

Nothing is sent in a week where the coming Monday has no presenter.

`previewFor('2026-10-01')` prints exactly what would go out on that date without sending anything.
`previewEmails()` does the same for today and logs it. `sendScheduledEmails()` sends for real.
The mailer address and secret live in Script Properties as `MAILER_URL` and `MAILER_SECRET`
(set them with `setMailer(url, secret)`); `installTriggers()` installs all four triggers.

## Running the job before noon

Open this address in a browser (or ask Claude to): the script's web app URL from `brownbag/config.js`
with `?action=run` appended. It runs the same job as the noon trigger, at most once every ten
minutes, and replies with a short JSON summary. The Log tab records the run like any other.

## Editing the schedule by hand

The Schedule tab is the source of truth. The job never deletes or moves a presenter row.

- **Swap or move someone**: edit the row. Keep dates as `yyyy-mm-dd` and times as `HH:MM`.
- **Drop someone**: delete their row (or blank the presenter). They will *not* be re-added
  automatically because they stay in the Placements ledger.
- **Re-place someone from their sign-up**: delete their row in the Placements ledger; the next run
  places them again.
- **Add a talk that did not come through the form** (faculty, visitors): add a row with `slot_min`
  30 or 60. Leave `presenter` blank for an open slot; blank shows as "TBD" on the page; a blank title shows as "Title TBD".
- **Cancel a week**: delete all rows for that date.
- **Fix a wrong title**: edit the row in *Title Responses* in the private spreadsheet, or ask the
  presenter to resubmit. A title typed straight into the Schedule tab is overwritten by the latest
  form response for that talk, if there is one.
- Avoid editing between 12:00 and 13:00, when the job runs.

## Columns of the Schedule tab

`date, term, start, end, presenter, slot_min, title, rsvps, notes`. Two 30-minute talks on the same
Monday are two rows. `notes` is not shown on the web page but is public, so no personal details.

## Tests

`npm test` runs the scheduling logic under Node (no Google account needed).
