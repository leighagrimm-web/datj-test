"""This season's Studio calendar as a filled-in workbook (same layout as Studio_Calendar_TEMPLATE.xlsx), from the
published content.json. Only public information: "Company families only" dates get their title, date, place and
type, and their details stay in the admin (a blank detail cell on a locked row keeps them).

python3 make_studio_calendar.py content.json Studio_Calendar_2026-27.xlsx [extra_rows.json]
(extra_rows.json: dates that aren't in content.json, e.g. "Only on Company Central" ones:
 [{"title": "...", "start": "2027-01-15", "where": "...", "type": "Company", "hidden": true}])
Then upload it to the studio's Google Drive, File > Save as Google Sheets, Share > Anyone with the link can view,
and paste its link on the admin's Studio calendar screen."""
import json, re, sys, datetime as dt, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter as L

CONTENT, OUT = sys.argv[1:3]
extra = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else []
cal = json.load(open(CONTENT, encoding='utf-8')).get('calendar', []) + extra
H = Font(bold=True, color='FFFFFF'); F = PatternFill('solid', fgColor='00ADB5'); W = Alignment(wrap_text=True, vertical='top')
D = lambda s: dt.date.fromisoformat(s) if s else None

def split_body(body):  # iBody -> summary, details, [(label, url)...]  (the admin joins them the same way on upload)
    paras = [p.strip() for p in re.split(r'\n\s*\n', str(body or '').strip()) if p.strip()]
    buttons, rest = [], []
    for p in paras:
        m = re.fullmatch(r'\[(.+)\]\((.*)\)', p)
        if m: buttons.append((m.group(1), m.group(2)))
        else: rest.append(p)
    summary = rest[0] if rest and not rest[0].startswith(('## ', '- ')) else ''
    details = '\n\n'.join(rest[1:] if summary else rest)
    return summary, details, buttons

rows = []
for e in sorted(cal, key=lambda e: (e.get('start', ''), e.get('title', ''))):
    if not e.get('title') or not e.get('start'): continue
    who = 'Company Central only' if e.get('hidden') else 'Company details locked' if e.get('lock') else 'Public'
    if e.get('lock') or e.get('hidden'): summary, details, buttons, time, addr = '', '', [], '', ''
    else:
        summary, details, buttons = split_body(e.get('iBody')); time, addr = e.get('iWhen', ''), e.get('iWhere', '')
    b = buttons + [('', '')] * 2
    rows.append([e['title'], D(e['start']), D(e.get('end')), time, e.get('where', ''), addr, e.get('type') or 'Event', who,
                 summary, details, b[0][0], b[0][1], b[1][0], b[1][1]])

wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Events'
ws.append(['One row per date. Rows with the same title and start date update the date that is already there; new rows are added. '
           'Details: “## Heading” on its own line, then “- ” for each point. Company details locked: leave Time, Address, Summary and '
           'Details empty to keep the private details in the admin.'])
ws['A1'].font = Font(italic=True, color='555555')
head = ['What', 'Start', 'End', 'Time', 'Where (short)', 'Address', 'Type', 'Who sees details', 'Summary (one or two sentences)', 'Details',
        'Button 1', 'Button 1 link', 'Button 2', 'Button 2 link']
ws.append(head)
for c in ws[2]: c.font = H; c.fill = F
for r in rows: ws.append(r)
for i, w in enumerate([40, 12, 12, 26, 26, 34, 11, 22, 46, 50, 14, 30, 14, 30]): ws.column_dimensions[L(i + 1)].width = w
last = max(400, len(rows) + 200)
for i in range(3, last + 1):
    ws.cell(i, 2).number_format = ws.cell(i, 3).number_format = 'mmm d, yyyy'
    for c in (9, 10): ws.cell(i, c).alignment = W
ws.freeze_panes = 'B3'
for col, items in (('G', ['Event', 'Company', 'Closure', 'Session', 'Recital']), ('H', ['Public', 'Company details locked', 'Company Central only'])):
    v = DataValidation(type='list', formula1='"' + ','.join(items) + '"', allow_blank=True, showErrorMessage=True); ws.add_data_validation(v); v.add('%s3:%s%d' % (col, col, last))

hw = wb.create_sheet('How to use')
for line in ['Studio calendar: how this sheet works', '',
             'This is the studio calendar for the whole season: breaks, session dates, events, Company dates and the Annual Performance.',
             'The website’s calendar, the homepage “Mark your calendar”, Company Central and the subscribe-to-calendar feed all come from it, through the admin.', '',
             'Columns',
             '  What: the title families see. Competitions start with “Competition:” (e.g. Competition: VIP (Elgin)) so they show in the competition schedules.',
             '  Start / End: real dates (type 3/12/2027). End only for dates that last more than a day.',
             '  Time: e.g. “2:30–4:30 PM” or “Saturday, Nov 14 · Call time 4:15 PM”. Where (short): a word or two (At the studio, Elgin). Address: the full address for maps.',
             '  Type: Event, Company, Closure, Session or Recital. These are the filters on the website.',
             '  Who sees details: Public · Company details locked (title and date are public, details need the Company password) · Company Central only (not on the public calendar at all).',
             '  Summary: one or two sentences. Details: “## Heading” on its own line, then “- ” for each point. Buttons: a label and a link.', '',
             'Private details',
             '  This sheet is shared “Anyone with the link can view”, so keep it public information only.',
             '  For “Company details locked” dates, type the details in the admin (Studio calendar → tap the date), not here. Leave Time, Address, Summary and Details empty here and the admin keeps them.', '',
             'Making updates',
             '  1. Change, add or delete rows here.',
             '  2. In the admin, open Studio calendar and press Check for updates. It lists what’s new, changed or gone. Review, then Apply.',
             '  3. Press Publish. The website and subscribed calendars update on their own.', '',
             'Linking it (once a season)',
             '  Share → General access → Anyone with the link → Viewer. Copy the link and paste it in the admin: Studio calendar → Your calendar Google Sheet.', '',
             'Next season',
             '  File → Make a copy, name it for the new season (Studio Calendar 2027-28), delete this season’s rows (keep rows 1 and 2), add the new dates,',
             '  then share it and paste the new link in the admin. Past dates hide themselves on the website, so there’s no rush to delete old rows.']:
    hw.append([line])
hw['A1'].font = Font(bold=True, size=14); hw.column_dimensions['A'].width = 150
wb.save(OUT)
print(len(rows), 'dates:', sum(r[7] == 'Public' for r in rows), 'public,', sum(r[7] == 'Company details locked' for r in rows), 'locked,',
      sum(r[7] == 'Company Central only' for r in rows), 'Company Central only')
