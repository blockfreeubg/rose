# Account setup: connect Rose to Supabase

When this is set up, people have to **create an account and sign in** before they can see or play
anything on Rose. Rose uses **Supabase Auth** for accounts. Supabase stores the users and passwords,
sends the confirmation emails, and handles "forgot password". Rose only checks that each person is signed in.

You do this once. It takes about 10 minutes.

---

## What you need

- Your Supabase project. You said you already have one. If you don't, see step 1.
- Rose's folder on this computer: `/home/duderucool/rose`
- The web address people use to open Rose, for example `http://localhost:8080`, or your tunnel
  address like `https://something.trycloudflare.com`. See step 4 for an important note about tunnels.

---

## Step 1: Open your Supabase project

1. Go to <https://supabase.com/dashboard> and sign in.
2. Click your project. If you have none, click **New project**, give it a name and a database
   password (save it somewhere), pick the region closest to you, and click **Create new project**.
   Wait about 2 minutes while it sets up.

## Step 2: Copy your project URL and public key

1. In the left sidebar, click the **gear icon (Project Settings)**.
2. Click **API Keys**. Older dashboards call this page **API**.
3. Copy these two values into a notepad:
   - **Project URL**: looks like `https://abcdefghijklmno.supabase.co`.
     It is at the top of the **API** page, or under **Project Settings → Data API**.
   - **Publishable key**: starts with `sb_publishable_...`.
     Older projects call this the **anon public** key instead. It is a long text starting with `eyJ...`.
     Either one works.

> ⚠️ **Never** copy the **secret key** (`sb_secret_...`) or the **service_role** key into Rose.
> Rose doesn't need them, and anyone who has them gets full control of your database.
> The publishable / anon key is meant to be public, so it's fine that browsers can see it.

## Step 3: Turn on email sign-up

1. In the left sidebar, click **Authentication**.
2. Click **Sign In / Providers**. Older dashboards call this **Providers**.
3. Make sure **Email** is **enabled**.
4. In the same section, check that **Allow new users to sign up** is **on**.
   Turn it off later if you want to stop new accounts.
5. **Confirm email**:
   - **On** (recommended): new users must click a link in an email before they can sign in.
   - **Off**: people can sign in right after signing up. This is easier for testing.

   > Supabase's built-in email sender only sends a few emails per hour, and it's meant for testing.
   > If many people will sign up, set up your own email service under
   > **Authentication → Emails → SMTP Settings**. Resend, Brevo, Mailgun and Gmail SMTP all work.

## Step 4: Tell Supabase where Rose lives (redirect URLs)

Links in confirmation and password-reset emails send people back to Rose. Supabase only allows
addresses you list.

1. Click **Authentication → URL Configuration**.
2. **Site URL**: put the main address people use for Rose, for example `https://rose.yourdomain.com`,
   or `http://localhost:8080` if only you use it.
3. **Redirect URLs**: click **Add URL** and add every address Rose is opened from, for example:
   - `http://localhost:8080/**`
   - `https://rose.yourdomain.com/**`
   - `https://*.trycloudflare.com/**` (only if you use the free Cloudflare quick tunnel)
4. Click **Save**.

> 💡 **About the free tunnel:** the free `docker compose --profile tunnel` link gets a new random
> `trycloudflare.com` address every time it restarts. The `https://*.trycloudflare.com/**` wildcard
> above covers that, but your Site URL will be out of date. For a permanent address, use a named
> Cloudflare Tunnel with your own domain. It's free, but it needs a domain.

## Step 5 (optional): "Sign in with Google / Discord / GitHub"

You can skip this step. Email accounts work without it.

1. Click **Authentication → Sign In / Providers**, then click the provider, for example **Discord**.
2. Turn it on and paste the **Client ID** and **Client Secret** from that company's developer site.
   Supabase shows the exact steps and the **Callback URL** you must give them. It looks like
   `https://abcdefghijklmno.supabase.co/auth/v1/callback`.
3. Click **Save**.
4. List the providers you turned on in `ROSE_AUTH_PROVIDERS` in step 6, for example `google,discord`.
   Rose shows a button for each one.

## Step 6: Give Rose your Supabase details

1. Open a terminal in Rose's folder:
   ```bash
   cd /home/duderucool/rose
   ```
2. Create a file called `.env`. If it already exists, add these lines to it.
   Replace the example values with yours from step 2:
   ```bash
   ROSE_SUPABASE_URL=https://abcdefghijklmno.supabase.co
   ROSE_SUPABASE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx
   ROSE_REQUIRE_ACCOUNT=1
   # Optional: buttons for social sign-in you enabled in step 5 (comma-separated)
   ROSE_AUTH_PROVIDERS=
   # Optional: only let these emails in (comma-separated). Leave empty to allow anyone who signs up.
   ROSE_ALLOWED_EMAILS=
   ```
   An easy way to create the file is `nano .env`. Paste the lines, press **Ctrl+O**, **Enter**,
   then **Ctrl+X**.
3. Apply the change. A plain restart is not enough, because new settings need the container recreated:
   ```bash
   docker compose up -d --no-build rose
   ```
   This disconnects anyone who is playing, so do it when nobody is on.

## Step 7: Test it

1. Open Rose in a private or incognito window, for example `http://localhost:8080`.
2. You should see the **Sign in to Rose** screen instead of the library.
3. Click **Create account**, enter an email and a password (at least 8 characters), and submit.
4. If **Confirm email** is on, open the email from Supabase and click the link. It brings you back to Rose.
5. Sign in. The library appears.
6. Your account menu is at the top right. **Sign out** is there.

You can see and manage every account in Supabase under **Authentication → Users**. You can delete
users, ban them, or send password resets from there.

---

## How it works (short version)

- The sign-in screen talks straight to Supabase. Your password never goes through Rose.
- Supabase gives the browser a short-lived **access token**. The browser sends it with every
  request to Rose and when it opens the game stream. Rose checks that token against your Supabase
  project before it lets anyone browse, queue or play.
- Signed-out visitors can only load the sign-in page and its files. Everything else answers
  "sign in first".
- The **upload password** (`/upload` page) still works as before, on top of the account.
  You need to be signed in **and** know the upload password to add or remove games.
- **Rose nodes** (other people's computers hosting games) use their own join codes, not accounts,
  so they keep working.
- To turn accounts off again, set `ROSE_REQUIRE_ACCOUNT=0` in `.env` and run
  `docker compose up -d --no-build rose`.

## Troubleshooting

| Problem | Fix |
|---|---|
| The sign-in screen says "Accounts aren't set up" | `ROSE_SUPABASE_URL` or `ROSE_SUPABASE_KEY` is missing or wrong in `.env`, or you ran `docker restart` instead of `docker compose up -d --no-build rose`. |
| "Invalid API key" | You pasted the wrong key. Use the **publishable** or **anon public** key, not the secret or service_role key. Make sure there are no extra spaces. |
| "Email not confirmed" | Click the link in the confirmation email, or turn off **Confirm email** (step 3). |
| The confirmation link opens the wrong site or says "redirect not allowed" | Add Rose's exact address to **Redirect URLs** (step 4), with `/**` on the end. |
| No confirmation email arrives | Check spam. Supabase's built-in sender is limited to a few emails per hour, so set up SMTP (step 3). |
| Social sign-in opens an error page | The provider's callback URL must be the Supabase one (`https://<project>.supabase.co/auth/v1/callback`), and Rose's address must be in Redirect URLs. |
| Everyone gets signed out after about an hour | That is normal token expiry. Rose renews it in the background. If it doesn't, check that the clock on the computer running Rose is correct. |
| You want only your friends to get in | Put their emails in `ROSE_ALLOWED_EMAILS`, or turn off **Allow new users to sign up** in Supabase and invite them from **Authentication → Users → Invite**. |
