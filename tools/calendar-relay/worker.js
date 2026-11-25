// Dancer calendar relay (Cloudflare Worker).
//
// Apple Calendar won't subscribe to an Apps Script address: Apps Script answers with a redirect to another Google
// host, and Apple's subscription check rejects it ("insecure connection", then "validation failed"). This Worker sits
// at a normal address, fetches the dancer calendar from the admin's Apps Script server (following the redirect) and
// hands the calendar file straight back.
//
// It passes along only a dancer link's random code (?cal=…) and the "also add studio dates" switch (&s=1): no names,
// no secrets. FEED is the admin's public Apps Script deployment (the same address the site already shows).
// Setup: Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy. One Worker per site
// (test, live), each with its own FEED.

const FEED = 'https://script.google.com/macros/s/AKfycbye-nEG-VYkahNzDHmkZNe2BurZ6n4g-m6o9R_PpgLNUNUvRujgoF97Hry-nODKegg35w/exec';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('cal') || url.searchParams.get('c') || '';
    if (!/^[a-f0-9]{20}$/.test(code)) return new Response('Not a calendar link.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    // ?cal= (Google reserves ?c= on Apps Script addresses)
    const target = FEED + '?cal=' + code + (url.searchParams.get('s') === '1' ? '&s=1' : '');
    const r = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'datj-calendar-relay' } });
    const body = await r.text();
    const isCal = /^BEGIN:VCALENDAR/.test(body);
    return new Response(body, {
      status: isCal ? 200 : (r.ok ? 404 : 502),
      headers: {
        'content-type': isCal ? 'text/calendar; charset=utf-8' : 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300'
      }
    });
  }
};
