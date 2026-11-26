/**
 * Dance & All That Jazz: admin Publish backend
 *
 * One script, two web app deployments (tools/deploy-admin.js sets both up and keeps their URLs):
 *   signin  : Execute as Me, Only myself. Opening it with the owner's Google account gives the admin a sign-in
 *             pass (good for 12 hours) and sends her back to the admin page. Anyone else gets plain text.
 *   public  : Execute as Me, Anyone. The admin page posts here (text/plain, so no CORS preflight). Every action
 *             checks the sign-in pass first and answers only the owner.
 *
 * Publish: checks the content on the server, saves it as a new version on the History tab (the full draft,
 * including the private parts, which stay in this Sheet), then writes the public part to content.json in the
 * site's GitHub repo, in one commit with the re-encrypted company.enc.json / recital.enc.json when those changed.
 * The website reads content.json.
 *
 * Private parts never go into content.json: Company Central edits (coEdit), the calendar sheet link, the details of
 * "Company families only" dates, and the Annual Performance "More details". The admin encrypts them in the browser
 * with the current Company / Families passwords (kept in Script Properties, given only to the owner) and sends the sealed files;
 * this script only checks their shape and refuses a publish that changes private parts without them.
 *
 * Script Properties (Project Settings → Script Properties), typed by hand:
 *   GITHUB_TOKEN    fine-grained token: only the site repo, Contents read and write
 *   GITHUB_REPO     owner/name, e.g. leighagrimm-web/datj-test
 *   GITHUB_BRANCH   main
 *   ADMIN_PAGE_URL  the admin page, e.g. https://leighagrimm-web.github.io/datj-test/admin.html
 *   ENVIRONMENT     TEST or LIVE
 *   LOCK_PW_COMPANY / LOCK_PW_FAMILIES  the passwords families use now (Company Central / Annual Performance
 *                   details). Optional: if missing, the admin asks once and saves them here. A new season's
 *                   password set in the admin is saved here by Publish, only after the re-locked file is live.
 * Set from the admin (Admin access, owner only):
 *   ADMIN_HELPERS   Google emails of people who can also use the admin (comma-separated)
 * Set by setup() (run once from the editor, signed in as the owner):
 *   OWNER_EMAIL     the Google account allowed into the admin
 *   SIGNIN_SECRET   random key that signs the sign-in passes
 */

var HISTORY = 'History';
var HEAD = ['Version', 'Published', 'By', 'Size (KB)', 'What changed', 'Website', 'Data'];
var DATA_COL = 7;          // the content JSON starts here, split into pieces across columns
var CHUNK = 45000;         // a cell holds at most 50,000 characters
var PASS_HOURS = 12;
var MAX_BYTES = 3000000;   // the whole draft
var MAX_PUBLIC_BYTES = 1500000;
var MAX_ENC_BYTES = 4000000;
// Photos the admin shrank in the browser arrive inside the draft as data: links. Publish saves each one as a file
// in the site (named by its contents, so the same photo is one file) and the content points to that file instead.
var PHOTO_DIR = 'images/up/';
var MAX_PHOTO_BYTES = 1500000;
var MAX_NEW_PHOTO_BYTES = 15000000;
var PHOTO_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+\/]+=*)$/;
// Encrypted files Publish may write, by what they protect
var ENC_FILES = { company: 'company.enc.json', recital: 'recital.enc.json' };
var ENC_NAMES = { company: 'Company Central (Company password)', recital: 'Annual Performance details (Families password)' };

// Top-level keys the admin's pick() produces, and their types. Anything else is dropped.
var KEYS = {
  recital: 'boolean', season: 'object', calSheet: 'string', banner: 'object', home: 'object', nav: 'array',
  prices: 'object', photos: 'object', featured: 'array', calendar: 'array', coEdit: 'objectOrNull',
  policies: 'array', rc: 'array', lists: 'object', texts: 'object', teachers: 'object', staffV: 'number', staff: 'array'
};
// What the public website reads. Company Central edits (coEdit) and the calendar sheet link stay private.
var PUBLIC_KEYS = ['recital', 'season', 'banner', 'home', 'nav', 'prices', 'photos', 'featured', 'calendar',
  'policies', 'rc', 'lists', 'texts', 'teachers', 'staffV', 'staff'];
var SECTION_NAMES = {
  recital: 'Annual Performance switch', season: 'Between seasons page', calSheet: 'Calendar sheet link', banner: 'Top banner',
  home: 'Home', nav: 'Menu', prices: 'Sessions & prices', photos: 'Photos', featured: 'Featured events', calendar: 'Studio calendar',
  coEdit: 'Company Central', policies: 'Policies', rc: 'Annual Performance', lists: 'Page cards', texts: 'Page text',
  teachers: 'Teachers', staffV: '', staff: 'Instructors & staff'
};
var NAV_IDS = ['classes', 'pricing', 'company', 'about', 'families', 'shop'];

// ---------------------------------------------------------------- one-time setup (run from the editor)

function setup() {
  var p = PropertiesService.getScriptProperties();
  var me = Session.getEffectiveUser().getEmail();
  p.setProperty('OWNER_EMAIL', String(me).toLowerCase());
  if (!p.getProperty('SIGNIN_SECRET')) p.setProperty('SIGNIN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  historySheet_();
  var need = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'ADMIN_PAGE_URL', 'ENVIRONMENT'].filter(function (k) { return !p.getProperty(k); });
  console.log('Owner: ' + me + '. History tab ready.' + (need.length ? ' Still to add in Script Properties: ' + need.join(', ') : ' All Script Properties are set.'));
}

// Run from the editor after adding the token: checks the repo can be read with it (writes nothing).
function checkGitHub() {
  var c = gh_();
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + c.repo, { headers: c.headers, muteHttpExceptions: true });
  noteKeyExpiry_(r);
  var j = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() !== 200) throw new Error('GitHub said ' + r.getResponseCode() + ': ' + (j.message || ''));
  console.log('OK: ' + j.full_name + (j.permissions && j.permissions.push ? ' (can write)' : ' (read only: the token needs Contents read and write)')
    + '. Key expires: ' + (prop_('GITHUB_TOKEN_EXPIRES') || 'never (or GitHub didn’t say)'));
}

// The GitHub key (GITHUB_TOKEN) has its own end date. GitHub sends it with every answer; keep it so the admin can warn
// 30 days ahead (load_ returns it), and turn "401" into words Brittany can act on.
var KEY_EXPIRED = 'The website’s publishing key (the GitHub key) has expired or was removed, so the site can’t be updated. Ask Leigha to renew it; it takes about 5 minutes.';
function noteKeyExpiry_(r) {
  try {
    var h = r.getAllHeaders ? r.getAllHeaders() : r.getHeaders(), v = '';
    Object.keys(h).forEach(function (k) { if (k.toLowerCase() === 'github-authentication-token-expiration') v = String(h[k]); });
    var m = /(\d{4}-\d{2}-\d{2})/.exec(v); if (!m) return;
    if (prop_('GITHUB_TOKEN_EXPIRES') !== m[1]) PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN_EXPIRES', m[1]);
  } catch (e) {}
}

// ---------------------------------------------------------------- web apps

// signin deployment: runs as whoever opens it ("Anyone with a Google account"), and its only permission is their
// email address. The owner and the helpers on ADMIN_HELPERS get a signed pass; everything else then runs as the
// owner in the public deployment, so helpers never need access to the Sheet, Drive or GitHub.
// The URL holds no return address: the pass only ever goes to ADMIN_PAGE_URL.
function doGet(e) {
  // A dancer calendar link (public deployment): see Feed.gs. The code is ?cal=… because Google reserves ?c= on
  // Apps Script addresses (it answers ?c= with its own "page not found")
  if (e && e.parameter && e.parameter.cal) return feedGet_({ c: e.parameter.cal, s: e.parameter.s });
  var me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!me) return text_('Sign in with a Google account to open the studio admin.');
  if (!allowed_(me)) return text_('The Google account ' + me + ' isn’t on the studio admin’s list. Ask the studio owner to add it under Admin access, then open this link again.');
  var adminUrl = prop_('ADMIN_PAGE_URL');
  if (!/^https:\/\//.test(adminUrl)) return text_('The admin page address (ADMIN_PAGE_URL) isn’t set up yet.');
  var t = HtmlService.createTemplate(SIGNIN_HTML);
  t.href = adminUrl + '#signin=' + makePass_(me);
  t.email = me;
  t.env = prop_('ENVIRONMENT') || 'TEST';
  return t.evaluate().setTitle('Sign in · Studio admin').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// public deployment. Body: {"action": "load" | "publish" | "history", "pass": "...", ...}
function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'That request couldn’t be read.' }); }
  // Company Central asking for a dancer calendar link: no admin pass, it proves the Company password instead (Feed.gs)
  if (req.action === 'subscribe') { try { return json_(feedSubscribe_(req)); } catch (err) { console.error('subscribe', err); return json_({ ok: false, error: 'Couldn’t make the link. Try again in a minute.' }); } }
  var who = checkPass_(req.pass);
  if (!who.ok) return json_({ ok: false, code: 'signin', error: who.error });
  try {
    if (req.action === 'load') return json_(load_(who));
    if (req.action === 'helpers') return json_(who.owner ? saveHelpers_(req) : { ok: false, error: 'Only the studio owner can change who has access.' });
    if (req.action === 'publish' && req.newLocks && Object.keys(req.newLocks).some(function (k) { return req.newLocks[k]; }) && !who.owner)
      return json_({ ok: false, code: 'invalid', error: 'Only the studio owner can change the Company or Families password.' });
    if (req.action === 'publish') return json_(publish_(who.email, req));
    if (req.action === 'history') return json_({ ok: true, versions: history_(20) });
    if (req.action === 'savelock') return json_(saveLock_(req));
    if (req.action === 'locks') return json_({ ok: true, locks: locks_() });
    // The Company sheet's rehearsals, days off and groups, for Publish to put in the locked Company file (Feed.gs)
    if (req.action === 'sheettabs') return json_(sheetTabs_(req));
    if (req.action === 'saveclasses') return json_(saveClasses_(req));
    if (req.action === 'companysheet') { var cs = readCompanySheet_({ sheet: String(req.sheet || ''), compSheet: String(req.compSheet || '') });
      return json_({ ok: cs.ok, rehearsals: cs.rehearsals, off: cs.off, groups: cs.groups, error: cs.error }); }
    return json_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error(req.action, err && err.stack || err);
    return json_({ ok: false, error: 'Something went wrong on the server: ' + (err && err.message || err) });
  }
}

// ---------------------------------------------------------------- owner and sign-in passes

function prop_(k) { return String(PropertiesService.getScriptProperties().getProperty(k) || ''); }
function ownerEmail_() { return prop_('OWNER_EMAIL').toLowerCase(); }
function helpers_() { return prop_('ADMIN_HELPERS').toLowerCase().split(/[\s,;]+/).filter(function (x) { return EMAIL_RE.test(x); }); }
function allowed_(email) { return !!email && (email === ownerEmail_() || helpers_().indexOf(email) > -1); }
var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;

// Admin access (owner only): replaces the helper list. Takes effect at once, since every action checks it.
function saveHelpers_(req) {
  var list = Array.isArray(req.emails) ? req.emails : [];
  if (list.length > 20) return { ok: false, error: 'That’s more than 20 people. Remove some first.' };
  var out = [], bad = [];
  list.forEach(function (x) {
    var e = String(x || '').trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e) || e.length > 120) bad.push(String(x).slice(0, 60));
    else if (e !== ownerEmail_() && out.indexOf(e) < 0) out.push(e);
  });
  if (bad.length) return { ok: false, error: 'That doesn’t look like an email address: ' + bad.join(', ') };
  PropertiesService.getScriptProperties().setProperty('ADMIN_HELPERS', out.join(','));
  return { ok: true, helpers: out };
}

function sign_(s) {
  var key = prop_('SIGNIN_SECRET');
  if (!key) throw new Error('Run setup() once from the editor first.');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, key)).replace(/=+$/, '');
}
function makePass_(email) {
  var body = Utilities.base64EncodeWebSafe(JSON.stringify({ e: email, x: Date.now() + PASS_HOURS * 3600000 }), Utilities.Charset.UTF_8).replace(/=+$/, '');
  return body + '.' + sign_(body);
}
function checkPass_(pass) {
  var bad = { ok: false, error: 'Please sign in again.' };
  if (typeof pass !== 'string' || pass.length > 600 || pass.indexOf('.') < 0) return bad;
  var parts = pass.split('.');
  if (parts.length !== 2 || !safeEqual_(sign_(parts[0]), parts[1])) return bad;
  var data;
  try { data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0] + '=='.slice(0, (4 - parts[0].length % 4) % 4))).getDataAsString()); } catch (err) { return bad; }
  if (!data || data.x < Date.now()) return { ok: false, error: 'Your sign-in timed out. Please sign in again. Your changes are still here.' };
  var email = String(data.e).toLowerCase();
  if (!allowed_(email)) return { ok: false, error: 'This Google account isn’t on the admin’s list any more. Ask the studio owner.' };
  return { ok: true, email: email, owner: email === ownerEmail_() };
}
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------------- load / publish / history

function load_(who) {
  var last = lastVersion_();
  return { ok: true, email: who.email, owner: who.owner, ownerEmail: ownerEmail_(), helpers: who.owner ? helpers_() : null,
    env: prop_('ENVIRONMENT') || 'TEST', version: last ? last.version : 0,
    publishedAt: last ? last.at : '', by: last ? last.by : '', content: last ? last.content : null, locks: locks_(), feedKey: feedKey_(), keyExpires: prop_('GITHUB_TOKEN_EXPIRES') || '' };
}

// The Company and Families passwords, kept here so Brittany's admin can re-lock details without typing them.
// Only the signed-in owner ever gets them (every action checks the pass first). Never written to the repo.
var LOCK_PROPS = { company: 'LOCK_PW_COMPANY', recital: 'LOCK_PW_FAMILIES' };
var LOCK_CHANGED = { company: 'New Company password', recital: 'New Families password' };
function locks_() { var o = {}; Object.keys(LOCK_PROPS).forEach(function (k) { o[k] = prop_(LOCK_PROPS[k]); }); return o; }
// The admin saves a password here only after it has opened the current locked file with it.
function saveLock_(req) {
  if (!LOCK_PROPS[req.which] || typeof req.pw !== 'string' || !req.pw || req.pw.length > 200) return { ok: false, error: 'That password can’t be saved.' };
  PropertiesService.getScriptProperties().setProperty(LOCK_PROPS[req.which], req.pw);
  return { ok: true };
}

function publish_(email, req) {
  var check = validate_(req.content);
  if (check.errors.length) return { ok: false, code: 'invalid', error: 'Some things need fixing before this can go live:', errors: check.errors.slice(0, 12) };
  var photos = takePhotos_(check.content);
  if (photos.errors.length) return { ok: false, code: 'invalid', error: 'Some photos need fixing before this can go live:', errors: photos.errors.slice(0, 12) };
  var full = photos.content;
  var fullText = JSON.stringify(full);
  if (fullText.length > MAX_BYTES) return { ok: false, error: 'This is too big to publish (' + Math.round(fullText.length / 1024) + ' KB). A photo may be saved inside the text; use a photo link instead.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, code: 'busy', error: 'Another publish is still running. Try again in a moment.' };
  try {
    var last = lastVersion_();
    var latest = last ? last.version : 0;
    // Published from another device (or another tab) since this draft was opened.
    if (!req.force && Number(req.baseVersion || 0) !== latest) {
      return { ok: false, code: 'stale', latest: latest, publishedAt: last ? last.at : '', by: last ? last.by : '',
        error: 'Version ' + latest + ' was published from another device or tab after you opened the admin.' };
    }
    var changed = last ? changedSections_(last.content, full) : ['First version'];
    // A new season's password: the file comes re-locked with it, and it's saved here once that file is live.
    var newPw = {}, pwErr = [];
    Object.keys(LOCK_PROPS).forEach(function (k) {
      var x = req.newLocks && req.newLocks[k];
      if (x == null || x === '') return;
      if (typeof x !== 'string' || x.trim() !== x || x.length < 6 || x.length > 60) pwErr.push(LOCK_CHANGED[k] + ': use 6 to 60 characters, with no spaces at the start or end.');
      else { newPw[k] = x; if (changed.indexOf(LOCK_CHANGED[k]) < 0) changed.push(LOCK_CHANGED[k]); }
    });
    var after = locks_(); Object.keys(newPw).forEach(function (k) { after[k] = newPw[k]; });
    if (after.company && after.company === after.recital) pwErr.push('The Company and Families passwords need to be different, or every family could open Company Central.');
    if (pwErr.length) return { ok: false, code: 'invalid', error: 'Some things need fixing before this can go live:', errors: pwErr };
    // Only a re-locked file (e.g. new rehearsals from the Company sheet) still goes out as a version
    if (last && !changed.length && req.enc && Object.keys(req.enc).some(function (k) { return req.enc[k]; }))
      changed.push(req.enc.company ? 'Company Central (from the Company sheet)' : 'Annual Performance details');
    if (last && !changed.length) return { ok: true, unchanged: true, version: latest, publishedAt: last.at, content: last.content };

    // Private parts that changed must come with their re-encrypted file, or families would keep seeing the old ones.
    var enc = {}, encErr = [], need = [];
    Object.keys(ENC_FILES).forEach(function (k) {
      var x = req.enc && req.enc[k];
      if (x != null) { var v = sealed_(x); if (v) enc[k] = v; else encErr.push(ENC_NAMES[k] + ': the locked file isn’t in the expected format.'); }
      else if (privateKey_(k, last ? last.content : null) !== privateKey_(k, full)) need.push(k);
    });
    Object.keys(newPw).forEach(function (k) { if (!enc[k]) encErr.push(LOCK_CHANGED[k] + ': the file locked with it is missing.'); });
    if (encErr.length) return { ok: false, code: 'invalid', error: 'Some things need fixing before this can go live:', errors: encErr };
    if (need.length) return { ok: false, code: 'needpw', need: need, error: 'Locked details changed, so they need to be locked again with the current password.' };

    var version = latest + 1;
    var at = new Date();
    // The admin sends this backend's own public address; it becomes the dancer calendar address on the site
    var feed = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/.test(String(req.feedUrl || '')) ? req.feedUrl : '';
    var cal = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(String(req.calUrl || '')) ? String(req.calUrl).replace(/\/$/, '') + '/' : '';
    var pub = publicPart_(full, version, at, feed, cal);
    var pubText = JSON.stringify(pub);
    if (pubText.length > MAX_PUBLIC_BYTES) return { ok: false, error: 'The website part is too big to publish (' + Math.round(pubText.length / 1024) + ' KB).' };

    var sh = historySheet_();
    var row = sh.getLastRow() + 1;
    var chunks = [];
    for (var i = 0; i < fullText.length; i += CHUNK) chunks.push(fullText.slice(i, i + CHUNK));
    sh.getRange(row, 1, 1, DATA_COL - 1 + chunks.length).setValues([[version, at, email, Math.round(fullText.length / 1024), changed.join(', '), 'Sending…'].concat(chunks)]);
    sh.getRange(row, 2).setNumberFormat('yyyy-mm-dd h:mm am/pm');
    SpreadsheetApp.flush();

    var files = { 'content.json': pubText };
    Object.keys(photos.files).forEach(function (p) { files[p] = { base64: photos.files[p] }; });
    Object.keys(enc).forEach(function (k) { files[ENC_FILES[k]] = JSON.stringify(enc[k]); });
    var site;
    try { site = ghCommit_(files, 'Content v' + version + ' published from the admin (' + changed.join(', ').slice(0, 120) + ')'); }
    catch (err) {
      sh.getRange(row, 6).setValue('Failed: ' + String(err && err.message || err).slice(0, 300));
      return { ok: false, code: 'site', version: version, publishedAt: at.toISOString(), content: full,
        error: String(err && err.message || err) === KEY_EXPIRED ? 'Saved as version ' + version + ' (nothing is lost). ' + KEY_EXPIRED + ' Once it’s renewed, press Publish again.'
          : 'Saved as version ' + version + ', but the website couldn’t be updated: ' + (err && err.message || err) + '. Press Publish again to retry.' };
    }
    var nPhotos = Object.keys(photos.files).length;
    var label = 'Updated' + (nPhotos ? ' + ' + nPhotos + ' photo' + (nPhotos > 1 ? 's' : '') : '') + (Object.keys(enc).length ? ' + locked files' : '');
    sh.getRange(row, 6).setValue(site.url ? '=HYPERLINK("' + site.url + '","' + label + '")' : label);
    try { CacheService.getScriptCache().removeAll(['src0', 'src1', 'src2', 'src3']); } catch (x) {}   // dancer calendars use the new version
    Object.keys(newPw).forEach(function (k) { PropertiesService.getScriptProperties().setProperty(LOCK_PROPS[k], newPw[k]); });
    return { ok: true, version: version, publishedAt: at.toISOString(), changed: changed, content: full, locks: locks_() };
  } finally {
    lock.releaseLock();
  }
}

function history_(n) {
  var sh = historySheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, 6).getDisplayValues().reverse().map(function (r) {
    return { version: Number(r[0]), at: r[1], by: r[2], kb: Number(r[3]), changed: r[4], site: r[5] };
  });
}

// ---------------------------------------------------------------- the History tab

function historySheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(HISTORY);
  if (!sh) { sh = ss.insertSheet(HISTORY); sh.setFrozenRows(1); }
  // Headers: add any missing ones on the end, so older rows never shift.
  var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  if (!have[0]) { sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold'); sh.setColumnWidths(DATA_COL, 1, 120); }
  return sh;
}

function lastVersion_() {
  var sh = historySheet_();
  var row = sh.getLastRow();
  if (row < 2) return null;
  var width = Math.max(DATA_COL, sh.getLastColumn());
  var r = sh.getRange(row, 1, 1, width).getValues()[0];
  var text = r.slice(DATA_COL - 1).join('');
  var content = null;
  try { content = JSON.parse(text); } catch (err) { throw new Error('The last saved version (row ' + row + ') couldn’t be read.'); }
  var at = r[1] instanceof Date ? r[1].toISOString() : String(r[1]);
  return { version: Number(r[0]) || 0, at: at, by: String(r[2]), content: content };
}

function changedSections_(a, b) {
  var out = [];
  Object.keys(KEYS).forEach(function (k) {
    if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b[k]) && SECTION_NAMES[k]) out.push(SECTION_NAMES[k]);
  });
  return out;
}

// ---------------------------------------------------------------- public and private parts

// What goes into content.json. Never trusts the page to have left the private parts out.
function publicPart_(full, version, at, feed, cal) {
  var pub = { _published: { version: version, at: at.toISOString() } };
  if (feed) pub._published.feed = feed;
  if (cal) pub._published.cal = cal;     // the dancer calendar relay that subscription links use (Apple Calendar can't use Apps Script directly)   // where Company Central asks for dancer calendar links
  PUBLIC_KEYS.forEach(function (k) { if (k in full) pub[k] = full[k]; });
  // "Only on Company Central" dates leave content.json entirely; they're in the Company bundle (hiddenCal)
  if (pub.calendar) pub.calendar = pub.calendar.filter(function (e) { return !(e && e.hidden); }).map(function (e) {
    if (!e || !e.lock) return e;
    var o = {}; Object.keys(e).forEach(function (k) { if (['iWhen', 'iWhere', 'iBody', 'info'].indexOf(k) < 0) o[k] = e[k]; });
    return o;
  });
  if (pub.rc) pub.rc = pub.rc.map(function (r) {
    if (!r || !String(r.more || '').trim()) return r;
    var o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; });
    o.more = ''; o.lockMore = true;
    return o;
  });
  return pub;
}

// A fingerprint of what each encrypted file holds, to tell whether it needs re-encrypting.
function privateKey_(which, c) {
  c = c || {};
  var t = function (x) { return String(x || '').trim(); };
  if (which === 'company') return JSON.stringify([c.coEdit || null, (c.calendar || []).filter(function (e) { return e && e.lock; })
    .map(function (e) { return [e.id, t(e.iWhen), t(e.iWhere), t(e.iBody)]; }).filter(function (x) { return x[1] || x[2] || x[3]; }),
    (c.calendar || []).filter(function (e) { return e && e.hidden; }).map(hiddenEvent_)]);
  return JSON.stringify((c.rc || []).filter(function (r) { return r && t(r.more); }).map(function (r) { return [t(r.t), t(r.more)]; }));
}

// A Company Central-only date as it goes in the Company bundle (details stay in bundle.locked)
function hiddenEvent_(e) {
  var o = {}; Object.keys(e).forEach(function (k) { if (['iWhen', 'iWhere', 'iBody', 'info'].indexOf(k) < 0) o[k] = e[k]; });
  return o;
}

// An encrypted file as the site reads it: {v, it, s, i, c} (PBKDF2-SHA256 + AES-GCM, all base64). Anything else is refused.
function sealed_(x) {
  if (!x || typeof x !== 'object' || x.v !== 1) return null;
  var b64 = /^[A-Za-z0-9+\/]+={0,2}$/;
  if (typeof x.it !== 'number' || x.it < 100000 || x.it > 5000000 || x.it % 1) return null;
  if (typeof x.s !== 'string' || !b64.test(x.s) || x.s.length < 16 || x.s.length > 64) return null;
  if (typeof x.i !== 'string' || !b64.test(x.i) || x.i.length !== 16) return null;
  if (typeof x.c !== 'string' || !b64.test(x.c) || x.c.length < 24 || x.c.length > MAX_ENC_BYTES) return null;
  return { v: 1, it: x.it, s: x.s, i: x.i, c: x.c };
}

// ---------------------------------------------------------------- photos

// Finds photos (data: links) in the public parts, checks each really is a JPEG, PNG or WebP of a sensible size,
// and swaps it for its file path. Returns { content, files: {path: base64}, errors }.
function takePhotos_(c) {
  var files = {}, errors = [], total = 0, out = {};
  var take = function (v, path) {
    if (typeof v === 'string') {
      var m = PHOTO_RE.exec(v);
      if (!m) return v;
      var bytes;
      try { bytes = Utilities.base64Decode(m[2]); } catch (e) { errors.push(label_(path) + ': that photo couldn’t be read. Choose it again.'); return v; }
      var type = photoType_(bytes);
      if (!type) { errors.push(label_(path) + ': that isn’t a JPEG, PNG or WebP photo. Choose it again.'); return v; }
      if (bytes.length > MAX_PHOTO_BYTES) { errors.push(label_(path) + ': that photo is too big (' + Math.round(bytes.length / 1024) + ' KB). Choose it again so the admin can shrink it.'); return v; }
      var hex = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
      var p = PHOTO_DIR + hex.slice(0, 24) + '.' + type;
      if (!files[p]) { total += bytes.length; files[p] = m[2]; }
      return p;
    }
    if (Array.isArray(v)) return v.map(function (x, i) { return take(x, path + '[' + i + ']'); });
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = take(v[k], path ? path + '.' + k : k); }); return o; }
    return v;
  };
  Object.keys(c).forEach(function (k) { out[k] = PUBLIC_KEYS.indexOf(k) > -1 ? take(c[k], k) : c[k]; });
  if (total > MAX_NEW_PHOTO_BYTES) errors.push('That’s a lot of new photos at once (' + Math.round(total / 1048576) + ' MB). Publish some, then the rest.');
  return { content: out, files: files, errors: errors };
}

// What the file really is, from its first bytes (never trust the label).
function photoType_(b) {
  var u = function (i) { return b[i] & 255; };
  if (b.length > 3 && u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'jpg';
  if (b.length > 8 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'png';
  if (b.length > 12 && u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50) return 'webp';
  return '';
}

// ---------------------------------------------------------------- server-side checks (never trust the page)

function validate_(c) {
  var errors = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { errors: ['Nothing to publish.'], content: null };
  var out = {};
  Object.keys(KEYS).forEach(function (k) {
    if (!(k in c)) return;
    var v = c[k], t = KEYS[k];
    var ok = t === 'array' ? Array.isArray(v) : t === 'objectOrNull' ? (v === null || (typeof v === 'object' && !Array.isArray(v)))
      : t === 'object' ? (v && typeof v === 'object' && !Array.isArray(v)) : typeof v === t;
    if (!ok) { errors.push((SECTION_NAMES[k] || k) + ': not in the expected format.'); return; }
    out[k] = v;
  });
  // Every string, anywhere: length limit and no script links.
  walk_(out, '', 0, errors);
  (out.calendar || []).forEach(function (e, i) {
    var name = '“' + String(e && e.title || 'Date ' + (i + 1)) + '”';
    if (!e || typeof e !== 'object') { errors.push('Studio calendar: item ' + (i + 1) + ' is empty.'); return; }
    if (e.start && !/^\d{4}-\d{2}-\d{2}$/.test(e.start)) errors.push('Studio calendar ' + name + ': the start date isn’t a date.');
    if (e.end && !/^\d{4}-\d{2}-\d{2}$/.test(e.end)) errors.push('Studio calendar ' + name + ': the end date isn’t a date.');
    if (e.start && e.end && e.end < e.start) errors.push('Studio calendar ' + name + ': ends before it starts.');
  });
  (out.nav || []).forEach(function (n) { if (!n || NAV_IDS.indexOf(n.id) < 0) errors.push('Menu: an item isn’t one of the site’s pages.'); });
  (out.staff || []).forEach(function (s, i) { if (!s || !String(s.name || '').trim()) errors.push('Instructors & staff: person ' + (i + 1) + ' needs a name.'); });
  return { errors: errors, content: out };
}

function walk_(v, path, depth, errors) {
  if (errors.length > 30) return;
  if (depth > 12) { errors.push(path + ': nested too deeply.'); return; }
  if (typeof v === 'string') {
    var isPhoto = PHOTO_RE.test(v) && PUBLIC_KEYS.indexOf(String(path).split(/[.[]/)[0]) > -1;
    if (v.length > 30000 && !isPhoto) errors.push(label_(path) + ': text is too long (' + v.length + ' characters).');
    var s = v.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
    if (/^(javascript|vbscript):/.test(s) || (/^data:/.test(s) && !/^data:image\/(png|jpe?g|webp|gif);/.test(s))) errors.push(label_(path) + ': that link type isn’t allowed.');
    return;
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
  if (Array.isArray(v)) {
    if (v.length > 3000) { errors.push(label_(path) + ': too many items.'); return; }
    v.forEach(function (x, i) { walk_(x, path + '[' + i + ']', depth + 1, errors); });
    return;
  }
  if (typeof v === 'object') { Object.keys(v).forEach(function (k) { walk_(v[k], path ? path + '.' + k : k, depth + 1, errors); }); return; }
  errors.push(label_(path) + ': unexpected value.');
}
function label_(path) { var top = String(path).split(/[.[]/)[0]; return (SECTION_NAMES[top] || top) + (path !== top ? ' (' + path + ')' : ''); }

// ---------------------------------------------------------------- GitHub

// ---------------------------------------------------------------- Refresh from Studio Pro now

// The admin fetches the class schedule from Studio Pro in the browser (scripts/studiopro.js, same as the nightly bot)
// and sends it here; this checks it and saves classes.json in the site, so the website updates in about a minute.
var CLASS_FIELDS = { key: 'string', season: 'string', name: 'string', note: 'string', day: 'string', time: 'string', start: 'number',
  end: 'number', mins: 'number', studio: 'string', location: 'string', lo: 'number', hi: 'number' };
function saveClasses_(req) {
  var list = req.classes;
  if (!Array.isArray(list) || list.length > 500) return { ok: false, error: 'That class list didn’t come through right. Try Refresh again.' };
  var clean = [], bad = 0;
  list.forEach(function (c) {
    if (!c || typeof c !== 'object' || typeof c.key !== 'string' || typeof c.name !== 'string') { bad++; return; }
    var o = {};
    Object.keys(CLASS_FIELDS).forEach(function (k) {
      var v = c[k], t = CLASS_FIELDS[k];
      if (t === 'string') o[k] = String(v == null ? '' : v).slice(0, 200);
      else o[k] = typeof v === 'number' && isFinite(v) ? v : (v == null ? null : Number(v) || 0);
    });
    clean.push(o);
  });
  if (bad) return { ok: false, error: bad + ' classes came back in an unexpected shape. Nothing was changed.' };
  var cur = null;
  try { cur = ghGetJson_('classes.json'); } catch (err) { console.error('classes.json', err); }
  var had = cur && Array.isArray(cur.classes) ? cur.classes.length : 0;
  // Same safety net as the nightly bot: a near-empty answer means Studio Pro hiccuped, not that every class was cancelled
  if (clean.length < Math.max(5, Math.floor(had / 2))) return { ok: false, error: 'Only ' + clean.length + ' classes came back from Studio Pro (the site has ' + had + '). Kept the current schedule; try again in a few minutes.' };
  if (cur && JSON.stringify(cur.classes) === JSON.stringify(clean)) return { ok: true, unchanged: true, count: clean.length };
  var text = JSON.stringify({ updated: new Date().toISOString(), source: 'Studio Pro live schedule', classes: clean }, null, 1) + '\n';
  var r = ghCommit_({ 'classes.json': text }, 'Class schedule refreshed from Studio Pro (admin)');
  return { ok: true, count: clean.length, url: r.url };
}
// A JSON file from the site's repo (the Contents API, up to 1 MB)
function ghGetJson_(path) {
  var c = gh_();
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + c.repo + '/contents/' + path + '?ref=' + encodeURIComponent(c.branch), { headers: c.headers, muteHttpExceptions: true });
  noteKeyExpiry_(r);
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() === 401) throw new Error(KEY_EXPIRED);
  if (r.getResponseCode() !== 200) throw new Error('GitHub said ' + r.getResponseCode() + ' reading ' + path);
  var j = JSON.parse(r.getContentText());
  return JSON.parse(Utilities.newBlob(Utilities.base64Decode(String(j.content).replace(/\s/g, ''))).getDataAsString('UTF-8'));
}

function gh_() {
  var token = prop_('GITHUB_TOKEN'), repo = prop_('GITHUB_REPO');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_TOKEN and GITHUB_REPO aren’t set up in Script Properties');
  return { repo: repo, branch: prop_('GITHUB_BRANCH') || 'main',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
}

// Writes several files in one commit (Git Data API), so the site never sees content.json without its matching
// locked files. If the branch moved in between (e.g. the nightly schedule bot), it starts again from the new tip.
function ghCommit_(files, message) {
  var c = gh_();
  var api = 'https://api.github.com/repos/' + c.repo + '/git/';
  var call = function (method, path, body) {
    var o = { method: method, headers: c.headers, muteHttpExceptions: true };
    if (body) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
    var r = UrlFetchApp.fetch(api + path, o);
    noteKeyExpiry_(r);
    return { code: r.getResponseCode(), j: JSON.parse(r.getContentText() || '{}') };
  };
  var fail = function (r, what) { return new Error(r.code === 401 ? KEY_EXPIRED : 'GitHub said ' + r.code + ' when ' + what + (r.j && r.j.message ? ': ' + r.j.message : '')); };
  var tree = Object.keys(files).map(function (p) {
    var f = files[p];
    if (typeof f === 'string') return { path: p, mode: '100644', type: 'blob', content: f };
    var b = call('post', 'blobs', { content: f.base64, encoding: 'base64' });
    if (b.code !== 201) throw fail(b, 'saving the photo ' + p);
    return { path: p, mode: '100644', type: 'blob', sha: b.j.sha };
  });
  for (var attempt = 0; attempt < 3; attempt++) {
    var ref = call('get', 'ref/heads/' + encodeURIComponent(c.branch));
    if (ref.code !== 200) throw fail(ref, 'reading the branch');
    var head = ref.j.object.sha;
    var hc = call('get', 'commits/' + head);
    if (hc.code !== 200) throw fail(hc, 'reading the latest commit');
    var t = call('post', 'trees', { base_tree: hc.j.tree.sha, tree: tree });
    if (t.code !== 201) throw fail(t, 'saving the files');
    var cm = call('post', 'commits', { message: message, tree: t.j.sha, parents: [head] });
    if (cm.code !== 201) throw fail(cm, 'making the commit');
    var up = call('patch', 'refs/heads/' + encodeURIComponent(c.branch), { sha: cm.j.sha, force: false });
    if (up.code === 200) return { url: cm.j.html_url, sha: cm.j.sha };
    if (up.code !== 422 && up.code !== 409) throw fail(up, 'updating the branch');
  }
  throw new Error('GitHub kept reporting a conflict');
}

// ---------------------------------------------------------------- replies

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

var SIGNIN_HTML = '<!doctype html><html><head><base target="_top"><meta charset="utf-8">'
  + '<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#F5F6F5;color:#111}'
  + '.c{max-width:420px;margin:12vh auto;padding:28px 24px;background:#fff;border:1px solid #E2E4E3;border-top:4px solid #00ADB5}'
  + 'h1{font-size:22px;margin:0 0 8px}p{color:#5C6360;line-height:1.5;margin:0 0 20px}'
  + 'a.b{display:flex;align-items:center;justify-content:center;min-height:48px;background:#00ADB5;color:#000;font-weight:700;'
  + 'letter-spacing:.12em;text-transform:uppercase;font-size:13px;text-decoration:none}a.b:focus-visible{outline:3px solid #111;outline-offset:2px}'
  + '.t{display:inline-block;background:#FFE08A;padding:2px 8px;font-size:12px;font-weight:700;margin-bottom:12px}</style></head><body>'
  + '<div class="c"><? if (env !== "LIVE") { ?><span class="t">TEST</span><? } ?><h1>You’re signed in</h1>'
  + '<p>Signed in as <b><?= email ?></b>. This keeps you signed in on this device for 12 hours.</p>'
  + '<a class="b" href="<?= href ?>">Continue to the admin</a></div></body></html>';
