// Supabase Edge Function: notion-sync (v2)
// Bidirectional sync between Notion (Life Dashboard) and dashboard_data.
//
// Conflict resolution: per-task `updatedAt` (set by the frontend on every
// mutation) is compared to Notion's `last_edited_time`. Whichever is newer
// wins for shared fields (title, done, due, section, tag, project, notes).
// Subtasks/checkins live only on the dashboard side and are preserved.
//
// Items present on only one side are propagated to the other.
// After any update, both sides are stamped to the same time so subsequent
// syncs are no-ops until the next user mutation.
//
// Env vars:
//   NOTION_TOKEN
//   NOTION_TASKS_DATA_SOURCE     (database ID, despite the name)
//   NOTION_PROJECTS_DATA_SOURCE  (database ID, despite the name)
//   SUPABASE_URL                 (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY    (auto-injected)

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

const SECTION_MAP: Record<string, string> = {
  '🎬 Content & Publishing': '📚 Content & Publishing',
  '🙋 Personal': '🎯 Personal Goals',
};
const TAG_MAP: Record<string, string> = { Call: 'Personal', Email: 'Personal' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = Deno.env.get('NOTION_TOKEN');
    const tasksDB = Deno.env.get('NOTION_TASKS_DATA_SOURCE');
    const projectsDB = Deno.env.get('NOTION_PROJECTS_DATA_SOURCE');
    if (!token || !tasksDB || !projectsDB) {
      return json({ error: 'Missing NOTION_TOKEN or database IDs' }, 500);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [notionProjects, notionTasks] = await Promise.all([
      notionQueryAll(token, projectsDB),
      notionQueryAll(token, tasksDB),
    ]);

    const [tasksRow, projectsRow] = await Promise.all([
      supabase.from('dashboard_data').select('value').eq('key', 'tasks').maybeSingle(),
      supabase.from('dashboard_data').select('value').eq('key', 'projects').maybeSingle(),
    ]);
    let tasks: any[] = (tasksRow.data?.value as any[]) ?? [];
    let projects: any[] = (projectsRow.data?.value as any[]) ?? [];

    let pulledTasks = 0, pushedTasks = 0, updatedNotionTasks = 0;
    let pulledProjects = 0, pushedProjects = 0, updatedNotionProjects = 0;

    // ─── PROJECTS ───
    const projectByDashId = new Map(projects.map((p) => [p.id, p]));
    const dashIdToNotionPageId = new Map<string, string>();
    const notionProjMatched = new Set<string>();

    for (const np of notionProjects) {
      const dashId = readText(np, 'Dashboard ID') || `p_${Date.now()}_${rand()}`;
      const notionTime = new Date(np.last_edited_time).getTime();
      const fromNotion = projectFromNotion(np, dashId);
      const existing = projectByDashId.get(dashId);

      dashIdToNotionPageId.set(dashId, np.id);
      notionProjMatched.add(dashId);

      if (!existing) {
        // New on Notion side → append to dashboard
        fromNotion.updatedAt = np.last_edited_time;
        projects.push(fromNotion);
        projectByDashId.set(dashId, fromNotion);
        pulledProjects++;
      } else {
        const dashTime = new Date(existing.updatedAt || 0).getTime();
        if (dashTime > notionTime + 500) {
          // Dashboard newer → PATCH Notion
          const updated = await notionPatchProject(token, np.id, existing);
          if (updated?.last_edited_time) existing.updatedAt = updated.last_edited_time;
          updatedNotionProjects++;
        } else if (notionTime > dashTime) {
          // Notion newer → overwrite shared fields, keep dashboard-only fields
          mergeIntoDashProject(existing, fromNotion, np.last_edited_time);
          pulledProjects++;
        }
      }
    }

    // Dashboard projects without Notion match → create in Notion
    for (const p of projects) {
      if (!notionProjMatched.has(p.id)) {
        const created = await notionCreateProject(token, projectsDB, p);
        if (created?.id) {
          dashIdToNotionPageId.set(p.id, created.id);
          if (created.last_edited_time) p.updatedAt = created.last_edited_time;
          pushedProjects++;
        }
      }
    }

    // ─── TASKS ───
    const taskByDashId = new Map(tasks.map((t) => [t.id, t]));
    const notionTaskMatched = new Set<string>();

    for (const nt of notionTasks) {
      const dashId = readText(nt, 'Dashboard ID') || `t_${Date.now()}_${rand()}`;
      const notionTime = new Date(nt.last_edited_time).getTime();
      const fromNotion = taskFromNotion(nt, dashId, dashIdToNotionPageId);
      const existing = taskByDashId.get(dashId);

      notionTaskMatched.add(dashId);

      if (!existing) {
        fromNotion.updatedAt = nt.last_edited_time;
        tasks.push(fromNotion);
        taskByDashId.set(dashId, fromNotion);
        pulledTasks++;
      } else {
        const isUpstreamSourced = existing.source === 'paperclip' || existing.source === 'paperclip-approval';
        const dashTime = new Date(existing.updatedAt || 0).getTime();
        if (isUpstreamSourced) {
          // Paperclip is authoritative for these — never pull Notion edits back.
          // But keep Notion mirror in sync by pushing dashboard state up.
          const projPageId = existing.projectId ? dashIdToNotionPageId.get(existing.projectId) : null;
          const updated = await notionPatchTask(token, nt.id, existing, projPageId);
          if (updated?.last_edited_time) existing.updatedAt = updated.last_edited_time;
          updatedNotionTasks++;
        } else if (dashTime > notionTime + 500) {
          const projPageId = existing.projectId ? dashIdToNotionPageId.get(existing.projectId) : null;
          const updated = await notionPatchTask(token, nt.id, existing, projPageId);
          if (updated?.last_edited_time) existing.updatedAt = updated.last_edited_time;
          updatedNotionTasks++;
        } else if (notionTime > dashTime) {
          mergeIntoDashTask(existing, fromNotion, nt.last_edited_time);
          pulledTasks++;
        }
      }
    }

    for (const t of tasks) {
      if (!notionTaskMatched.has(t.id)) {
        const projPageId = t.projectId ? dashIdToNotionPageId.get(t.projectId) : null;
        const created = await notionCreateTask(token, tasksDB, t, projPageId);
        if (created?.id) {
          if (created.last_edited_time) t.updatedAt = created.last_edited_time;
          pushedTasks++;
        }
      }
    }

    // ─── Persist merged state ───
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
        {
          key: 'notion_last_sync',
          value: { at: now, pulledTasks, pushedTasks, updatedNotionTasks, pulledProjects, pushedProjects, updatedNotionProjects },
          updated_at: now,
        },
        { onConflict: 'key' },
      ),
    ]);

    return json({
      ok: true,
      tasks: { pulled: pulledTasks, pushed: pushedTasks, updated: updatedNotionTasks, total: tasks.length },
      projects: { pulled: pulledProjects, pushed: pushedProjects, updated: updatedNotionProjects, total: projects.length },
    });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err), stack: (err as any)?.stack }, 500);
  }
});

// ──────────────────────────────────────────────────────────
// Notion <-> dashboard mappers
// ──────────────────────────────────────────────────────────

function projectFromNotion(np: any, dashId: string) {
  return {
    id: dashId,
    name: readTitle(np, 'Name') || 'Untitled',
    emoji: readText(np, 'Emoji') || '🚀',
    color: '#4f8cff',
    statusColor: 'var(--blue)',
    status: readSelect(np, 'Status') || 'Active',
    progress: Number(readNumber(np, 'Progress') ?? 0),
    description: readText(np, 'Description') ?? '',
    due: readDate(np, 'Due') ?? '',
    nextStep: readText(np, 'Next Step') ?? '',
    nextStepDue: readDate(np, 'Next Step Due') ?? '',
    notes: readText(np, 'Notes') ?? '',
  };
}

function mergeIntoDashProject(existing: any, fromNotion: any, lastEdited: string) {
  for (const k of ['name', 'emoji', 'status', 'progress', 'description', 'due', 'nextStep', 'nextStepDue', 'notes']) {
    existing[k] = fromNotion[k];
  }
  existing.updatedAt = lastEdited;
}

function taskFromNotion(nt: any, dashId: string, projMap: Map<string, string>) {
  const projRel = readRelation(nt, 'Project');
  const notionProjId = projRel[0];
  let projectId: string | null = null;
  if (notionProjId) {
    for (const [dashPid, notionPid] of projMap) {
      if (notionPid === notionProjId) { projectId = dashPid; break; }
    }
  }
  const tag = readSelect(nt, 'Tag') || 'Personal';
  return {
    id: dashId,
    title: readTitle(nt, 'Title') || 'Untitled',
    sub: readText(nt, 'Subtitle') ?? '',
    section: readSelect(nt, 'Section') || '📋 Admin & Ops',
    tag,
    tagC: TAG_TO_TAGC[tag] || 'tp',
    done: readCheckbox(nt, 'Done'),
    due: readDate(nt, 'Due') ?? '',
    notes: readText(nt, 'Notes') ?? '',
    projectId,
    subtasks: [],
    checkins: [],
  };
}

function mergeIntoDashTask(existing: any, fromNotion: any, lastEdited: string) {
  for (const k of ['title', 'sub', 'section', 'tag', 'tagC', 'done', 'due', 'notes', 'projectId']) {
    existing[k] = fromNotion[k];
  }
  if (!existing.subtasks) existing.subtasks = [];
  if (!existing.checkins) existing.checkins = [];
  existing.updatedAt = lastEdited;
}

// ──────────────────────────────────────────────────────────
// Notion API calls
// ──────────────────────────────────────────────────────────

async function notionQueryAll(token: string, dbId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
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

async function notionCreateProject(token: string, dbId: string, p: any) {
  return notionPostPage(token, { parent: { database_id: dbId }, properties: projectProperties(p) });
}
async function notionPatchProject(token: string, pageId: string, p: any) {
  return notionPatchPage(token, pageId, { properties: projectProperties(p) });
}
function projectProperties(p: any): any {
  const props: any = {
    Name: { title: [{ text: { content: p.name || 'Untitled' } }] },
    Emoji: { rich_text: [{ text: { content: p.emoji || '' } }] },
    Status: { select: { name: p.status || 'Active' } },
    Progress: { number: Number(p.progress) || 0 },
    Description: { rich_text: [{ text: { content: p.description || '' } }] },
    'Next Step': { rich_text: [{ text: { content: p.nextStep || '' } }] },
    Notes: { rich_text: [{ text: { content: p.notes || '' } }] },
    'Dashboard ID': { rich_text: [{ text: { content: p.id } }] },
  };
  props.Due = p.due ? { date: { start: p.due } } : { date: null };
  props['Next Step Due'] = p.nextStepDue ? { date: { start: p.nextStepDue } } : { date: null };
  return props;
}

async function notionCreateTask(token: string, dbId: string, t: any, projPageId: string | null | undefined) {
  return notionPostPage(token, { parent: { database_id: dbId }, properties: taskProperties(t, projPageId) });
}
async function notionPatchTask(token: string, pageId: string, t: any, projPageId: string | null | undefined) {
  return notionPatchPage(token, pageId, { properties: taskProperties(t, projPageId) });
}
function taskProperties(t: any, projPageId: string | null | undefined): any {
  const props: any = {
    Title: { title: [{ text: { content: t.title || 'Untitled' } }] },
    Done: { checkbox: !!t.done },
    Notes: { rich_text: [{ text: { content: t.notes || '' } }] },
    Subtitle: { rich_text: [{ text: { content: t.sub || '' } }] },
    'Dashboard ID': { rich_text: [{ text: { content: t.id } }] },
  };
  if (t.section) {
    const sec = SECTION_MAP[t.section] ?? t.section;
    props.Section = { select: { name: sec } };
  }
  if (t.tag) {
    const tag = TAG_MAP[t.tag] ?? t.tag;
    props.Tag = { select: { name: tag } };
  }
  props.Due = t.due ? { date: { start: t.due } } : { date: null };
  props.Project = projPageId ? { relation: [{ id: projPageId }] } : { relation: [] };
  return props;
}

async function notionPostPage(token: string, body: any) {
  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Notion create page failed:', res.status, text);
    return null;
  }
  return res.json();
}

async function notionPatchPage(token: string, pageId: string, body: any) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Notion patch page failed:', res.status, text, 'page', pageId);
    return null;
  }
  return res.json();
}

function notionHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
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

function rand() { return Math.random().toString(36).slice(2, 8); }

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
