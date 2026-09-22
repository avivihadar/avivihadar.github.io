# Brown bag scheduler (Apps Script)

The schedule page at `https://avivihadar.github.io/brownbag/` reads the **Schedule** tab of the
public spreadsheet *Applied Micro Brown Bag Schedule 2026/27*. A Google Apps Script bound to that
spreadsheet runs every day at 12:00 London time and:

1. places new sign-ups from the sign-up form into the earliest date they ticked that still has room
   (60-minute talks need an empty Monday; 30-minute talks take 12:00, then 12:30);
2. fills in titles: first from the optional title question on the sign-up form, then from the
   "talk title" form (the latest submission there wins);
3. counts RSVPs per date (for lunch ordering);
4. removes past and fully booked dates from the sign-up form;
5. emails the organiser a summary, but only when something changed.

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
4. Publish the Schedule tab: File > Share > Publish to web > pick **Schedule** (not "Entire
   document") and **Comma-separated values (.csv)** > Publish. Copy the link and send it to Claude;
   it goes into `brownbag/config.js` on the website.
5. Run `dryRun` to see what the job would do, then `dailyJob` to do it. Check the summary email and
   the sign-up form (only future, open dates should remain).

Alternative to pasting: run `npx @google/clasp login` once, enable the Apps Script API at
https://script.google.com/home/usersettings, and Claude can push these files with `clasp`.

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
