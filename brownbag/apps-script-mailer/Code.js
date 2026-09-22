/**
 * Applied Micro Brown Bag: mailer.
 *
 * Runs under appliedmicrobrownbag@gmail.com and does two things:
 *   1. sends an email when the scheduler script asks it to (doPost, shared secret);
 *   2. forwards anything that arrives in the seminar inbox to the organisers.
 *
 * It holds no schedule data and can only send what it is given.
 *
 * Run once after pasting: authorize()  -> grants the permissions and installs the
 * forwarding trigger. It prints the shared secret to paste into the scheduler script.
 */

var ORGANISERS = ['h.avivi@ucl.ac.uk', 'g.ulyssea@ucl.ac.uk'];
var SENDER_NAME = 'Applied Micro Brown Bag';
var REPLY_TO = 'h.avivi@ucl.ac.uk';
var FORWARD_LABEL = 'forwarded-to-organisers';
var MAX_RECIPIENTS = 90;           // Gmail allows ~100 a day on a free account

function props() { return PropertiesService.getScriptProperties(); }

/** One-time setup, run from the editor. */
function authorize() {
  var p = props();
  var secret = p.getProperty('SHARED_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    p.setProperty('SHARED_SECRET', secret);
  }
  GmailApp.getInboxUnreadCount();                       // triggers the Gmail permission prompt
  getOrCreateLabel(FORWARD_LABEL);
  installForwardTrigger();
  console.log('Mailer ready. Shared secret (give this to the scheduler script):');
  console.log(secret);
  console.log('Forwarding replies to: ' + ORGANISERS.join(', '));
}

function installForwardTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'forwardReplies') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('forwardReplies').timeBased().everyMinutes(15).create();
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonOut({ ok: true, service: 'brown bag mailer' });
}

/**
 * POST JSON (as text/plain to avoid a CORS preflight):
 *   { secret, to: [], cc: [], bcc: [], subject, body, test: false }
 * With test:true nothing is sent; the message is echoed back for checking.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData && e.postData.contents || '{}'); } catch (err) { return jsonOut({ ok: false, error: 'bad JSON' }); }
  var secret = props().getProperty('SHARED_SECRET') || (typeof SHARED_SECRET_FILE !== 'undefined' ? SHARED_SECRET_FILE : '');
  if (!secret || body.secret !== secret) return jsonOut({ ok: false, error: 'not authorised' });

  var to = clean(body.to), cc = clean(body.cc), bcc = clean(body.bcc);
  var subject = String(body.subject || '').slice(0, 250);
  var text = String(body.body || '');
  if (!subject || !text) return jsonOut({ ok: false, error: 'subject and body are required' });
  if (!to.length && !bcc.length) return jsonOut({ ok: false, error: 'no recipients' });
  var total = to.length + cc.length + bcc.length;
  if (total > MAX_RECIPIENTS) return jsonOut({ ok: false, error: 'too many recipients (' + total + '), refusing to send' });
  if (body.test) return jsonOut({ ok: true, test: true, to: to, cc: cc, bccCount: bcc.length, subject: subject });

  var quota = MailApp.getRemainingDailyQuota();
  if (quota < total) return jsonOut({ ok: false, error: 'daily quota too low (' + quota + ' left, need ' + total + ')' });

  GmailApp.sendEmail(to.join(','), subject, text, {
    cc: cc.join(','), bcc: bcc.join(','), name: SENDER_NAME, replyTo: REPLY_TO
  });
  return jsonOut({ ok: true, sent: { to: to.length, cc: cc.length, bcc: bcc.length }, quotaLeft: quota - total });
}

function clean(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (x) {
    var e = String(x || '').trim().toLowerCase();
    if (!e || e.indexOf('@') < 0 || seen[e]) return;
    seen[e] = true; out.push(e);
  });
  return out;
}

/**
 * Forwards anything new in the inbox to the organisers, unless they are already on it.
 * Nothing is deleted, so the seminar inbox keeps the full record.
 */
function forwardReplies() {
  var label = getOrCreateLabel(FORWARD_LABEL);
  var threads = GmailApp.search('in:inbox -label:' + FORWARD_LABEL, 0, 25);
  var forwarded = 0;
  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var last = messages[messages.length - 1];
    var everyone = (last.getTo() + ',' + last.getCc() + ',' + last.getBcc() + ',' + last.getFrom()).toLowerCase();
    var alreadyThere = ORGANISERS.every(function (o) { return everyone.indexOf(o.toLowerCase()) >= 0; });
    if (!alreadyThere) {
      try {
        last.forward(ORGANISERS.join(','), { name: SENDER_NAME, replyTo: last.getFrom(),
          htmlBody: '<p style="color:#555">Forwarded from the brown bag inbox.</p>' + last.getBody() });
        forwarded++;
      } catch (err) { console.error('could not forward: ' + err); }
    }
    thread.addLabel(label);
    thread.markRead();
  });
  if (forwarded) console.log('forwarded ' + forwarded + ' message(s)');
}

/** Handy check from the editor: sends one email to the organisers. */
function sendTestToOrganisers() {
  GmailApp.sendEmail(ORGANISERS.join(','), 'Brown bag mailer: test',
    'This is a test from the brown bag mailer. Replies go to ' + REPLY_TO + '.',
    { name: SENDER_NAME, replyTo: REPLY_TO });
  console.log('test sent to ' + ORGANISERS.join(', '));
}

function showSecret() { console.log(props().getProperty('SHARED_SECRET') || '(not set: run authorize first)'); }
