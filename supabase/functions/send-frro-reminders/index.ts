
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const REMINDER_DAYS = [60, 45, 30, 21, 14, 10, 7, 3, 2, 1, 0];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

type ReminderResult = {
  user_id: string;
  days_before: number;
  status: string;
  error?: string;
};

function indiaDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')}`;
}

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
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return base64Bytes(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGmailAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN.'
    );
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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
      `Google token refresh failed: ${data.error_description || data.error || response.status}`
    );
  }

  return data.access_token;
}

async function sendGmail(
  accessToken: string,
  fromEmail: string,
  toEmail: string,
  subject: string,
  html: string,
): Promise<string | null> {
  if (/[\r\n]/.test(fromEmail) || /[\r\n]/.test(toEmail)) {
    throw new Error('Invalid email header.');
  }

  const htmlBase64 = base64Bytes(new TextEncoder().encode(html));

  const mimeMessage = [
    `From: ${fromEmail}`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
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
      body: JSON.stringify({
        raw: base64Url(mimeMessage),
      }),
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Gmail API error (${response.status}): ${
        data.error?.message || JSON.stringify(data)
      }`
    );
  }

  return data.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const expectedSecret = Deno.env.get('FRRO_REMINDER_FUNCTION_SECRET');
  const authHeader = req.headers.get('Authorization') || '';

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const fromEmail = Deno.env.get('FRRO_FROM_EMAIL');

  if (!supabaseUrl || !serviceRoleKey || !fromEmail) {
    return new Response(
      JSON.stringify({
        error: 'Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or FRRO_FROM_EMAIL.',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const dryRun = new URL(req.url).searchParams.get('dry_run') === 'true';
  const db = createClient(supabaseUrl, serviceRoleKey);
  const today = indiaDate();

  const results: ReminderResult[] = [];
  let accessToken: string | null = null;

  for (const daysBefore of REMINDER_DAYS) {
    const expiry = new Date(`${today}T00:00:00.000Z`);
    expiry.setUTCDate(expiry.getUTCDate() + daysBefore);
    const expiryDate = expiry.toISOString().slice(0, 10);

    const { data: records, error: recordsError } = await db
      .from('frro_records')
      .select('user_id, next_expiry_date')
      .eq('next_expiry_date', expiryDate);

    if (recordsError) {
      results.push({
        user_id: 'batch',
        days_before: daysBefore,
        status: 'query_error',
        error: recordsError.message,
      });
      continue;
    }

    for (const record of records ?? []) {
      const { data: profile, error: profileError } = await db
        .from('student_profiles')
        .select('full_name, email')
        .eq('user_id', record.user_id)
        .maybeSingle();

      if (profileError || !profile?.email) {
        results.push({
          user_id: record.user_id,
          days_before: daysBefore,
          status: 'missing_email',
          error: profileError?.message || 'Student email not found.',
        });
        continue;
      }

      if (dryRun) {
        results.push({
          user_id: record.user_id,
          days_before: daysBefore,
          status: 'dry_run',
        });
        continue;
      }

      // Insert a claim before sending. The unique constraint prevents duplicates.
      const { error: claimError } = await db
        .from('reminder_log')
        .insert({
          user_id: record.user_id,
          expiry_date: record.next_expiry_date,
          days_before: daysBefore,
          channel: 'email',
          status: 'processing',
        });

      if (claimError) {
        if (claimError.code === '23505') {
          results.push({
            user_id: record.user_id,
            days_before: daysBefore,
            status: 'already_claimed',
          });
          continue;
        }

        results.push({
          user_id: record.user_id,
          days_before: daysBefore,
          status: 'claim_error',
          error: claimError.message,
        });
        continue;
      }

      try {
        if (!accessToken) {
          accessToken = await getGmailAccessToken();
        }

        const name = escapeHtml(profile.full_name || 'student');
        const expiryText = record.next_expiry_date;
        const dayText = daysBefore === 1 ? 'day' : 'days';
        const subject =
          `FRRO expiry reminder: ${daysBefore} ${dayText} remaining`;

        const html = `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#183247">
            <h2>FRRO renewal reminder</h2>
            <p>Hello ${name},</p>
            <p>Your FRRO record is due to expire on
              <strong>${expiryText}</strong>.</p>
            <p>
              ${
                daysBefore === 0
                  ? 'Your recorded FRRO expiry date is today.'
                  : `There are ${daysBefore} ${dayText} remaining.`
              }
            </p>
            <p>
              Please check your documents and follow the official instructions
              applicable to your situation. This is an administrative reminder,
              not immigration advice.
            </p>
            <p>— MRU FRRO Tracker</p>
          </div>
        `;

        const messageId = await sendGmail(
          accessToken,
          fromEmail,
          profile.email,
          subject,
          html,
        );

        const { error: updateError } = await db
          .from('reminder_log')
          .update({
            status: 'sent',
            provider_message_id: messageId,
            sent_at: new Date().toISOString(),
            error_message: null,
          })
          .eq('user_id', record.user_id)
          .eq('expiry_date', record.next_expiry_date)
          .eq('days_before', daysBefore)
          .eq('channel', 'email');

        if (updateError) {
          throw new Error(
            `Email sent, but reminder log update failed: ${updateError.message}`
          );
        }

        const { error: notificationError } = await db
          .from('in_app_notifications')
          .insert({
            user_id: record.user_id,
            title: subject,
            body: `Your FRRO record is due to expire on ${expiryText}.`,
          });

        results.push({
          user_id: record.user_id,
          days_before: daysBefore,
          status: notificationError
            ? 'sent_notification_failed'
            : 'sent',
          error: notificationError?.message,
        });
      } catch (error) {
        const errorMessage = String(error);

        await db
          .from('reminder_log')
          .update({
            status: 'failed',
            error_message: errorMessage,
            sent_at: null,
          })
          .eq('user_id', record.user_id)
          .eq('expiry_date', record.next_expiry_date)
          .eq('days_before', daysBefore)
          .eq('channel', 'email');

        results.push({
          user_id: record.user_id,
          days_before: daysBefore,
          status: 'failed',
          error: errorMessage,
        });
      }
    }
  }

  return new Response(
    JSON.stringify({
      date: today,
      dry_run: dryRun,
      results,
    }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
