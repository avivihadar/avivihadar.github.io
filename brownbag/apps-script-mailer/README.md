# Brown bag mailer (Apps Script under appliedmicrobrownbag@gmail.com)

This small script is the only thing that sends email for the seminar. It lives in the seminar
Gmail account, so nothing is ever sent from a personal account.

It does two jobs:

1. **Sends** an email when the scheduler script asks it to. Requests must carry a shared secret,
   so only that script can use it. It refuses more than 90 recipients in one message and checks
   the remaining daily quota first.
2. **Forwards** anything that arrives in the seminar inbox to Hadar and Gabriel, every 15 minutes,
   unless both are already on the message. Threads are labelled `forwarded-to-organisers` and
   marked read; nothing is deleted.

Addresses and the sender name are the constants at the top of `Code.js`.

## Setup (once)

1. Sign in as appliedmicrobrownbag@gmail.com and open https://script.google.com
2. New project, name it "Brown bag mailer". Show `appsscript.json` under Project Settings and
   replace both files with the ones here.
3. Run `authorize`. Approve the permissions (Advanced > Go to project > Allow). The log prints a
   shared secret.
4. Deploy > New deployment > Web app; execute as yourself, access "Anyone". Copy the /exec URL.
5. Give the secret and the URL to the scheduler script (Claude does this, or paste them into the
   scheduler's Script Properties as `MAILER_URL` and `MAILER_SECRET`).

`sendTestToOrganisers` sends one test email. `showSecret` prints the secret again.
