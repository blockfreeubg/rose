// Waiting line for when every rig is busy, with ads while you wait.
// The server answers POST /api/sessions with { queue: true } when it's full (or others are already
// waiting); the page then holds a ticket, polls its place, and takes the slot once it's first.
// Ads run in sandboxed iframes (public/ads/unit.html) without allow-same-origin: they can't touch
// this page, its storage (upload password) or the stream, and can only open new tabs.
// Rose+ members (server/plus.js) wait ahead of everyone else: the server marks their ticket
// priority: true, and they get a calm, ad-free card instead (no ad code is loaded for them at all).

const POLL_MS = 3000;
const AD = '/ads/unit.html';
const K = { lb: 'fb510fa83b3b4090ca4c0057c60fa0c7', ban: '771c384fe775fb2b9877f709cb6467aa',
  mob: '5d6b58958b083253b3f2c1937777c37c', sky: 'b03d8fcbc6977bfd8c4b3c92ad90853f', half: 'cfeb76f267af02c56291eda03391d671' };
const SIZE = { [K.lb]: [728, 90], [K.ban]: [468, 60], [K.mob]: [320, 50], [K.sky]: [160, 600], [K.half]: [160, 300] };

function frame(src, w, h, cls) {
  const f = document.createElement('iframe');
  f.className = `q-ad ${cls}`;
  f.src = src; f.width = w; f.height = h;
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  f.setAttribute('scrolling', 'no'); f.setAttribute('loading', 'eager');
  f.setAttribute('title', 'Advertisement'); f.setAttribute('aria-label', 'Advertisement');
  f.style.border = '0'; f.style.colorScheme = 'dark'; f.style.background = 'transparent';
  return f;
}
const unit = (k, cls) => frame(`${AD}?k=${k}`, ...SIZE[k], cls);

function showQueue(st) {
  const launch = document.getElementById('launch');
  let box = document.getElementById('lQueue');
  box?.remove();
  box = document.createElement('div');
  box.id = 'lQueue';
  box.innerHTML = `<div class="q-top"></div>
    <div class="q-card"><div class="q-label">All rigs are busy</div>
      <div class="q-pos"><span id="qPos">–</span><small>in line</small></div>
      <div class="q-sub" id="qSub">Hang tight. Your game starts automatically when a rig frees up.</div>
      <div class="q-prio" id="qPrio" hidden><span class="tag plus">Rose+ priority</span><span>You wait ahead of everyone without Rose+.</span></div></div>
    <div class="q-native"></div>
    <div class="q-side q-left"></div><div class="q-side q-right"></div>`;
  launch.appendChild(box);
  launch.classList.add('queued');
  paintPerks(box, st);
  return box;
}
/**
 * Ads, or for a Rose+ ticket the priority badge and a calm card. Called on every poll: a ticket
 * gains or loses priority when its account turns Rose+ on or off while waiting.
 */
function paintPerks(box, st) {
  const plus = !!st?.priority;
  if (box.dataset.plus === String(plus)) return;
  box.dataset.plus = String(plus);
  box.querySelector('#qPrio').hidden = !plus;
  for (const el of box.querySelectorAll('.q-top, .q-native, .q-side')) el.replaceChildren();
  if (plus) {
    box.querySelector('.q-native').innerHTML = `<div class="q-calm"><span class="q-calm-mark" aria-hidden="true"></span>
      <b>Rose+ · no ads</b><span>Sit back: your game starts on its own as soon as a rig frees up.</span></div>`;
    return;
  }
  const w = innerWidth, h = innerHeight;
  box.querySelector('.q-top').appendChild(w >= 760 ? unit(K.lb, 'lb') : w >= 490 ? unit(K.ban, 'ban') : unit(K.mob, 'mob'));
  if (w >= 1150) {
    box.querySelector('.q-left').appendChild(h >= 720 ? unit(K.sky, 'sky') : unit(K.half, 'half'));
    box.querySelector('.q-right').appendChild(unit(K.half, 'half'));
  }
  box.querySelector('.q-native').appendChild(frame(`${AD}?native=1`, Math.min(728, w - 32), 250, 'native'));
}
function hideQueue() {
  document.getElementById('lQueue')?.remove();
  document.getElementById('launch')?.classList.remove('queued');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Create a session, waiting in line if every rig is busy. Returns the session, or null if the
 * launch was cancelled (alive() went false) while waiting.
 */
export async function getSession(api, { alive, status, game }) {
  // `game` (library id) lets a hub with Rose nodes pick a host that can run it; older servers ignore it.
  const g = game ? { game } : {};
  try { return await api('/api/sessions', { method: 'POST', json: g }); }
  catch (e) { if (!e.data?.queue) throw e; }
  let st = await api('/api/queue', { method: 'POST' });
  let ticket = st.ticket;
  const box = showQueue(st);
  const leave = () => api(`/api/queue/${ticket}`, { method: 'DELETE' }).catch(() => {});
  addEventListener('pagehide', leave, { once: true });
  try {
    for (;;) {
      if (!alive()) { leave(); return null; }
      if (st.gone) { st = await api('/api/queue', { method: 'POST' }); ticket = st.ticket; }
      paintPerks(box, st);
      const pos = document.getElementById('qPos');
      if (pos) pos.textContent = `#${st.position}`;
      const sub = document.getElementById('qSub');
      if (sub) sub.textContent = st.position === 1 ? 'You’re next. Starting as soon as a rig frees up…'
        : `${st.position - 1} ${st.position === 2 ? 'person' : 'people'} ahead of you. Your game starts automatically.`;
      status?.(st.position === 1 ? 'You’re next in line' : `You’re #${st.position} in line`);
      if (st.ready) {
        try { const s = await api('/api/sessions', { method: 'POST', json: { ticket, ...g } }); return s; }
        catch (e) {
          if (e.data?.needPlus) leave();   // Rose+ was cancelled while waiting: this launch is over, free the head of the line
          if (!e.data?.queue) throw e;     // otherwise someone beat us to it: keep our place
        }
      }
      await sleep(POLL_MS);
      if (!alive()) { leave(); return null; }
      st = await api(`/api/queue/${ticket}`);
    }
  } finally {
    removeEventListener('pagehide', leave);
    hideQueue();
  }
}
