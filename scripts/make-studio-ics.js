// Builds studio.ics (the public "Subscribe to the studio calendar" feed).
// Same code as the Apps Script feed (apps-script/calendar-feed.gs), so both always agree.
// Usage: node scripts/make-studio-ics.js [calendar.json | content.json] [studio.ics] [https://site/]
//  - Reads the calendar from content.json (what the admin published) or a plain calendar.json list.
//  - Site address: the third argument, else SITE_URL, else the CNAME file (custom domain), else the GitHub
//    Pages address of the repo it runs in (GITHUB_REPOSITORY), else the datj-concept prototype.
const fs = require('fs'), path = require('path'), vm = require('vm');
const args = process.argv.slice(2);
const cal = args[0] || 'calendar.json', out = args[1] || 'studio.ics';
const site = (() => {
  if (args[2]) return args[2];
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const cname = path.join(path.dirname(path.resolve(out)), 'CNAME');
  if (fs.existsSync(cname)) { const d = fs.readFileSync(cname, 'utf8').trim(); if (d) return 'https://' + d + '/'; }
  const r = /^([^/]+)\/(.+)$/.exec(process.env.GITHUB_REPOSITORY || '');
  if (r) return /\.github\.io$/i.test(r[2]) ? 'https://' + r[2] + '/' : 'https://' + r[1].toLowerCase() + '.github.io/' + r[2] + '/';
  return 'https://leighagrimm-web.github.io/datj-concept/';
})().replace(/\/?$/, '/');
const box = { module: { exports: {} } }; vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'calendar-feed.gs'), 'utf8'), box);
const FEED = box.module.exports;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const data = JSON.parse(fs.readFileSync(cal, 'utf8'));
const list = Array.isArray(data) ? data : (data.calendar || []);
// The whole calendar, plus one file per filter on the website's calendar (Subscribe follows the filter you're on)
const FILES = [['', null, 'Dance & All That Jazz'], ['-closures', 'Closure', 'D&ATJ · Closures'], ['-events', 'Event', 'D&ATJ · Events'],
  ['-sessions', 'Session', 'D&ATJ · Session dates'], ['-recital', 'Recital', 'D&ATJ · Recital'], ['-company', 'Company', 'D&ATJ · Company']];
// Keep a file unchanged when only the timestamp would change (no pointless commits)
const strip = (s) => s.replace(/^DTSTAMP:.*$/mg, '');
FILES.forEach(([suffix, type, name]) => {
  const file = out.replace(/\.ics$/, suffix + '.ics');
  const ics = FEED.calendar(name, FEED.studioEvents(type ? list.filter((e) => (e.type || 'Event') === type) : list, site, today));
  if (fs.existsSync(file) && strip(fs.readFileSync(file, 'utf8')) === strip(ics)) { console.log(path.basename(file) + ' unchanged'); return; }
  fs.writeFileSync(file, ics); console.log(path.basename(file) + ':', (ics.match(/BEGIN:VEVENT/g) || []).length, 'dates, links to', site);
});
