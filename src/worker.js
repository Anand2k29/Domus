// Domus MVP: Cloudflare Worker serving the JSON API. Static UI comes from ./public via Workers Static Assets.
// Storage: Cloudflare D1 (binding DB). AI: Gemini with a key x model waterfall, then rule-based fallbacks.

const DEFAULT_MODELS = 'gemini-2.5-flash,gemini-2.5-flash-lite';
const cooldowns = new Map(); // "keyIndex:model" -> timestamp until which we skip it (per isolate, best effort)
let seeded = false;

const SEEDS = [
  { id: 'seed-riya', name: 'Riya Sharma', age: 24, gender: 'Female', looking_for: 'Any', occupation: 'Working Professional', lifestyle: 'Work + Chill', city: 'Bengaluru', locality: 'Koramangala', budget_min: 15000, budget_max: 25000, move_in: 'This Month', sleep: 'early', cleanliness: 'tidy', cooking: 'yes', smoking: 0, pets: 'ok', guests: 'sometimes', work_mode: 'hybrid', about: 'Love good food, clean spaces and great conversations!' },
  { id: 'seed-sneha', name: 'Sneha Iyer', age: 24, gender: 'Female', looking_for: 'Any', occupation: 'Product Designer', lifestyle: 'Quiet & Focused', city: 'Bengaluru', locality: 'Koramangala', budget_min: 12000, budget_max: 20000, move_in: 'Flexible', sleep: 'flexible', cleanliness: 'tidy', cooking: 'no', smoking: 0, pets: 'ok', guests: 'rarely', work_mode: 'remote', about: 'Quiet weekdays, lively weekends. I work from home and like a clean kitchen.' },
  { id: 'seed-rohan', name: 'Rohan Mehta', age: 22, gender: 'Male', looking_for: 'Any', occupation: 'Software Engineer', lifestyle: 'Social & Active', city: 'Bengaluru', locality: 'Indiranagar', budget_min: 12000, budget_max: 18000, move_in: 'This Month', sleep: 'late', cleanliness: 'relaxed', cooking: 'yes', smoking: 0, pets: 'no', guests: 'often', work_mode: 'office', about: 'Night owl who cooks on weekends and plays badminton on Sundays.' },
  { id: 'seed-arjun', name: 'Arjun Nair', age: 27, gender: 'Male', looking_for: 'Any', occupation: 'Data Analyst', lifestyle: 'Fitness & Health', city: 'Bengaluru', locality: 'HSR Layout', budget_min: 15000, budget_max: 22000, move_in: 'Next Month', sleep: 'early', cleanliness: 'tidy', cooking: 'no', smoking: 0, pets: 'no', guests: 'rarely', work_mode: 'hybrid', about: 'Early gym, quiet evenings, and a strict no-smoking flat.' },
  { id: 'seed-meera', name: 'Meera Kapoor', age: 25, gender: 'Female', looking_for: 'Female', occupation: 'Primary School Teacher', lifestyle: 'Work + Chill', city: 'Bengaluru', locality: 'Whitefield', budget_min: 10000, budget_max: 16000, move_in: 'This Month', sleep: 'early', cleanliness: 'tidy', cooking: 'yes', smoking: 0, pets: 'have', guests: 'sometimes', work_mode: 'office', about: 'I have a cat named Mango and I am happy to cook for the flat on Sundays.' },
  { id: 'seed-karthik', name: 'Karthik Rao', age: 29, gender: 'Male', looking_for: 'Any', occupation: 'Product Manager', lifestyle: 'Social & Active', city: 'Bengaluru', locality: 'Indiranagar', budget_min: 20000, budget_max: 30000, move_in: 'Flexible', sleep: 'flexible', cleanliness: 'relaxed', cooking: 'yes', smoking: 1, pets: 'no', guests: 'sometimes', work_mode: 'remote', about: 'Work hard, travel often, and keep the common areas shared and fair.' },
];

const CATEGORIES = ['Bills', 'Groceries', 'Subscriptions', 'Rent', 'Other'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const now = () => Date.now();
const uid = () => crypto.randomUUID();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    if (url.pathname.startsWith('/api/')) {
      try {
        response = await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) {
          response = json({ error: err.message }, err.status);
        } else {
          // Log only the error type, never the request body or cookies.
          console.error('unhandled', err && err.name);
          response = json({ error: 'Something went wrong. Please try again.' }, 500);
        }
      }
    } else {
      response = await env.ASSETS.fetch(request);
    }
    return withSecurityHeaders(response);
  },
};

// ---------- Routing ----------

async function handleApi(request, env, url) {
  const { pathname } = url;
  const m = request.method;
  await ensureSeed(env);
  // CSRF defence: writes must be JSON and must come from this origin. The SameSite=Strict cookie is the first line.
  if (m !== 'GET') {
    if (!originOk(request, url)) throw new HttpError(403, 'Request blocked.');
    if (!(request.headers.get('content-type') || '').includes('application/json')) {
      throw new HttpError(415, 'Requests must be JSON.');
    }
  }

  // Public routes
  if (m === 'POST' && pathname === '/api/auth/send-otp') return sendOtp(request, env);
  if (m === 'POST' && pathname === '/api/auth/verify-otp') return verifyOtp(request, env);
  if (m === 'POST' && pathname === '/api/demo/login') return demoLogin(env);
  if (m === 'GET' && pathname === '/api/ai-status') return aiStatus(env);

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please sign in to continue.');

  if (m === 'POST' && pathname === '/api/auth/logout') {
    const token = sessionToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return withCookie(json({ ok: true }), clearedCookie);
  }
  if (m === 'GET' && pathname === '/api/me') return getMe(env, user);
  if (m === 'PUT' && pathname === '/api/profile') return saveProfile(request, env, user);
  if (m === 'POST' && pathname === '/api/verify-id') return verifyId(env, user);
  if (m === 'GET' && pathname === '/api/discover') return discover(url, env, user);
  if (m === 'GET' && pathname === '/api/home') return home(env, user);
  if (m === 'GET' && pathname === '/api/admin/usage') return adminUsage(env, user);
  if (m === 'POST' && pathname === '/api/requests') return sendRequest(request, env, user);
  if (m === 'POST' && pathname === '/api/scam-check') return scamCheck(request, env, user);

  const profileMatch = pathname.match(/^\/api\/profiles\/([\w-]+)$/);
  if (m === 'GET' && profileMatch) return getProfile(profileMatch[1], env, user);

  if (m === 'GET' && pathname === '/api/expenses') return getExpenses(env, user);
  if (m === 'POST' && pathname === '/api/expenses') return addExpense(request, env, user);
  if (m === 'POST' && pathname === '/api/expenses/sample') return loadSample(env, user);
  if (m === 'POST' && pathname === '/api/members') return addMember(request, env, user);
  if (m === 'GET' && pathname === '/api/account/export') return exportAccount(env, user);
  if (m === 'DELETE' && pathname === '/api/account') return deleteAccount(request, env, user);

  if (m === 'GET' && pathname === '/api/agreement') return getAgreement(env, user);
  if (m === 'POST' && pathname === '/api/agreement') return createAgreement(request, env, user);

  throw new HttpError(404, 'Not found');
}

// The session token lives only in an HttpOnly cookie. Authorization headers are ignored on purpose.
async function currentUser(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  // Only the hash is stored, so a database leak does not expose live sessions. Expired sessions count as signed out.
  return env.DB.prepare(
    'SELECT u.id, u.phone_last4, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(await sha256Hex(token), now()).first();
}

// ---------- Seed data ----------

async function ensureSeed(env) {
  if (seeded) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM profiles WHERE is_seed = 1').first();
  if (!row || row.n < SEEDS.length) {
    await env.DB.batch(
      SEEDS.map((s) => {
        const { sql, values } = insertSql('profiles', { ...s, verified: 1, is_seed: 1, updated_at: now() }, true);
        return env.DB.prepare(sql).bind(...values);
      })
    );
  }
  seeded = true;
}

// ---------- Auth (mock OTP: no SMS is sent) ----------

// Accepts "9876543210", "+91 98765 43210" or "919876543210" and returns "+919876543210" or null.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? '+91' + digits : null;
}

async function sendOtp(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  const ph = await phoneHash(env, phone);
  await env.DB.prepare('DELETE FROM otps WHERE expires_at < ?').bind(now()).run();
  // Resend cooldown: one code per phone every 30 seconds.
  const existing = await env.DB.prepare('SELECT created_at FROM otps WHERE phone_hash = ?').bind(ph).first();
  if (existing && now() - existing.created_at < 30000) {
    throw new HttpError(429, 'Please wait 30 seconds before requesting another code.');
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.DB.prepare(
    'INSERT INTO otps (phone_hash, code, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(phone_hash) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
  ).bind(ph, code, now() + 5 * 60 * 1000, now()).run();
  // Demo mode shows the code on screen because no SMS provider is connected.
  const demo = env.DEMO_MODE !== 'false';
  return json({ ok: true, phone_masked: maskPhone(phone.slice(-4)), demo_code: demo ? code : undefined });
}

async function verifyOtp(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  const code = String(body.code || '').trim();
  const ph = await phoneHash(env, phone);
  const row = await env.DB.prepare('SELECT code, expires_at, attempts FROM otps WHERE phone_hash = ?').bind(ph).first();
  if (!row || row.expires_at < now()) {
    throw new HttpError(401, 'That code has expired. Request a new one.');
  }
  // Brute-force protection: five wrong guesses locks the code until a new one is requested.
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
  if (row.code !== code) {
    await env.DB.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone_hash = ?').bind(ph).run();
    throw new HttpError(401, 'That code is incorrect.');
  }
  await env.DB.prepare('DELETE FROM otps WHERE phone_hash = ?').bind(ph).run();

  const admins = await Promise.all(adminPhones(env).map((p) => phoneHash(env, p)));
  const role = admins.includes(ph) ? 'admin' : 'user';
  const last4 = phone.slice(-4);
  let user = await env.DB.prepare('SELECT id FROM users WHERE phone_hash = ?').bind(ph).first();
  if (!user) {
    user = { id: uid() };
    await env.DB.prepare('INSERT INTO users (id, phone_hash, phone_last4, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, ph, last4, role, now()).run();
  } else {
    await env.DB.prepare('UPDATE users SET role = ?, phone_last4 = ? WHERE id = ?').bind(role, last4, user.id).run();
  }
  // 256 bits of randomness; only its SHA-256 hash is stored.
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), user.id, now(), now() + SESSION_DAYS * 86400000).run();
  return withCookie(json({ user: { id: user.id, phone_masked: maskPhone(last4), role } }), sessionCookie(token));
}

// ---------- Demo (judges): one click, no phone number ----------
// Only active when DEMO_MODE is "true". Each click creates a separate demo account with its own data and quota.
async function demoLogin(env) {
  if (env.DEMO_MODE !== 'true') throw new HttpError(404, 'Not found');
  const userId = uid();
  const last4 = String(1000 + Math.floor(Math.random() * 9000));
  // No phone number is involved: the hash input is random, so this account cannot be signed into by phone.
  const ph = await sha256Hex('demo:' + userId);
  await env.DB.prepare('INSERT INTO users (id, phone_hash, phone_last4, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, ph, last4, 'user', now()).run();
  const profile = {
    id: userId, user_id: userId, name: 'Aarav Demo', age: 26, gender: 'Male', looking_for: 'Any',
    occupation: 'Software Engineer', lifestyle: 'Work + Chill', city: 'Bengaluru', locality: 'Koramangala',
    budget_min: 15000, budget_max: 25000, move_in: 'This Month', deposit: 24000, sleep: 'early',
    cleanliness: 'tidy', cooking: 'yes', smoking: 0, pets: 'ok', guests: 'rarely', work_mode: 'hybrid',
    about: 'I cook on weekends, I am an early riser, and I have a cat.',
    discoverable: 1, share_locality: 1, share_budget: 1,
    privacy_consent_at: now(), privacy_version: 'v1',
    ai_summary: 'Aarav is a software engineer working hybrid, looking for a tidy flat in Koramangala. An early riser who cooks at weekends.',
    ai_tags: JSON.stringify(['Early Riser', 'Cooks Weekends', 'Pet Friendly']),
    ai_filters: '{}', ai_source: 'demo seed', updated_at: now(),
  };
  const { sql, values } = insertSql('profiles', profile);
  await env.DB.prepare(sql).bind(...values).run();
  await loadSample(env, { id: userId }); // sample members and expenses, so the ledger is not empty
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now(), now() + SESSION_DAYS * 86400000).run();
  return withCookie(json({ user: { id: userId, phone_masked: maskPhone(last4), role: 'user' }, demo: true }), sessionCookie(token));
}

// ---------- Profile ----------

async function getMe(env, user) {
  const row = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(user.id).first();
  return json({
    user: { id: user.id, phone_masked: maskPhone(user.phone_last4), role: user.role },
    profile: row ? formatProfile(row) : null,
  });
}

function cleanProfile(b) {
  const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
  const num = (v, min, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

  const p = {
    name: str(b.name, 60),
    age: num(b.age, 18, 70),
    gender: pick(b.gender, ['Male', 'Female', 'Other'], 'Other'),
    looking_for: pick(b.looking_for, ['Male', 'Female', 'Any'], 'Any'),
    occupation: str(b.occupation, 60) || 'Working Professional',
    lifestyle: str(b.lifestyle, 40) || 'Work + Chill',
    city: str(b.city, 40) || 'Bengaluru',
    locality: str(b.locality, 60),
    budget_min: num(b.budget_min, 1000, 500000) ?? 15000,
    budget_max: num(b.budget_max, 1000, 500000) ?? 25000,
    move_in: pick(b.move_in, ['This Month', 'Next Month', 'Flexible'], 'Flexible'),
    deposit: num(b.deposit, 0, 5000000),
    sleep: pick(b.sleep, ['early', 'late', 'flexible'], 'flexible'),
    cleanliness: pick(b.cleanliness, ['tidy', 'relaxed'], 'tidy'),
    cooking: pick(b.cooking, ['yes', 'no'], 'no'),
    smoking: b.smoking ? 1 : 0,
    pets: pick(b.pets, ['ok', 'no', 'have'], 'ok'),
    guests: pick(b.guests, ['rarely', 'sometimes', 'often'], 'sometimes'),
    work_mode: pick(b.work_mode, ['office', 'hybrid', 'remote'], 'hybrid'),
    about: str(b.about, 500),
    // Visibility choices. Stored as 0/1 and enforced on the server in summaryOf() and getProfile().
    discoverable: b.discoverable === false ? 0 : 1,
    share_locality: b.share_locality === false ? 0 : 1,
    share_budget: b.share_budget === false ? 0 : 1,
  };
  if (!p.name) throw new HttpError(400, 'Please add your name.');
  if (!p.age) throw new HttpError(400, 'Please add a valid age (18 or older).');
  if (p.budget_max < p.budget_min) [p.budget_min, p.budget_max] = [p.budget_max, p.budget_min];
  return p;
}

async function saveProfile(request, env, user) {
  const body = await readJson(request);
  const p = cleanProfile(body);
  // Consent is required the first time a profile is saved. It is kept with a timestamp.
  const existingProfile = await env.DB.prepare('SELECT privacy_consent_at FROM profiles WHERE id = ?').bind(user.id).first();
  if (!existingProfile?.privacy_consent_at && body.consent !== true) {
    throw new HttpError(400, 'Please agree to the privacy notice to save your profile.');
  }
  const ai = await aiTask(env, user.id, profilePrompt(p), () => profileFallback(p), (d) => d && typeof d.summary === 'string');
  const inferred = sanitizeInferred(ai.data.inferred);

  const row = {
    id: user.id,
    user_id: user.id,
    ...p,
    ai_summary: String(ai.data.summary || '').slice(0, 300),
    ai_tags: JSON.stringify(Array.isArray(ai.data.tags) ? ai.data.tags.slice(0, 4).map(String) : []),
    ai_filters: JSON.stringify(inferred),
    ai_source: ai.source,
    privacy_consent_at: existingProfile?.privacy_consent_at || now(),
    privacy_version: 'v1',
    updated_at: now(),
  };
  const { sql, values } = upsertSql('profiles', row, 'id');
  await env.DB.prepare(sql).bind(...values).run();
  // Scores and notes depend on the profile, so drop cached notes written by this user.
  await env.DB.prepare('DELETE FROM match_notes WHERE viewer_id = ?').bind(user.id).run();

  const saved = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(user.id).first();
  return json({ profile: formatProfile(saved), ai: { source: ai.source, inferred } });
}

async function verifyId(env, user) {
  const row = await env.DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(user.id).first();
  if (!row) throw new HttpError(400, 'Complete your profile before verifying your ID.');
  await env.DB.prepare('UPDATE profiles SET verified = 1 WHERE id = ?').bind(user.id).run();
  return json({ ok: true, verified: true, note: 'Mock verification for the demo. No ID document is checked.' });
}

// ---------- Matching ----------

async function myProfile(env, userId) {
  const row = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(userId).first();
  return row ? formatProfile(row) : null;
}

async function discover(url, env, user) {
  const me = await myProfile(env, user.id);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const gender = url.searchParams.get('gender') || 'All';

  const rows = (await env.DB.prepare('SELECT * FROM profiles WHERE id != ?').bind(user.id).all()).results;
  const list = rows
    .map(formatProfile)
    .filter((c) => c.discoverable)
    .filter((c) => !me || genderOk(me, c))
    .filter((c) => gender === 'All' || c.gender === gender)
    .filter((c) => !q || `${c.name} ${c.locality} ${c.occupation}`.toLowerCase().includes(q))
    .map((c) => ({ ...summaryOf(c), score: me ? scoreMatch(me, c) : null }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return json({ profiles: list, has_profile: !!me });
}

async function getProfile(id, env, user) {
  const row = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first();
  // Hidden profiles look the same as missing ones, so they cannot be found by id either.
  if (!row || id === user.id || !row.discoverable) throw new HttpError(404, 'That profile is not available.');
  const target = formatProfile(row);
  const me = await myProfile(env, user.id);

  let score = null;
  let note = null;
  let noteSource = null;
  if (me) {
    score = scoreMatch(me, target);
    const cached = await env.DB.prepare('SELECT note, source FROM match_notes WHERE viewer_id = ? AND target_id = ?')
      .bind(user.id, id).first();
    if (cached) {
      note = cached.note;
      noteSource = cached.source;
    } else {
      const ai = await aiTask(env, user.id, matchPrompt(me, target, score), () => matchFallback(me, target, score),
        (d) => d && typeof d.note === 'string');
      note = ai.data.note;
      noteSource = ai.source;
      await env.DB.prepare(
        'INSERT OR REPLACE INTO match_notes (viewer_id, target_id, note, source) VALUES (?, ?, ?, ?)'
      ).bind(user.id, id, note, noteSource).run();
    }
  }

  return json({
    profile: { ...summaryOf(target), about: redactPII(target.about), ai_summary: target.ai_summary, ai_tags: target.ai_tags },
    score,
    note,
    note_source: noteSource,
  });
}

async function sendRequest(request, env, user) {
  const body = await readJson(request);
  const to = String(body.to_profile || '');
  if (to === user.id) throw new HttpError(400, 'You cannot send a request to your own profile.');
  const row = await env.DB.prepare('SELECT id FROM profiles WHERE id = ? AND discoverable = 1').bind(to).first();
  if (!row) throw new HttpError(404, 'That profile is not available.');
  await env.DB.prepare(
    'INSERT OR IGNORE INTO requests (id, from_user, to_profile, created_at) VALUES (?, ?, ?, ?)'
  ).bind(uid(), user.id, to, now()).run();
  return json({ ok: true, message: "Request Sent! You'll hear back soon." });
}

async function home(env, user) {
  const me = await myProfile(env, user.id);
  const ledger = await ledgerData(env, user.id);
  const reqs = await env.DB.prepare(
    'SELECT r.created_at, p.name FROM requests r JOIN profiles p ON p.id = r.to_profile WHERE r.from_user = ? ORDER BY r.created_at DESC LIMIT 5'
  ).bind(user.id).all();

  let activeMatches = 0;
  if (me) {
    const rows = (await env.DB.prepare('SELECT * FROM profiles WHERE id != ?').bind(user.id).all()).results;
    activeMatches = rows.map(formatProfile).filter((c) => c.discoverable && genderOk(me, c) && scoreMatch(me, c) >= 80).length;
  }
  const agreement = await env.DB.prepare('SELECT updated_at FROM agreements WHERE user_id = ?').bind(user.id).first();

  const activity = [
    ...ledger.expenses.slice(0, 4).map((e) => ({ text: `${e.paid_by} paid ${rupees(e.amount)} for ${e.title}`, at: e.created_at })),
    ...reqs.results.map((r) => ({ text: `Request sent to ${r.name}`, at: r.created_at })),
    ...(agreement ? [{ text: 'Agreement draft updated', at: agreement.updated_at }] : []),
  ].sort((a, b) => b.at - a.at).slice(0, 5);

  return json({
    name: me?.name || null,
    has_profile: !!me,
    verified: !!me?.verified,
    active_matches: activeMatches,
    total_this_month: ledger.total_this_month,
    deposit: me?.deposit ?? null,
    recent_activity: activity,
  });
}

// ---------- Scam check ----------

async function scamCheck(request, env, user) {
  const body = await readJson(request);
  // Scam-check text is redacted before it reaches Gemini and is not stored.
  const text = redactPII(String(body.text || '').trim().slice(0, 3000));
  if (text.length < 10) throw new HttpError(400, 'Paste a listing or message with at least a sentence.');
  const ai = await aiTask(env, user.id, scamPrompt(text), () => scamFallback(text),
    (d) => d && ['low', 'medium', 'high'].includes(d.risk) && Array.isArray(d.reasons));
  const risk = ai.data.risk;
  const label = { low: 'Looks Safe!', medium: 'Be Careful', high: 'Likely Scam' }[risk];
  return json({
    risk,
    label,
    reasons: ai.data.reasons.slice(0, 4).map(String),
    advice: String(ai.data.advice || ''),
    source: ai.source,
  });
}

// ---------- Ledger ----------

async function ledgerData(env, userId) {
  const members = (await env.DB.prepare('SELECT id, name FROM members WHERE user_id = ? ORDER BY created_at').bind(userId).all()).results;
  const expenses = (await env.DB.prepare(
    'SELECT id, title, amount, paid_by, category, created_at FROM expenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(userId).all()).results;

  const balances = computeBalances(members.map((m) => m.name), expenses);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const total_this_month = expenses
    .filter((e) => e.created_at >= monthStart.getTime())
    .reduce((s, e) => s + e.amount, 0);
  const by_category = {};
  for (const e of expenses) by_category[e.category] = (by_category[e.category] || 0) + e.amount;
  return { members, expenses, balances, total_this_month, by_category };
}

function computeBalances(names, expenses) {
  const n = names.length || 1;
  const net = Object.fromEntries(names.map((name) => [name, 0]));
  for (const e of expenses) {
    if (!(e.paid_by in net)) continue;
    const share = e.amount / n;
    net[e.paid_by] += e.amount - share;
    for (const name of names) if (name !== e.paid_by) net[name] -= share;
  }
  return names.map((name) => ({ name, net: Math.round(net[name]) }));
}

async function getExpenses(env, user) {
  return json(await ledgerData(env, user.id));
}

async function addExpense(request, env, user) {
  const b = await readJson(request);
  const title = String(b.title || '').trim().slice(0, 60);
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const category = CATEGORIES.includes(b.category) ? b.category : 'Other';
  if (!title) throw new HttpError(400, 'Add a short title for the expense.');
  if (!(amount > 0) || amount > 10000000) throw new HttpError(400, 'Enter an amount greater than 0.');
  const members = (await env.DB.prepare('SELECT name FROM members WHERE user_id = ?').bind(user.id).all()).results.map((m) => m.name);
  if (!members.includes(b.paid_by)) throw new HttpError(400, 'Choose who paid from your members list.');
  await env.DB.prepare(
    'INSERT INTO expenses (id, user_id, title, amount, paid_by, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(uid(), user.id, title, amount, b.paid_by, category, now()).run();
  return json({ ok: true, message: 'Expense added successfully!' });
}

async function addMember(request, env, user) {
  const name = String((await readJson(request)).name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Enter a name.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = ?').bind(user.id).first();
  if (count.n >= 8) throw new HttpError(400, 'A home can have up to 8 members in this demo.');
  await env.DB.prepare('INSERT INTO members (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').bind(uid(), user.id, name, now()).run();
  return json({ ok: true });
}

async function loadSample(env, user) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = ?').bind(user.id).first();
  if (existing.n > 0) return json({ ok: true, loaded: false });
  const me = await myProfile(env, user.id);
  const youName = me?.name?.split(' ')[0] || 'You';
  const names = [youName, 'Riya', 'Sneha'];
  const t = now();
  const samples = [
    ['Electricity Bill', 1200, youName, 'Bills'],
    ['Groceries', 850, 'Riya', 'Groceries'],
    ['Netflix', 499, 'Sneha', 'Subscriptions'],
    ['Internet', 1000, youName, 'Bills'],
    ['Gas Cylinder', 690, 'Riya', 'Bills'],
  ];
  const stmts = [
    ...names.map((name, i) => env.DB.prepare('INSERT INTO members (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').bind(uid(), user.id, name, t + i)),
    ...samples.map(([title, amount, paid, cat], i) =>
      env.DB.prepare('INSERT INTO expenses (id, user_id, title, amount, paid_by, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid(), user.id, title, amount, paid, cat, t - (samples.length - i) * 3600000)),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true, loaded: true });
}

// ---------- Roommate agreement (draft) ----------

async function getAgreement(env, user) {
  const row = await env.DB.prepare('SELECT title, clauses, source, updated_at FROM agreements WHERE user_id = ?').bind(user.id).first();
  if (!row) return json({ agreement: null });
  return json({ agreement: { title: row.title, clauses: safeJSON(row.clauses, []), source: row.source, updated_at: row.updated_at } });
}

async function createAgreement(request, env, user) {
  const b = await readJson(request);
  const me = await myProfile(env, user.id);
  const rent = Math.round(Number(b.rent)) || 0;
  const deposit = Math.round(Number(b.deposit)) || me?.deposit || 0;
  const notice = Math.min(90, Math.max(15, Math.round(Number(b.notice_days)) || 30));
  if (rent <= 0) throw new HttpError(400, 'Enter the monthly rent.');
  const members = (await env.DB.prepare('SELECT name FROM members WHERE user_id = ? ORDER BY created_at').bind(user.id).all()).results.map((m) => m.name);
  const facts = { city: me?.city || 'Bengaluru', locality: me?.locality || '', members: members.length ? members : ['Flatmate 1', 'Flatmate 2'], rent, deposit, notice_days: notice };

  const ai = await aiTask(env, user.id, agreementPrompt(facts), () => agreementFallback(facts),
    (d) => d && Array.isArray(d.clauses) && d.clauses.length > 0);
  const title = String(ai.data.title || 'Roommate Agreement (Draft)').slice(0, 120);
  const clauses = ai.data.clauses.slice(0, 10).map((c) => ({ heading: String(c.heading || '').slice(0, 80), text: String(c.text || '').slice(0, 800) }));

  await env.DB.prepare(
    'INSERT INTO agreements (user_id, title, clauses, source, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, clauses = excluded.clauses, source = excluded.source, updated_at = excluded.updated_at'
  ).bind(user.id, title, JSON.stringify(clauses), ai.source, now()).run();
  return json({ agreement: { title, clauses, source: ai.source, updated_at: now() } });
}

// ---------- Gemini waterfall ----------
// Order: key1/model1 -> key1/model2 -> key2/model1 -> key2/model2 -> key3/...
// 429 or 403 puts that key/model pair on a 60s cooldown. Any failure moves to the next pair.
// If every pair fails, the caller's rule-based fallback is used and the source says so.

// Per-user quota: a request that is over its per-minute or per-day limit never reaches Gemini.
// It gets the rule-based fallback and the source says why, so the UI stays usable.
async function aiTask(env, userId, prompt, fallbackFn, validate) {
  const quota = await consumeAiQuota(env, userId);
  if (!quota.allowed) {
    return { data: fallbackFn(), source: `rate limit reached (${quota.reason}): rule-based fallback` };
  }
  const hit = await callGemini(env, prompt, validate);
  if (hit.data) return { data: hit.data, source: hit.source };
  // Say why Gemini was not used, so a demo problem is visible on screen rather than silent.
  const why = hit.failures.length ? ` (${hit.failures.slice(0, 4).join(', ')})` : ' (no Gemini keys set)';
  return { data: fallbackFn(), source: `rule-based fallback${why}` };
}

function minuteKey(d) { return 'min:' + d.toISOString().slice(0, 16); }
function dayKey(d) { return 'day:' + d.toISOString().slice(0, 10); }

async function consumeAiQuota(env, userId) {
  const perMinute = Number(env.AI_LIMIT_PER_MINUTE) || 5;
  const perDay = Number(env.AI_LIMIT_PER_DAY) || 30;
  const d = new Date();
  const mk = minuteKey(d);
  const dk = dayKey(d);
  // Retention: drop usage windows that no longer count toward any limit.
  await env.DB.prepare(
    "DELETE FROM ai_usage WHERE (window_key LIKE 'min:%' AND window_key < ?) OR (window_key LIKE 'day:%' AND window_key < ?)"
  ).bind(minuteKey(new Date(now() - 2 * 86400000)), dayKey(new Date(now() - 35 * 86400000))).run();
  const rows = (await env.DB.prepare(
    'SELECT window_key, count FROM ai_usage WHERE user_id = ? AND window_key IN (?, ?)'
  ).bind(userId, mk, dk).all()).results;
  const count = (k) => rows.find((r) => r.window_key === k)?.count || 0;

  if (count(mk) >= perMinute) return { allowed: false, reason: `${perMinute} per minute` };
  if (count(dk) >= perDay) return { allowed: false, reason: `${perDay} per day` };

  const bump = (k) => env.DB.prepare(
    'INSERT INTO ai_usage (user_id, window_key, count) VALUES (?, ?, 1) ON CONFLICT(user_id, window_key) DO UPDATE SET count = count + 1'
  ).bind(userId, k);
  await env.DB.batch([bump(mk), bump(dk)]);
  return { allowed: true };
}

// ---------- Authorization ----------

function adminPhones(env) {
  return String(env.ADMIN_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function adminUsage(env, user) {
  if (user.role !== 'admin') throw new HttpError(403, 'You do not have access to this.');
  const dk = dayKey(new Date());
  const rows = (await env.DB.prepare(
    'SELECT u.phone_last4, a.count FROM ai_usage a JOIN users u ON u.id = a.user_id WHERE a.window_key = ? ORDER BY a.count DESC'
  ).bind(dk).all()).results;
  return json({
    window: dk,
    limits: { per_minute: Number(env.AI_LIMIT_PER_MINUTE) || 5, per_day: Number(env.AI_LIMIT_PER_DAY) || 30 },
    usage: rows.map((r) => ({ phone_masked: maskPhone(r.phone_last4), gemini_calls_today: r.count })),
  });
}

function geminiKeys(env) {
  return [env.GEMINI_KEY_1, env.GEMINI_KEY_2, env.GEMINI_KEY_3].filter(Boolean);
}

function geminiModels(env) {
  return (env.GEMINI_MODELS || DEFAULT_MODELS).split(',').map((s) => s.trim()).filter(Boolean);
}

// One Gemini request. The key is only ever sent in a header, never in a URL or a response.
async function geminiRequest(key, model, prompt) {
  const generationConfig = { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 2048 };
  // Gemini 2.5 models think before answering, and that thinking uses the output budget.
  // Turning thinking off keeps the JSON answer from being cut short.
  if (/gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return { ok: false, status: res.status, text: '' };
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return { ok: true, status: res.status, text };
}

// Waterfall: key1/model1, key1/model2, key2/model1, ... Returns the first valid answer, plus the reasons for every failure.
async function callGemini(env, prompt, validate) {
  const keys = geminiKeys(env);
  const models = geminiModels(env);
  const failures = [];
  for (let k = 0; k < keys.length; k++) {
    for (const model of models) {
      const slot = `${k}:${model}`;
      if ((cooldowns.get(slot) || 0) > now()) {
        failures.push(`k${k + 1}/${model}:cooldown`);
        continue;
      }
      try {
        const r = await geminiRequest(keys[k], model, prompt);
        if (!r.ok) {
          if (r.status === 429 || r.status === 403) cooldowns.set(slot, now() + 60000);
          failures.push(`k${k + 1}/${model}:${r.status}`);
          continue;
        }
        const parsed = parseJSON(r.text);
        if (parsed && (!validate || validate(parsed))) {
          return { data: parsed, source: `gemini:${model} (key ${k + 1})`, failures };
        }
        failures.push(`k${k + 1}/${model}:bad-json`);
      } catch (err) {
        failures.push(`k${k + 1}/${model}:${err.name === 'TimeoutError' ? 'timeout' : 'network'}`);
      }
    }
  }
  return { data: null, source: null, failures };
}

// Live check for judges and developers: sends a tiny request to every key and model.
// Shows status codes only, never the keys. Result is cached for five minutes. Demo mode only.
let statusCache = { at: 0, body: null };
async function aiStatus(env) {
  if (env.DEMO_MODE !== 'true') throw new HttpError(404, 'Not found');
  if (statusCache.body && now() - statusCache.at < 5 * 60000) return json(statusCache.body);
  const keys = geminiKeys(env);
  const models = geminiModels(env);
  const checks = [];
  for (let k = 0; k < keys.length; k++) {
    for (const model of models) {
      const t0 = now();
      try {
        const r = await geminiRequest(keys[k], model, 'Reply with JSON: {"ok": true}');
        checks.push({ key: k + 1, model, ok: r.ok && /true/.test(r.text), status: r.status, ms: now() - t0 });
      } catch (err) {
        checks.push({ key: k + 1, model, ok: false, status: err.name === 'TimeoutError' ? 'timeout' : 'network', ms: now() - t0 });
      }
    }
  }
  const working = checks.find((c) => c.ok);
  const body = {
    keys_configured: keys.length,
    models,
    live: !!working,
    served_by: working ? `${working.model} (key ${working.key})` : null,
    checks,
    checked_at: new Date().toISOString(),
  };
  statusCache = { at: now(), body };
  return json(body);
}

function parseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
  }
}

// ---------- Prompts ----------

const JSON_RULE = 'Return only valid JSON. No markdown, no code fences.';

function profilePrompt(p) {
  return `You help Domus, a flatmate app in India. Read the user's form answers and free-text "about me".
${JSON_RULE}
Keys:
"summary": one friendly sentence, max 30 words, plain English, describing this person as a flatmate.
"tags": up to 4 short lifestyle tags, 2 to 3 words each.
"inferred": an object containing only keys the about text clearly implies, from: sleep (early|late|flexible), cleanliness (tidy|relaxed), cooking (yes|no), smoking (yes|no), pets (ok|no|have), guests (rarely|sometimes|often), work_mode (office|hybrid|remote). Use {} if nothing is clear.
Never infer or mention religion, caste, community, or any protected trait. Do not invent facts.

Form answers: ${JSON.stringify({ occupation: p.occupation, lifestyle: p.lifestyle, sleep: p.sleep, cleanliness: p.cleanliness, cooking: p.cooking, smoking: !!p.smoking, pets: p.pets, guests: p.guests, work_mode: p.work_mode })}
About me: """${redactPII(p.about)}"""`;
}

function matchPrompt(a, b, score) {
  return `Write a match note for two flatmates on Domus. ${JSON_RULE}
Key: "note": max 40 words, two short sentences. Say what they share, then one thing they should agree on before moving in.
Use only the facts below. Do not mention age, gender, religion, caste, community, or appearance.
Compatibility score: ${score}%
Viewer: ${JSON.stringify(pick(a))}
Candidate: ${JSON.stringify(pick(b))}`;
}

function scamPrompt(text) {
  return `You check rental listings and messages for scam signs in India: advance or booking payment pressure, urgency, requests to move off-platform (WhatsApp only, Telegram), UPI or bank transfer before a visit, gift cards or crypto, prices that are too good to be true, requests for OTP, Aadhaar, PAN or bank details. ${JSON_RULE}
Keys:
"risk": "low" | "medium" | "high"
"reasons": array of up to 4 short reasons, empty if none
"advice": one plain sentence for the user.
This check is advisory. Do not claim certainty.
Text: """${text}"""`;
}

function agreementPrompt(f) {
  return `Draft a roommate agreement for a shared flat in India. Mark it clearly as a DRAFT and not legal advice. ${JSON_RULE}
Keys:
"title": string
"clauses": array of 6 to 8 objects with "heading" and "text" (2 to 3 plain sentences each). Cover: rent and deposit terms, shared bills split, house rules, guest policy, notice period, move-out and deposit return, and a clause saying a lawyer should review the final version.
Facts: ${JSON.stringify(f)}`;
}

// Only lifestyle fields go to Gemini. Name, area and budget stay on our side.
function pick(p) {
  return { occupation: p.occupation, lifestyle: p.lifestyle, sleep: p.sleep, cleanliness: p.cleanliness, cooking: p.cooking, smoking: p.smoking, pets: p.pets, guests: p.guests, work_mode: p.work_mode };
}

// ---------- Rule-based fallbacks (used when every Gemini key/model fails) ----------

function profileFallback(p) {
  const work = p.work_mode === 'remote' ? 'from home' : p.work_mode;
  return {
    summary: `${p.name} works ${work} and is looking for a flat in ${p.locality || p.city}.`,
    tags: [p.lifestyle],
    inferred: {},
  };
}

function sanitizeInferred(raw) {
  const allowed = {
    sleep: ['early', 'late', 'flexible'], cleanliness: ['tidy', 'relaxed'], cooking: ['yes', 'no'],
    smoking: ['yes', 'no'], pets: ['ok', 'no', 'have'], guests: ['rarely', 'sometimes', 'often'], work_mode: ['office', 'hybrid', 'remote'],
  };
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, vals] of Object.entries(allowed)) if (vals.includes(raw[k])) out[k] = raw[k];
  }
  return out;
}

function matchFallback(a, b, score) {
  const same = [];
  if (a.sleep === b.sleep) same.push(`${b.sleep} sleep schedules`);
  if (a.cleanliness === b.cleanliness) same.push(`${b.cleanliness} cleanliness standards`);
  if (a.smoking === b.smoking) same.push(b.smoking ? 'a shared smoking habit' : 'a smoke-free home');
  if (a.work_mode === b.work_mode) same.push(`${b.work_mode} work`);
  const shared = same.length ? `You both have ${joinList(same)}.` : 'Your routines differ in a few places.';
  const check = a.cooking !== b.cooking
    ? 'Agree on cooking and shared groceries early.'
    : a.guests !== b.guests
      ? 'Agree on guest rules before you move in.'
      : 'Agree on bills and the cleaning rota before you move in.';
  return { note: `${shared} ${check}` };
}

function scamFallback(text) {
  const t = text.toLowerCase();
  const rules = [
    [/advance|token amount|booking amount|pay (now|first)|pay \d+%/, 'Asks for advance or booking payment before a visit'],
    [/urgent|asap|today only|last chance|hurry/, 'Uses urgency pressure'],
    [/whatsapp only|telegram|off.?platform|outside the app|direct(ly)? message/, 'Pushes you to move off-platform'],
    [/upi|gpay|paytm|phonepe|bank transfer/, 'Asks for a direct payment method'],
    [/gift card|western union|crypto|bitcoin/, 'Asks for untraceable payment'],
    [/too good|50% off|lowest price|half rent|no broker fee/, 'Price looks too good to be true'],
    [/otp|aadhaar|aadhar|pan card|bank details/, 'Asks for an OTP, ID number or bank details'],
  ];
  const reasons = rules.filter(([re]) => re.test(t)).map(([, msg]) => msg);
  const risk = reasons.length >= 3 ? 'high' : reasons.length ? 'medium' : 'low';
  return {
    risk,
    reasons,
    advice: risk === 'low'
      ? 'No obvious scam signs found. Still meet in person and check ID before paying anything.'
      : 'Do not pay anything before you verify the person and see the place in person.',
  };
}

function agreementFallback(f) {
  const names = f.members.join(', ');
  const place = f.locality ? `${f.locality}, ${f.city}` : f.city;
  return {
    title: 'Roommate Agreement (Draft)',
    clauses: [
      { heading: 'Parties', text: `This draft is between ${names}, who share a flat in ${place}.` },
      { heading: 'Rent and deposit', text: `Monthly rent is Rs ${f.rent.toLocaleString('en-IN')}, split equally unless agreed otherwise. The security deposit is Rs ${f.deposit.toLocaleString('en-IN')} and is held against damage beyond normal wear.` },
      { heading: 'Shared bills', text: 'Electricity, internet, gas and groceries are split equally. Each person pays their share by the 5th of the month, and the ledger in Domus records who paid.' },
      { heading: 'House rules', text: 'Shared spaces are kept clean after use. Quiet hours are agreed between flatmates. Smoking is allowed only where all flatmates agree.' },
      { heading: 'Guests', text: 'Overnight guests need a heads-up to all flatmates in advance. Guests should not stay for more than a set number of nights without agreement.' },
      { heading: 'Notice period', text: `Either party gives ${f.notice_days} days written notice before leaving. Rent is due until the notice period ends or a replacement is found.` },
      { heading: 'Move-out and deposit return', text: 'The flat is checked against move-in photos before the deposit is returned. Deductions are listed in writing.' },
      { heading: 'Review', text: 'This is a draft generated by Domus, not legal advice. A lawyer should review the final version before anyone signs.' },
    ],
  };
}

// ---------- Helpers ----------

// ---------- Privacy: cookies, hashing, headers ----------

const COOKIE_NAME = 'domus_session';
const SESSION_DAYS = 30;

function sessionToken(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)domus_session=([A-Za-z0-9_-]{20,200})/);
  return m ? m[1] : null;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

const clearedCookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

function withCookie(response, value) {
  response.headers.append('set-cookie', value);
  return response;
}

function originOk(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-site fetches from tools may omit Origin; SameSite and JSON-only still apply
  try { return new URL(origin).host === url.host; } catch { return false; }
}

function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return res;
}

function requirePepper(env) {
  if (!env.PRIVACY_PEPPER || env.PRIVACY_PEPPER.length < 16) {
    throw new HttpError(500, 'Server is not configured. Set PRIVACY_PEPPER (16+ characters).');
  }
  return env.PRIVACY_PEPPER;
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Phone numbers are stored as an HMAC, so a database leak does not reveal them.
async function phoneHash(env, phone) {
  return hmacHex(requirePepper(env), 'phone:' + phone);
}

function maskPhone(last4) {
  return '+91******' + last4;
}

// PII redaction. Applied to free text before it goes to Gemini, and to about-me text before other users see it.
const PII_PATTERNS = [
  [/https?:\/\/\S+/gi, '[link]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[\w.-]{2,}@[a-z]{2,}\b/gi, '[upi id]'],
  [/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[phone]'],
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[id number]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id number]'],
];

export function redactPII(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of PII_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// ---------- Privacy: user rights (export and delete) ----------

async function exportAccount(env, user) {
  const profile = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(user.id).first();
  const members = (await env.DB.prepare('SELECT name, created_at FROM members WHERE user_id = ?').bind(user.id).all()).results;
  const expenses = (await env.DB.prepare(
    'SELECT title, amount, paid_by, category, created_at FROM expenses WHERE user_id = ?'
  ).bind(user.id).all()).results;
  const agreement = await env.DB.prepare('SELECT title, clauses, source, updated_at FROM agreements WHERE user_id = ?').bind(user.id).first();
  const requests = (await env.DB.prepare('SELECT to_profile, created_at FROM requests WHERE from_user = ?').bind(user.id).all()).results;
  const notes = (await env.DB.prepare('SELECT target_id, note, source FROM match_notes WHERE viewer_id = ?').bind(user.id).all()).results;
  return json({
    exported_at: new Date().toISOString(),
    account: { phone_masked: maskPhone(user.phone_last4), role: user.role },
    profile: profile ? formatProfile(profile) : null,
    members,
    expenses,
    agreement: agreement ? { ...agreement, clauses: safeJSON(agreement.clauses, []) } : null,
    requests_sent: requests,
    match_notes: notes,
  });
}

async function deleteAccount(request, env, user) {
  const body = await readJson(request);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
  // One transaction: either everything about this person goes, or nothing does.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM expenses WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM agreements WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM requests WHERE from_user = ? OR to_profile = ?').bind(user.id, user.id),
    env.DB.prepare('DELETE FROM match_notes WHERE viewer_id = ? OR target_id = ?').bind(user.id, user.id),
    env.DB.prepare('DELETE FROM ai_usage WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return withCookie(json({ ok: true, message: 'Your account and data were deleted.' }), clearedCookie);
}

function genderOk(me, c) {
  return (me.looking_for === 'Any' || me.looking_for === c.gender) && (c.looking_for === 'Any' || c.looking_for === me.gender);
}

function scoreMatch(a, b) {
  let pts = 0;
  if (a.city === b.city) pts += 10;
  if (Math.min(a.budget_max, b.budget_max) >= Math.max(a.budget_min, b.budget_min)) pts += 15;
  if (a.sleep === b.sleep) pts += 10; else if (a.sleep === 'flexible' || b.sleep === 'flexible') pts += 5;
  if (a.cleanliness === b.cleanliness) pts += 15;
  if (a.cooking === b.cooking) pts += 10;
  if (a.smoking === b.smoking) pts += 15;
  if (!((a.pets === 'have' && b.pets === 'no') || (a.pets === 'no' && b.pets === 'have'))) pts += 10;
  pts += a.guests === b.guests ? 10 : 5;
  pts += a.work_mode === b.work_mode ? 5 : 2;
  return Math.round(pts); // out of 100
}

function badgesFor(r) {
  const out = [r.cleanliness === 'tidy' ? 'Clean' : 'Relaxed'];
  out.push(r.smoking ? 'Smoker' : 'Non-Smoker');
  out.push(r.pets === 'no' ? 'No Pets' : r.pets === 'have' ? 'Has a Pet' : 'Pets OK');
  out.push(r.sleep === 'early' ? 'Early Riser' : r.sleep === 'late' ? 'Night Owl' : 'Flexible Hours');
  return out.slice(0, 4);
}

function formatProfile(r) {
  return {
    id: r.id, name: r.name, age: r.age, gender: r.gender, looking_for: r.looking_for,
    occupation: r.occupation, lifestyle: r.lifestyle, city: r.city, locality: r.locality,
    budget_min: r.budget_min, budget_max: r.budget_max, move_in: r.move_in, deposit: r.deposit,
    sleep: r.sleep, cleanliness: r.cleanliness, cooking: r.cooking, smoking: !!r.smoking,
    pets: r.pets, guests: r.guests, work_mode: r.work_mode, about: r.about,
    discoverable: !!r.discoverable, share_locality: !!r.share_locality, share_budget: !!r.share_budget,
    privacy_consent_at: r.privacy_consent_at || null,
    verified: !!r.verified, ai_summary: r.ai_summary || '', ai_tags: safeJSON(r.ai_tags, []),
    ai_filters: safeJSON(r.ai_filters, {}), ai_source: r.ai_source || null,
    initials: initials(r.name), tags: badgesFor({ ...r, smoking: !!r.smoking }),
  };
}

// Public view of a profile. Hidden fields are removed here, on the server, not just hidden in the UI.
function summaryOf(p) {
  return {
    id: p.id, name: p.name, age: p.age, gender: p.gender, occupation: p.occupation, lifestyle: p.lifestyle,
    city: p.city, locality: p.share_locality ? p.locality : '',
    budget_min: p.share_budget ? p.budget_min : null, budget_max: p.share_budget ? p.budget_max : null,
    move_in: p.move_in, verified: p.verified, initials: p.initials, tags: p.tags,
  };
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function rupees(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

function safeJSON(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function insertSql(table, obj, orIgnore = false) {
  const keys = Object.keys(obj);
  return {
    sql: `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    values: keys.map((k) => obj[k] ?? null),
  };
}

function upsertSql(table, obj, conflictKey) {
  const keys = Object.keys(obj);
  const updates = keys.filter((k) => k !== conflictKey).map((k) => `${k} = excluded.${k}`).join(', ');
  return {
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT(${conflictKey}) DO UPDATE SET ${updates}`,
    values: keys.map((k) => obj[k] ?? null),
  };
}
