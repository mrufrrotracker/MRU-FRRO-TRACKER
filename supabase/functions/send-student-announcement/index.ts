
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CAMPAIGN_ID = 'frro_dates_update_2026_01';
const SUBJECT = 'Important: Keep Your FRRO Dates Updated - MRU FRRO Tracker';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(input: string): string {
  return base64Bytes(new TextEncoder().encode(input))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGmailAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth secrets are not configured.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google token refresh failed: ${data.error_description || data.error || response.status}`,
    );
  }

  return data.access_token;
}

async function sendGmail(
  accessToken: string,
  fromEmail: string,
  toEmail: string,
  name: string,
): Promise<string | null> {
  if (/[\r\n]/.test(fromEmail) || /[\r\n]/.test(toEmail)) {
    throw new Error('Invalid email address.');
  }

  const safeName = escapeHtml(name || 'Student');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.7;color:#183247;max-width:650px;margin:auto">
      <h2>Important: Keep Your FRRO Dates Updated</h2>

      <p>Dear ${safeName},</p>

      <p>
        Please ensure that your FRRO information in the
        <strong>MRU FRRO Tracker</strong> is accurate and up to date.
      </p>

      <p>Please log in to your account and check that the following details are correct:</p>

      <ul>
        <li>Your FRRO issue date</li>
        <li>Your current FRRO expiry date</li>
        <li>Any updated dates following an FRRO renewal</li>
      </ul>

      <p>
        Whenever you receive a renewed FRRO document, please update your dates
        promptly so that the tracker can provide accurate expiry reminders.
      </p>

      <p>
        Keeping your information current helps the university monitor expiry
        dates and send timely notifications.
      </p>

      <p>Thank you for your cooperation.</p>

      <p><strong>MRU FRRO Tracker Administration</strong></p>
    </div>
  `;

  const htmlBase64 = base64Bytes(new TextEncoder().encode(html));

  const mimeMessage = [
    `From: ${fromEmail}`,
    `To: ${toEmail}`,
    `Subject: ${SUBJECT}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64,
  ].join('\r\n');

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64Url(mimeMessage) }),
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Gmail API error (${response.status}): ${data.error?.message || JSON.stringify(data)}`,
    );
  }

  return data.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405);
  }

  const expectedSecret = Deno.env.get('FRRO_REMINDER_FUNCTION_SECRET');
  const authHeader = req.headers.get('Authorization') || '';

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return respond({ error: 'Unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const fromEmail = Deno.env.get('FRRO_FROM_EMAIL');

  if (!supabaseUrl || !serviceRoleKey || !fromEmail) {
    return respond({ error: 'Required Supabase or sender secrets are missing.' }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey);

  const { data: students, error: studentsError } = await db
    .from('student_profiles')
    .select('user_id, full_name, email')
    .eq('role', 'student')
    .not('email', 'is', null)
    .order('full_name');

  if (studentsError) {
    return respond({ error: 'Could not load students.', details: studentsError.message }, 500);
  }

  const recipients = (students ?? []).filter(
    (student) => typeof student.email === 'string' && student.email.trim() !== '',
  );

  const results: Array<{ user_id: string; status: string; error?: string }> = [];
  let accessToken: string | null = null;

  for (const student of recipients) {
    const email = student.email.trim();
// Check whether this student already has a campaign record.
const { data: existing, error: lookupError } = await db
  .from('student_announcement_log')
  .select('id, status')
  .eq('campaign_id', CAMPAIGN_ID)
  .eq('user_id', student.user_id)
  .maybeSingle();

if (lookupError) {
  results.push({
    user_id: student.user_id,
    status: 'claim_failed',
    error: lookupError.message,
  });
  continue;
}

if (existing?.status === 'sent' || existing?.status === 'processing') {
  results.push({
    user_id: student.user_id,
    status: 'already_sent_or_claimed',
  });
  continue;
}

if (existing?.status === 'failed') {
  // Reclaim a previously failed attempt.
  const { data: reclaimed, error: reclaimError } = await db
    .from('student_announcement_log')
    .update({
      status: 'processing',
      email,
      error_message: null,
    })
    .eq('id', existing.id)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle();

  if (reclaimError || !reclaimed) {
    results.push({
      user_id: student.user_id,
      status: 'already_sent_or_claimed',
      error: reclaimError?.message,
    });
    continue;
  }
} else if (!existing) {
  // Create a new campaign claim.
  const { error: claimError } = await db
    .from('student_announcement_log')
    .insert({
      campaign_id: CAMPAIGN_ID,
      user_id: student.user_id,
      email,
      status: 'processing',
    });

  if (claimError) {
    results.push({
      user_id: student.user_id,
      status: 'claim_failed',
      error: claimError.message,
    });
    continue;
  }
}

    try {
      if (!accessToken) accessToken = await getGmailAccessToken();

      const messageId = await sendGmail(
        accessToken,
        fromEmail,
        email,
        student.full_name || 'Student',
      );

      const { error: updateError } = await db
        .from('student_announcement_log')
        .update({
          status: 'sent',
          provider_message_id: messageId,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('campaign_id', CAMPAIGN_ID)
        .eq('user_id', student.user_id);

      if (updateError) {
        results.push({
          user_id: student.user_id,
          status: 'sent_but_log_update_failed',
          error: updateError.message,
        });
      } else {
        results.push({ user_id: student.user_id, status: 'sent' });
      }
    } catch (error) {
      const errorMessage = String(error);

      await db
        .from('student_announcement_log')
        .update({
          status: 'failed',
          error_message: errorMessage,
        })
        .eq('campaign_id', CAMPAIGN_ID)
        .eq('user_id', student.user_id);

      results.push({
        user_id: student.user_id,
        status: 'failed',
        error: errorMessage,
      });
    }
  }

  return respond({
    campaign_id: CAMPAIGN_ID,
    recipients_found: recipients.length,
    sent: results.filter((r) => r.status === 'sent').length,
    skipped: results.filter((r) => r.status === 'already_sent_or_claimed').length,
    failed: results.filter((r) =>
      r.status === 'failed' ||
      r.status === 'claim_failed' ||
      r.status === 'sent_but_log_update_failed'
    ).length,
    results,
  });
});
