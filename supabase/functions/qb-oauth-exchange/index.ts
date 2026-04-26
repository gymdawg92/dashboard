// Supabase Edge Function: qb-oauth-exchange
// Exchanges an Intuit OAuth authorization code for refresh + access tokens
// and stores them in the qb_credentials table.
//
// Triggered by oauth-callback.html after the user approves the OAuth prompt.
//
// Env vars required (set via `supabase secrets set ...` or the dashboard):
//   QB_CLIENT_ID
//   QB_CLIENT_SECRET
//   QB_REDIRECT_URI
//   QB_ENVIRONMENT       'sandbox' | 'production'
//   SUPABASE_URL         (auto-injected by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-injected by Supabase)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const INTUIT_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { code, realmId } = await req.json();

    if (!code || !realmId) {
      return json({ error: 'Missing code or realmId' }, 400);
    }

    const clientId = Deno.env.get('QB_CLIENT_ID');
    const clientSecret = Deno.env.get('QB_CLIENT_SECRET');
    const redirectUri = Deno.env.get('QB_REDIRECT_URI');
    const environment = Deno.env.get('QB_ENVIRONMENT') ?? 'sandbox';

    if (!clientId || !clientSecret || !redirectUri) {
      return json({ error: 'Server is missing QB_CLIENT_ID, QB_CLIENT_SECRET, or QB_REDIRECT_URI' }, 500);
    }

    // Exchange the auth code for tokens
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(INTUIT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return json({ error: 'Intuit token exchange failed', detail: tokenData }, 502);
    }

    const { access_token, refresh_token, expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();

    // Store in Supabase
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error: dbError } = await supabase
      .from('qb_credentials')
      .upsert({
        realm_id: realmId,
        environment,
        refresh_token,
        access_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'realm_id' });

    if (dbError) {
      return json({ error: 'Database write failed', detail: dbError.message }, 500);
    }

    return json({ ok: true, realmId, environment, expiresAt });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: String(err) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
