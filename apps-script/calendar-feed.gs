/**
 * Dance & All That Jazz: calendar feed code (shared)
 *
 *  1. Studio calendar (public): every public date on the studio calendar. Built into studio.ics by
 *     scripts/make-studio-ics.js (the website build and .github/workflows/studio-calendar.yml), so it needs no server.
 *  2. A dancer's Company calendar (private): their rehearsals, their competition times (arrival / on stage / awards),
 *     Company-only dates and payment due dates. Served by the admin's Apps Script (apps-script/admin/Feed.gs), which
 *     loads this file as FeedCore.gs when it's deployed.
 *
 * This file is only the calendar-making code: no Google services, so the website build and the tests
 * (apps-script/test-feeds.js) run it in Node too.
 */

var FEED = (function () {
  var TZID = 'America/Chicago';
  var VTZ = ['BEGIN:VTIMEZONE', 'TZID:America/Chicago',
    'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'END:DAYLIGHT',
    'END:VTIMEZONE'];
  var STUDIO = 'Dance & All That Jazz, 844 N Elmhurst Rd, Prospect Heights, IL';
  var MONS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(t, suf) {
    var m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(t).trim()); if (!m) return null;
    var h = +m[1] % 12; var ap = (m[3] || suf || '').toLowerCase(); if (ap === 'pm') h += 12; return [h, +(m[2] || 0), ap];
  }
  // "8–10am", "10am–12pm", "2:30–4:30 PM" -> [[h,m],[h,m]]
  function span(txt) {
    var p = String(txt || '').replace(/\u2060/g, '').split(/\s*[–-]\s*/); if (p.length !== 2) return null;
    var b = hm(p[1]); if (!b) return null; var a = hm(p[0], b[2]); if (!a) return null;
    if (!/am|pm/i.test(p[0]) && a[0] * 60 + a[1] > b[0] * 60 + b[1]) a = hm(p[0], 'am');
    return [a, b];
  }
  function clock(t) { var m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim()); if (!m) return null; var h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return [h, +m[2]]; }
  function mins(t) { var k = clock(t); return k ? k[0] * 60 + k[1] : null; }
  function later(t, n) { var x = t[0] * 60 + t[1] + n; return [Math.min(23, Math.floor(x / 60)), x >= 1440 ? 59 : x % 60]; }
  function addDay(iso, n) { var a = iso.split('-').map(Number); var t = new Date(Date.UTC(a[0], a[1] - 1, a[2] + n)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
  function esc(x) { return String(x || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  // Fold long lines at 75 bytes (UTF-8), never inside a character
  function fold(line) {
    var out = [], cur = '', bytes = 0, limit = 75;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i), code = line.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < line.length) { ch += line.charAt(++i); }
      var b = encodeURIComponent(ch).replace(/%[0-9A-F]{2}/g, 'x').length;
      if (bytes + b > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
      cur += ch; bytes += b;
    }
    out.push(cur); return out.join('\r\n');
  }
  function stamp(iso, t) { return iso.replace(/-/g, '') + 'T' + pad(t[0]) + pad(t[1]) + '00'; }
  function vevent(e, now) {
    var L = ['BEGIN:VEVENT', 'UID:' + String(e.uid).replace(/[^\w.-]/g, '') + '@danceandallthatjazz.com', 'DTSTAMP:' + now];
    if (e.t0) {
      var t1 = e.t1 || later(e.t0, 60);
      if (t1[0] * 60 + t1[1] <= e.t0[0] * 60 + e.t0[1]) t1 = later(e.t0, 30);
      L.push('DTSTART;TZID=' + TZID + ':' + stamp(e.date, e.t0), 'DTEND;TZID=' + TZID + ':' + stamp(e.date, t1));
    } else {
      L.push('DTSTART;VALUE=DATE:' + e.date.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + addDay(e.end && e.end > e.date ? e.end : e.date, 1).replace(/-/g, ''));
      L.push('TRANSP:TRANSPARENT');
    }
    L.push('SUMMARY:' + esc(e.title));
    if (e.where) L.push('LOCATION:' + esc(e.where));
    if (e.desc) L.push('DESCRIPTION:' + esc(e.desc));
    if (e.url) L.push('URL:' + e.url);
    L.push('END:VEVENT');
    return L.map(fold).join('\r\n');
  }
  // name: what the calendar is called in the family's calendar app
  function calendar(name, events, nowDate) {
    var now = (nowDate || new Date()).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    var head = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dance & All That Jazz//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + esc(name), 'X-WR-TIMEZONE:' + TZID,
      // Ask calendar apps to check every hour (Apple and Outlook listen; Google Calendar picks its own schedule)
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'].map(fold).concat(VTZ);
    var seen = {};
    var body = events.filter(function (e) { if (!e || !e.date || seen[e.uid]) return false; seen[e.uid] = 1; return true; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .map(function (e) { return vevent(e, now); });
    return head.concat(body).concat(['END:VCALENDAR']).join('\r\n') + '\r\n';
  }
  function infoText(e) {
    var i = e.info || {}, out = [];
    if (i.when) out.push(i.when);
    if (i.summary) out.push(i.summary);
    (i.sections || []).forEach(function (s) { out.push(''); if (s.h) out.push(s.h); (s.items || []).forEach(function (x) { out.push('• ' + x); }); });
    return out.join('\n').trim();
  }

  // ---------- Feed 1: studio calendar (public) ----------
  // cal: the studio calendar list (same as the website). Hidden dates (Company Central only) stay out.
  // "Company families only" dates show their title and day; their details stay behind the Company password.
  function studioEvents(cal, siteUrl, today) {
    var from = addDay(today, -60);
    return (cal || []).filter(function (e) { return e.start && !e.hidden && (e.end || e.start) >= from; }).map(function (e, i) {
      var sp = e.info && e.info.when && !e.end ? timeIn(e.info.when) : null;
      var desc = e.lock ? 'Company families: details are in Company Central (Company password).\n' + siteUrl + 'company-families.html'
        : (infoText(e) + '\n\nStudio calendar: ' + siteUrl + 'families.html#calendar').trim();
      // Location that Maps can find: the full address when it's public; for a "Company families only" date (address
      // private) the short place plus the city from the title, e.g. "Hemmens Cultural Center, Elgin"
      var place = String(e.where || '').trim(), addr = e.lock ? '' : String(e.iWhere || '').trim();
      var city = (/\(([^)]+)\)\s*$/.exec(e.title || '') || [])[1] || '';
      var venue = place.split(',')[0].trim().toLowerCase();
      var where = addr ? (venue && addr.toLowerCase().indexOf(venue) < 0 ? place + ', ' + addr : addr)
        : (place && city && place.toLowerCase().indexOf(city.toLowerCase()) < 0 ? place + ', ' + city : place);
      return { uid: 'cal-' + (e.id || ('c' + i)), date: e.start, end: e.end || '', t0: sp && sp[0], t1: sp && sp[1], title: e.title, where: where, desc: desc };
    });
  }
  // Pull a time out of text like "Wednesday, Nov 18 · 7:00 PM" or "2:30–4:30 PM"
  function timeIn(txt) {
    var s = String(txt || ''), m = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(s);
    if (m) { var sp = span(m[1].replace(/\s+/g, '')); if (sp) return [sp[0], sp[1]]; }
    m = /(\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(s); if (m) { var c = clock(m[1].replace(/\s+/g, ' ')); if (c) return [c, later(c, 60)]; }
    return null;
  }

  // ---------- Feed 2: one dancer's Company calendar (private) ----------
  // Same rules as Company Central's "Add to my calendar":
  //  - rehearsals with the dancer's name, plus the group rehearsals they are in (team rosters + the competition Groups tab)
  //  - competition times: arrival for the first dance of the day (and again only when there are 2+ hours
  //    between the last awards and the next arrival), on stage, and awards (the first awards after the dance on its stage)
  //  - Company dates hidden from the public calendar, and Company payment due dates
  function query(q) {
    q = String(q || '').trim().toLowerCase();
    var qG = q.split(/\s*(?:,|&|\+|\band\b)\s*/).map(function (x) { return x.split(/[^a-z]+/).filter(Boolean); }).filter(function (g) { return g.length; });
    return function (txt) {
      var T = String(txt || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
      return qG.some(function (g) { return T.some(function (_, i) { return g.every(function (w, j) { return T[i + j] && T[i + j].indexOf(w) === 0; }); }); });
    };
  }
  function dancerEvents(o) {
    var co = o.co || {}, teams = o.teams || [], hitQ = query(o.q), today = o.today, siteUrl = o.siteUrl || '';
    var cc = siteUrl + 'company-families.html', from = addDay(today, -60);
    if (!String(o.q || '').trim()) return [];
    var nameHit = function (r) { return hitQ(r.what); };
    var GROUPK = { 'Large group': 1, 'Hip Hop Company': 1, 'Dress rehearsal': 1, 'Windy City Bulls': 1, 'Performance': 1 };
    var isShow = function (r) { return r.kind === 'Performance' || r.kind === 'Windy City Bulls'; };
    var GG = {};
    teams.forEach(function (t) { var n = (t.dancers || []).map(function (d) { return d.t; }).filter(Boolean); if (n.length) GG[(t.t + ' company').toLowerCase()] = n; });
    (co.comps || []).forEach(function (c) { Object.keys(c.groups || {}).forEach(function (g) { if ((c.groups[g] || []).length) GG[g.toLowerCase()] = c.groups[g]; }); });
    var onTeam = function (t) { return (t.dancers || []).some(function (d) { return hitQ(d.t); }); };
    var inIt = function (r) {
      if (nameHit(r)) return true;
      if (r.kind === 'Dress rehearsal' || isShow(r)) {
        var named = teams.filter(function (t) { return new RegExp('\\b' + t.t + '\\b', 'i').test(r.what || ''); });
        return !named.length || named.some(onTeam);
      }
      var g = GG[String(r.what || '').replace(/\s*\(.*\)$/, '').trim().toLowerCase()];
      return g ? g.some(function (n) { return hitQ(n); }) : true;
    };
    var out = [];
    // a rehearsal named after a group on the Groups tab (any size) counts too; inIt checks the dancer is in it
    var isGroup = function (r) { return !!GG[String(r.what || '').replace(/\s*\(.*\)$/, '').trim().toLowerCase()]; };
    (co.rehearsals || []).filter(function (r) { return r.date >= from && (nameHit(r) || GROUPK[r.kind] || isGroup(r)) && inIt(r); }).forEach(function (r) {
      var sp = span(r.time);
      out.push({ uid: 'reh-' + r.date + '-' + (sp ? pad(sp[0][0]) + pad(sp[0][1]) + pad(sp[1][0]) + pad(sp[1][1]) : String(r.time).replace(/\W/g, '')) + '-' + String(r.what).replace(/\W/g, '').slice(0, 24), date: r.date, t0: sp && sp[0], t1: sp && sp[1],
        title: (isShow(r) || /rehearsal/i.test(r.what) ? '' : 'Rehearsal: ') + r.what,
        where: isShow(r) ? (r.room || '') : STUDIO + (r.room ? ' (' + r.room + ')' : ''),
        desc: [r.room, r.teacher].filter(Boolean).join(' · ') + (sp ? '' : (r.time ? '\n' + r.time : '')) + '\nCompany Central: ' + cc });
    });
    // A competition's dates, year, place and address come from its Studio calendar date (the one place they're kept);
    // the Competitions tab's old columns are only a fallback
    var M3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var nmC = function (t) { return String(t || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); };
    var calComp = function (c) {
      var cal = o.cal || [], ev = cal.filter(function (e) { return e && e.id && e.id === (c.calId || c.id); })[0]
        || cal.filter(function (e) { return e && /^Competition:/.test(e.title || '') && nmC(String(e.title).replace(/^Competition:\s*/, '').replace(/\s*\(.*\)$/, '')) === nmC(c.name); })[0];
      if (!ev || !ev.start) return c;
      var a = ev.start.split('-').map(Number), b = (ev.end || ev.start).split('-').map(Number);
      var dates = M3[a[1] - 1] + ' ' + a[2] + (ev.end && ev.end !== ev.start ? (a[1] === b[1] ? '–' + b[2] : ' – ' + M3[b[1] - 1] + ' ' + b[2]) : '') + ', ' + b[0];
      var lk = (co.locked || {})[ev.id] || {};
      return Object.assign({}, c, { calId: ev.id, dates: dates, venue: ev.where || c.venue || '', address: ev.iWhere || lk.where || c.address || '', hideAfter: (c.hideOwn && c.hideAfter) || ev.end || ev.start });
    };
    (co.comps || []).map(calComp).filter(function (c) { return c.show !== false && (!c.hideAfter || c.hideAfter >= today) && (c.days || []).length; }).forEach(function (c) {
      var yr = (/(20\d\d)/.exec(c.dates || '') || [])[1]; if (!yr) return;
      var prelim = !/final/i.test(c.status || ''), tag = prelim ? ' (preliminary)' : '';
      var G = {}; teams.forEach(function (t) { var n = (t.dancers || []).map(function (d) { return d.t; }).filter(Boolean); if (n.length) G[(t.t + ' company').toLowerCase()] = n; });
      Object.keys(c.groups || {}).forEach(function (g) { if ((c.groups[g] || []).length) G[g.toLowerCase()] = c.groups[g]; });
      var where = [c.venue, c.address].filter(Boolean).join(', ');
      var foot = (prelim ? '\nPRELIMINARY schedule: times can change. This calendar updates on its own when the final schedule is posted.' : '') + '\nSchedule: ' + cc + '#competitions';
      (c.days || []).forEach(function (d) {
        var m = /(\d{1,2})\/(\d{1,2})/.exec(d.day || ''); if (!m) return;
        var iso = yr + '-' + pad(+m[1]) + '-' + pad(+m[2]); if (iso < from) return;
        var rows = d.rows || [];
        var awards = rows.filter(function (r) { return r.awards && mins(r.perf) != null; });
        var mine = rows.filter(function (r) { return !r.awards && mins(r.perf) != null; }).filter(function (r) {
          var g = G[String(r.dancers || '').trim().toLowerCase()]; return hitQ(r.dancers) || (g && g.some(hitQ));
        }).sort(function (x, y) { return mins(x.perf) - mins(y.perf); });
        var awardFor = function (r) {
          return awards.filter(function (w) { return mins(w.perf) > mins(r.perf) && (!w.stage || !r.stage || w.stage === r.stage); })
            .sort(function (x, y) { return mins(x.perf) - mins(y.perf); })[0] || null;
        };
        var seenW = {}, freeAt = null;
        mine.forEach(function (r) {
          var aw = awardFor(r), a = mins(r.arrive), pf = mins(r.perf);
          if (a != null && (freeAt == null || a - freeAt >= 120))
            out.push({ uid: c.id + '-' + iso + '-arr-' + r.num, date: iso, t0: clock(r.arrive), t1: clock(r.perf), title: 'Arrive: ' + c.name + tag, where: where,
              desc: 'Arrive ' + r.arrive + ' for #' + r.num + ' ' + r.song + ' (on stage ~' + r.perf + ')\n' + r.dancers + (r.stage ? ' · ' + r.stage : '') + foot });
          out.push({ uid: c.id + '-' + iso + '-' + r.num, date: iso, t0: clock(r.perf), t1: later(clock(r.perf), 5), title: '#' + r.num + ' ' + r.song + ' on stage' + tag, where: where,
            desc: r.dancers + (r.stage ? ' · ' + r.stage : '') + (r.note ? '\n' + r.note : '') + foot });
          if (aw) {
            var k = aw.perf + (aw.stage || '');
            if (!seenW[k]) {
              seenW[k] = 1; var dur = +((/(\d+)\s*min/.exec(aw.note || '') || [])[1] || 30);
              out.push({ uid: c.id + '-' + iso + '-awards-' + String(aw.perf).replace(/\W/g, '') + (aw.stage ? '-' + String(aw.stage).replace(/\W/g, '') : ''), date: iso, t0: clock(aw.perf), t1: later(clock(aw.perf), dur),
                title: 'Awards: ' + c.name + tag, where: where, desc: 'Awards' + (aw.stage ? ' · ' + aw.stage : '') + (aw.note ? ' (' + aw.note + ')' : '') + foot });
            }
          }
          freeAt = Math.max(freeAt || 0, aw ? mins(aw.perf) + 30 : pf + 5);
        });
      });
    });
    // Company dates that only show in Company Central (the public studio feed leaves them out), with their details
    // (Publish keeps them out of the public content.json and puts them in the Company bundle as hiddenCal)
    (co.hiddenCal || []).concat((o.cal || []).filter(function (e) { return e.hidden && !(co.hiddenCal || []).some(function (h) { return h.id === e.id; }); }))
      .filter(function (e) { return e.hidden && e.start && (e.end || e.start) >= from; }).forEach(function (e, i) {
      var lk = (co.locked || {})[e.id] || {};
      out.push({ uid: 'cal-' + (e.id || 'h' + i), date: e.start, end: e.end || '', title: e.title, where: lk.where || e.where || '',
        desc: [lk.when, lk.summary, infoText(e)].filter(Boolean).join('\n') + '\nCompany Central: ' + cc });
    });
    // Every other Company date (competitions, the convention, Soirée, performances…) as an all-day event, so one
    // subscription has the whole Company season; competition times above are added once a schedule is posted.
    // Dates for new families (New Member auditions and their sign-up deadline) are left out.
    (o.cal || []).filter(function (e) { return e && e.type === 'Company' && !e.hidden && e.start && (e.end || e.start) >= from && !/new member/i.test(e.title || ''); }).forEach(function (e, i) {
      var lk = (co.locked || {})[e.id] || {}, addr = e.iWhere || lk.where || '';
      out.push({ uid: 'co-' + (e.id || 'c' + i), date: e.start, end: e.end || '', title: e.title,
        where: addr && e.where && addr.indexOf(e.where) < 0 ? e.where + ', ' + addr : (addr || e.where || ''),
        desc: [e.iWhen || lk.when, lk.summary || (e.iBody ? String(e.iBody).split('\n')[0] : '')].filter(Boolean).join('\n') + '\nCompany Central: ' + cc });
    });
    (co.due || []).filter(function (d) { return d.date >= from; }).forEach(function (d) {
      var dup = (o.cal || []).concat(co.hiddenCal || []).some(function (e) { return e.start === d.date && String(e.title).toLowerCase() === String(d.t).toLowerCase(); });
      if (!dup) out.push({ uid: 'due-' + d.date + '-' + String(d.t).replace(/\W/g, '').slice(0, 24), date: d.date, title: 'Due: ' + d.t, where: '', desc: 'Company Central: ' + cc });
    });
    return out;
  }
  function dancerName(q) { return String(q || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }


  // ---------- Reading Brittany's sheets (rows of displayed text, the way Google Sheets shows them) ----------
  var MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function isoDate(v) {
    v = String(v || '').trim(); var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v))) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v))) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(+m[1]) + '-' + pad(+m[2]);
    if ((m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(v))) { var mo = MON3.indexOf(m[1].toLowerCase()); if (mo >= 0) return m[3] + '-' + pad(mo + 1) + '-' + pad(+m[2]); }
    return '';
  }
  function hhmm(v) { var m = /^\s*(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)\s*$/i.exec(String(v || '')); return m ? [+m[1] % 12 + (/pm/i.test(m[3]) ? 12 : 0), +(m[2] || 0)] : null; }
  function short(a, b) {
    var lab = function (t) { return (t[0] % 12 || 12) + (t[1] ? ':' + pad(t[1]) : ''); }, ap = function (t) { return t[0] < 12 ? 'am' : 'pm'; };
    if (!a) return ''; if (!b) return lab(a) + ap(a);
    return lab(a) + (ap(a) === ap(b) ? '' : ap(a)) + '–' + lab(b) + ap(b);
  }
  function kindOf(w) {
    var wl = String(w || '').toLowerCase();
    if (/dress rehearsal/.test(wl)) return 'Dress rehearsal'; if (/windy city/.test(wl)) return 'Windy City Bulls';
    if (/hip hop company/.test(wl)) return 'Hip Hop Company'; if (/large group/.test(wl)) return 'Large group';
    if (/solo/.test(wl) || (wl.indexOf(',') < 0 && wl.indexOf('&') < 0 && wl.split(/\s+/).filter(Boolean).length <= 2)) return 'Solo';
    var n = String(w).split(/,|&/).length; return n === 2 ? 'Duet' : n === 3 ? 'Trio' : 'Small group';
  }
  // rows: 2-D array; the header is the first row with at least `min` filled cells. Returns objects keyed by lower-case header.
  function table(rows, min) {
    rows = rows || []; var hi = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].filter(function (x) { return String(x).trim(); }).length >= (min || 3)) { hi = i; break; }
    if (hi < 0) return [];
    var H = rows[hi].map(function (x) { return String(x).trim().toLowerCase(); });
    return rows.slice(hi + 1).filter(function (r) { return r.some(function (x) { return String(x).trim(); }); })
      .map(function (r) { var o = {}; H.forEach(function (h, i) { o[h] = String(r[i] == null ? '' : r[i]).trim(); }); return o; });
  }
  function col(o) { for (var a = 1; a < arguments.length; a++) { for (var k in o) if (k.indexOf(arguments[a]) === 0 && o[k]) return o[k]; } return ''; }
  function normN(x) { return String(x || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
  // Company Calendar workbook: Rehearsals + No rehearsals tabs
  function readCompany(tab) {
    var reh = table(tab('Rehearsals'), 4).filter(function (r) { return isoDate(col(r, 'date')); }).map(function (r) {
      var st = col(r, 'studio'), what = col(r, 'dancers', 'routine');
      return { date: isoDate(col(r, 'date')), time: short(hhmm(col(r, 'start')), hhmm(col(r, 'end'))) || col(r, 'notes') || 'Time TBA',
        room: /^[abc]$/i.test(st) ? 'Studio ' + st.toUpperCase() : st, what: what, teacher: col(r, 'teacher'), kind: col(r, 'type') || kindOf(what) };
    });
    var off = table(tab('No rehearsals'), 2).filter(function (r) { return isoDate(col(r, 'date')); }).map(function (r) {
      return { date: isoDate(col(r, 'date')), who: (col(r, 'teacher') || 'All').split(',').map(function (x) { return x.trim(); }).filter(Boolean) };
    });
    return { rehearsals: reh, off: off };
  }
  // Competition workbook: Competitions, Routines, Groups + one schedule tab per competition (same rules as the admin)
  function readComps(tab) {
    var R = {}; table(tab('Routines')).forEach(function (r) { var s = col(r, 'song'); if (s) R[s.toLowerCase()] = r; });
    var groups = {}; table(tab('Groups'), 2).forEach(function (r) { var g = col(r, 'group'), n = col(r, 'dancers'); if (g && n && !/^e\.g\./i.test(g)) groups[g] = n.split(/\s*(?:,|&|\band\b|\n)\s*/i).map(function (x) { return x.trim(); }).filter(Boolean); });
    return table(tab('Competitions')).filter(function (c) { return col(c, 'tab') || col(c, 'competition'); }).map(function (c) {
      var t = col(c, 'tab') || col(c, 'competition'), days = [];
      table(tab(t)).forEach(function (r) {
        var d = col(r, 'day'); if (!d) return;
        if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, label: d, rows: [] });
        var song = col(r, 'song'), D = days[days.length - 1];
        if (/^awards?$/i.test(song)) { D.rows.push({ awards: true, perf: col(r, 'est'), note: col(r, 'note'), stage: col(r, 'stage') }); return; }
        var x = R[song.toLowerCase()] || {};
        D.rows.push({ num: col(r, 'entry'), song: song, dancers: col(x, 'dancers'), arrive: col(r, 'arrival'), perf: col(r, 'est'), note: col(r, 'note'), stage: col(r, 'stage') });
      });
      return { id: normN(t), name: col(c, 'competition') || t, venue: col(c, 'venue'), address: col(c, 'address'), dates: col(c, 'dates'), status: col(c, 'status') || 'Preliminary', groups: groups, days: days };
    });
  }

  return { calendar: calendar, studioEvents: studioEvents, dancerEvents: dancerEvents, dancerName: dancerName, query: query, span: span, timeIn: timeIn, readCompany: readCompany, readComps: readComps, isoDate: isoDate };
})();


// Node (website build + tests) can load the feed code too
if (typeof module !== 'undefined') module.exports = FEED;
