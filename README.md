# MRU FRRO Tracker — Fresh Starter Project

A fresh React + Vite + Supabase app for recording **only two FRRO dates**:
- Previous renewal date
- Next expiry date

Includes student registration/login, automatic student-profile creation, an admin renewal register, expiry filters, in-app announcements, and a server-side email reminder function.

## Important design/security notes

- This starter treats new student accounts as `verified` automatically, matching the requested workflow. This verifies the app account only; it does **not** prove university enrollment. Restrict registration to an approved group/domain or add an eligibility check if the tracker is for actual enrolled students only.
- Never place a Supabase service-role key in `VITE_*` variables or browser code.
- The daily email reminder function is not active until deployed and scheduled, and an email provider is configured.
- “Push messages” in this starter are in-app announcements displayed in the student portal. True browser push notifications require service-worker subscriptions and VAPID keys; they are not the same as in-app messages.
- Use a fresh/dedicated Supabase project for this SQL. Do not blindly run `schema.sql` on the old project because it creates types/tables/triggers that may already exist.

## 1. Run locally

Install Node.js LTS, unzip this folder, and open a terminal in the project directory:

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and enter your Supabase project URL and publishable/anon key:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_OR_ANON_KEY
```

Then start Vite:

```bash
npm run dev -- --host 0.0.0.0
```

Open the `Local` URL printed in the terminal, usually `http://localhost:5173`.

## 2. Set up a fresh Supabase project

1. Create a dedicated project in Supabase.
2. Open **SQL Editor → New query**.
3. Copy all of `supabase/schema.sql`, review it, and run it once.
4. In **Authentication → URL Configuration**, set the local Site URL to `http://localhost:5173` while developing. Add your production URL later.
5. In **Authentication → Providers → Email**, decide whether email confirmation should be enabled.
6. Add the project URL and publishable/anon key to `.env.local`, then restart the Vite server.

The `auth.users` trigger creates a profile with `role=student` and `verification_status=verified`. The trigger assigns the role itself; registration metadata cannot choose an admin role.

## 3. Promote your own account to admin

1. Register your own account through the app.
2. In Supabase **Authentication → Users**, copy your account UUID.
3. Open `supabase/promote-admin.sql.example`, replace the placeholder UUID with your own, and run that one UPDATE in the SQL Editor.
4. Sign out of the app and sign in again. The dashboard should show the admin renewal register.

Do not expose the admin-promotion SQL in the app or let students choose their role.

## 4. Automated email reminders

The schedule is 60, 45, 30, 21, 14, 10, 7, 3, 2 and 1 day before `next_expiry_date`.

### Configure secrets

Deploy `supabase/functions/send-frro-reminders/index.ts` as the `send-frro-reminders` Edge Function. Configure these function secrets in Supabase:

- `FRRO_REMINDER_FUNCTION_SECRET`: a long random secret used to authorize scheduled calls.
- `RESEND_API_KEY`: an API key for Resend (or adapt the function to your chosen provider).
- `FRRO_FROM_EMAIL`: a sender address verified with your email provider.

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Keep these server-side only.

### Test the function

Invoke the function with header:

```http
Authorization: Bearer YOUR_FRRO_REMINDER_FUNCTION_SECRET
Content-Type: application/json
```

The function looks for records whose expiry is exactly the configured number of days from today, claims each reminder using a unique database key, sends the email, records success/failure, and adds an in-app notification.

### Schedule daily execution

Enable the `pg_cron`, `pg_net`, and Vault extensions if supported by your project. Review `supabase/schedule-reminders.sql.example`, store the project URL and function secret in Vault, then adapt and run the schedule statement. It is set for 03:05 UTC (08:35 India Standard Time). Alternatively use Supabase's supported Cron UI to invoke the Edge Function daily with the authorization header. Verify the job's execution logs.

**Delivery caveat:** The unique reminder row prevents duplicate sends. If the email provider accepts an email but the function times out before updating the log, a later retry may not automatically resend it. Monitor failed/processing entries and provider logs.

## 5. What this version includes / does not include

Included:
- Responsive navy/teal design
- Student sign-up/sign-in
- Automatic profile row creation
- Two-date FRRO form; late/near-expiry records are accepted
- Admin total list, due-within-60-days and expired filters
- In-app announcements to all student profiles
- Daily Edge Function for email reminders and in-app reminders
- RLS policies and admin-only directory access

Not yet included:
- Native browser push notifications
- SMS/WhatsApp
- Import from spreadsheets
- Admin-created accounts
- Formal verification of university enrollment
- Production monitoring, backup/retention policy, and a security/privacy review

## 6. Before production

Test using dummy accounts and dummy dates. Review all RLS policies, auth email settings, sender domain, reminder delivery, audit requirements, privacy notice, and university approval before storing real passport or immigration-related information.
