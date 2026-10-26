import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const REMINDER_DAYS = [60, 45, 30, 21, 14, 10, 7, 3, 2, 1];
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const expectedSecret = Deno.env.get('FRRO_REMINDER_FUNCTION_SECRET');
  const authHeader = req.headers.get('Authorization') || '';
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('FRRO_FROM_EMAIL');

  if (!supabaseUrl || !serviceRoleKey || !resendKey || !fromEmail) {
    return new Response(JSON.stringify({
      error: 'Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY or FRRO_FROM_EMAIL secret.'
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const db = createClient(supabaseUrl, serviceRoleKey);
  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ user_id: string; days_before: number; status: string; error?: string }> = [];

  for (const daysBefore of REMINDER_DAYS) {
    const expiry = new Date(`${today}T00:00:00Z`);
    expiry.setUTCDate(expiry.getUTCDate() + daysBefore);
    const expiryDate = expiry.toISOString().slice(0, 10);

    const { data: records, error: recordsError } = await db
      .from('frro_records')
      .select('user_id,next_expiry_date')
      .eq('next_expiry_date', expiryDate);

    if (recordsError) {
      results.push({ user_id: 'batch', days_before: daysBefore, status: 'query_error', error: recordsError.message });
      continue;
    }

    for (const record of records ?? []) {
      const { data: profile, error: profileError } = await db
        .from('student_profiles')
        .select('full_name,email')
        .eq('user_id', record.user_id)
        .maybeSingle();

      if (profileError || !profile?.email) {
        results.push({ user_id: record.user_id, days_before: daysBefore, status: 'missing_email', error: profileError?.message });
        continue;
      }

      // Claim this reminder first; the unique constraint prevents duplicate sends on retries.
      const { error: claimError } = await db.from('reminder_log').insert({
        user_id: record.user_id,
        expiry_date: record.next_expiry_date,
        days_before: daysBefore,
        channel: 'email',
        status: 'processing'
      });

      if (claimError) {
        // Unique violation means this reminder has already been claimed/sent.
        if (claimError.code === '23505') continue;
        results.push({ user_id: record.user_id, days_before: daysBefore, status: 'claim_error', error: claimError.message });
        continue;
      }

      const subject = `FRRO expiry reminder: ${daysBefore} day${daysBefore === 1 ? '' : 's'} remaining`;
      const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#183247"><h2>FRRO renewal reminder</h2><p>Hello ${escapeHtml(profile.full_name || 'student')},</p><p>Your FRRO record is due to expire on <strong>${record.next_expiry_date}</strong>, in ${daysBefore} day${daysBefore === 1 ? '' : 's'}.</p><p>Please check your documents and follow the official instructions applicable to your situation. This is an administrative reminder, not immigration advice.</p><p>— MRU FRRO Tracker</p></div>`;

      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromEmail, to: [profile.email], subject, html })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || `Email provider returned ${response.status}`);

        await db.from('reminder_log').update({
          status: 'sent',
          provider_message_id: body.id ?? null,
          sent_at: new Date().toISOString(),
          error_message: null
        }).eq('user_id', record.user_id).eq('expiry_date', record.next_expiry_date)
          .eq('days_before', daysBefore).eq('channel', 'email');

        await db.from('in_app_notifications').insert({
          user_id: record.user_id,
          title: subject,
          body: `Your FRRO record is due to expire on ${record.next_expiry_date}, in ${daysBefore} day${daysBefore === 1 ? '' : 's'}. Please plan your renewal.`
        });

        results.push({ user_id: record.user_id, days_before: daysBefore, status: 'sent' });
      } catch (error) {
        await db.from('reminder_log').update({
          status: 'failed',
          error_message: String(error),
          sent_at: null
        }).eq('user_id', record.user_id).eq('expiry_date', record.next_expiry_date)
          .eq('days_before', daysBefore).eq('channel', 'email');
        results.push({ user_id: record.user_id, days_before: daysBefore, status: 'failed', error: String(error) });
      }
    }
  }

  return new Response(JSON.stringify({ date: today, results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char] ?? char);
}
