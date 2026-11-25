/**
 * Dancer calendar feeds (private), served by the admin's public deployment.
 *
 * How a family gets their dancer link: Company Central (after the Company password) → Find your dancer → Subscribe.
 * The page sends the dancer search ("Bella M") plus a proof that it knows the feed key (the key is inside the locked
 * Company file, so only families with the password have it). This saves a random code for that search on the
 * "Calendar links" tab and returns it. The link holds only the code, never the dancer's name:
 *   <public deployment>/exec?c=CODE
 * Turning off a link that got shared: on the "Calendar links" tab, untick Active. The family subscribes again.
 *
 * What a dancer calendar is made from (one read shared by every link for 10 minutes):
 *  - the latest published version on the History tab (competitions, due dates, Company-only dates and their details,
 *    team rosters, and the two sheet links saved on the admin's Company Central screen), so no readable copy of the
 *    Company data is needed anywhere else;
 *  - Brittany's Company Calendar sheet (Rehearsals, No rehearsals) and Competition sheet (Competitions, Routines,
 *    Groups and one tab per competition), read live, so an edit shows up within 10 minutes.
 * The calendar-making code is FeedCore.gs (apps-script/calendar-feed.gs, copied in by tools/deploy-admin.js).
 *
 * Script Properties: FEED_KEY is made on its own (the admin puts it in the locked Company file on Publish).
 */

var LINKS_TAB = 'Calendar links';
var FEED_CACHE_SECONDS = 600;

// GET ?c=CODE
function feedGet_(p) {
  var row = findCode_(p.c);
  if (!row) return text_('This calendar link is turned off. Subscribe again from Company Central.');
  touch_(row);
  // Calendar apps check every hour or so; a finished calendar is kept 10 minutes, so a sheet edit shows up within 10
  var cache = CacheService.getScriptCache(), hit = cache.get('ics:' + p.c);
  if (hit) return ics_(hit);
  var src = feedSources_();
  var ics = FEED.calendar(FEED.dancerName(row.q) + ' · D&ATJ Company', FEED.dancerEvents({ co: src.co, cal: src.cal, teams: src.teams, q: row.q, today: todayChicago_(), siteUrl: src.siteUrl }));
  try { cache.put('ics:' + p.c, ics, FEED_CACHE_SECONDS); } catch (x) {} // too big to cache (very rare): built fresh next time
  return ics_(ics);
}

// POST { action: 'subscribe', q: 'bella m', proof: HMAC-SHA256(FEED_KEY, q) as hex }
function feedSubscribe_(data) {
  var q = normQ_(data.q);
  if (!q || q.length > 80) return { ok: false, error: 'Type your dancer’s name first.' };
  var key = prop_('FEED_KEY');
  if (!key) return { ok: false, error: 'Dancer calendars aren’t set up yet. Ask the studio.' };
  if (!safeEqual_(String(data.proof || ''), hmacHex_(q, key))) return { ok: false, error: 'Unlock Company Central again, then try once more.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = linksSheet_(), vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) if (vals[i][1] === q && vals[i][5] === true) return { ok: true, code: vals[i][0] };
    var code = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    sh.appendRow([code, q, new Date(), '', 0, true]);
    return { ok: true, code: code };
  } finally { lock.releaseLock(); }
}

// The key Company Central uses to prove it was unlocked. Made once; Publish puts it in the locked Company file.
function feedKey_() {
  var k = prop_('FEED_KEY');
  if (k) return k;
  k = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('FEED_KEY', k);
  return k;
}

function feedSources_() {
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var cache = CacheService.getScriptCache(), keys = ['src0', 'src1', 'src2', 'src3'], got = cache.getAll(keys);
    if (got.src0) { var txt = keys.map(function (k) { return got[k] || ''; }).join(''); try { return JSON.parse(txt); } catch (x) {} }
    var last = lastVersion_(), c = (last && last.content) || {}, ce = c.coEdit || {};
    var sh = readCompanySheet_(ce), cal = sh, comps = sh.comps;
    var out = {
      co: { rehearsals: cal.rehearsals, off: cal.off, comps: comps, due: ce.due || [], locked: lockedInfo_(c.calendar) },
      cal: c.calendar || [], teams: ((c.lists || {}).teams) || [], siteUrl: siteUrl_()
    };
    var s = JSON.stringify(out), parts = {}; // the cache holds 100 KB per entry: split it
    for (var i = 0; i < keys.length; i++) parts[keys[i]] = s.slice(i * 95000, (i + 1) * 95000);
    if (s.length <= 95000 * keys.length) { try { cache.putAll(parts, FEED_CACHE_SECONDS); } catch (x) {} }
    return out;
  } finally { lock.releaseLock(); }
}

// The Company sheet(s) linked on the admin's Company Central screen, read privately with this script's account:
// { ok, rehearsals, off, comps (sheet times on top of the admin's), groups: {name: [dancers]}, error }
function readCompanySheet_(ce) {
  ce = ce || {};
  var idOf = function (u) { var m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(String(u || '')); return m ? m[1] : ''; };
  var errors = [];
  var tabsOf = function (id, what) {
    var ss = null;
    if (!id) errors.push('No ' + what + ' sheet link is saved yet.');
    else { try { ss = SpreadsheetApp.openById(id); } catch (err) {
      console.error('Couldn’t open the ' + what + ' sheet', id, err);
      var m = String(err && err.message || err), link = ' (link …/d/' + id.slice(0, 8) + '…)';
      errors.push(/specified permissions|not sufficient|authoriz/i.test(m) ? 'The script isn’t allowed to read other Google Sheets yet. In the Apps Script editor, run setup once and click Allow.'
        : /not supported|document type|xlsx|office/i.test(m) ? 'The ' + what + ' link' + link + ' is an Excel file. Open the Google Sheets copy (same name, no .XLSX tag), copy its link and paste that here instead.'
        : /permission|access/i.test(m) ? 'The studio’s Google account can’t open the ' + what + ' sheet' + link + '. Upload it in that account’s Drive, or share it with that account as Viewer.'
        : /not found|does not exist|missing/i.test(m) ? 'The ' + what + ' sheet' + link + ' wasn’t found. Check the link saved here.'
        : 'The ' + what + ' sheet' + link + ' couldn’t be opened: ' + m.slice(0, 120));
    } }
    return function (name) {
      if (!ss) return [];
      var sh = ss.getSheetByName(name) || ss.getSheets().filter(function (x) { return x.getName().toLowerCase().replace(/[^a-z0-9]/g, '') === String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); })[0];
      return sh ? sh.getDataRange().getDisplayValues() : [];
    };
  };
  // Rehearsals + days off from the Company Calendar sheet; competitions + groups from the Competition sheet
  // (the links saved in the admin, so a new season's sheet is picked up on its own)
  var compId = idOf(ce.compSheet) || idOf(ce.sheet), calId = idOf(ce.sheet);
  var calTabs = tabsOf(calId, 'Company Calendar');
  var cal = FEED.readCompany(calTabs);
  var comps = (ce.comps || []).slice();
  // One sheet can hold both (Rehearsals and Competitions tabs side by side): no competition link = the same sheet
  var fresh = FEED.readComps(compId === calId ? calTabs : tabsOf(compId, 'Competition'));
  // The sheet's times win; a blank cell keeps what the admin already has (e.g. the dates with their year)
  if (fresh.length) comps = fresh.map(function (x) {
    var old = comps.filter(function (o) { return o.id === x.id; })[0] || {}, o = Object.assign({}, old);
    Object.keys(x).forEach(function (k) { if (x[k] !== '' && x[k] != null) o[k] = x[k]; });
    return o;
  });
  return { ok: !errors.length || cal.rehearsals.length > 0, rehearsals: cal.rehearsals, off: cal.off, comps: comps,
    groups: (fresh[0] && fresh[0].groups) || {}, error: errors.join(' ') };
}

// The admin's "Check for updates" (Studio calendar, competition schedules): some tabs of a sheet, exactly as Google
// Sheets shows them, read privately with this script's account (no "Anyone with the link" needed).
// { ok, tabs: { name: rows | null }, error }
function sheetTabs_(req) {
  var m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(String(req.sheet || ''));
  if (!m) return { ok: false, error: 'That doesn’t look like a Google Sheet link. Copy it from the address bar while the sheet is open.' };
  var names = (Array.isArray(req.tabs) ? req.tabs : []).slice(0, 20).map(String);
  var ss;
  try { ss = SpreadsheetApp.openById(m[1]); } catch (err) {
    var e = String(err && err.message || err);
    return { ok: false, error: /specified permissions|not sufficient|authoriz/i.test(e) ? 'The script isn’t allowed to read other Google Sheets yet. In the Apps Script editor, run setup once and click Allow.'
      : /not supported|document type|xlsx|office/i.test(e) ? 'That link is an Excel file. Open the Google Sheets copy (same name, no .XLSX tag) and paste its link instead.'
      : 'Couldn’t open that sheet with the studio’s Google account. It has to be in that account’s Drive or shared with it.' };
  }
  var all = ss.getSheets(), norm = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); }, tabs = {};
  names.forEach(function (n) {
    var sh = ss.getSheetByName(n) || all.filter(function (x) { return norm(x.getName()) === norm(n); })[0];
    tabs[n] = sh ? sh.getDataRange().getDisplayValues() : null;
  });
  return { ok: true, tabs: tabs };
}

// Details of "Company families only" dates, the way the locked Company file has them ({when, where, summary})
function lockedInfo_(calendar) {
  var o = {};
  (calendar || []).forEach(function (e) {
    if (!e || !e.lock || !e.id) return;
    var body = String(e.iBody || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var summary = body.filter(function (l) { return !/^(## |- |\[)/.test(l); }).slice(0, 2).join(' ');
    if (e.iWhen || e.iWhere || summary) o[e.id] = { when: String(e.iWhen || ''), where: String(e.iWhere || ''), summary: summary };
  });
  return o;
}

function siteUrl_() { return prop_('ADMIN_PAGE_URL').replace(/[^/]*$/, ''); }
function normQ_(q) { return String(q || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function hmacHex_(q, key) {
  return Utilities.computeHmacSha256Signature(q, key).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function linksSheet_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(LINKS_TAB);
  if (!sh) { sh = ss.insertSheet(LINKS_TAB); sh.appendRow(['Code', 'Dancer search', 'Created', 'Last checked by a calendar app', 'Hours with a check', 'Active']); sh.setFrozenRows(1); }
  return sh;
}
function findCode_(code) {
  if (!code || !/^[a-f0-9]{20}$/.test(code)) return null;
  var cache = CacheService.getScriptCache(), hit = cache.get('code:' + code);
  if (hit) return JSON.parse(hit);
  var sh = linksSheet_(), vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === code) {
    if (vals[i][5] !== true) return null;
    var row = { r: i + 1, q: vals[i][1] }; cache.put('code:' + code, JSON.stringify(row), 300); return row;
  }
  return null;
}
function touch_(row) {
  try {
    var cache = CacheService.getScriptCache(), k = 'seen:' + row.r; if (cache.get(k)) return; cache.put(k, '1', 3600);
    var sh = linksSheet_(); sh.getRange(row.r, 4).setValue(new Date()); var n = sh.getRange(row.r, 5); n.setValue((+n.getValue() || 0) + 1);
  } catch (e) {}
}
function todayChicago_() { return Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd'); }
function ics_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.ICAL); }
