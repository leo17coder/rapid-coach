# Setting up accounts (Supabase)

Accounts are optional. Until `config.js` has a key, the app works exactly as without them and shows no sign-in links.

Project: `https://ednyucirnrdcsveqlokb.supabase.co`. Make sure it's in an EU region (Project Settings → General). The region can't be changed later.

## 1. Create the tables

SQL Editor → New query → paste all of `migrations/001_sync.sql` → Run. It's safe to run again.

Then do the same with `migrations/002_friends.sql` (friends and the leaderboard), then `migrations/003_openings.sql` (opening trainer progress, and "openings learned" on the leaderboard), then `migrations/004_gamification.sql` (daily goal, streaks, XP and badges, plus weekly XP and streak on the leaderboard), then `migrations/005_keep_alive.sql` (the tiny function the keep-awake job calls).

Then check Database → Tables: `analyses`, `baselines`, `linked_accounts`, `puzzle_progress`, `profiles`, `friendships` and `leaderboard_stats` should each show "RLS enabled".

## 2. Sign-in settings (Authentication)

- **Sign In / Providers → Email**: enabled, "Confirm email" on. Turn off providers you don't use.
- **URL Configuration**: Site URL `https://leo17coder.github.io/rapid-coach/`. Redirect URLs: add `https://leo17coder.github.io/rapid-coach/` and `http://localhost:8000/`.
- **Emails → Templates → Magic Link**: the app lets people type the code, so the email must contain it. For example:

  ```html
  <h2>Sign in to Rapid Coach</h2>
  <p><a href="{{ .ConfirmationURL }}">Sign in on this device</a></p>
  <p>Or enter this code in Rapid Coach: <b>{{ .Token }}</b></p>
  <p>If you didn't ask for this, ignore this email.</p>
  ```

  Use the same text for the **Confirm signup** template: a person's first sign-in sends that one.
- **Emails → SMTP Settings**: required. Supabase's built-in sender only mails members of your Supabase organisation. Enter your email provider's SMTP host, port, user and password, with a sender name like "Rapid Coach".
- **Rate Limits**: raise "emails sent per hour" to what your provider allows.
- Optional, if spam sign-ups appear: **Attack Protection → CAPTCHA** with Cloudflare Turnstile. (The app doesn't send a CAPTCHA token yet; tell Claude first.)

## 3. Switch it on

Project Settings → API Keys: copy the **publishable** key (`sb_publishable_…`; the legacy `anon` key also works) into `supabaseKey` in `../config.js`. Never use the `service_role` / secret key.

## 4. Legal

- Sign Supabase's DPA (Organization settings → Legal documents) and your email provider's.
- `privacy.html` names GitHub issues as the contact. Add an email address there if you prefer.

## Free tier notes

- Free projects pause after about a week without activity. `.github/workflows/keep-supabase-awake.yml` prevents that: every 3 days GitHub Actions calls `public.keep_alive()` (from `migrations/005_keep_alive.sql`, which must be run once) with the publishable key read from `config.js`. No secrets or settings are needed. Run it by hand under Actions → "Keep Supabase awake" → Run workflow. A failed ping fails the run, and GitHub emails you.
- GitHub disables scheduled workflows in a public repository after 60 days without any commits, and emails you first; re-enable it with one click on the Actions tab.
- If the project ever does pause, sign-in fails until you resume it in the dashboard; the app carries on locally meanwhile.
- About 1 KB per analysed game, so the 500 MB database holds hundreds of active users.
