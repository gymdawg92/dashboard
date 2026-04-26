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

    const snapshot = {
      asOf: todayStr,
      ytdStart,
      revenue: summary.income,
      expenses: summary.expenses,
      netIncome: summary.netIncome,
      cash,
      arOutstanding,
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

function parseExpenseBreakdown(pl: any) {
  const rows = pl?.Rows?.Row ?? [];
  const expensesRow = findRowByGroup(rows, 'Expenses');
  const detailRows: any[] = expensesRow?.Rows?.Row ?? [];
  const total = summaryAmount(expensesRow) || 1;

  return detailRows
    .filter((r) => r.type === 'Data')
    .map((r) => {
      const name = r.ColData?.[0]?.value ?? 'Other';
      const amount = Number(r.ColData?.[1]?.value ?? 0);
      return { name, amount, pct: Math.round((amount / total) * 100) };
    })
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
  // A/R Aging summary has a TOTAL row; sum the last column or find the total.
  const totalRow = rows.find((r: any) => r.group === 'GrandTotal' || r.Summary);
  const cells = totalRow?.Summary?.ColData ?? [];
  return Number(cells[cells.length - 1]?.value ?? 0);
}

// --------------------------------------------------------------------
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
