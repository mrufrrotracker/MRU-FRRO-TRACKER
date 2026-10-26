
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getFirebaseAccessToken(
  clientEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const pem = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claim = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: clientEmail,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ),
  );

  const unsigned = `${header}.${claim}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  );

  const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("Firebase OAuth token request failed:", tokenData.error);
    throw new Error("Could not authenticate with Firebase.");
  }

  return tokenData.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const firebaseProjectId = Deno.env.get("FIREBASE_PROJECT_ID");
    const firebaseClientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL");
    const firebasePrivateKey = Deno.env.get("FIREBASE_PRIVATE_KEY");

    if (
      !supabaseUrl || !anonKey || !serviceRoleKey ||
      !firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey
    ) {
      console.error("Required function configuration is missing.");
      return response({ error: "Server configuration is incomplete." }, 500);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return response({ error: "Sign-in required." }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();

    if (userError || !userData.user) {
      return response({ error: "Invalid or expired session." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("student_profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Admin authorization lookup failed:", profileError.message);
      return response({ error: "Could not verify permissions." }, 500);
    }

    if (profile?.role !== "admin") {
      return response({ error: "Admin access required." }, 403);
    }

    let body: { user_id?: string; title?: string; message?: string };
    try {
      body = await req.json();
    } catch {
      return response({ error: "Invalid JSON body." }, 400);
    }

    const userId = body.user_id?.trim();
    const title = body.title?.trim();
    const message = body.message?.trim();

    if (
      !userId || !title || !message ||
      title.length > 100 || message.length > 1000
    ) {
      return response({
        error: "Provide user_id, a title (max 100 characters), and a message (max 1000 characters).",
      }, 400);
    }

    const { data: tokens, error: tokenError } = await adminClient
      .from("push_device_tokens")
      .select("token")
      .eq("user_id", userId);

    if (tokenError) {
      console.error("Device token lookup failed:", tokenError.message);
      return response({ error: "Could not retrieve device tokens." }, 500);
    }

    if (!tokens?.length) {
      return response({ message: "No registered device tokens for this user.", sent: 0 });
    }

    const accessToken = await getFirebaseAccessToken(
      firebaseClientEmail,
      firebasePrivateKey,
    );

    let sent = 0;
    let failed = 0;

    for (const device of tokens) {
      const fcmResponse = await fetch(
        `https://fcm.googleapis.com/v1/projects/${firebaseProjectId}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: device.token,
              notification: { title, body: message },
              data: { type: "admin_message" },
              android: { priority: "HIGH" },
            },
          }),
        },
      );

      if (fcmResponse.ok) {
        sent++;
      } else {
        failed++;
        console.error("FCM send failed with HTTP status:", fcmResponse.status);
      }
    }

    return response({ sent, failed, total: tokens.length });
  } catch (error) {
    console.error(
      "send-push error:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return response({ error: "Push notification could not be sent." }, 500);
  }
});
