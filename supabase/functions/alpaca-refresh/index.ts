// Supabase Edge Function: alpaca-refresh
// Pulls account + positions + day P&L from Alpaca and stores a snapshot
// in dashboard_data.alpaca for the dashboard's Investments module.
//
// Env vars:
//   ALPACA_BASE_URL              https://paper-api.alpaca.markets (paper) or
//                                https://api.alpaca.markets (live)
//   ALPACA_KEY_ID
//   ALPACA_SECRET
//   ALPACA_ENVIRONMENT           'paper' | 'live'
//   SUPABASE_URL                 (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY    (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const baseUrl = Deno.env.get('ALPACA_BASE_URL');
    const keyId = Deno.env.get('ALPACA_KEY_ID');
    const secret = Deno.env.get('ALPACA_SECRET');
    const environment = Deno.env.get('ALPACA_ENVIRONMENT') || 'paper';

    if (!baseUrl || !keyId || !secret) {
      return json({ error: 'Missing ALPACA_BASE_URL / ALPACA_KEY_ID / ALPACA_SECRET' }, 500);
    }

    const headers = {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secret,
      'Accept': 'application/json',
    };

    // Pull account, positions, recent orders, intraday portfolio history
    const [account, positions, orders, history] = await Promise.all([
      apget(`${baseUrl}/v2/account`, headers),
      apget(`${baseUrl}/v2/positions`, headers),
      apget(`${baseUrl}/v2/orders?status=all&limit=10&direction=desc`, headers),
      apget(`${baseUrl}/v2/account/portfolio/history?period=1D&timeframe=15Min&intraday_reporting=continuous`, headers),
    ]);

    const equity = num(account?.equity);
    const lastEquity = num(account?.last_equity);
    const cash = num(account?.cash);
    const buyingPower = num(account?.buying_power);
    const dayTradeCount = num(account?.daytrade_count);
    const dayPnL = equity - lastEquity;
    const dayPnLPct = lastEquity > 0 ? (dayPnL / lastEquity) * 100 : 0;

    const positionsParsed = Array.isArray(positions) ? positions.map((p: any) => ({
      symbol: p.symbol,
      qty: num(p.qty),
      side: p.side,
      avgPrice: num(p.avg_entry_price),
      currentPrice: num(p.current_price),
      marketValue: num(p.market_value),
      costBasis: num(p.cost_basis),
      unrealizedPnL: num(p.unrealized_pl),
      unrealizedPnLPct: num(p.unrealized_plpc) * 100,
      changeToday: num(p.change_today) * 100,
    })).sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue)) : [];

    const ordersParsed = Array.isArray(orders) ? orders.slice(0, 8).map((o: any) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: num(o.qty),
      type: o.type,
      status: o.status,
      filledAt: o.filled_at,
      submittedAt: o.submitted_at,
      filledAvgPrice: num(o.filled_avg_price),
      limitPrice: num(o.limit_price),
    })) : [];

    // Portfolio history → equity samples for an intraday sparkline
    const histTimestamps: number[] = Array.isArray(history?.timestamp) ? history.timestamp : [];
    const histEquity: number[] = Array.isArray(history?.equity) ? history.equity : [];
    const intraday = histTimestamps.map((t, i) => ({ ts: t * 1000, eq: histEquity[i] })).filter((p) => p.eq > 0);

    const snapshot = {
      account: {
        equity, lastEquity, cash, buyingPower, dayTradeCount,
        status: account?.status || 'UNKNOWN',
        currency: account?.currency || 'USD',
      },
      dayPnL: { absolute: dayPnL, pct: dayPnLPct },
      positions: positionsParsed,
      orders: ordersParsed,
      intraday,
      refreshedAt: new Date().toISOString(),
      environment,
    };

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error } = await supabase.from('dashboard_data').upsert(
      { key: 'alpaca', value: snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );

    if (error) return json({ error: 'Failed to store snapshot', detail: error.message, snapshot }, 500);
    return json({ ok: true, snapshot });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
});

async function apget(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca ${url}: ${res.status} ${text}`);
  }
  return res.json();
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
