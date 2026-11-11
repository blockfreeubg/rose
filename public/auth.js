// Accounts (ACCOUNTSETUP.md): the sign-in screen talks to Supabase Auth directly (its REST API, no
// library), keeps the session in localStorage, renews it before it expires, and hands Rose the
// access token: authHeader() for /api calls, wsProtocols() for the stream. Passwords never touch Rose.
// When the server doesn't require accounts, initAuth() resolves at once and nothing else changes.

const LS = 'rose-auth';
let cfg = { required: false };
let sess = null;              // { access_token, refresh_token, expires_at (s), user: { id, email } }
let refreshing = null, timer = 0, readyResolve = null;

const $ = s => document.querySelector(s);
const now = () => Math.floor(Date.now() / 1000);
const save = () => (sess ? localStorage.setItem(LS, JSON.stringify(sess)) : localStorage.removeItem(LS));
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
const back = () => `${location.origin}/`;

async function gotrue(path, { method = 'POST', body, token } = {}) {
  const r = await fetch(`${cfg.url}/auth/v1/${path}`, {
    method,
    headers: { apikey: cfg.key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.msg || d.error_description || d.message || d.error || `Account server error (${r.status})`), { code: d.error_code || '' });
  return d;
}
/** What a failed account request means for the person signing in (Supabase's codes, then its wording). */
function authError(err) {
  const m = err.message || '', c = err.code || '';
  if (c === 'invalid_credentials' || /invalid login/i.test(m)) return 'Wrong email or password.';
  // Accounts made while "Confirm email" was on, whose email never arrived: they stay unconfirmed.
  if (c === 'email_not_confirmed' || /email not confirmed/i.test(m)) return 'This account’s email was never confirmed. Ask whoever runs this Rose to remove that sign-up, then create your account again.';
  if (c === 'over_email_send_rate_limit' || /email rate limit/i.test(m)) return 'Rose can’t send another account email right now (only a few go out each hour). Try again later.';
  return m;
}
const fromTokens = d => ({
  access_token: d.access_token, refresh_token: d.refresh_token,
  expires_at: Number(d.expires_at) || now() + (Number(d.expires_in) || 3600),
  user: { id: d.user?.id || '', email: d.user?.email || '' },
});
function adopt(d) {
  sess = fromTokens(d);
  if (!sess.user.email) {   // tokens from a redirect come without the user: read it from the JWT
    try { const c = JSON.parse(atob(sess.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); sess.user = { id: c.sub, email: c.email || '' }; } catch {}
  }
  save(); schedule(); paintAccount();
}

function schedule() {
  clearTimeout(timer);
  if (!sess) return;
  const ms = Math.max(5, sess.expires_at - now() - 120) * 1000;   // renew 2 min early
  timer = setTimeout(() => refresh().catch(() => {}), Math.min(ms, 2 ** 31 - 1));
}
async function refresh() {
  if (!sess?.refresh_token) throw new Error('signed out');
  refreshing ??= (async () => {
    try {
      const latest = load();   // another tab may already have renewed it
      if (latest?.access_token && latest.access_token !== sess.access_token && latest.expires_at - now() > 120) { sess = latest; schedule(); return; }
      adopt(await gotrue('token?grant_type=refresh_token', { body: { refresh_token: sess.refresh_token } }));
    } catch (e) {
      if (!/fetch|network/i.test(e.message)) { sess = null; save(); lost('Your sign-in expired. Sign in again.'); }
      throw e;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/** Current token, renewed first if it's about to expire. '' when accounts are off. */
export async function freshToken() {
  if (!cfg.required || !sess) return '';
  if (sess.expires_at - now() < 60) await refresh().catch(() => {});
  return sess?.access_token || '';
}
export const authHeader = () => (cfg.required && sess ? { authorization: `Bearer ${sess.access_token}` } : {});
export const wsProtocols = () => (cfg.required && sess ? ['rose', `rose.auth.${sess.access_token}`] : undefined);
export const authRequired = () => cfg.required;

// ---- sign-in screen ----
let mode = 'in';   // in | up | forgot | reset
function screen() {
  let el = $('#auth');
  if (el) return el;
  el = document.createElement('section');
  el.id = 'auth';
  el.innerHTML = `
    <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <img class="auth-logo" src="img/rose-192.png" alt="" width="72" height="72">
      <h1 id="authTitle">Sign in to Rose</h1>
      <p class="auth-sub" id="authSub">Play your games from any browser.</p>
      <div class="auth-tabs" role="tablist">
        <button type="button" role="tab" data-mode="in">Sign in</button>
        <button type="button" role="tab" data-mode="up">Create account</button>
      </div>
      <form id="authForm" novalidate>
        <label class="auth-field" id="authEmailF"><span>Email</span><input id="authEmail" type="email" autocomplete="email" required></label>
        <label class="auth-field" id="authPassF"><span>Password</span><input id="authPass" type="password" autocomplete="current-password" minlength="8" required></label>
        <label class="auth-field" id="authPass2F"><span>Confirm password</span><input id="authPass2" type="password" autocomplete="new-password" minlength="8"></label>
        <div class="auth-msg" id="authMsg" role="status" aria-live="polite"></div>
        <button class="btn btn-play auth-go" id="authGo" type="submit">Sign in</button>
      </form>
      <button type="button" class="auth-link" id="authForgot">Forgot password?</button>
      <div class="auth-social" id="authSocial"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
  $('#authForgot').onclick = () => setMode(mode === 'forgot' ? 'in' : 'forgot');
  $('#authForm').onsubmit = submit;
  const social = $('#authSocial');
  for (const p of cfg.providers || []) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn auth-provider';
    b.textContent = `Continue with ${p[0].toUpperCase()}${p.slice(1)}`;
    b.onclick = () => { location.href = `${cfg.url}/auth/v1/authorize?provider=${encodeURIComponent(p)}&redirect_to=${encodeURIComponent(back())}`; };
    social.appendChild(b);
  }
  return el;
}
function setMode(m, msg = '', kind = '') {
  mode = m;
  const T = { in: ['Sign in to Rose', 'Sign in'], up: ['Create your Rose account', 'Create account'], forgot: ['Reset your password', 'Send reset link'], reset: ['Choose a new password', 'Save password'] }[m];
  $('#authTitle').textContent = T[0];
  $('#authGo').textContent = T[1];
  $('#authSub').textContent = m === 'forgot' ? 'We’ll email you a link to set a new password.' : m === 'reset' ? 'Enter a new password for your account.' : 'Play your games from any browser.';
  $('#authEmailF').hidden = m === 'reset';
  $('#authPassF').hidden = m === 'forgot';
  $('#authPass2F').hidden = !(m === 'up' || m === 'reset');
  $('#authPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  $('#authForgot').hidden = m === 'up' || m === 'reset';
  $('#authForgot').textContent = m === 'forgot' ? 'Back to sign in' : 'Forgot password?';
  document.querySelectorAll('#auth [data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('#auth .auth-tabs').hidden = m === 'reset' || m === 'forgot';
  $('#authSocial').hidden = m !== 'in' && m !== 'up';
  note(msg, kind);
}
function note(msg, kind = '') { const n = $('#authMsg'); n.textContent = msg; n.className = `auth-msg ${kind}`; }

async function submit(e) {
  e.preventDefault();
  const email = $('#authEmail').value.trim(), pass = $('#authPass').value, pass2 = $('#authPass2').value;
  if (mode !== 'reset' && !/^\S+@\S+\.\S+$/.test(email)) return note('Enter your email address.', 'err');
  if ((mode === 'in' || mode === 'up' || mode === 'reset') && pass.length < 8) return note('Passwords are at least 8 characters.', 'err');
  if ((mode === 'up' || mode === 'reset') && pass !== pass2) return note('The two passwords don’t match.', 'err');
  const go = $('#authGo'); go.disabled = true; note('One moment…');
  try {
    if (mode === 'in') {
      adopt(await gotrue('token?grant_type=password', { body: { email, password: pass } }));
      return done();
    }
    if (mode === 'up') {
      const d = await gotrue(`signup?redirect_to=${encodeURIComponent(back())}`, { body: { email, password: pass } });
      if (d.access_token) { adopt(d); return done(); }
      setMode('in', `Check ${email} for a confirmation link, then sign in.`, 'ok');
      $('#authEmail').value = email; $('#authPass').value = '';
      return;
    }
    if (mode === 'forgot') {
      await gotrue(`recover?redirect_to=${encodeURIComponent(back())}`, { body: { email } });
      return setMode('in', `If ${email} has an account, a reset link is on its way.`, 'ok');
    }
    if (mode === 'reset') {
      await gotrue('user', { method: 'PUT', body: { password: pass }, token: sess?.access_token });
      note('Password saved.', 'ok');
      return done();
    }
  } catch (err) {
    note(authError(err), 'err');
  } finally { go.disabled = false; }
}

function done() {
  $('#auth')?.remove();
  document.body.classList.remove('signed-out');
  paintAccount();
  if (readyResolve) { const r = readyResolve; readyResolve = null; r(); }
  dispatchEvent(new Event('rose-signed-in'));   // app.js asks /api/me again: it may be another account
}
function lost(msg) {
  if (!cfg.required) return;
  document.body.classList.add('signed-out');
  screen(); setMode('in', msg || '', msg ? 'err' : '');
}
/** Called by app.js when the server answers "sign in first". */
export function authLost(msg) { sess = null; save(); clearTimeout(timer); lost(msg); paintAccount(); }

export async function signOut() {
  const t = sess?.access_token;
  sess = null; save(); clearTimeout(timer);
  if (t) gotrue('logout', { token: t }).catch(() => {});
  location.hash = ''; location.reload();
}

// ---- account button (top bar): opens the Profile page (app.js #profile), which has Sign out ----
function paintAccount() {
  const bar = $('.topbar-right');
  let b = $('#acctBtn');
  if (!cfg.required || !sess || !bar) { b?.remove(); return; }
  if (!b) {
    b = document.createElement('a');
    b.id = 'acctBtn'; b.className = 'acct-btn'; b.href = '#profile';
    if (location.hash === '#profile') b.setAttribute('aria-current', 'page');
    bar.appendChild(b);
  }
  const email = sess.user.email || 'Signed in';
  b.textContent = email[0].toUpperCase();
  b.title = `Profile · ${email}`; b.setAttribute('aria-label', `Profile and Rose+: ${email}`);
}

// ---- start ----
function readRedirect() {
  // Email confirmation / password reset / social sign-in come back as #access_token=…  or #error=…
  const h = location.hash.startsWith('#') ? new URLSearchParams(location.hash.slice(1)) : null;
  const q = new URLSearchParams(location.search);
  const err = h?.get('error_description') || q.get('error_description');
  if (h?.get('access_token')) {
    adopt({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_at: h.get('expires_at'), expires_in: h.get('expires_in') });
    history.replaceState(null, '', location.pathname);
    return h.get('type') === 'recovery' ? 'reset' : 'in';
  }
  if (err) { history.replaceState(null, '', location.pathname); return { error: err.replace(/\+/g, ' ') }; }
  return null;
}

/** Resolves once the visitor may use Rose (signed in, or accounts not required). */
export async function initAuth() {
  try { cfg = await (await fetch('/api/auth-config', { cache: 'no-store' })).json(); } catch { cfg = { required: false }; }
  if (!cfg.required) return;
  document.body.classList.add('signed-out');
  if (!cfg.configured) { screen(); setMode('in', 'Accounts aren’t set up on this server yet. The owner needs to follow ACCOUNTSETUP.md.', 'err'); $('#authForm').hidden = true; return new Promise(() => {}); }
  addEventListener('storage', e => {   // signed in/out or renewed in another tab
    if (e.key !== LS) return;
    const s = load();
    if (!s) { if (sess) { sess = null; lost('You signed out in another tab.'); paintAccount(); } return; }
    sess = s; schedule(); paintAccount();
    if ($('#auth') && mode !== 'reset') done();
  });
  const r = readRedirect();
  if (!sess) sess = load();
  if (r === 'reset') { screen(); setMode('reset'); return new Promise(res => (readyResolve = res)); }
  if (sess) {
    if (sess.expires_at - now() < 60) await refresh().catch(() => {});
    if (sess) { done(); schedule(); return; }
  }
  screen(); setMode('in', r?.error || '', r?.error ? 'err' : '');
  return new Promise(res => (readyResolve = res));
}
