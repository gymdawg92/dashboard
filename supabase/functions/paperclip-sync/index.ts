// Supabase Edge Function: paperclip-sync
// Pulls open Paperclip issues + pending approvals into dashboard_data.tasks
// as a one-way feed. Tasks get id `pcp_<uuid>` (issues) or `pcpa_<uuid>` (approvals)
// and source: 'paperclip', so notion-sync and other writers know they're authoritative
// upstream and shouldn't be merged from elsewhere.
//
// Routines are surfaced via calendar-refresh (separate function), not here.
//
// Env vars required:
//   PAPERCLIP_BASE_URL          'https://paperclip.rootedfinancial.co/api'
//   PAPERCLIP_API_KEY           'pcp_...'
//   PAPERCLIP_COMPANIES         JSON array — see structure below.
//                                 If a single company, you can omit this and use
//                                 PAPERCLIP_COMPANY_ID + PAPERCLIP_SECTION + PAPERCLIP_PROJECT_ID.
//   SUPABASE_URL                auto-injected
//   SUPABASE_SERVICE_ROLE_KEY   auto-injected
//
// PAPERCLIP_COMPANIES shape:
//   [{ "id": "uuid", "name": "Rooted Financial", "section": "🏢 Rooted Financial",
//      "projectId": "p1", "prefix": "ROOAAA", "tag": "Tech", "tagC": "ttech" }]

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CompanyConfig {
  id: string;
  name?: string;
  section: string;
  projectId?: string | null;
  prefix?: string;
  tag?: string;
  tagC?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const baseUrl = Deno.env.get('PAPERCLIP_BASE_URL');
    const apiKey = Deno.env.get('PAPERCLIP_API_KEY');
    if (!baseUrl || !apiKey) return json({ error: 'Missing PAPERCLIP_BASE_URL or PAPERCLIP_API_KEY' }, 500);

    const companies = readCompanies();
    if (companies.length === 0) return json({ error: 'No PAPERCLIP_COMPANIES configured' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: tasksRow } = await supabase.from('dashboard_data').select('value').eq('key', 'tasks').maybeSingle();
    let tasks: any[] = (tasksRow?.value as any[]) ?? [];
    const tasksByDashId = new Map(tasks.map((t) => [t.id, t]));

    const stats = { companies: 0, issuesPulled: 0, approvalsPulled: 0, removed: 0, errors: [] as any[] };
    const seenPaperclipIds = new Set<string>();

    for (const co of companies) {
      stats.companies++;
      try {
        const [issues, approvals] = await Promise.all([
          paperclipGet(baseUrl, apiKey, `/companies/${co.id}/issues`),
          paperclipGet(baseUrl, apiKey, `/companies/${co.id}/approvals`).catch(() => []),
        ]);

        // ── Issues ──
        for (const iss of issues) {
          if (iss.cancelledAt || iss.hiddenAt) continue;
          const dashId = `pcp_${iss.id}`;
          seenPaperclipIds.add(dashId);
          const merged = tasksByDashId.get(dashId) ?? { subtasks: [], checkins: [] };
          const isDone = iss.status === 'done';
          const identifier = iss.identifier || `${co.prefix || 'PCP'}-${iss.issueNumber || ''}`;

          merged.id = dashId;
          merged.title = `[${identifier}] ${iss.title || '(untitled)'}`;
          merged.sub = paperclipStatusLabel(iss);
          merged.section = co.section;
          merged.tag = co.tag || 'Tech';
          merged.tagC = co.tagC || 'ttech';
          merged.done = isDone;
          merged.due = ''; // Paperclip doesn't track due dates on issues
          merged.notes = (iss.description || '').slice(0, 4000);
          merged.projectId = co.projectId || null;
          merged.subtasks = merged.subtasks || [];
          merged.checkins = merged.checkins || [];
          merged.source = 'paperclip';
          merged.paperclipId = iss.id;
          merged.paperclipIdentifier = identifier;
          merged.paperclipCompanyId = co.id;
          merged.paperclipStatus = iss.status;
          merged.paperclipPriority = iss.priority || null;
          merged.paperclipUrl = paperclipIssueUrl(baseUrl, co.id, iss.id);
          merged.updatedAt = iss.updatedAt || new Date().toISOString();

          if (!tasksByDashId.has(dashId)) {
            tasks.push(merged);
            tasksByDashId.set(dashId, merged);
          }
          stats.issuesPulled++;
        }

        // ── Approvals (mapped as tasks, prefixed with ⚡) ──
        for (const ap of approvals) {
          if (ap.resolvedAt || ap.cancelledAt) continue;
          const dashId = `pcpa_${ap.id}`;
          seenPaperclipIds.add(dashId);
          const merged = tasksByDashId.get(dashId) ?? { subtasks: [], checkins: [] };

          merged.id = dashId;
          merged.title = `⚡ APPROVAL — ${ap.title || ap.summary || 'Decision needed'}`;
          merged.sub = `Paperclip approval · ${ap.kind || ''}`.trim();
          merged.section = co.section;
          merged.tag = 'Personal';
          merged.tagC = 'tp';
          merged.done = false;
          merged.due = '';
          merged.notes = (ap.description || ap.context || '').slice(0, 4000);
          merged.projectId = co.projectId || null;
          merged.subtasks = merged.subtasks || [];
          merged.checkins = merged.checkins || [];
          merged.source = 'paperclip-approval';
          merged.paperclipId = ap.id;
          merged.paperclipCompanyId = co.id;
          merged.updatedAt = ap.updatedAt || new Date().toISOString();

          if (!tasksByDashId.has(dashId)) {
            tasks.push(merged);
            tasksByDashId.set(dashId, merged);
          }
          stats.approvalsPulled++;
        }
      } catch (err) {
        stats.errors.push({ companyId: co.id, detail: String(err) });
      }
    }

    // ── Remove Paperclip-sourced tasks no longer present (closed/deleted upstream) ──
    const before = tasks.length;
    tasks = tasks.filter((t) => {
      const isPaperclipSourced = t.source === 'paperclip' || t.source === 'paperclip-approval';
      if (!isPaperclipSourced) return true;
      return seenPaperclipIds.has(t.id);
    });
    stats.removed = before - tasks.length;

    const now = new Date().toISOString();
    await Promise.all([
      supabase.from('dashboard_data').upsert(
        { key: 'tasks', value: tasks, updated_at: now },
        { onConflict: 'key' },
      ),
      supabase.from('dashboard_data').upsert(
        { key: 'paperclip_last_sync', value: { at: now, ...stats }, updated_at: now },
        { onConflict: 'key' },
      ),
    ]);

    return json({ ok: true, ...stats, totalTasks: tasks.length });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err), stack: (err as any)?.stack }, 500);
  }
});

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function readCompanies(): CompanyConfig[] {
  const json = Deno.env.get('PAPERCLIP_COMPANIES');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through */ }
  }
  // Fallback to single-company env vars
  const id = Deno.env.get('PAPERCLIP_COMPANY_ID');
  if (!id) return [];
  return [{
    id,
    name: Deno.env.get('PAPERCLIP_COMPANY_NAME') ?? 'Rooted Financial',
    section: Deno.env.get('PAPERCLIP_SECTION') ?? '🏢 Rooted Financial',
    projectId: Deno.env.get('PAPERCLIP_PROJECT_ID') ?? null,
    prefix: Deno.env.get('PAPERCLIP_PREFIX') ?? '',
    tag: Deno.env.get('PAPERCLIP_TAG') ?? 'Tech',
    tagC: Deno.env.get('PAPERCLIP_TAG_C') ?? 'ttech',
  }];
}

async function paperclipGet(baseUrl: string, key: string, path: string): Promise<any[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  return data.issues || data.approvals || data.routines || data.items || [];
}

function paperclipStatusLabel(iss: any): string {
  const status = iss.status || '';
  const blocked = status === 'blocked';
  const attention = iss.blockerAttention;
  let label = `Paperclip · ${status}`;
  if (iss.priority && iss.priority !== 'medium') label += ` · ${iss.priority}`;
  if (blocked && attention) label += ' · needs attention';
  if (iss.parentId) label += ' · child issue';
  return label;
}

function paperclipIssueUrl(baseUrl: string, companyId: string, issueId: string): string {
  // baseUrl ends in /api; the UI is the same host without /api
  const ui = baseUrl.replace(/\/api\/?$/, '');
  return `${ui}/c/${companyId}/issues/${issueId}`;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
