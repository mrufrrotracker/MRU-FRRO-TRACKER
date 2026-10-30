
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(input: string): string {
  return base64Bytes(new TextEncoder().encode(input))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeHeader(input: string): string {
  return `=?UTF-8?B?${base64Bytes(new TextEncoder().encode(input))}?=`;
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
      `Google token refresh failed: ${data.error_description || data.error || response.status
      }`,
    );
  }

  return data.access_token;
}

async function sendGmail(
  accessToken: string,
  fromEmail: string,
  toEmail: string,
  title: string,
  body: string,
  studentName: string,
): Promise<string | null> {
  if (/[\r\n]/.test(fromEmail) || /[\r\n]/.test(toEmail)) {
    throw new Error('Invalid email address.');
  }

  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body).replace(/\r?\n/g, '<br>');
  const safeName = escapeHtml(studentName || 'Student');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.7;color:#183247;max-width:650px;margin:auto;padding:24px">
      <div style="background:#123a63;color:#ffffff;padding:18px 22px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">MRU FRRO Tracker</h2>
      </div>
      <div style="border:1px solid #dce4ec;padding:22px;border-radius:0 0 8px 8px">
        <p>Dear ${safeName},</p>
        <h2>${safeTitle}</h2>
        <p>${safeBody}</p>
        <p style="margin-top:28px">
          Regards,<br>
          <strong>MRU FRRO Tracker Administration</strong>
        </p>
      </div>
    </div>
  `;

  const htmlBase64 = base64Bytes(new TextEncoder().encode(html));

  const mimeMessage = [
    `From: ${fromEmail}`,
    `To: ${toEmail}`,
    `Subject: ${encodeHeader(title)}`,
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
      `Gmail API error (${response.status}): ${data.error?.message || JSON.stringify(data)
      }`,
    );
  }

  return data.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return respond({ error: 'Authentication required.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const fromEmail = Deno.env.get('FRRO_FROM_EMAIL');

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !fromEmail) {
    return respond({ error: 'Required server configuration is missing.' }, 500);
  }

  // Verify the caller's Supabase access token.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData.user) {
    return respond({ error: 'Invalid or expired login session.' }, 401);
  }

  // Use the service role only on the server.
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Only verified administrators may send announcements.
  const { data: adminProfile, error: adminError } = await db
    .from('student_profiles')
    .select('role, verification_status')
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (
    adminError ||
    adminProfile?.role !== 'admin' ||
    adminProfile?.verification_status !== 'verified'
  ) {
    return respond({ error: 'Verified administrator access required.' }, 403);
  }

  let payload: {
    request_id?: string;
    user_ids?: string[];
    title?: string;
    body?: string;
  };

  try {
    payload = await req.json();
  } catch {
    return respond({ error: 'Invalid JSON request.' }, 400);
  }

  const requestId = payload.request_id?.trim();
  const title = payload.title?.trim();
  const messageBody = payload.body?.trim();
  const userIds = [...new Set(payload.user_ids ?? [])];

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!requestId || !uuidPattern.test(requestId)) {
    return respond({ error: 'A valid request ID is required.' }, 400);
  }

  if (!title || title.length > 120 || !messageBody || messageBody.length > 3000) {
    return respond({ error: 'Enter a title and message within the allowed limits.' }, 400);
  }

  if (
    userIds.length === 0 ||
    userIds.length > 100 ||
    userIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))
  ) {
    return respond({ error: 'Select between 1 and 100 valid student accounts.' }, 400);
  }

  const { data: students, error: studentsError } = await db
    .from('student_profiles')
    .select('user_id, full_name, email')
    .eq('role', 'student')
    .in('user_id', userIds);

  if (studentsError) {
    return respond({ error: 'Could not load selected students.' }, 500);
  }

  const studentById = new Map(
    (students ?? []).map((student) => [student.user_id, student]),
  );

  if (studentById.size !== userIds.length) {
    return respond({
      error: 'One or more selected accounts are missing or are not student accounts.',
    }, 400);
  }

  const results: Array<{
    user_id: string;
    status: string;
    error?: string;
  }> = [];

  let accessToken: string | null = null;

  for (const userId of userIds) {
    const student = studentById.get(userId);
    const email = typeof student?.email === 'string' ? student.email.trim() : '';

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  const errorMessage = 'Student email is missing or invalid.';

  const { error: logError } = await db
    .from('admin_announcement_email_log')
    .upsert(
      {
        request_id: requestId,
        user_id: userId,
        email: email || 'unknown',
        status: 'failed',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'request_id,user_id' }
    );

  results.push({
    user_id: userId,
    status: 'failed',
    error: logError
      ? `${errorMessage} Logging failed: ${logError.message}`
      : errorMessage,
  });

  continue;
}

    // Check whether this request has already been sent or claimed.
    const { data: existing, error: lookupError } = await db
      .from('admin_announcement_email_log')
      .select('id, status')
      .eq('request_id', requestId)
      .eq('user_id', userId)
      .maybeSingle();

    if (lookupError) {
      results.push({ user_id: userId, status: 'claim_failed', error: lookupError.message });
      continue;
    }

   if (existing?.status === 'sent') {
  results.push({ user_id: userId, status: 'already_sent_or_claimed' });
  continue;
}

if (existing?.status === 'processing') {
  const { data: staleClaim, error: staleError } = await db
    .from('admin_announcement_email_log')
    .update({
      status: 'failed',
      error_message: 'Previous email attempt timed out. Safe to retry only after checking delivery.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .select('id')
    .maybeSingle();

  if (staleError || !staleClaim) {
    results.push({ user_id: userId, status: 'already_sent_or_claimed' });
    continue;
  }
}

    if (existing?.status === 'failed') {
      const { data: reclaimed, error: reclaimError } = await db
        .from('admin_announcement_email_log')
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
          user_id: userId,
          status: 'already_sent_or_claimed',
          error: reclaimError?.message,
        });
        continue;
      }
    } else if (!existing) {
      const { error: claimError } = await db
        .from('admin_announcement_email_log')
        .insert({
          request_id: requestId,
          user_id: userId,
          email,
          status: 'processing',
        });

      if (claimError) {
        results.push({
          user_id: userId,
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
        title,
        messageBody,
        student?.full_name || 'Student',
      );

      const { error: updateError } = await db
        .from('admin_announcement_email_log')
        .update({
          status: 'sent',
          provider_message_id: messageId,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('request_id', requestId)
        .eq('user_id', userId);

      results.push({
        user_id: userId,
        status: updateError ? 'sent_but_log_update_failed' : 'sent',
        error: updateError?.message,
      });
    } catch (error) {
      const errorMessage = String(error);

      await db
        .from('admin_announcement_email_log')
        .update({
          status: 'failed',
          error_message: errorMessage,
        })
        .eq('request_id', requestId)
        .eq('user_id', userId);

      results.push({
        user_id: userId,
        status: 'failed',
        error: errorMessage,
      });
    }
  }

  return respond({
    request_id: requestId,
    recipients_found: students?.length ?? 0,
    sent: results.filter((result) => result.status === 'sent').length,
    skipped: results.filter(
      (result) => result.status === 'already_sent_or_claimed',
    ).length,
    failed: results.filter((result) =>
      ['failed', 'claim_failed', 'sent_but_log_update_failed'].includes(result.status)
    ).length,
    results,
  });
});
