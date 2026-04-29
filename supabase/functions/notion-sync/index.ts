// Supabase Edge Function: notion-sync
// Bidirectional sync between Notion (Life Dashboard databases) and dashboard_data.
//
// PULL: Notion -> dashboard. Notion is authoritative for shared fields (title,
//   done, due, section, tag, status, progress, notes). Dashboard preserves
//   subtasks/checkins (Notion doesn't model them) and color/statusColor.
//
// PUSH: dashboard items without a matching Notion page (by Dashboard ID) get
//   created in Notion. State changes for already-matched items are NOT pushed
//   in this v1 — Notion wins on conflict during pull. To force-push from
//   dashboard, the chat-sync protocol (see feedback_dashboard_sync memory)
//   uses the Notion MCP directly.
//
// Env vars required:
//   NOTION_TOKEN                    Internal Integration token (ntn_...)
//   NOTION_TASKS_DATA_SOURCE        '3e4a049a-e4b7-477d-9ac7-27cb3ebd380c'
//   NOTION_PROJECTS_DATA_SOURCE     'd125d4a7-2caa-4db6-aa41-ccfb1b11148a'
//   SUPABASE_URL                    auto-injected
//   SUPABASE_SERVICE_ROLE_KEY       auto-injected

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TAG_TO_TAGC: Record<string, string> = {
  Finance: 'tf', Tech: 'ttech', Brand: 'tbiz', Content: 'tbiz',
  Idea: 'tbiz', Learn: 'tl', Personal: 'tp',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = Deno.env.get('NOTION_TOKEN');
    const tasksDS = Deno.env.get('NOTION_TASKS_DATA_SOURCE');
    const projectsDS = Deno.env.get('NOTION_PROJECTS_DATA_SOURCE');
    if (!token || !tasksDS || !projectsDS) {
      return json({ error: 'Missing NOTION_TOKEN or data source IDs' }, 500);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── 1. Fetch all Notion pages ──
    const [notionProjects, notionTasks] = await Promise.all([
      notionQueryAll(token, projectsDS),
      notionQueryAll(token, tasksDS),
    ]);

    // ── 2. Get current dashboard state ──
    const [tasksRow, projectsRow] = await Promise.all([
      supabase.from('dashboard_data').select('value').eq('key', 'tasks').maybeSingle(),
      supabase.from('dashboard_data').select('value').eq('key', 'projects').maybeSingle(),
    ]);
    let tasks: any[] = (tasksRow.data?.value as any[]) ?? [];
    let projects: any[] = (projectsRow.data?.value as any[]) ?? [];

    // ── 3. PULL: merge Notion projects into dashboard ──
    const projByDashId = new Map(projects.map((p) => [p.id, p]));
    const notionProjPageToDashId = new Map<string, string>();

    for (const np of notionProjects) {
      const dashId = readText(np, 'Dashboard ID') || `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const merged: any = projByDashId.get(dashId) ?? { color: '#4f8cff', statusColor: 'var(--blue)' };
      merged.id = dashId;
      merged.name = readTitle(np, 'Name') || merged.name || 'Untitled';
      merged.emoji = readText(np, 'Emoji') || merged.emoji || '🚀';
      merged.status = readSelect(np, 'Status') || merged.status || 'Active';
      merged.progress = Number(readNumber(np, 'Progress') ?? merged.progress ?? 0);
      merged.description = readText(np, 'Description') ?? merged.description ?? '';
      merged.due = readDate(np, 'Due') ?? merged.due ?? '';
      merged.nextStep = readText(np, 'Next Step') ?? merged.nextStep ?? '';
      merged.nextStepDue = readDate(np, 'Next Step Due') ?? merged.nextStepDue ?? '';
      merged.notes = readText(np, 'Notes') ?? merged.notes ?? '';

      if (!projByDashId.has(dashId)) {
        projects.push(merged);
        projByDashId.set(dashId, merged);
      }
      notionProjPageToDashId.set(np.id, dashId);
    }

    // ── 3b. PULL: merge Notion tasks into dashboard ──
    const tasksByDashId = new Map(tasks.map((t) => [t.id, t]));

    for (const nt of notionTasks) {
      const dashId = readText(nt, 'Dashboard ID') || `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const merged: any = tasksByDashId.get(dashId) ?? { subtasks: [], checkins: [] };
      merged.id = dashId;
      merged.title = readTitle(nt, 'Title') || merged.title || 'Untitled';
      merged.sub = readText(nt, 'Subtitle') ?? merged.sub ?? '';
      merged.section = readSelect(nt, 'Section') || merged.section || '📋 Admin & Ops';
      const tag = readSelect(nt, 'Tag');
      if (tag) {
        merged.tag = tag;
        merged.tagC = TAG_TO_TAGC[tag] || merged.tagC || 'tp';
      } else if (!merged.tag) {
        merged.tag = 'Personal';
        merged.tagC = 'tp';
      }
      merged.done = readCheckbox(nt, 'Done');
      merged.due = readDate(nt, 'Due') ?? '';
      merged.notes = readText(nt, 'Notes') ?? '';

      // Project relation: take first relation, map to dashboard project ID
      const projRels = readRelation(nt, 'Project');
      const notionProjPageId = projRels[0];
      merged.projectId = notionProjPageId ? notionProjPageToDashId.get(notionProjPageId) ?? null : null;

      // Preserve subtasks/checkins (not modeled in Notion)
      merged.subtasks = merged.subtasks ?? [];
      merged.checkins = merged.checkins ?? [];

      if (!tasksByDashId.has(dashId)) {
        tasks.push(merged);
        tasksByDashId.set(dashId, merged);
      }
    }

    // ── 4. PUSH: items in dashboard with no Notion match get created ──
    const notionProjDashIds = new Set([...notionProjPageToDashId.values()]);
    const notionTaskDashIds = new Set(notionTasks.map((nt: any) => readText(nt, 'Dashboard ID')).filter(Boolean));

    const dashIdToNotionPageId = new Map<string, string>();
    for (const [pageId, dashId] of notionProjPageToDashId) dashIdToNotionPageId.set(dashId, pageId);

    let pushedProjects = 0;
    for (const p of projects) {
      if (!notionProjDashIds.has(p.id)) {
        const pageId = await notionCreateProjectPage(token, projectsDS, p);
        if (pageId) {
          dashIdToNotionPageId.set(p.id, pageId);
          pushedProjects++;
        }
      }
    }

    let pushedTasks = 0;
    for (const t of tasks) {
      if (!notionTaskDashIds.has(t.id)) {
        const projectPageId = t.projectId ? dashIdToNotionPageId.get(t.projectId) : null;
        const ok = await notionCreateTaskPage(token, tasksDS, t, projectPageId);
        if (ok) pushedTasks++;
      }
    }

    // ── 5. Save merged dashboard state ──
    const now = new Date().toISOString();
    await Promise.all([
      supabase.from('dashboard_data').upsert(
        { key: 'tasks', value: tasks, updated_at: now },
        { onConflict: 'key' },
      ),
      supabase.from('dashboard_data').upsert(
        { key: 'projects', value: projects, updated_at: now },
        { onConflict: 'key' },
      ),
      supabase.from('dashboard_data').upsert(
        { key: 'notion_last_sync', value: { at: now, pulledTasks: notionTasks.length, pulledProjects: notionProjects.length, pushedTasks, pushedProjects }, updated_at: now },
        { onConflict: 'key' },
      ),
    ]);

    return json({
      ok: true,
      pulled: { tasks: notionTasks.length, projects: notionProjects.length },
      pushed: { tasks: pushedTasks, projects: pushedProjects },
      totals: { tasks: tasks.length, projects: projects.length },
    });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err), stack: (err as any)?.stack }, 500);
  }
});

// ──────────────────────────────────────────────────────────
// Notion API helpers
// ──────────────────────────────────────────────────────────

async function notionQueryAll(token: string, dataSourceId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${dataSourceId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion query failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    all.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

async function notionCreateProjectPage(token: string, dataSourceId: string, p: any): Promise<string | null> {
  const properties: any = {
    'Name': { title: [{ text: { content: p.name || 'Untitled' } }] },
    'Emoji': { rich_text: [{ text: { content: p.emoji || '' } }] },
    'Status': { select: { name: p.status || 'Active' } },
    'Progress': { number: Number(p.progress) || 0 },
    'Description': { rich_text: [{ text: { content: p.description || '' } }] },
    'Next Step': { rich_text: [{ text: { content: p.nextStep || '' } }] },
    'Notes': { rich_text: [{ text: { content: p.notes || '' } }] },
    'Dashboard ID': { rich_text: [{ text: { content: p.id } }] },
  };
  if (p.due) properties['Due'] = { date: { start: p.due } };
  if (p.nextStepDue) properties['Next Step Due'] = { date: { start: p.nextStepDue } };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: dataSourceId }, properties }),
  });
  if (!res.ok) {
    console.error('Failed to create Notion project', p.id, await res.text());
    return null;
  }
  const data = await res.json();
  return data.id ?? null;
}

async function notionCreateTaskPage(
  token: string, dataSourceId: string, t: any, projectPageId: string | null,
): Promise<boolean> {
  const properties: any = {
    'Title': { title: [{ text: { content: t.title || 'Untitled' } }] },
    'Done': { checkbox: !!t.done },
    'Section': t.section ? { select: { name: normalizeSection(t.section) } } : undefined,
    'Tag': t.tag ? { select: { name: normalizeTag(t.tag) } } : undefined,
    'Notes': { rich_text: [{ text: { content: t.notes || '' } }] },
    'Subtitle': { rich_text: [{ text: { content: t.sub || '' } }] },
    'Dashboard ID': { rich_text: [{ text: { content: t.id } }] },
  };
  if (t.due) properties['Due'] = { date: { start: t.due } };
  if (projectPageId) properties['Project'] = { relation: [{ id: projectPageId }] };

  // Strip any undefined props (Notion rejects them)
  for (const k of Object.keys(properties)) if (properties[k] === undefined) delete properties[k];

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: dataSourceId }, properties }),
  });
  if (!res.ok) {
    console.error('Failed to create Notion task', t.id, await res.text());
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────
// Property readers
// ──────────────────────────────────────────────────────────

function readTitle(page: any, prop: string): string {
  const arr = page.properties?.[prop]?.title || [];
  return arr.map((r: any) => r.plain_text ?? '').join('');
}
function readText(page: any, prop: string): string {
  const arr = page.properties?.[prop]?.rich_text || [];
  return arr.map((r: any) => r.plain_text ?? '').join('');
}
function readSelect(page: any, prop: string): string | null {
  return page.properties?.[prop]?.select?.name ?? null;
}
function readCheckbox(page: any, prop: string): boolean {
  return !!page.properties?.[prop]?.checkbox;
}
function readNumber(page: any, prop: string): number | null {
  const n = page.properties?.[prop]?.number;
  return typeof n === 'number' ? n : null;
}
function readDate(page: any, prop: string): string {
  return page.properties?.[prop]?.date?.start ?? '';
}
function readRelation(page: any, prop: string): string[] {
  return (page.properties?.[prop]?.relation || []).map((r: any) => r.id);
}

// ──────────────────────────────────────────────────────────
// Section/Tag normalization
// ──────────────────────────────────────────────────────────

const SECTION_MAP: Record<string, string> = {
  '🎬 Content & Publishing': '📚 Content & Publishing',
  '🙋 Personal': '🎯 Personal Goals',
};
function normalizeSection(s: string): string {
  return SECTION_MAP[s] ?? s;
}

const TAG_MAP: Record<string, string> = { Call: 'Personal', Email: 'Personal' };
function normalizeTag(t: string): string {
  return TAG_MAP[t] ?? t;
}

// ──────────────────────────────────────────────────────────
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
