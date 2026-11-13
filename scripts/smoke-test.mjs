// Smoke test for the Domus API. Run with the dev server up:  node scripts/smoke-test.mjs
// Uses demo mode (OTP is returned in the response). Takes about 40 seconds because of the resend cooldown.

import { redactPII } from '../src/worker.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

// token is sent the way a browser would send it: as the HttpOnly session cookie.
async function call(method, path, { body, token, headers: extra = {} } = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (token) headers.cookie = 'domus_session=' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(phone) {
  const sent = await call('POST', '/api/auth/send-otp', { body: { phone } });
  if (sent.status !== 200) throw new Error('send-otp failed: ' + JSON.stringify(sent));
  const ok = await call('POST', '/api/auth/verify-otp', { body: { phone, code: sent.data.demo_code } });
  if (ok.status !== 200) throw new Error('verify-otp failed: ' + JSON.stringify(ok));
  const setCookie = ok.headers.get('set-cookie') || '';
  const token = /domus_session=([^;]+)/.exec(setCookie)?.[1];
  return { token, setCookie, user: ok.data.user, code: sent.data.demo_code };
}

// ---------- Authentication ----------
// Fresh random numbers each run, so earlier runs do not leave data behind for this one.
const randomPhone = () => '9' + String(Math.floor(100000000 + Math.random() * 899999999));
const A = randomPhone();
const sent1 = await call('POST', '/api/auth/send-otp', { body: { phone: A } });
check('send-otp returns a demo code', sent1.status === 200 && /^\d{6}$/.test(sent1.data.demo_code || ''));
const again = await call('POST', '/api/auth/send-otp', { body: { phone: A } });
check('resend within 30s is blocked (cooldown)', again.status === 429);

let wrongOk = true;
for (let i = 0; i < 5; i++) {
  const r = await call('POST', '/api/auth/verify-otp', { body: { phone: A, code: '000000' } });
  if (r.status !== 401) wrongOk = false;
}
check('five wrong codes are rejected with 401', wrongOk);
const locked = await call('POST', '/api/auth/verify-otp', { body: { phone: A, code: sent1.data.demo_code } });
check('correct code is refused after five wrong guesses (lockout)', locked.status === 429);

console.log('      waiting 31s for the resend cooldown...');
await sleep(31000);
const userA = await signIn(A);
check('sign-in with a fresh code returns a session token', !!userA.token, `role=${userA.user?.role}`);

const noAuth = await call('GET', '/api/me');
check('protected route without token returns 401', noAuth.status === 401);
const bogus = await call('GET', '/api/me', { token: 'not-a-real-token' });
check('protected route with a fake token returns 401', bogus.status === 401);

const meA = await call('GET', '/api/me', { token: userA.token });
check('GET /api/me works for a signed-in user', meA.status === 200 && meA.data.user.id === userA.user.id);
check('phone is shown masked, never in full', meA.data.user.phone_masked === '+91******' + A.slice(-4) && !JSON.stringify(meA.data).includes(A));

// ---------- Profile, matching, AI fallback ----------
const profile = await call('PUT', '/api/profile', {
  token: userA.token,
  body: {
    name: 'Test Anand', age: 26, gender: 'Male', looking_for: 'Any', occupation: 'Software Engineer',
    lifestyle: 'Work + Chill', city: 'Bengaluru', locality: 'Koramangala', budget_min: 15000, budget_max: 25000,
    move_in: 'This Month', sleep: 'early', cleanliness: 'tidy', cooking: 'yes', smoking: false, pets: 'ok',
    guests: 'rarely', work_mode: 'hybrid', deposit: 24000,
    about: 'I cook on weekends, I am an early riser, and I have a cat.',
    consent: true,
  },
});
check('PUT /api/profile saves and returns an AI summary source', profile.status === 200 && !!profile.data.ai?.source, `source=${profile.data.ai?.source}`);
check('AI filters are picked from about-text (rule fallback or Gemini)', profile.status === 200);

const discover = await call('GET', '/api/discover', { token: userA.token });
check('discover returns seed profiles with scores', discover.status === 200 && discover.data.profiles.length >= 5 && discover.data.profiles.every((p) => typeof p.score === 'number'));
check('gender preference hides profiles that do not want this user (Meera wants women only)', !discover.data.profiles.some((p) => p.id === 'seed-meera'));
check('discover excludes the signed-in user', discover.data.profiles.every((p) => p.id !== userA.user.id));

const riya = discover.data.profiles.find((p) => p.id === 'seed-riya');
const view = await call('GET', '/api/profiles/seed-riya', { token: userA.token });
check('profile view returns a match note with a source', view.status === 200 && typeof view.data.note === 'string' && !!view.data.note_source, `source=${view.data.note_source}`);
check('profile view has a numeric score', typeof view.data.score === 'number');

const selfReq = await call('POST', '/api/requests', { token: userA.token, body: { to_profile: userA.user.id } });
check('cannot send a request to your own profile', selfReq.status === 400);
const req = await call('POST', '/api/requests', { token: userA.token, body: { to_profile: 'seed-riya' } });
check('send request to a seed profile works', req.status === 200);

// ---------- Rate limit (Gemini quota per user) ----------
let sawLimit = false;
let lastSource = '';
for (let i = 0; i < 6; i++) {
  const r = await call('POST', '/api/scam-check', { token: userA.token, body: { text: 'Urgent! Pay 50% advance via UPI only, WhatsApp only.' } });
  lastSource = r.data.source;
  if (String(r.data.source || '').includes('rate limit')) sawLimit = true;
}
check('per-minute Gemini limit kicks in for one user (6 quick calls)', sawLimit, `last source="${lastSource}"`);

// ---------- Scam checker ----------
const scam = await call('POST', '/api/scam-check', { token: userA.token, body: { text: 'Urgent! Pay 50% advance via UPI only, WhatsApp only.' } });
check('scam checker flags a risky listing', scam.status === 200 && ['medium', 'high'].includes(scam.data.risk), `risk=${scam.data.risk}`);
const shortText = await call('POST', '/api/scam-check', { token: userA.token, body: { text: 'hi' } });
check('scam checker rejects very short input', shortText.status === 400);

// ---------- Ledger ----------
const emptyLedger = await call('GET', '/api/expenses', { token: userA.token });
check('ledger starts empty for a new user', emptyLedger.status === 200 && emptyLedger.data.expenses.length === 0);
const sample = await call('POST', '/api/expenses/sample', { token: userA.token });
check('load sample ledger', sample.status === 200 && sample.data.loaded === true);
const afterSample = await call('GET', '/api/expenses', { token: userA.token });
check('sample ledger has expenses and balances', afterSample.data.expenses.length === 5 && afterSample.data.balances.length === 3);
const bad = await call('POST', '/api/expenses', { token: userA.token, body: { title: 'x', amount: 100, paid_by: 'Nobody' } });
check('expense with a non-member payer is rejected', bad.status === 400);
const good = await call('POST', '/api/expenses', { token: userA.token, body: { title: 'Milk', amount: 120, paid_by: afterSample.data.members[0].name, category: 'Groceries' } });
check('valid expense is added', good.status === 200);

// ---------- Agreement (draft) ----------
const agreement = await call('POST', '/api/agreement', { token: userA.token, body: { rent: 18000, deposit: 24000, notice_days: 30 } });
check('agreement draft is generated', agreement.status === 200 && agreement.data.agreement.clauses.length > 0);
const agrGet = await call('GET', '/api/agreement', { token: userA.token });
check('agreement can be read back', agrGet.status === 200 && agrGet.data.agreement?.clauses?.length > 0);

// ---------- Authorization between users ----------
const B = randomPhone();
const userB = await signIn(B);
const noConsent = await call('PUT', '/api/profile', { token: userB.token, body: { name: 'No Consent', age: 25, about: '' } });
check('profile cannot be saved without privacy consent', noConsent.status === 400);
const bLedger = await call('GET', '/api/expenses', { token: userB.token });
check('user B cannot see user A ledger', bLedger.status === 200 && bLedger.data.expenses.length === 0);
const bAgr = await call('GET', '/api/agreement', { token: userB.token });
check('user B cannot see user A agreement', bAgr.status === 200 && bAgr.data.agreement === null);
const adminAttempt = await call('GET', '/api/admin/usage', { token: userA.token });
check('non-admin is refused the admin usage endpoint', adminAttempt.status === 403);

// ---------- Privacy ----------
const sc = userA.setCookie;
check('session cookie is HttpOnly, Secure and SameSite=Strict', /HttpOnly/i.test(sc) && /;\s*Secure/i.test(sc) && /SameSite=Strict/i.test(sc));
const viaHeader = await call('GET', '/api/me', { headers: { authorization: 'Bearer ' + userA.token } });
check('Authorization header is ignored (cookie only)', viaHeader.status === 401);
const evil = await call('POST', '/api/requests', { token: userA.token, headers: { origin: 'https://evil.example' }, body: { to_profile: 'seed-riya' } });
check('cross-site write is refused by the Origin check', evil.status === 403);
const textPlain = await call('POST', '/api/requests', { token: userA.token, headers: { 'content-type': 'text/plain' }, body: { to_profile: 'seed-riya' } });
check('write without a JSON content type is refused', textPlain.status === 415);
check('security headers are present', !!meA.headers.get('content-security-policy') && meA.headers.get('x-content-type-options') === 'nosniff' && meA.headers.get('referrer-policy') === 'no-referrer');

const red = redactPII('Call 98765 43210 or mail ravi@example.com, UPI ravi.k@okaxis, Aadhaar 1234 5678 9012, PAN ABCDE1234F, see https://x.example/a');
check('redactPII removes phone, email, UPI, ID numbers and links', !/98765|example\.com|okaxis|1234 5678|ABCDE1234F|https?:/.test(red), `"${red}"`);

const C = randomPhone();
const userC = await signIn(C);
const cBody = {
  name: 'Private Person', age: 30, gender: 'Female', looking_for: 'Any', city: 'Bengaluru', locality: 'Indiranagar',
  budget_min: 20000, budget_max: 30000, about: 'Call me on 98765 43210 or mail me at me@example.com',
  consent: true, share_locality: false, share_budget: false,
};
const pC = await call('PUT', '/api/profile', { token: userC.token, body: cBody });
check('profile saves with consent', pC.status === 200);
const aDisc = await call('GET', '/api/discover', { token: userA.token });
const cCard = aDisc.data.profiles.find((p) => p.id === userC.user.id);
check('hidden budget and area are removed for other users', !!cCard && cCard.budget_min === null && cCard.budget_max === null && cCard.locality === '');
const cView = await call('GET', '/api/profiles/' + userC.user.id, { token: userA.token });
check('phone and email are redacted from About Me shown to others', cView.status === 200 && !/98765|example\.com/.test(cView.data.profile.about) && cView.data.profile.about.includes('[phone]'));

await call('PUT', '/api/profile', { token: userC.token, body: { ...cBody, discoverable: false } });
const aDisc2 = await call('GET', '/api/discover', { token: userA.token });
check('hidden profile is absent from other users\' Discover', !aDisc2.data.profiles.some((p) => p.id === userC.user.id));
const hiddenView = await call('GET', '/api/profiles/' + userC.user.id, { token: userA.token });
check('hidden profile returns 404 when opened by id', hiddenView.status === 404);

const exp = await call('GET', '/api/account/export', { token: userC.token });
const expText = JSON.stringify(exp.data);
check('export has own data, no hashes, no raw phone', exp.status === 200 && !!exp.data.profile && !/token_hash|phone_hash/.test(expText) && !expText.includes(C));
const badDel = await call('DELETE', '/api/account', { token: userA.token, body: { confirm: 'yes' } });
check('account deletion needs the DELETE confirmation', badDel.status === 400);
const del = await call('DELETE', '/api/account', { token: userC.token, body: { confirm: 'DELETE' } });
check('account deletion succeeds', del.status === 200);
const afterDel = await call('GET', '/api/me', { token: userC.token });
check('deleted account can no longer use its session', afterDel.status === 401);

// ---------- Judge demo ----------
const demo = await call('POST', '/api/demo/login', { body: {} });
const demoToken = /domus_session=([^;]+)/.exec(demo.headers.get('set-cookie') || '')?.[1];
check('one-click demo login works and sets a session cookie', demo.status === 200 && !!demoToken);
const demoMe = await call('GET', '/api/me', { token: demoToken });
check('demo account comes with a filled, consented profile', demoMe.status === 200 && demoMe.data.profile?.name === 'Aarav Demo' && !!demoMe.data.profile?.privacy_consent_at);
const demoLedger = await call('GET', '/api/expenses', { token: demoToken });
check('demo account comes with a sample ledger', demoLedger.status === 200 && demoLedger.data.expenses.length === 5);
const demoDisc = await call('GET', '/api/discover', { token: demoToken });
check('demo account sees matches', demoDisc.status === 200 && demoDisc.data.profiles.length >= 5);
const status = await call('GET', '/api/ai-status');
check('AI status endpoint reports the live state and each key/model check', status.status === 200 && typeof status.data.live === 'boolean' && Array.isArray(status.data.checks) && !JSON.stringify(status.data).includes('fake-key'));
check('AI fallback says why Gemini was not used', /rule-based fallback|gemini:/.test(profile.data.ai?.source || ''), `source=${profile.data.ai?.source}`);
const demo2 = await call('POST', '/api/demo/login', { body: {} });
const demo2Token = /domus_session=([^;]+)/.exec(demo2.headers.get('set-cookie') || '')?.[1];
const demo2Ledger = await call('GET', '/api/expenses', { token: demo2Token });
check('each demo click is a separate account (own data)', demo2Token !== demoToken && demo2Ledger.data.expenses.length === 5);

// ---------- Logout ----------
const out = await call('POST', '/api/auth/logout', { token: userA.token });
check('logout succeeds', out.status === 200);
const afterOut = await call('GET', '/api/me', { token: userA.token });
check('token stops working after logout', afterOut.status === 401);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
