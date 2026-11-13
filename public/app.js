// Domus frontend: plain JS, no build step.
// Every piece of user or AI text goes through esc() before it reaches innerHTML.

const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 23 24 8l18 15" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 20v20h24V20" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/><path d="M20 40V30h8v10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/></svg>`;

// Line icons for the bottom navigation (kit icon style: 1.8px stroke, rounded caps).
const NAV_ICON = {
  discover: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/></svg>',
  matches: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
  me: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};

const S = {
  user: null,
  profile: null,
  phone: null,
  demoCode: null,
  members: [],
  filter: { q: '', gender: 'All' },
  matchTab: 'top',
  ledgerTab: 'all',
};

const PUBLIC = ['', 'welcome', 'login', 'otp', 'privacy'];
const CATEGORY_ICON = { Bills: '⚡', Groceries: '🛒', Subscriptions: '📺', Rent: '🏠', Other: '🧾' };

// ---------- Small helpers ----------

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: fine */ } }
function safeDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const rupeesK = (n) => (n >= 1000 ? '₹' + Math.round(n / 1000) + 'k' : rupees(n));
const dateShort = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const $ = (sel) => document.querySelector(sel);
const youName = () => S.profile?.name?.split(' ')[0] || 'You';

function sourceLabel(src) {
  if (!src) return '';
  if (src.startsWith('gemini')) return `✦ Powered by Gemini · ${esc(src)}`;
  if (src.includes('rate limit')) return `Daily AI limit reached, using rules · ${esc(src)}`;
  return 'Offline rules (AI unavailable right now)';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  // The session lives in an HttpOnly cookie that the browser sends automatically. Nothing is stored in JS.
  const headers = { 'content-type': 'application/json' };
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user && !path.startsWith('/auth/')) {
    signOutLocal();
    toast('Your session ended. Please sign in again.');
    go('login');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function signOutLocal() {
  S.user = null;
  S.profile = null;
  S.members = [];
}

async function loadMe() {
  const d = await api('/me');
  S.user = d.user;
  S.profile = d.profile;
}

// ---------- Router ----------

function parseRoute() {
  const [key = '', id = null] = location.hash.replace(/^#\/?/, '').split('/');
  return { key, id };
}

function go(path) {
  if (location.hash === '#/' + path) render();
  else location.hash = '#/' + path;
}

async function paint(active, html, after) {
  $('#app').innerHTML = active && S.user ? shell(active, html) : html;
  if (after) after();
  window.scrollTo(0, 0);
}

async function render() {
  clearInterval(otpTimer);
  const { key, id } = parseRoute();
  const PROTECTED = ['home', 'discover', 'matches', 'view', 'expenses', 'agreement', 'scam', 'me', 'preferences'];
  if (!S.user && PROTECTED.includes(key)) return go('login');
  if (!S.user && !PUBLIC.includes(key)) return paint('', notFound());
  if (S.user && ['', 'login', 'otp', 'welcome'].includes(key)) return go(S.profile ? 'home' : 'preferences');
  if (S.user && !S.profile && !['preferences', 'privacy'].includes(key)) return go('preferences');

  const screens = {
    '': landing, welcome: onboarding, login: loginScreen, otp: otpScreen, privacy: privacyScreen,
    preferences: preferencesScreen, home: homeScreen, discover: discoverScreen,
    matches: matchesScreen, view: () => viewScreen(id), expenses: expensesScreen,
    agreement: agreementScreen, scam: scamScreen, me: meScreen,
  };
  const fn = screens[key];
  if (!fn) return paint(S.user ? 'home' : '', notFound());
  try {
    await fn();
  } catch (e) {
    if (e.status === 401) return;
    paint(S.user ? 'home' : '', `<section class="card center"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" data-go="${S.user ? 'home' : ''}">Try again</button></section>`);
  }
}

window.addEventListener('hashchange', render);

// ---------- Shell (signed-in layout: sidebar on desktop, 4-button nav on mobile) ----------

function shell(active, content) {
  const side = [
    ['home', 'Home'], ['discover', 'Discover'], ['matches', 'Matches'], ['expenses', 'Expenses'],
    ['agreement', 'Agreement'], ['scam', 'Scam Check'], ['me', 'Profile'],
  ].map(([k, l]) => `<button class="side-item ${active === k ? 'on' : ''}" data-go="${k}">${l}</button>`).join('');
  const bottom = [
    ['discover', 'Discover'], ['matches', 'Matches'], ['home', 'Home'], ['me', 'Profile'],
  ].map(([k, l]) => `<button class="${active === k ? 'on' : ''}" data-go="${k}"><span class="ico">${NAV_ICON[k]}</span>${l}</button>`).join('');
  const verified = !!S.profile?.verified;
  return `<div class="shell">
    <aside class="sidebar"><div class="brand">${LOGO}<span>Domus</span></div><nav class="stack">${side}</nav>
      <div class="verify-pill ${verified ? 'ok' : ''}">${verified ? 'Verified User Level 2' : 'Unverified user'}</div></aside>
    <main class="main">${content}</main>
    <nav class="bottomnav" aria-label="Main">${bottom}</nav>
  </div>`;
}

// ---------- Public: splash, landing, onboarding ----------

function splash() {
  $('#app').innerHTML = `<div class="splash"><div>${LOGO}<h1>Domus</h1><p>Find. Share. Belong.</p><p class="small">Loading your home...</p></div><img class="splash-art" src="/assets/images/house-and-city-illustrations.png" alt=""></div>`;
}

function topbar() {
  return `<header class="topbar"><a class="brand" href="/">${LOGO}<span>Domus</span></a>
    <div class="row"><button class="btn ghost small-btn" data-go="login">Login</button>
    <button class="btn primary small-btn" data-go="welcome">Get Started</button></div></header>`;
}

function landing() {
  return paint('', `${topbar()}
  <section class="hero">
    <div>
      <div class="eyebrow">Verify. Match. Protect. Manage.</div>
      <h1>Find your perfect flatmate. <span class="serif-accent">Safely.</span></h1>
      <p class="muted">Domus helps you find a trusted flatmate and manage shared living, together.</p>
      <div class="row wrap" style="margin-top:20px">
        <button class="btn primary" data-action="demo">Try the live demo (no sign-up)</button>
        <button class="btn ghost" data-go="welcome">Start Your Journey →</button>
        <button class="btn ghost" data-action="learn">Learn More</button>
      </div>
      <p class="small muted" style="margin-top:14px">A better home, together.</p>
    </div>
    <img class="hero-photo" src="/site/assets/images/hero-living-room.jpg" alt="Warm modern shared living room">
  </section>
  <section id="features" class="hero" style="padding-top:0">
    <div class="features" style="grid-column:1/-1">
      <div class="feature"><b>Verified Profiles</b><span class="muted small">Phone OTP and ID check with a visible badge.</span></div>
      <div class="feature"><b>Smart Matching</b><span class="muted small">Preferences plus a Gemini-written match note.</span></div>
      <div class="feature"><b>Shared Expenses</b><span class="muted small">Split bills and track deposits in one place.</span></div>
      <div class="feature"><b>Roommate Agreement</b><span class="muted small">A clear draft to review before you move in.</span></div>
    </div>
  </section>
  <p class="footer-line">Built for a safer, happier shared home.</p>`);
}

const SLIDES = [
  { title: 'Find trusted flatmates', text: 'Verified profiles, genuine matches.', img: '/site/assets/images/hero-living-room.jpg' },
  { title: 'Your new home awaits', text: 'Discover verified flatmates, find your vibe and move in with confidence.', img: '/site/assets/images/about-living-space.jpg' },
];
let onbStep = 0;

function onboarding() {
  const s = SLIDES[onbStep];
  return paint('', `<section class="auth-wrap"><div class="auth-card">
    <img class="slide-art" src="${s.img}" alt="">

    <h1>${esc(s.title)}</h1>
    <p class="muted">${esc(s.text)}</p>
    <div class="dots">${SLIDES.map((_, i) => `<i class="${i === onbStep ? 'on' : ''}"></i>`).join('')}</div>
    <button class="btn primary block" data-action="onb-next">Next →</button>
  </div></section>`);
}

// ---------- Auth: phone, mock OTP ----------

function loginScreen() {
  return paint('', `<section class="auth-wrap"><div class="auth-card">
    <div class="logo-lg">${LOGO}<h2>Welcome back</h2><p class="tagline">Enter your mobile number</p></div>
    <form id="login-form">
      <div class="phone"><span class="cc">🇮🇳 +91</span><input id="phone" type="tel" inputmode="tel" placeholder="98765 43210" autocomplete="tel" required></div>
      <button class="btn primary block" type="submit">Send OTP</button>
    </form>
    <div class="or">or</div>
    <button class="btn primary block" data-action="demo">Try the demo instead</button>
    <button class="btn ghost block" data-action="social">Continue with Google</button>
    <button class="btn ghost block" data-action="social">Continue with Apple</button>
    <p class="legal">By continuing, you agree to our Terms &amp; Privacy Policy.</p>
  </div></section>`, () => $('#phone')?.focus());
}

let otpTimer = null;
function otpScreen() {
  if (!S.phone) return go('login');
  let left = 30;
  const demo = S.demoCode
    ? `<div class="demo-banner">Demo mode: no SMS is sent. Your code is <b>${esc(S.demoCode)}</b></div>`
    : '';
  return paint('', `<section class="auth-wrap"><div class="auth-card">
    <h2>Verify Your Phone</h2>
    <p class="muted">Enter the 6-digit code sent to ${esc(S.phoneMasked || '')}</p>
    ${demo}
    <div class="otp">${Array.from({ length: 6 }, (_, i) => `<input class="otp-box" inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i + 1}">`).join('')}</div>
    <p class="small muted" id="timer">Resend code in 00:${String(left).padStart(2, '0')}</p>
    <button class="btn ghost small-btn" id="resend" disabled data-action="resend">Resend code</button>
    <button class="btn primary block" style="margin-top:14px" data-action="verify-otp">Continue</button>
    <button class="btn ghost block" data-action="try-other">Try another option</button>
  </div></section>`, () => {
    const boxes = [...document.querySelectorAll('.otp-box')];
    boxes[0].focus();
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        if (box.value && boxes[i + 1]) boxes[i + 1].focus();
      });
      box.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !box.value && boxes[i - 1]) boxes[i - 1].focus(); });
      box.addEventListener('paste', (e) => {
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        e.preventDefault();
        digits.split('').forEach((d, j) => { if (boxes[j]) boxes[j].value = d; });
        boxes[Math.min(digits.length, 5)].focus();
      });
    });
    otpTimer = setInterval(() => {
      left -= 1;
      const t = $('#timer');
      if (!t) return clearInterval(otpTimer);
      if (left <= 0) {
        clearInterval(otpTimer);
        t.textContent = 'Did not get it?';
        $('#resend').disabled = false;
      } else {
        t.textContent = `Resend code in 00:${String(left).padStart(2, '0')}`;
      }
    }, 1000);
  });
}

// ---------- Preferences / profile form ----------

function chipGroup(name, options, current) {
  return `<div class="chips" data-group="${name}">${options.map(([v, l]) =>
    `<button type="button" class="chip ${String(current) === String(v) ? 'on' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
}
function readChips(name) {
  return document.querySelector(`.chips[data-group="${name}"] .chip.on`)?.dataset.v;
}

function preferencesScreen() {
  const p = S.profile || {
    name: S.user ? '' : '', age: '', gender: 'Female', looking_for: 'Any', occupation: 'Working Professional',
    lifestyle: 'Work + Chill', city: 'Bengaluru', locality: '', budget_min: 15000, budget_max: 25000,
    move_in: 'Flexible', deposit: '', sleep: 'flexible', cleanliness: 'tidy', cooking: 'no', smoking: 0,
    pets: 'ok', guests: 'sometimes', work_mode: 'hybrid', about: '',
  };
  return paint(S.profile ? 'me' : '', `<div class="page-head"><div><h1>Your Preferences</h1><p>Help us find your perfect match</p></div></div>
  <form id="prefs-form" class="card">
    <div class="two">
      <div>
        <div class="field"><span>Name</span><input id="f-name" type="text" value="${esc(p.name)}" maxlength="60" required></div>
        <div class="field"><span>Age</span><input id="f-age" type="number" min="18" max="70" value="${esc(p.age)}" required></div>
        <div class="field"><span>Gender</span>${chipGroup('gender', [['Male', 'Male'], ['Female', 'Female'], ['Other', 'Other']], p.gender)}</div>
        <div class="field"><span>Looking For</span>${chipGroup('looking_for', [['Male', 'Male'], ['Female', 'Female'], ['Any', 'Any']], p.looking_for)}</div>
        <div class="field"><span>Occupation</span><input id="f-occupation" type="text" value="${esc(p.occupation)}" maxlength="60"></div>
        <div class="field"><span>Lifestyle</span><select id="f-lifestyle">${['Work + Chill', 'Social & Active', 'Quiet & Focused', 'Fitness & Health'].map((o) => `<option ${o === p.lifestyle ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
      </div>
      <div>
        <div class="field"><span>Preferred City</span><select id="f-city"><option>Bengaluru</option></select></div>
        <div class="field"><span>Locality</span><input id="f-locality" type="text" value="${esc(p.locality)}" placeholder="e.g. Koramangala" maxlength="60"></div>
        <div class="field"><span>Budget Range <b id="budget-label">${rupeesK(p.budget_min)} – ${rupeesK(p.budget_max)}</b> / month</span>
          <input id="f-budget_min" type="range" min="5000" max="60000" step="1000" value="${p.budget_min}" aria-label="Minimum budget">
          <input id="f-budget_max" type="range" min="5000" max="60000" step="1000" value="${p.budget_max}" aria-label="Maximum budget"></div>
        <div class="field"><span>Move-in Date</span>${chipGroup('move_in', [['This Month', 'This Month'], ['Next Month', 'Next Month'], ['Flexible', 'Flexible']], p.move_in)}</div>
        <div class="field"><span>Security deposit (₹)</span><input id="f-deposit" type="number" min="0" value="${esc(p.deposit ?? '')}" placeholder="e.g. 24000"></div>
      </div>
    </div>
    <div class="field"><span>Sleep Schedule</span>${chipGroup('sleep', [['early', 'Early'], ['late', 'Late'], ['flexible', 'Flexible']], p.sleep)}</div>
    <div class="field"><span>Cleanliness</span>${chipGroup('cleanliness', [['tidy', 'Tidy'], ['relaxed', 'Relaxed']], p.cleanliness)}</div>
    <div class="field"><span>Cooking at Home</span>${chipGroup('cooking', [['yes', 'Yes'], ['no', 'No']], p.cooking)}</div>
    <div class="field"><span>Pets</span>${chipGroup('pets', [['ok', 'Pets OK'], ['no', 'No Pets'], ['have', 'Have a Pet']], p.pets)}</div>
    <div class="field"><span>Guests</span>${chipGroup('guests', [['rarely', 'Rarely'], ['sometimes', 'Sometimes'], ['often', 'Often']], p.guests)}</div>
    <div class="field"><span>Work Mode</span>${chipGroup('work_mode', [['office', 'Office'], ['hybrid', 'Hybrid'], ['remote', 'Remote']], p.work_mode)}</div>
    <div class="field"><label class="toggle"><input id="f-smoking" type="checkbox" ${p.smoking ? 'checked' : ''}> I smoke</label></div>
    <div class="field"><span>About Me</span><textarea id="f-about" maxlength="500" placeholder="Tell us about yourself">${esc(p.about)}</textarea>
      <span class="small muted">Gemini reads this to suggest filters and write your profile summary. Phone numbers, emails and UPI IDs are removed before it is sent.</span></div>
    <div class="notice"><b>Your privacy.</b> We store what you enter here. You choose what other people see below, and you can export or delete everything from Profile. <a href="#/privacy">Read the privacy notice</a></div>
    <div class="field"><span>Visibility</span>
      <label class="toggle"><input id="f-discoverable" type="checkbox" ${p.discoverable === false ? '' : 'checked'}> Show me in Discover</label>
      <label class="toggle"><input id="f-share_locality" type="checkbox" ${p.share_locality === false ? '' : 'checked'}> Show my area (locality)</label>
      <label class="toggle"><input id="f-share_budget" type="checkbox" ${p.share_budget === false ? '' : 'checked'}> Show my budget range</label>
    </div>
    <div class="field"><label class="toggle"><input id="f-consent" type="checkbox" ${S.profile?.privacy_consent_at ? 'checked disabled' : ''}> I agree that Domus stores this profile and uses Gemini to summarise my about text.</label></div>
    <button class="btn primary block" type="submit">Continue →</button>
    <div id="ai-result"></div>
  </form>`);
}

function collectProfile() {
  const v = (id) => $('#' + id).value;
  return {
    name: v('f-name'), age: v('f-age'), gender: readChips('gender'), looking_for: readChips('looking_for'),
    occupation: v('f-occupation'), lifestyle: v('f-lifestyle'), city: v('f-city'), locality: v('f-locality'),
    budget_min: v('f-budget_min'), budget_max: v('f-budget_max'), move_in: readChips('move_in'),
    deposit: v('f-deposit') || null, sleep: readChips('sleep'), cleanliness: readChips('cleanliness'),
    cooking: readChips('cooking'), pets: readChips('pets'), guests: readChips('guests'),
    work_mode: readChips('work_mode'), smoking: $('#f-smoking').checked, about: v('f-about'),
    discoverable: $('#f-discoverable').checked, share_locality: $('#f-share_locality').checked,
    share_budget: $('#f-share_budget').checked, consent: $('#f-consent').checked,
  };
}

function aiResultCard(profile, ai) {
  const inferred = Object.entries(ai?.inferred || {}).map(([k, val]) => `<span class="tag">${esc(k)}: ${esc(val)}</span>`).join('');
  return `<div class="card ai" style="margin:16px 0 0">
    <div class="eyebrow">AI summary</div>
    <p>${esc(profile.ai_summary || 'Your summary will appear here.')}</p>
    <div class="row wrap">${(profile.ai_tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${inferred ? `<p class="small muted" style="margin-top:12px">Filters we picked up from your about text:</p><div class="row wrap">${inferred}</div>` : ''}
    <div class="source">${sourceLabel(ai?.source || profile.ai_source)}</div>
    <button class="btn primary block" style="margin-top:14px" data-go="discover">Continue to Discover →</button>
  </div>`;
}

// ---------- Home dashboard ----------

async function homeScreen() {
  const h = await api('/home');
  // Live Gemini status (demo mode only). Shows which key and model answered, never the keys themselves.
  let ai = null;
  try { ai = await (await fetch('/api/ai-status')).json(); } catch { ai = null; }
  const aiBadgeHtml = !ai || ai.error ? '' : ai.live
    ? `<span class="badge">✦ Gemini live · ${esc(ai.served_by)}</span>`
    : `<span class="tag">Gemini not reachable (${ai.keys_configured ? 'check the keys in .dev.vars' : 'no keys set'}). Rule-based answers are shown instead.</span>`;
  const name = h.name || S.user?.phone || 'there';
  const feed = h.recent_activity.length
    ? h.recent_activity.map((a) => `<div><span>${esc(a.text)}</span><div class="small muted">${dateShort(a.at)}</div></div>`).join('')
    : '<div class="empty">No activity yet. Send a request or add an expense.</div>';
  return paint('home', `<div class="page-head"><div><h1>Hello, ${esc(name)}! 👋</h1><p>Here's what's happening with your home.</p></div></div>
  <div class="stats">
    <div class="stat"><span>Active Match</span><b>${h.active_matches}</b></div>
    <div class="stat"><span>This Month</span><b>${rupees(h.total_this_month)}</b></div>
    <div class="stat"><span>Deposit Tracker</span><b>${h.deposit ? rupees(h.deposit) : '—'}</b></div>
  </div>
  <section class="card ai"><div class="eyebrow">Judge's guide · about 3 minutes</div>
    <p>${aiBadgeHtml}</p>
    <p class="small muted">Everything here is live. Try each step, then come back.</p>
    <div class="chips">
      <button class="btn ghost small-btn" data-go="discover">1 · Discover: open a match, send a request</button>
      <button class="btn ghost small-btn" data-go="matches">2 · Matches: scores and recently viewed</button>
      <button class="btn ghost small-btn" data-go="expenses">3 · Expenses: add a bill, see who owes whom</button>
      <button class="btn ghost small-btn" data-go="agreement">4 · Agreement: create a draft</button>
      <button class="btn ghost small-btn" data-go="scam">5 · Scam Check: scan a suspicious message</button>
      <button class="btn ghost small-btn" data-go="me">6 · Privacy: export or delete your data</button>
    </div>
  </section>
  <div class="dash">
    <div class="card">
      <img class="home-pic" src="/site/assets/images/hero-living-room.jpg" alt="Shared living room">
      <div class="row between"><div><h3>Your Home</h3><p class="muted small">${esc(S.profile?.locality || '')}${S.profile?.locality ? ', ' : ''}${esc(S.profile?.city || '')}</p></div>
      <button class="btn ghost small-btn" data-go="expenses">View Details →</button></div>
    </div>
    <div class="card">
      <h3>Recent Activity</h3>
      <div class="list">${feed}</div>
    </div>
    <div class="card dark full">
      <div class="row between wrap"><div><h3>Your Home, Your Rules</h3><p class="muted">Generate a roommate agreement with a click.</p></div>
      <button class="btn primary" data-go="agreement">Create Agreement →</button></div>
    </div>
  </div>
  <p class="small muted center" style="margin-top:12px"><a href="#" data-go="scam">Check a listing</a></p>`);
}

// ---------- Discover and matches ----------

function profileCard(p) {
  return `<article class="card match" data-go="view/${esc(p.id)}" tabindex="0">
    <div class="row">
      <div class="avatar">${esc(p.initials)}</div>
      <div class="grow">
        <h3>${esc(p.name)}, ${esc(p.age)}</h3>
        <p class="muted small" style="margin:0">${esc(p.occupation)} · ${esc(p.gender)}</p>
        <p class="muted small" style="margin:0">📍 ${esc([p.locality, p.city].filter(Boolean).join(', '))}</p>
      </div>
      ${p.score != null ? `<div class="score"><b>${p.score}%</b><span>match</span></div>` : ''}
    </div>
    <div class="row wrap" style="margin-top:12px">${p.verified ? '<span class="badge">✓ Verified</span>' : ''}${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="row between" style="margin-top:12px">
      <span class="small muted">${p.budget_min == null ? 'Budget hidden' : rupeesK(p.budget_min) + ' – ' + rupeesK(p.budget_max) + ' / month'}</span>
      <span class="link">View Profile →</span>
    </div>
  </article>`;
}

// Fetches the list only, so typing in search does not re-render (and drop focus from) the input.
async function discoverList() {
  const qs = new URLSearchParams({ q: S.filter.q, gender: S.filter.gender });
  const d = await api('/discover?' + qs.toString());
  const notice = d.has_profile ? '' : '<div class="notice">Complete your preferences to see match scores. <a href="#/preferences">Set preferences</a></div>';
  const cards = d.profiles.length
    ? `<div class="grid-cards discover-grid">${d.profiles.map(profileCard).join('')}</div>`
    : '<div class="card empty">No flatmates match this search yet.</div>';
  return notice + cards;
}

async function discoverScreen() {
  const list = await discoverList();
  return paint('discover', `<div class="page-head"><div><h1>Discover</h1><p>Verified profiles, genuine matches.</p></div></div>
  <div class="discover-toolbar">
    <div class="search"><input id="q" type="search" placeholder="Search flatmates..." value="${esc(S.filter.q)}" aria-label="Search flatmates"></div>
    <div class="chips">
      ${['All', 'Male', 'Female'].map((g) => `<button class="chip ${S.filter.gender === g ? 'on' : ''}" data-filter="${g}">${g}</button>`).join('')}
    </div>
  </div>
  <div id="discover-list">${list}</div>`, () => {
    let t;
    $('#q').addEventListener('input', (e) => {
      S.filter.q = e.target.value;
      clearTimeout(t);
      t = setTimeout(async () => {
        try { $('#discover-list').innerHTML = await discoverList(); } catch (err) { toast(err.message); }
      }, 350);
    });
  });
}

async function matchesScreen() {
  const d = await api('/discover?gender=All');
  const recent = JSON.parse(safeGet('domus_recent') || '[]');
  const top = d.profiles.filter((p) => p.score != null).slice(0, 6);
  const list = S.matchTab === 'top'
    ? (top.length ? top.map(profileCard).join('') : '<div class="card empty">Complete your preferences to see your top picks.</div>')
    : (recent.length ? recent.map(profileCard).join('') : '<div class="card empty">Profiles you open will show here.</div>');
  return paint('matches', `<div class="page-head"><div><h1>Your Matches</h1><p>Your best fits and recently viewed profiles.</p></div></div>
  <div class="tabs"><button class="${S.matchTab === 'top' ? 'on' : ''}" data-action="tab" data-scope="match" data-tab="top">Top Picks</button>
  <button class="${S.matchTab === 'recent' ? 'on' : ''}" data-action="tab" data-scope="match" data-tab="recent">Recently Viewed</button></div>
  <div class="grid-cards">${list}</div>`);
}

async function viewScreen(id) {
  const d = await api('/profiles/' + encodeURIComponent(id));
  const p = d.profile;
  const recent = JSON.parse(safeGet('domus_recent') || '[]').filter((r) => r.id !== p.id);
  recent.unshift({ ...p, score: d.score, tags: [], verified: p.verified });
  safeSet('domus_recent', JSON.stringify(recent.slice(0, 6)));

  return paint('discover', `<div class="row" style="margin:8px 0 16px"><button class="btn ghost small-btn" data-go="discover">← Back</button></div>
  <section class="card">
    <div class="row wrap">
      <div class="avatar lg">${esc(p.initials)}</div>
      <div class="grow">
        <h1 style="font-size:28px">${esc(p.name)}, ${esc(p.age)}</h1>
        <p class="muted" style="margin:0">${esc(p.occupation)} · ${esc(p.gender)}</p>
        <p class="muted" style="margin:0">📍 ${esc([p.locality, p.city].filter(Boolean).join(', '))}</p>
        <div class="row wrap" style="margin-top:10px">${p.verified ? '<span class="badge">✓ Verified</span>' : ''}<span class="tag">${p.budget_min == null ? 'Budget hidden' : rupeesK(p.budget_min) + ' – ' + rupeesK(p.budget_max) + ' / month'}</span><span class="tag">Move-in: ${esc(p.move_in)}</span></div>
      </div>
      ${d.score != null ? `<div class="score"><b style="font-size:28px">${d.score}%</b><span>match</span></div>` : ''}
    </div>
  </section>
  <section class="card"><div class="eyebrow">About Me</div><p>“${esc(p.about || 'No bio yet.')}”</p></section>
  <section class="card ai"><div class="eyebrow">Why you might match</div>
    <p>${esc(d.note || 'Complete your preferences to get a match note.')}</p>
    ${d.note_source ? `<div class="source">${sourceLabel(d.note_source)}</div>` : ''}
  </section>
  ${p.ai_summary ? `<section class="card"><div class="eyebrow">Profile summary</div><p>${esc(p.ai_summary)}</p></section>` : ''}
  <div class="row wrap">
    <button class="btn primary" data-action="request" data-id="${esc(p.id)}">Send Request</button>
    <button class="btn ghost" data-go="scam">Check a Listing</button>
  </div>`);
}

// ---------- Expenses ledger ----------

async function expensesScreen() {
  const d = await api('/expenses');
  S.members = d.members.map((m) => m.name);
  const me = youName();
  const shown = d.expenses.filter((e) => S.ledgerTab === 'all' || (S.ledgerTab === 'you' ? e.paid_by === me : e.paid_by !== me));
  const max = Math.max(1, ...Object.values(d.by_category));
  const bars = Object.keys(d.by_category).length
    ? Object.entries(d.by_category).map(([cat, amt]) => `<div class="bar-row"><span>${CATEGORY_ICON[cat] || '🧾'} ${esc(cat)}</span><div class="bar" style="width:${Math.round((amt / max) * 100)}%"></div><span class="small">${rupees(amt)}</span></div>`).join('')
    : '<div class="empty">No spending yet.</div>';
  const list = shown.length
    ? shown.map((e) => `<div class="row"><div class="avatar" style="width:44px;height:44px;font-size:18px">${CATEGORY_ICON[e.category] || '🧾'}</div>
        <div class="grow"><b>${esc(e.title)}</b><div class="small muted">${esc(e.paid_by)} paid · ${dateShort(e.created_at)}</div></div><b>${rupees(e.amount)}</b></div>`).join('')
    : `<div class="empty">${d.expenses.length ? 'Nothing in this view.' : 'No expenses yet. Add the first one, or load a sample ledger.'}</div>`;
  const balances = d.balances.map((b) => `<div class="row between"><span>${esc(b.name)}</span>
    <span class="${b.net >= 0 ? 'money-pos' : 'money-neg'}">${b.net >= 0 ? 'is owed ' : 'owes '}${rupees(Math.abs(b.net))}</span></div>`).join('') || '<div class="empty">Add members to see who owes whom.</div>';
  const members = d.members.map((m) => `<span class="tag">${esc(m.name)}</span>`).join(' ');

  return paint('expenses', `<div class="page-head"><div><h1>Expenses</h1><p>Shared bills for your home.</p></div>
    <button class="btn primary small-btn no-print" data-action="add-expense">+ Add Expense</button></div>
  <div class="dash">
    <div class="card dark">
      <div class="small muted">Total Spent</div>
      <div class="verdict" style="color:var(--bone)">${rupees(d.total_this_month)}</div>
      <div class="small muted" style="margin-bottom:14px">This Month</div>
      <div class="bar-wrap">${bars}</div>
    </div>
    <div class="card">
      <h3>Who owes whom</h3>
      <div class="list" style="margin-top:8px">${balances}</div>
      <p class="small muted" style="margin-top:10px">Costs are split equally across members.</p>
    </div>
    <div class="card full">
      <div class="tabs">${[['all', 'All'], ['you', 'You'], ['others', 'Others']].map(([k, l]) =>
        `<button class="${S.ledgerTab === k ? 'on' : ''}" data-action="tab" data-scope="ledger" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="list">${list}</div>
      ${d.members.length === 0 ? '<button class="btn ghost small-btn" style="margin-top:12px" data-action="sample">Load sample ledger</button>' : ''}
    </div>
    <div class="card full">
      <h3>Members</h3>
      <div class="row wrap" style="margin:8px 0 12px">${members || '<span class="muted small">No members yet.</span>'}</div>
      <form id="member-form" class="row wrap">
        <input type="text" id="member-name" placeholder="Add a flatmate's name" maxlength="40" style="max-width:280px">
        <button class="btn ghost small-btn" type="submit">Add member</button>
      </form>
    </div>
  </div>`);
}

function openExpenseModal() {
  const options = S.members.length ? S.members : [youName()];
  const el = document.createElement('div');
  el.className = 'overlay';
  el.id = 'expense-overlay';
  el.innerHTML = `<form class="modal" id="expense-form">
    <h2>Add Expense</h2>
    <div class="field"><span>Title</span><input id="e-title" type="text" maxlength="60" placeholder="e.g. Electricity Bill" required></div>
    <div class="field"><span>Amount (₹)</span><input id="e-amount" type="number" min="1" step="1" required></div>
    <div class="field"><span>Paid by</span><select id="e-paid">${options.map((n) => `<option>${esc(n)}</option>`).join('')}</select></div>
    <div class="field"><span>Category</span><select id="e-cat">${Object.keys(CATEGORY_ICON).map((c) => `<option>${c}</option>`).join('')}</select></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost small-btn" data-action="close-modal">Cancel</button>
    <button class="btn primary small-btn" type="submit">Save</button></div>
  </form>`;
  document.body.appendChild(el);
  $('#e-title').focus();
}

// ---------- Agreement (draft) ----------

async function agreementScreen() {
  const d = await api('/agreement');
  const a = d.agreement;
  const deposit = S.profile?.deposit ?? '';
  const clauses = a ? a.clauses.map((c) => `<div class="clause"><h3>${esc(c.heading)}</h3><p>${esc(c.text)}</p></div>`).join('') : '';
  return paint('agreement', `<div class="page-head"><div><h1>Roommate Agreement</h1><p>A fair and clear agreement for peaceful co-living.</p></div></div>
  <div class="notice">Draft only. Not legal advice. Have a lawyer review it before anyone signs.</div>
  <div class="two">
    <form class="card" id="agreement-form">
      <h3>Terms</h3>
      <div class="field"><span>Monthly rent (₹)</span><input id="a-rent" type="number" min="1" value="18000" required></div>
      <div class="field"><span>Security deposit (₹)</span><input id="a-deposit" type="number" min="0" value="${esc(deposit)}"></div>
      <div class="field"><span>Notice period (days)</span><input id="a-notice" type="number" min="15" max="90" value="30"></div>
      <div class="checklist">
        <div><span class="check">✓</span> Rent &amp; Deposit Terms</div>
        <div><span class="check">✓</span> House Rules</div>
        <div><span class="check">✓</span> Notice Period</div>
        <div><span class="check">✓</span> Guest Policy</div>
      </div>
      <div class="row wrap no-print">
        <button class="btn primary" type="submit">${a ? 'Regenerate with AI' : 'Create Agreement'}</button>
        ${a ? '<button type="button" class="btn soft" data-action="print">Download PDF</button>' : ''}
      </div>
      ${a ? `<div class="source">${sourceLabel(a.source)}</div>` : ''}
    </form>
    <div class="card">
      ${a ? `<h2>${esc(a.title)}</h2>${clauses}` : '<div class="empty">Your draft will appear here. Enter the terms and create the agreement.</div>'}
    </div>
  </div>`);
}

// ---------- Scam checker ----------

function scamScreen() {
  return paint('scam', `<div class="page-head"><div><h1>Check a Listing</h1><p>Paste the listing or message to scan for scams.</p></div></div>
  <form class="card" id="scam-form">
    <div class="field"><textarea id="scam-text" placeholder="Urgent! Pay 50% now to book..." maxlength="3000" required></textarea></div>
    <div class="row wrap"><button class="btn ghost small-btn" type="button" data-action="sample-scam">Use a sample scam message</button>
    <button class="btn primary" type="submit">Scan Now</button></div>
  </form>
  <div id="scam-result"></div>`);
}

function scamResultCard(r) {
  const reasons = r.reasons.length
    ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '<p class="muted">No suspicious activity found.</p>';
  return `<section class="card center result-${esc(r.risk)}">
    <div class="verdict ${esc(r.risk)}">${esc(r.label)}</div>
    ${reasons}
    <p>${esc(r.advice)}</p>
    <div class="source">${sourceLabel(r.source)}</div>
  </section>`;
}

// ---------- Profile (me) ----------

function meScreen() {
  const p = S.profile;
  if (!p) return go('preferences');
  return paint('me', `<div class="page-head"><div><h1>Profile</h1><p>How flatmates see you.</p></div></div>
  <section class="card">
    <div class="row wrap">
      <div class="avatar lg">${esc(p.initials)}</div>
      <div class="grow"><h2>${esc(p.name)}, ${esc(p.age)}</h2>
        <p class="muted" style="margin:0">${esc(p.occupation)} · ${esc(p.gender)}</p>
        <p class="muted" style="margin:0">📍 ${esc([p.locality, p.city].filter(Boolean).join(', '))}</p>
        <div class="row wrap" style="margin-top:8px">${p.verified ? '<span class="badge">✓ ID verified (demo)</span>' : '<span class="tag">Not verified yet</span>'}</div>
      </div>
    </div>
  </section>
  <section class="card ai"><div class="eyebrow">AI summary</div><p>${esc(p.ai_summary || 'Save your preferences to generate a summary.')}</p>
    <div class="row wrap">${(p.ai_tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="source">${sourceLabel(p.ai_source)}</div></section>
  <div class="two">
    <section class="card"><h3>Verification</h3>
      <p class="muted small">Mock verification for the demo. No ID document is checked.</p>
      ${p.verified ? '<p class="money-pos">✓ Verified</p>' : '<button class="btn primary small-btn" data-action="verify">Verify ID (demo)</button>'}
    </section>
    <section class="card"><h3>Account</h3>
      <div class="row wrap"><button class="btn ghost small-btn" data-go="preferences">Edit Preferences</button>
      <button class="btn ghost small-btn" data-action="logout">Sign out</button></div>
    </section>
  </div>
  <section class="card"><div class="eyebrow">Your privacy</div>
    <p class="muted small">Download a copy of everything Domus holds about you, or delete your account and that data.</p>
    <div class="row wrap"><button class="btn ghost small-btn" data-action="export">Download my data</button>
    <button class="btn ghost small-btn" data-action="delete-account" style="color:var(--danger)">Delete my account</button></div>
    <p class="small muted" style="margin-top:10px"><a href="#/privacy">How we handle your data</a></p>
  </section>`);
}

function privacyScreen() {
  const body = `<div class="page-head"><div><h1>Privacy</h1><p>What Domus stores, why, and how you control it.</p></div></div>
  <section class="card"><div class="eyebrow">What we store</div>
    <ul class="small" style="padding-left:18px">
      <li>Your phone number, only as a secure hash, plus the last 4 digits for display.</li>
      <li>Your profile: name, age, occupation, habits and budget. You choose whether your area and budget are shown to others, or hide your profile from Discover.</li>
      <li>Your ledger, agreement draft and the requests you send.</li>
    </ul></section>
  <section class="card ai"><div class="eyebrow">Gemini (AI)</div>
    <p>We send only what a task needs: your lifestyle answers and your about text, with phone numbers, emails, UPI IDs and ID numbers removed. We do not send your name, phone number or exact area. Scam-check text is not stored by Domus.</p>
    <p class="small muted">Google's terms for the Gemini key in use apply to what is sent.</p>
    <p><a href="/privacy.html">Read the full privacy policy</a></p></section>
  <section class="card"><div class="eyebrow">Your rights</div>
    <p>Download your data or delete your account from Profile at any time. Deleting removes your profile, ledger, agreement, requests and sessions.</p></section>
  <section class="card"><div class="eyebrow">Demo notice</div>
    <p>This is a hackathon demo. Sign-in codes are shown on screen, ID verification is mocked, and no real personal data should be entered.</p></section>`;
  return paint(S.user ? 'me' : '', S.user ? body : `${topbar()}<div class="main" style="max-width:720px">${body}</div>`);
}

function notFound() {
  return `${topbar()}<section class="auth-wrap"><div class="auth-card">
    <img class="slide-art" src="/site/assets/images/hero-living-room.jpg" alt="">
    <h1>Oops! Page not found</h1>
    <p class="muted">The home you're looking for might have moved.</p>
    <button class="btn primary block" data-go="${S.user ? 'home' : ''}">Go Home →</button>
  </div></section>`;
}

// ---------- Actions and form handlers (event delegation) ----------

const ACTIONS = {
  'onb-next'() {
    if (onbStep < SLIDES.length - 1) { onbStep += 1; onboarding(); } else { onbStep = 0; go('login'); }
  },
  learn() { $('#features')?.scrollIntoView({ behavior: 'smooth' }); },
  async demo() {
    try {
      toast('Setting up your demo home...');
      await api('/demo/login', { method: 'POST', body: {} });
      await loadMe();
      toast('Welcome to Domus. Start with the judge guide below.');
      go('home');
    } catch (e) { toast(e.message); }
  },
  'sample-scam'() {
    const t = $('#scam-text');
    if (t) t.value = 'URGENT! Flat in Koramangala at half rent. Pay 50% advance via UPI now. I only talk on WhatsApp, no visit needed.';
  },
  social() { toast('Not available in this demo. Use your mobile number.'); },
  async resend() {
    try {
      const d = await api('/auth/send-otp', { method: 'POST', body: { phone: S.phone } });
      S.demoCode = d.demo_code || null;
      toast('A new code is on its way.');
      otpScreen();
    } catch (e) { toast(e.message); }
  },
  'try-other'() { go('login'); },
  async 'verify-otp'() {
    const code = [...document.querySelectorAll('.otp-box')].map((b) => b.value).join('');
    if (code.length !== 6) return toast('Enter the 6-digit code.');
    try {
      const d = await api('/auth/verify-otp', { method: 'POST', body: { phone: S.phone, code } });
      await loadMe();
      toast('Signed in.');
      go(S.profile ? 'home' : 'preferences');
    } catch (e) { toast(e.message); }
  },
  request(el) {
    api('/requests', { method: 'POST', body: { to_profile: el.dataset.id } })
      .then((d) => toast(d.message))
      .catch((e) => toast(e.message));
  },
  tab(el) {
    if (el.dataset.scope === 'match') S.matchTab = el.dataset.tab;
    else S.ledgerTab = el.dataset.tab;
    render();
  },
  'add-expense': () => openExpenseModal(),
  'close-modal'() { $('#expense-overlay')?.remove(); },
  async sample() {
    try {
      await api('/expenses/sample', { method: 'POST' });
      toast('Sample ledger loaded.');
      render();
    } catch (e) { toast(e.message); }
  },
  print() { window.print(); },
  async verify() {
    try {
      const d = await api('/verify-id', { method: 'POST' });
      await loadMe();
      toast(d.note);
      render();
    } catch (e) { toast(e.message); }
  },
  async export() {
    try {
      const data = await api('/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'domus-my-data.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Your data was downloaded.');
    } catch (e) { toast(e.message); }
  },
  'delete-account'() {
    const typed = window.prompt('This permanently deletes your profile, ledger, agreement and requests. Type DELETE to confirm.');
    if (typed !== 'DELETE') return toast('Account not deleted.');
    api('/account', { method: 'DELETE', body: { confirm: 'DELETE' } })
      .then((d) => { signOutLocal(); toast(d.message); go(''); })
      .catch((e) => toast(e.message));
  },
  logout() {
    api('/auth/logout', { method: 'POST' }).catch(() => {}).finally(() => {
      signOutLocal();
      toast('Signed out.');
      go('');
    });
  },
};

const FORMS = {
  async 'login-form'(form) {
    const phone = $('#phone').value;
    try {
      const d = await api('/auth/send-otp', { method: 'POST', body: { phone } });
      S.phone = phone;
      S.phoneMasked = d.phone_masked;
      S.demoCode = d.demo_code || null;
      toast(d.demo_code ? 'Demo code shown on screen.' : 'Code sent.');
      go('otp');
    } catch (e) { toast(e.message); }
  },
  async 'prefs-form'() {
    const body = collectProfile();
    if (!body.name.trim()) return toast('Please add your name.');
    if (!body.age || Number(body.age) < 18) return toast('Please add a valid age (18 or older).');
    if (!body.consent && !S.profile?.privacy_consent_at) return toast('Please agree to the privacy notice first.');
    try {
      const d = await api('/profile', { method: 'PUT', body });
      S.profile = d.profile;
      $('#ai-result').innerHTML = aiResultCard(d.profile, d.ai);
      toast('Profile saved.');
    } catch (e) { toast(e.message); }
  },
  async 'expense-form'() {
    const body = { title: $('#e-title').value, amount: $('#e-amount').value, paid_by: $('#e-paid').value, category: $('#e-cat').value };
    try {
      const d = await api('/expenses', { method: 'POST', body });
      $('#expense-overlay')?.remove();
      toast(d.message);
      render();
    } catch (e) { toast(e.message); }
  },
  async 'member-form'() {
    const name = $('#member-name').value.trim();
    if (!name) return toast('Enter a name.');
    try {
      await api('/members', { method: 'POST', body: { name } });
      toast(`${name} added.`);
      render();
    } catch (e) { toast(e.message); }
  },
  async 'agreement-form'() {
    try {
      toast('Drafting with AI...');
      const d = await api('/agreement', {
        method: 'POST',
        body: { rent: $('#a-rent').value, deposit: $('#a-deposit').value, notice_days: $('#a-notice').value },
      });
      toast('Draft ready. Review it before signing.');
      render();
      return d;
    } catch (e) { toast(e.message); }
  },
  async 'scam-form'() {
    const text = $('#scam-text').value;
    try {
      const r = await api('/scam-check', { method: 'POST', body: { text } });
      $('#scam-result').innerHTML = scamResultCard(r);
    } catch (e) { toast(e.message); }
  },
};

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chips .chip');
  if (chip && chip.parentElement.dataset.group && !chip.dataset.filter) {
    const group = chip.parentElement;
    group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    return;
  }
  const filter = e.target.closest('[data-filter]');
  if (filter) {
    S.filter.gender = filter.dataset.filter;
    return render();
  }
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    e.preventDefault();
    return go(goEl.dataset.go);
  }
  const actionEl = e.target.closest('[data-action]');
  if (actionEl && ACTIONS[actionEl.dataset.action]) {
    e.preventDefault();
    ACTIONS[actionEl.dataset.action](actionEl, e);
  }
});

document.addEventListener('submit', (e) => {
  const handler = FORMS[e.target.id];
  if (!handler) return;
  e.preventDefault();
  if (e.target.id === 'agreement-form') { handler(e.target); return; }
  handler(e.target);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'f-budget_min' || e.target.id === 'f-budget_max') {
    const lo = Number($('#f-budget_min').value);
    const hi = Number($('#f-budget_max').value);
    $('#budget-label').textContent = `${rupeesK(Math.min(lo, hi))} – ${rupeesK(Math.max(lo, hi))}`;
  }
});

// ---------- Boot ----------

async function boot() {
  splash();
  if (S.token) {
    try { await loadMe(); } catch { signOutLocal(); }
  }
  setTimeout(render, 900);
}

boot();
