// Supabase Edge Function: briefing-generator
// Composes a morning briefing from the latest dashboard snapshots
// (tasks, projects, calendar, financials) and stores it in
// dashboard_data.briefing for the dashboard's Briefing module.
//
// If RESEND_API_KEY + BRIEFING_EMAIL_TO are set, also emails the briefing.
//
// Triggered by daily cron at 11:00 UTC (7am ET) and on-demand from the
// dashboard Refresh button.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [tasks, projects, calendar, financials] = await Promise.all([
      readKey(supabase, 'tasks'),
      readKey(supabase, 'projects'),
      readKey(supabase, 'calendar'),
      readKey(supabase, 'financials'),
    ]);

    const briefing = composeBriefing(
      Array.isArray(tasks) ? tasks : [],
      Array.isArray(projects) ? projects : [],
      calendar || {},
      financials || {},
    );

    // Persist for the dashboard module
    await supabase.from('dashboard_data').upsert(
      { key: 'briefing', value: briefing, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );

    // Optional email send
    const resendKey = Deno.env.get('RESEND_API_KEY');
    const to = Deno.env.get('BRIEFING_EMAIL_TO');
    let emailed = false;
    if (resendKey && to) {
      const sent = await sendEmail(resendKey, to, briefing);
      emailed = sent;
    }

    return json({ ok: true, briefing, emailed });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
});

async function readKey(sb: any, key: string) {
  const { data } = await sb.from('dashboard_data').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

// ──────────────────────────────────────────────────────────
// Briefing composition
// ──────────────────────────────────────────────────────────

function composeBriefing(tasks: any[], projects: any[], cal: any, fin: any) {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const weekAhead = addDays(today, 7);

  const todayEvents = (cal.events || []).filter((e: any) => e.startMs >= today.getTime() && e.startMs < tomorrow.getTime());
  const tomorrowEvents = (cal.events || []).filter((e: any) => e.startMs >= tomorrow.getTime() && e.startMs < dayAfter.getTime());

  const openTasks = tasks.filter((t) => !t.done);
  const dueToday = openTasks.filter((t) => t.due && new Date(t.due + 'T00:00:00').getTime() <= today.getTime() + 86400000 - 1 && new Date(t.due + 'T00:00:00').getTime() >= today.getTime() - 86400000);
  const overdue = openTasks.filter((t) => t.due && new Date(t.due + 'T00:00:00').getTime() < today.getTime());
  const dueThisWeek = openTasks.filter((t) => t.due && new Date(t.due + 'T00:00:00').getTime() >= today.getTime() && new Date(t.due + 'T00:00:00').getTime() < weekAhead.getTime() && !dueToday.includes(t));

  const activeProjects = projects.filter((p) => p.progress < 100 && p.status !== 'On Hold');
  const projectsByNextStep = [...activeProjects]
    .filter((p) => p.nextStep)
    .sort((a, b) => (a.nextStepDue || '9999').localeCompare(b.nextStepDue || '9999'))
    .slice(0, 5);

  const alerts: string[] = [];
  const cash = Number(fin?.cash) || 0;
  const ar = Number(fin?.arOutstanding) || 0;
  const monthly = fin?.monthly || {};
  const monthsExp = (monthly.expenses || []).filter((v: number) => v > 0);
  const burn = monthsExp.length ? monthsExp.reduce((a: number, b: number) => a + b, 0) / monthsExp.length : 0;
  const runwayMonths = burn > 0 ? cash / burn : Infinity;
  if (runwayMonths < 3) alerts.push(`⚠️ Runway is ${runwayMonths.toFixed(1)} months — below 3-month threshold.`);
  if (ar > 5000) alerts.push(`💸 ${money(ar)} in outstanding A/R — follow up with clients.`);
  if (overdue.length > 0) alerts.push(`⏰ ${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}.`);
  const fresh = fin?.refreshedAt ? Date.now() - new Date(fin.refreshedAt).getTime() : Infinity;
  if (fresh > 7 * 24 * 3600 * 1000) alerts.push(`🔁 QuickBooks snapshot is over a week old — click ↻ on Financials.`);

  const greeting = greetingFor(now);
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Markdown version (used for email)
  const md: string[] = [];
  md.push(`# ${greeting}, William`);
  md.push(`*${dateStr}*\n`);

  if (alerts.length) {
    md.push(`## ⚡ Alerts`);
    alerts.forEach((a) => md.push(`- ${a}`));
    md.push('');
  }

  md.push(`## 📅 Today's Schedule`);
  if (todayEvents.length === 0) {
    md.push(`- *Nothing on the calendar today.*`);
  } else {
    todayEvents.forEach((e: any) => md.push(`- **${time(e)}** — ${e.summary}${e.location ? ` *(${e.location})*` : ''}${e.source ? ` *[${e.source}]*` : ''}`));
  }
  md.push('');

  if (tomorrowEvents.length) {
    md.push(`### Tomorrow`);
    tomorrowEvents.forEach((e: any) => md.push(`- **${time(e)}** — ${e.summary}`));
    md.push('');
  }

  md.push(`## ✅ Tasks`);
  if (overdue.length) {
    md.push(`### Overdue (${overdue.length})`);
    overdue.slice(0, 5).forEach((t) => md.push(`- ${t.title}${dueLabel(t.due)}`));
  }
  if (dueToday.length) {
    md.push(`### Due Today (${dueToday.length})`);
    dueToday.forEach((t) => md.push(`- ${t.title}${sectionLabel(t)}`));
  }
  if (dueThisWeek.length) {
    md.push(`### Due This Week (${dueThisWeek.length})`);
    dueThisWeek.slice(0, 6).forEach((t) => md.push(`- ${t.title}${dueLabel(t.due)}${sectionLabel(t)}`));
  }
  if (overdue.length === 0 && dueToday.length === 0 && dueThisWeek.length === 0) {
    md.push(`- *No date-bound tasks pressing this week.*`);
  }
  md.push('');

  md.push(`## 📁 Projects to push forward`);
  if (projectsByNextStep.length === 0) {
    md.push(`- *No active projects with a next step set.*`);
  } else {
    projectsByNextStep.forEach((p) => md.push(`- **${p.emoji || '🚀'} ${p.name}** *(${p.progress}%)* — ${p.nextStep}${p.nextStepDue ? ` *(by ${p.nextStepDue})*` : ''}`));
  }
  md.push('');

  if (fin?.revenue !== undefined) {
    md.push(`## 💰 Financials (${fin.environment === 'production' ? 'YTD' : 'sandbox YTD'})`);
    md.push(`- Revenue **${money(fin.revenue)}** · Net Income **${money(fin.netIncome)}** · Expenses **${money(fin.expenses)}**`);
    md.push(`- Cash **${money(fin.cash)}**${burn > 0 ? ` · Burn **${money(burn)}/mo** · Runway **${runwayMonths === Infinity ? '∞' : runwayMonths.toFixed(1)} mo**` : ''}`);
    if (ar > 0) md.push(`- A/R Outstanding **${money(ar)}**`);
    md.push('');
  }

  const summary = {
    eventsToday: todayEvents.length,
    eventsTomorrow: tomorrowEvents.length,
    overdueTasks: overdue.length,
    dueToday: dueToday.length,
    dueThisWeek: dueThisWeek.length,
    activeProjects: activeProjects.length,
    cash,
    runwayMonths: runwayMonths === Infinity ? null : Number(runwayMonths.toFixed(2)),
    burn: Number(burn.toFixed(2)),
  };

  return {
    asOf: now.toISOString(),
    greeting: `${greeting}, William`,
    dateLine: dateStr,
    markdown: md.join('\n'),
    sections: {
      alerts,
      todayEvents: todayEvents.map((e: any) => ({ time: time(e), summary: e.summary, source: e.source, location: e.location })),
      tomorrowEvents: tomorrowEvents.map((e: any) => ({ time: time(e), summary: e.summary, source: e.source })),
      overdue: overdue.slice(0, 5).map((t) => ({ id: t.id, title: t.title, due: t.due, section: t.section })),
      dueToday: dueToday.map((t) => ({ id: t.id, title: t.title, section: t.section })),
      dueThisWeek: dueThisWeek.slice(0, 6).map((t) => ({ id: t.id, title: t.title, due: t.due, section: t.section })),
      projects: projectsByNextStep.map((p) => ({ id: p.id, emoji: p.emoji, name: p.name, progress: p.progress, nextStep: p.nextStep, nextStepDue: p.nextStepDue })),
    },
    summary,
  };
}

// ──────────────────────────────────────────────────────────
// Email (optional; needs RESEND_API_KEY + BRIEFING_EMAIL_TO)
// ──────────────────────────────────────────────────────────

async function sendEmail(apiKey: string, to: string, briefing: any): Promise<boolean> {
  const html = mdToHtml(briefing.markdown);
  const subject = `${briefing.greeting} — ${briefing.dateLine}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('BRIEFING_EMAIL_FROM') || 'Command Center <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      text: briefing.markdown,
    }),
  });
  if (!res.ok) {
    console.error('Resend send failed:', res.status, await res.text());
    return false;
  }
  return true;
}

function mdToHtml(md: string): string {
  // Tiny converter — just enough for the briefing's structure
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (line.startsWith('# ')) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h1 style="margin:18px 0 4px">${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h2 style="margin:18px 0 6px;font-size:17px">${esc(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('### ')) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h3 style="margin:12px 0 4px;font-size:14px;color:#555">${esc(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('- ')) {
      if (!inList) { out.push('<ul style="margin:4px 0 8px 22px;padding:0">'); inList = true; }
      out.push(`<li style="margin:3px 0">${inlineMd(line.slice(2))}</li>`);
      continue;
    }
    if (line.startsWith('*') && line.endsWith('*') && line.length > 2) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<p style="color:#777;font-style:italic;margin:0 0 12px">${esc(line.slice(1, -1))}</p>`); continue; }
    if (line.trim() === '') { if (inList) { out.push('</ul>'); inList = false; } continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p style="margin:6px 0">${inlineMd(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;max-width:640px;margin:0 auto;padding:18px">${out.join('\n')}</div>`;
}
function inlineMd(s: string): string { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>'); }
function esc(s: string): string { return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!)); }

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function time(e: any): string {
  if (e.allDay) return 'All day';
  const d = new Date(e.startMs);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function dueLabel(due: string): string { return due ? ` *(due ${due})*` : ''; }
function sectionLabel(t: any): string { const s = (t.section || '').replace(/^[^ ]+ /, ''); return s ? ` _[${s}]_` : ''; }
function money(n: number): string {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString();
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
