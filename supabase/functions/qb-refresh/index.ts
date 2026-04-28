// Supabase Edge Function: qb-refresh
// Pulls live financial data from QuickBooks Online and stores a snapshot
// in dashboard_data so the dashboard can render it.
//
// Triggered by the "↻ Refresh from QB" button in the Financials module.
//
// Env vars required:
//   QB_CLIENT_ID
//   QB_CLIENT_SECRET
//   QB_ENVIRONMENT             'sandbox' | 'production'
//   QB_REALM_ID                (defaults to the only row in qb_credentials)
//   SUPABASE_URL               (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-injected)

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const INTUIT_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

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

    const env = Deno.env.get('QB_ENVIRONMENT') ?? 'sandbox';
    const apiBase = env === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

    // Look up the credentials row. If QB_REALM_ID is set, prefer it; otherwise
    // pick the most recently updated row for this environment.
    const realmFromEnv = Deno.env.get('QB_REALM_ID');
    const credQuery = supabase.from('qb_credentials').select('*').eq('environment', env);
    const { data: creds, error: credErr } = realmFromEnv
      ? await credQuery.eq('realm_id', realmFromEnv).maybeSingle()
      : await credQuery.order('updated_at', { ascending: false }).limit(1).maybeSingle();

    if (credErr) return json({ error: 'Failed to read credentials', detail: credErr.message }, 500);
    if (!creds) return json({ error: 'No QuickBooks credentials configured. Run the OAuth connect flow first.' }, 400);

    const accessToken = await ensureFreshAccessToken(supabase, creds);
    const realmId = creds.realm_id;

    // Date ranges
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const ytdStart = `${yyyy}-01-01`;

    // Fetch reports in parallel
    const [pl, plMonthly, bs, ar] = await Promise.all([
      qbReport(apiBase, realmId, accessToken, 'ProfitAndLoss', { start_date: ytdStart, end_date: todayStr }),
      qbReport(apiBase, realmId, accessToken, 'ProfitAndLoss', { start_date: ytdStart, end_date: todayStr, summarize_column_by: 'Month' }),
      qbReport(apiBase, realmId, accessToken, 'BalanceSheet', { as_of: todayStr }),
      qbReport(apiBase, realmId, accessToken, 'AgedReceivables', { report_date: todayStr }),
    ]);

    const summary = parsePLSummary(pl);
    const monthly = parsePLMonthly(plMonthly);
    const expenses = parseExpenseBreakdown(pl);
    const cash = parseCashFromBS(bs);
    const arOutstanding = parseAROutstanding(ar);
    const arDetail = parseARDetail(ar);

    const snapshot = {
      asOf: todayStr,
      ytdStart,
      revenue: summary.income,
      expenses: summary.expenses,
      netIncome: summary.netIncome,
      cash,
      arOutstanding,
      arDetail,
      monthly,
      expenseBreakdown: expenses,
      refreshedAt: new Date().toISOString(),
      environment: env,
    };

    // Store the snapshot for the dashboard to read on next load
    const { error: writeErr } = await supabase
      .from('dashboard_data')
      .upsert({ key: 'financials', value: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (writeErr) {
      return json({ error: 'Failed to store snapshot', detail: writeErr.message, snapshot }, 500);
    }

    return json({ ok: true, snapshot });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
});

// --------------------------------------------------------------------
// Token management
// --------------------------------------------------------------------
async function ensureFreshAccessToken(sb: SupabaseClient, creds: any): Promise<string> {
  const skewMs = 60_000;
  const expiresAt = creds.expires_at ? new Date(creds.expires_at).getTime() : 0;
  if (creds.access_token && expiresAt - Date.now() > skewMs) return creds.access_token;

  const clientId = Deno.env.get('QB_CLIENT_ID')!;
  const clientSecret = Deno.env.get('QB_CLIENT_SECRET')!;
  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(INTUIT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  const newExpiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await sb.from('qb_credentials').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? creds.refresh_token,
    expires_at: newExpiresAt,
    updated_at: new Date().toISOString(),
  }).eq('realm_id', creds.realm_id);

  return data.access_token;
}

// --------------------------------------------------------------------
// QB Reports API
// --------------------------------------------------------------------
async function qbReport(apiBase: string, realmId: string, token: string, name: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const url = `${apiBase}/v3/company/${realmId}/reports/${name}?${qs}&minorversion=70`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`QB report ${name} failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// --------------------------------------------------------------------
// Report parsers — QB returns nested Row structures with group labels.
// We walk them looking for known group names.
// --------------------------------------------------------------------
function findRowByGroup(rows: any[], group: string): any | null {
  for (const r of rows ?? []) {
    if (r.group === group) return r;
    const nested = r.Rows?.Row ? findRowByGroup(r.Rows.Row, group) : null;
    if (nested) return nested;
  }
  return null;
}

function summaryAmount(row: any, columnIndex = 1): number {
  const cells = row?.Summary?.ColData ?? [];
  return Number(cells[columnIndex]?.value ?? 0);
}

function parsePLSummary(pl: any) {
  const rows = pl?.Rows?.Row ?? [];
  const incomeRow = findRowByGroup(rows, 'Income');
  const expensesRow = findRowByGroup(rows, 'Expenses');
  const netIncomeRow = findRowByGroup(rows, 'NetIncome') ?? findRowByGroup(rows, 'NetOperatingIncome');
  return {
    income: summaryAmount(incomeRow),
    expenses: summaryAmount(expensesRow),
    netIncome: summaryAmount(netIncomeRow),
  };
}

function parsePLMonthly(pl: any) {
  // Columns: [Account, Jan, Feb, Mar, ..., Total]
  const cols = pl?.Columns?.Column ?? [];
  const monthLabels = cols.slice(1, -1).map((c: any) => c.ColTitle);

  const rows = pl?.Rows?.Row ?? [];
  const incomeRow = findRowByGroup(rows, 'Income');
  const expensesRow = findRowByGroup(rows, 'Expenses');

  const seriesFrom = (row: any) => {
    const cells = row?.Summary?.ColData ?? [];
    return cells.slice(1, -1).map((c: any) => Number(c.value ?? 0));
  };

  return {
    months: monthLabels,
    revenue: incomeRow ? seriesFrom(incomeRow) : [],
    expenses: expensesRow ? seriesFrom(expensesRow) : [],
  };
}

function cleanCategoryName(raw: string): string {
  let s = String(raw || 'Other');
  s = s.replace(/^Total\s+/i, '');   // "Total 6100 Foo" -> "6100 Foo"
  s = s.replace(/^\d+\s+/, '');       // "6100 Foo" -> "Foo"
  return s.trim() || 'Other';
}

function parseExpenseBreakdown(pl: any) {
  const rows = pl?.Rows?.Row ?? [];
  const expensesRow = findRowByGroup(rows, 'Expenses');
  const children: any[] = expensesRow?.Rows?.Row ?? [];
  const total = summaryAmount(expensesRow) || 1;

  // QB returns either flat Data rows directly under Expenses (simple books)
  // or Section subgroups with nested detail (chart-of-accounts with categories).
  // Aggregate at the top level so the breakdown stays readable.
  const items = children.map((r) => {
    if (r.type === 'Data') {
      return {
        name: cleanCategoryName(r.ColData?.[0]?.value),
        amount: Number(r.ColData?.[1]?.value ?? 0),
      };
    }
    if (r.type === 'Section') {
      const cells = r.Summary?.ColData ?? [];
      return {
        name: cleanCategoryName(cells[0]?.value),
        amount: Number(cells[1]?.value ?? 0),
      };
    }
    return null;
  }).filter((x): x is { name: string; amount: number } => x !== null && x.amount !== 0);

  return items
    .map((i) => ({ ...i, pct: Math.round((i.amount / total) * 100) }))
    .sort((a, b) => b.amount - a.amount);
}

function parseCashFromBS(bs: any) {
  const rows = bs?.Rows?.Row ?? [];
  const cashRow = findRowByGroup(rows, 'BankAccounts')
    ?? findRowByGroup(rows, 'Cash')
    ?? findRowByGroup(rows, 'CashAndCashEquivalents');
  return summaryAmount(cashRow);
}

function parseAROutstanding(ar: any) {
  const rows = ar?.Rows?.Row ?? [];
  const totalRow = rows.find((r: any) => r.group === 'GrandTotal');
  const cells = totalRow?.Summary?.ColData ?? [];
  return Number(cells[cells.length - 1]?.value ?? 0);
}

// AgedReceivables column order (typical, minorversion 70):
//   [Customer, Current, 1-30, 31-60, 61-90, 91 and over, Total]
function parseARDetail(ar: any) {
  const rows = ar?.Rows?.Row ?? [];
  const items = rows
    .filter((r: any) => r.group !== 'GrandTotal' && Array.isArray(r.ColData))
    .map((r: any) => {
      const c = r.ColData;
      const customer = c[0]?.value ?? '(Unknown)';
      const current = Number(c[1]?.value || 0);
      const d1to30 = Number(c[2]?.value || 0);
      const d31to60 = Number(c[3]?.value || 0);
      const d61to90 = Number(c[4]?.value || 0);
      const d91plus = Number(c[5]?.value || 0);
      const total = Number(c[6]?.value || 0);
      // Worst-case aging bucket label
      let oldest: string;
      if (d91plus > 0) oldest = '91+ days';
      else if (d61to90 > 0) oldest = '61-90 days';
      else if (d31to60 > 0) oldest = '31-60 days';
      else if (d1to30 > 0) oldest = '1-30 days';
      else oldest = 'Current';
      return { customer, current, days1to30: d1to30, days31to60: d31to60, days61to90: d61to90, days91plus: d91plus, total, oldest };
    })
    .filter((x: any) => x.total > 0)
    .sort((a: any, b: any) => b.total - a.total);
  return items;
}

// --------------------------------------------------------------------
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
