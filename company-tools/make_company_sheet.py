"""One Company sheet with every tab the dancer calendars read: Rehearsals + No rehearsals (from Brittany's month-grid
Company Rehearsal Calendar, via parse_rehearsals.py) and Competitions + Routines + Groups + one schedule tab per
competition (from the studio calendar). Private (dancer names): the .xlsx stays out of the repo (.gitignore *.xlsx).

python3 parse_rehearsals.py "Company Rehearsal Calendar.xlsx" raw.json
python3 make_company_sheet.py raw.json content.json Company_Sheet_2026-27.xlsx [groups.json]
(groups.json: [["Jazz Large Group", "Ava S, Bella M, ..."], ...], also private)
Then upload the .xlsx to the season's Google account, File > Save as Google Sheets, and paste its link on the admin's
Company Central screen."""
import json, re, sys, datetime as dt, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter as L

RAW, CONTENT, OUT = sys.argv[1:4]
GROUPS = json.load(open(sys.argv[4], encoding='utf-8')) if len(sys.argv) > 4 else []
HERE = __file__.replace('\\', '/').rsplit('/', 1)[0] + '/..'
raw = json.load(open(RAW, encoding='utf-8'))
content = json.load(open(CONTENT, encoding='utf-8'))
H = Font(bold=True, color='FFFFFF'); F = PatternFill('solid', fgColor='00ADB5'); W = Alignment(wrap_text=True, vertical='top')
TEACHERS = ['Miss Kelly', 'Miss Katie', 'Miss Meghan', 'Mr. Daniel', 'Miss Allie']
TYPES = ['Solo', 'Duet', 'Trio', 'Small group', 'Large group', 'Hip Hop Company', 'Dress rehearsal', 'Performance', 'Windy City Bulls']
TEAMS = {'Petite Co': 'Petite Company', 'Int.': 'Intermediate', 'Jr.': 'Junior', 'Teen Co': 'Teen Company', 'Senior Co': 'Senior Company',
         'Junior Co': 'Junior Company', 'Hip Hop Co': 'Hip Hop Company', 'Intermediate Co': 'Intermediate Company'}

def times(t):  # "8–10am" -> (time(8,0), time(10,0)); not a time -> None  (same as make_company_workbook.py)
    p = re.split(r'\s*[–-]\s*', t.replace(' ', ''))
    if len(p) != 2: return None
    hm = lambda x: re.fullmatch(r'(\d{1,2})(?::(\d{2}))?(am|pm)?', x, re.I)
    a, b = hm(p[0]), hm(p[1])
    if not a or not b or not b.group(3): return None
    to = lambda m, ap: (int(m.group(1)) % 12 + (12 if ap.lower() == 'pm' else 0), int(m.group(2) or 0))
    e = to(b, b.group(3)); s = to(a, a.group(3) or b.group(3))
    if not a.group(3) and s > e: s = to(a, 'am')
    return dt.time(*s), dt.time(*e)
def teams(s):  # "Int., Jr., & Teen Co" -> "Intermediate, Junior, & Teen Company"
    for k, v in TEAMS.items(): s = s.replace(k, v)
    return re.sub(r'\bCompany\b(?=.*\bCompany\b)', '', s).replace(' ,', ',').replace('  ', ' ').strip()
def typ(what):  # only where the website's guess (1 name = Solo, 2 = Duet ...) would be wrong
    parts = [x.strip() for x in re.split(r',|&', what) if x.strip()]
    if len(parts) > 1 and all(x.endswith('Solo') for x in parts): return 'Solo'
    return ''
D = dt.date.fromisoformat
rows, off, skipped = [], [], []
def add(date, tt, studio, teacher, what, kind='', note=''):
    rows.append([D(date), None, tt[0] if tt else None, tt[1] if tt else None, studio, teacher, what, kind, note])

for e in raw['entries']:
    if e['kind'] == 'rehearsal':
        add(e['date'], times(e['time']), e['room'], e['teacher'], e['what'], typ(e['what']), '' if times(e['time']) else e['time'])
weekly_days = sorted({e['date'] for e in raw['entries'] if e['kind'] == 'note' and e['text'].strip().lower() == 'weekly rehearsals'})
for d in weekly_days:
    for w in raw['weekly']:
        add(d, times(w['time']), w['room'].replace('Studio ', ''), w['teacher'], w['what'], typ(w['what']), '' if times(w['time']) else w['time'])
for e in raw['entries']:
    if e['kind'] != 'note': continue
    t = e['text'].split(' · ')[0].strip(); tl = t.lower()
    if tl == 'weekly rehearsals': continue
    if tl.startswith('no rehearsals'):
        why = t.split('-', 1)[1].strip().capitalize() if '-' in t else ''
        off.append([D(e['date']), None, e['teacher'] or 'All', why]); continue
    if 'dress rehearsal' in tl:
        add(e['date'], None, '', '', teams(t.replace(' - ', ': ', 1)).replace('Mandatory Dress Rehearsal', 'mandatory dress rehearsal'), 'Dress rehearsal'); continue
    m = re.match(r'^(Windy City Rehearsal)\s+(.+)$', t)
    if m: add(e['date'], times(m.group(2)), '', '', m.group(1), 'Windy City Bulls'); continue
    if tl.startswith('windy city bulls game'):
        add(e['date'], None, 'Windy City Bulls game', '', 'Windy City Bulls Game', 'Windy City Bulls', t.split('Game', 1)[1].strip(' ;')); continue
    m = re.match(r'^Dance Films-\s*(.+)$', t)
    if m: add(e['date'], None, '', '', 'Dance Films: ' + teams(m.group(1)), 'Performance', 'Times to come'); continue
    m = re.match(r'^(.+?)\s+(\d{1,2}(?::\d\d)?\s*-\s*\d{1,2}(?::\d\d)?\s*(?:am|pm))$', t, re.I)
    if m and e['teacher']:  # a rehearsal typed as a note, in a teacher's color
        add(e['date'], times(m.group(2)), '', e['teacher'], m.group(1)); continue
    skipped.append(e['date'] + ' ' + t)
# A rehearsal written as a list of names that is clearly one of the groups (every name is in it, at most one dancer
# missing, a short name like "Mila" counting for "Milana") gets the group's name, so the Groups tab decides who's in it
first = lambda n: n.strip().split()[0].lower() if n.strip() else ''
renamed = {}
for r in rows:
    names = [first(x) for x in re.split(r',|&', r[6]) if first(x)]
    if len(names) < 5: continue
    for g, members in GROUPS:
        gm = [first(x) for x in members.split(',')]
        hit = lambda n: any(m.startswith(n) for m in gm)
        if all(hit(n) for n in names) and len(gm) - len(set(names)) <= 1:
            renamed[r[6]] = g; r[6] = g; break
rows.sort(key=lambda r: (r[0], r[2] or dt.time(23, 59), r[6]))
off.sort(key=lambda r: r[0])

# Competitions from the studio calendar ("Competition: VIP (Elgin)")
TABS = {'VIP': 'VIP', 'Hall of Fame': 'HOF', 'WCTE': 'WCTE', 'BTS': 'BTS'}
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
def span(a, b):
    a = D(a); b = D(b) if b else a
    if b == a: return '%s %d, %d' % (MON[a.month - 1], a.day, a.year)
    if a.month == b.month: return '%s %d–%d, %d' % (MON[a.month - 1], a.day, b.day, b.year)
    return '%s %d – %s %d, %d' % (MON[a.month - 1], a.day, MON[b.month - 1], b.day, b.year)
comps = []
for e in sorted(content.get('calendar', []), key=lambda e: e['start']):
    m = re.match(r'^Competition:\s*(.+?)\s*\((.+)\)$', e.get('title', ''))
    if m: comps.append([TABS.get(m.group(1), re.sub(r'\W', '', m.group(1))[:12]), m.group(1), 'Preliminary'])

wb = openpyxl.Workbook(); ws0 = wb.active; ws0.title = 'How to use'
for line in ['Company sheet: rehearsals and competitions in one place', '',
             'Rehearsals tab: one row per rehearsal (Date, Start, End, Studio A/B/C, Teacher, Dancers or group, Type only when the guess would be wrong).',
             'No rehearsals tab: days off. Teacher = All, or the teachers who are off.',
             'Competitions tab: one row per competition. Tab name = the schedule tab below. Competition = its name on the Studio calendar (VIP for “Competition: VIP (Elgin)”). Status: Preliminary or Final.',
             'Dates, place and address are not kept here: they come from the competition’s date on the Studio calendar, so moving a competition is one edit there.',
             'Routines tab: once a season (song, dancers, costume). Groups tab: who is in each group dance.',
             'Schedule tabs (VIP, HOF, WCTE, BTS): paste each schedule when it comes in: Day (Fri 3/12), Entry #, Song, Arrival, Est. performance, Note, Stage.',
             '', 'Every dancer calendar subscribed from Company Central picks up changes here within about 10 minutes.',
             'Studio dates (breaks, autopay, events) are on the Studio calendar in the admin, not here.']:
    ws0.append([line])
ws0['A1'].font = Font(bold=True, size=14); ws0.column_dimensions['A'].width = 130
def sheet(title, note, head, data, widths):
    ws = wb.create_sheet(title); ws.append([note]); ws['A1'].font = Font(italic=True, color='555555'); ws.append(head)
    for c in ws[2]: c.font = H; c.fill = F
    for r in data: ws.append(r)
    for i, w in enumerate(widths): ws.column_dimensions[L(i + 1)].width = w
    ws.freeze_panes = 'A3'
    return ws
ws = sheet('Rehearsals', 'One row per rehearsal. Type is optional. Dancers or group: names separated by commas, or a group name from the Groups tab.',
           ['Date', 'Day', 'Start', 'End', 'Studio', 'Teacher', 'Dancers or group', 'Type', 'Notes'], rows, [13, 6, 10, 10, 18, 13, 50, 16, 28])
last = max(600, len(rows) + 200)
for i in range(3, last + 1):
    ws.cell(i, 2).value = '=IF(A%d="","",TEXT(A%d,"ddd"))' % (i, i)
    ws.cell(i, 1).number_format = 'mmm d, yyyy'; ws.cell(i, 3).number_format = ws.cell(i, 4).number_format = 'h:mm AM/PM'
    for c in (7, 9): ws.cell(i, c).alignment = W
for col, items, strict in (('E', ['A', 'B', 'C'], False), ('F', TEACHERS, False), ('H', TYPES, True)):
    v = DataValidation(type='list', formula1='"' + ','.join(items) + '"', allow_blank=True, showErrorMessage=strict); ws.add_data_validation(v); v.add('%s3:%s%d' % (col, col, last))
ws2 = sheet('No rehearsals', 'Days with no rehearsals. Teacher = All, or the teachers who are off, separated by commas.', ['Date', 'Day', 'Teacher', 'Reason'], off, [13, 6, 40, 40])
for i in range(3, 200):
    ws2.cell(i, 2).value = '=IF(A%d="","",TEXT(A%d,"ddd"))' % (i, i); ws2.cell(i, 1).number_format = 'mmm d, yyyy'
sheet('Competitions', 'One row per competition. "Tab name" matches the schedule tab; "Competition" matches its name on the Studio calendar, where its dates, place and address are kept. Change Status to Final when the final schedule is in.',
      ['Tab name', 'Competition', 'Status (Preliminary / Final)', 'Prop sign-up link', 'Rules link', 'Livestream link', 'Notes for everyone', 'Lipstick', 'Hair video link', 'Makeup pictures link'],
      comps, [10, 18, 16, 22, 22, 22, 30, 14, 22, 22])
sheet('Routines', 'Fill in once a season. The costume checklist comes from this tab. Leave a cell empty instead of typing "--".',
      ['Song', 'Dancers', 'Choreographer', 'Tights?', 'Hair', 'Hairpiece', 'Shoes', 'Accessories', 'Props'], [], [24, 40, 14, 9, 22, 20, 14, 18, 14])
sheet('Groups', 'One row per group dance: Group = exactly what the Dancers column says on Routines. Company teams fill in from the website’s team rosters.',
      ['Group', 'Dancers'], GROUPS, [28, 110])
for c in comps:
    sheet(c[0], 'Paste the ' + c[1] + ' schedule here when it comes in. For awards, type AWARDS as the Song. Stage is optional.',
          ['Day', 'Entry #', 'Song', 'Arrival', 'Est. performance', 'Note', 'Stage'], [], [10, 9, 26, 10, 16, 30, 8])
# Same arrival reminders as the template (generic, no names)
try:
    t = openpyxl.load_workbook(HERE + '/Competition_Workbook_TEMPLATE.xlsx')['Arrival reminders']
    sheet('Arrival reminders', 'Same for every competition. One point per row.', ['Heading', 'Point'],
          [list(r[:2]) for r in t.iter_rows(min_row=3, values_only=True) if r[0] or r[1]], [30, 90])
except Exception as err:
    print('No arrival reminders copied:', err)
wb.save(OUT)
print(len(rows), 'rehearsal rows (', len(weekly_days), 'weekly Saturdays x', len(raw['weekly']), 'slots ),', len(off), 'days off,', len(comps), 'competitions')
print('Written as a group:'); [print('  ', g, '<-', k) for k, g in renamed.items()]
print('Left on the studio calendar:'); [print('  ', s) for s in skipped]
