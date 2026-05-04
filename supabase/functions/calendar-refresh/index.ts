// Supabase Edge Function: calendar-refresh
// Fetches calendar events from configured ICS feeds (Titan + Google) AND
// computes the next N occurrences of any active Paperclip schedule routines,
// merges everything into a rolling window, and stores in dashboard_data.calendar
// for the dashboard's This Week module to render.
//
// Env vars:
//   TITAN_ICS_URL              full ICS feed URL with auth token in path
//   GCAL_ICS_URL               (optional) Google Calendar private ICS URL
//   PAPERCLIP_BASE_URL         (optional) e.g. https://paperclip.example.com/api
//   PAPERCLIP_API_KEY          (optional) Paperclip agent API key
//   PAPERCLIP_COMPANIES        (optional) JSON array, same shape as paperclip-sync
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

    const paperclipBase = Deno.env.get('PAPERCLIP_BASE_URL');
    const paperclipKey = Deno.env.get('PAPERCLIP_API_KEY');
    const paperclipCompanies = readPaperclipCompanies();
    const hasPaperclip = paperclipBase && paperclipKey && paperclipCompanies.length > 0;

    if (sources.length === 0 && !hasPaperclip) {
      return json({ error: 'No calendar sources configured. Set TITAN_ICS_URL, GCAL_ICS_URL, or Paperclip env vars.' }, 400);
    }

    const now = Date.now();
    const windowEnd = now + WINDOW_DAYS * 24 * 3600 * 1000;

    const all: any[] = [];
    const errors: any[] = [];
    const sourceLabels: string[] = [];

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
    sources.forEach((s) => sourceLabels.push(s.name));

    // ── Paperclip routines ──
    if (hasPaperclip) {
      try {
        const routineEvents = await fetchPaperclipRoutineEvents(
          paperclipBase!, paperclipKey!, paperclipCompanies, now, windowEnd,
        );
        all.push(...routineEvents);
        sourceLabels.push('Paperclip');
      } catch (err) {
        errors.push({ source: 'Paperclip', detail: String(err) });
      }
    }

    all.sort((a, b) => a.startMs - b.startMs);

    const snapshot = {
      events: all.slice(0, 75),
      sources: sourceLabels,
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

// ──────────────────────────────────────────────────────────
// Paperclip routine integration
// ──────────────────────────────────────────────────────────

interface PaperclipCompanyConfig {
  id: string;
  name?: string;
  prefix?: string;
}

function readPaperclipCompanies(): PaperclipCompanyConfig[] {
  const json = Deno.env.get('PAPERCLIP_COMPANIES');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed.map((c: any) => ({ id: c.id, name: c.name, prefix: c.prefix }));
    } catch (_) { /* fall through */ }
  }
  const id = Deno.env.get('PAPERCLIP_COMPANY_ID');
  if (!id) return [];
  return [{
    id,
    name: Deno.env.get('PAPERCLIP_COMPANY_NAME') ?? undefined,
    prefix: Deno.env.get('PAPERCLIP_PREFIX') ?? undefined,
  }];
}

async function fetchPaperclipRoutineEvents(
  baseUrl: string, key: string,
  companies: PaperclipCompanyConfig[],
  now: number, windowEnd: number,
): Promise<any[]> {
  const events: any[] = [];

  for (const co of companies) {
    const url = `${baseUrl.replace(/\/$/, '')}/companies/${co.id}/routines`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Paperclip routines (${co.id}) → ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const routines: any[] = Array.isArray(data) ? data : (data.routines || data.items || []);

    for (const r of routines) {
      if (r.status !== 'active') continue;
      const triggers = Array.isArray(r.triggers) ? r.triggers : [];
      for (const t of triggers) {
        if (t.kind !== 'schedule' || t.enabled === false) continue;
        const occurrences = expandCronOccurrences(t.cronExpression, t.timezone || 'UTC', t.nextRunAt, now, windowEnd);
        for (const ms of occurrences) {
          events.push({
            summary: `🤖 ${r.title || 'Routine'}`,
            location: '',
            description: t.label || r.description || '',
            startMs: ms,
            endMs: ms + 30 * 60 * 1000, // assume 30 min for visualization
            allDay: false,
            source: 'Paperclip',
            uid: `paperclip-routine-${r.id}-${ms}`,
          });
        }
      }
    }
  }

  return events;
}

// Compute upcoming occurrences within [now, windowEnd].
// Iterates day-by-day using cron's dayOfWeek + dayOfMonth + month masks,
// then for each matching day computes timestamps from the cron's hour/minute
// at the routine's TZID. Cheap: ~14 day-iterations per routine × small fan-out.
// Includes Paperclip's `nextRunAt` as a seed if it's within the window.
function expandCronOccurrences(
  cronExpr: string | undefined | null,
  tzid: string,
  nextRunAt: string | undefined | null,
  now: number, windowEnd: number,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (ms: number) => { if (!seen.has(ms)) { seen.add(ms); out.push(ms); } };

  const seed = nextRunAt ? new Date(nextRunAt).getTime() : NaN;
  if (Number.isFinite(seed) && seed >= now - 60_000 && seed <= windowEnd) push(seed);

  if (!cronExpr) return out;
  const parsed = parseCron(cronExpr);
  if (!parsed) return out;

  const dayMs = 86_400_000;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  for (let cursor = now; cursor <= windowEnd && out.length < 8; cursor += dayMs) {
    let y = 0, m = 0, d = 0, dow = 0;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      }).formatToParts(new Date(cursor));
      const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
      y = Number(get('year'));
      m = Number(get('month'));
      d = Number(get('day'));
      dow = wdMap[get('weekday') as string] ?? 0;
    } catch { continue; }

    if (!parsed.month.has(m)) continue;
    const domR = parsed.dayOfMonth.size !== 31;
    const dowR = parsed.dayOfWeek.size !== 7;
    const dayMatch = (!domR && !dowR) ||
      (domR && dowR ? (parsed.dayOfMonth.has(d) || parsed.dayOfWeek.has(dow)) :
       domR ? parsed.dayOfMonth.has(d) : parsed.dayOfWeek.has(dow));
    if (!dayMatch) continue;

    for (const hr of parsed.hour) {
      for (const mi of parsed.minute) {
        const ms = wallClockToUTC(y, m - 1, d, hr, mi, 0, tzid);
        if (ms > now && ms <= windowEnd) {
          push(ms);
          if (out.length >= 8) return out;
        }
      }
    }
  }
  return out;
}

function wallClockToUTC(y: number, m0: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const guess = Date.UTC(y, m0, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    let lh = get('hour'); if (lh === 24) lh = 0;
    const asIfUTC = Date.UTC(get('year'), get('month') - 1, get('day'), lh, get('minute'), get('second'));
    const offset = asIfUTC - guess;
    return guess - offset;
  } catch {
    return guess;
  }
}

interface CronParsed {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}
function parseCron(expr: string): CronParsed | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const sets: Set<number>[] = parts.map((field, i) => expandField(field, ranges[i][0], ranges[i][1]));
  if (sets.some((s) => s === null as any)) return null;
  return { minute: sets[0], hour: sets[1], dayOfMonth: sets[2], month: sets[3], dayOfWeek: sets[4] };
}
function expandField(field: string, lo: number, hi: number): Set<number> {
  const set = new Set<number>();
  for (const tok of field.split(',')) {
    let step = 1;
    let body = tok;
    if (tok.includes('/')) { const [b, s] = tok.split('/'); body = b; step = Number(s) || 1; }
    let start = lo, end = hi;
    if (body !== '*') {
      if (body.includes('-')) { const [a, b] = body.split('-'); start = Number(a); end = Number(b); }
      else { start = end = Number(body); }
    }
    for (let v = start; v <= end; v += step) set.add(v);
  }
  return set;
}
function cronMatchesAtTz(ms: number, c: CronParsed, tzid: string): boolean {
  // Decompose ms into wall-clock fields in tzid using Intl.
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    let hour = Number(get('hour')); if (hour === 24) hour = 0;
    const minute = Number(get('minute'));
    const day = Number(get('day'));
    const month = Number(get('month'));
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = wdMap[get('weekday') as string] ?? 0;
    if (!c.minute.has(minute)) return false;
    if (!c.hour.has(hour)) return false;
    if (!c.month.has(month)) return false;
    // POSIX cron semantics: dom and dow are OR'd if both restricted.
    const domRestricted = c.dayOfMonth.size !== 31;
    const dowRestricted = c.dayOfWeek.size !== 7;
    const dayMatch = (!domRestricted && !dowRestricted) ||
      (domRestricted && dowRestricted ? (c.dayOfMonth.has(day) || c.dayOfWeek.has(dow)) :
       domRestricted ? c.dayOfMonth.has(day) : c.dayOfWeek.has(dow));
    return dayMatch;
  } catch {
    return false;
  }
}
