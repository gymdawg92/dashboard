// Supabase Edge Function: calendar-refresh
// Fetches calendar events from configured ICS feeds (Titan + any others),
// merges, filters to a rolling window, and stores in dashboard_data.calendar
// for the dashboard's This Week module to render.
//
// Env vars:
//   TITAN_ICS_URL              full ICS feed URL with auth token in path
//   GCAL_ICS_URL               (optional) Google Calendar private ICS URL
//   SUPABASE_URL               auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  auto-injected

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const WINDOW_DAYS = 14;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const sources: Array<{ name: string; url: string }> = [];
    const titan = Deno.env.get('TITAN_ICS_URL');
    const gcal = Deno.env.get('GCAL_ICS_URL');
    if (titan) sources.push({ name: 'Titan', url: titan });
    if (gcal) sources.push({ name: 'Google', url: gcal });

    if (sources.length === 0) {
      return json({ error: 'No calendar sources configured. Set TITAN_ICS_URL or GCAL_ICS_URL.' }, 400);
    }

    const now = Date.now();
    const windowEnd = now + WINDOW_DAYS * 24 * 3600 * 1000;

    const all: any[] = [];
    const errors: any[] = [];

    await Promise.all(sources.map(async (src) => {
      try {
        const res = await fetch(src.url, { headers: { 'Accept': 'text/calendar' } });
        if (!res.ok) {
          errors.push({ source: src.name, status: res.status });
          return;
        }
        const text = await res.text();
        const events = parseICS(text, src.name).filter(
          (e) => e.startMs && e.startMs >= now - 6 * 3600 * 1000 && e.startMs <= windowEnd,
        );
        all.push(...events);
      } catch (err) {
        errors.push({ source: src.name, detail: String(err) });
      }
    }));

    all.sort((a, b) => a.startMs - b.startMs);

    const snapshot = {
      events: all.slice(0, 50),
      sources: sources.map((s) => s.name),
      windowDays: WINDOW_DAYS,
      refreshedAt: new Date().toISOString(),
      errors: errors.length ? errors : undefined,
    };

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error: writeErr } = await supabase
      .from('dashboard_data')
      .upsert({ key: 'calendar', value: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (writeErr) return json({ error: 'Failed to store calendar snapshot', detail: writeErr.message, snapshot }, 500);
    return json({ ok: true, snapshot });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
});

// --------------------------------------------------------------------
// ICS parser — handles VEVENT blocks, line continuation (RFC 5545),
// DTSTART/DTEND in TZID + UTC + DATE-only forms, basic SUMMARY/LOCATION.
// --------------------------------------------------------------------
function parseICS(text: string, sourceName: string): any[] {
  // Unfold RFC 5545 line continuation: lines starting with space/tab continue prior line
  const unfolded: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      unfolded[unfolded.length - 1] = (unfolded[unfolded.length - 1] || '') + raw.slice(1);
    } else {
      unfolded.push(raw);
    }
  }

  const events: any[] = [];
  let cur: Record<string, any> | null = null;

  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') {
      cur = { source: sourceName };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) {
        const ev = finalizeEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    // Split key (with params) from value
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const head = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const [key, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const [pk, pv] = p.split('=');
      if (pk) params[pk.toUpperCase()] = (pv || '').replace(/^"|"$/g, '');
    }
    cur[key.toUpperCase()] = { value, params };
  }

  return events;
}

function finalizeEvent(raw: Record<string, any>): any | null {
  const summary = unescapeIcs(raw.SUMMARY?.value || '(No title)');
  const location = unescapeIcs(raw.LOCATION?.value || '');
  const description = unescapeIcs(raw.DESCRIPTION?.value || '');
  const startMs = parseIcsDate(raw.DTSTART);
  const endMs = parseIcsDate(raw.DTEND);
  if (!startMs) return null;
  return {
    summary,
    location,
    description,
    startMs,
    endMs: endMs || startMs + 3600 * 1000,
    allDay: raw.DTSTART?.params?.VALUE === 'DATE',
    source: raw.source || 'Unknown',
    uid: raw.UID?.value || '',
  };
}

function parseIcsDate(field: any): number | null {
  if (!field?.value) return null;
  const v: string = field.value;

  // DATE-only (e.g. 20260428)
  if (/^\d{8}$/.test(v)) {
    const y = Number(v.slice(0, 4));
    const m = Number(v.slice(4, 6)) - 1;
    const d = Number(v.slice(6, 8));
    return Date.UTC(y, m, d);
  }

  // DATE-TIME
  // Forms: 20260428T130000  /  20260428T130000Z  /  TZID=America/New_York:20260428T090000
  const match = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const yy = Number(y), MM = Number(mo) - 1, dd = Number(d), hh = Number(h), mm = Number(mi), ss = Number(s);

  if (z === 'Z') return Date.UTC(yy, MM, dd, hh, mm, ss);

  const tzid = field.params?.TZID;
  if (tzid) {
    // Use Intl to compute the UTC offset for the given zone at the given wall-clock time
    return tzAwareToUTC(yy, MM, dd, hh, mm, ss, tzid);
  }

  // Floating local time — assume UTC. (Most calendars produce TZID or Z, so this is rare.)
  return Date.UTC(yy, MM, dd, hh, mm, ss);
}

// Convert wall-clock time in given IANA zone to UTC ms.
// Uses Intl.DateTimeFormat to read the zone's offset at that instant.
function tzAwareToUTC(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const guessUTC = Date.UTC(y, mo, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(guessUTC));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const localY = get('year'), localM = get('month') - 1, localD = get('day');
    let localH = get('hour'); if (localH === 24) localH = 0;
    const localMi = get('minute'), localS = get('second');
    const asIfUTC = Date.UTC(localY, localM, localD, localH, localMi, localS);
    const offset = asIfUTC - guessUTC;
    return guessUTC - offset;
  } catch {
    return guessUTC;
  }
}

function unescapeIcs(s: string): string {
  return String(s)
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
