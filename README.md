# Domus

**Find. Share. Belong.** Domus helps people find a flatmate they can trust, then runs the shared parts of the home: bills, deposits and the house agreement.

Team: **Softtouch** · Team size: [TBD]

Live demo: open `/` and click **Try the live demo** (no sign-up). Each click creates a separate demo account.

---

## Judges: quick start

1. Open the app and click **Try the live demo (no sign-up)**. You get a filled-in profile and a sample ledger in one click.
2. Follow the **Judge's guide** on the Home screen: Discover, Matches, Expenses, Agreement, Scam Check, Privacy. About three minutes.
3. The Home screen and the landing page show a live status line: it reports whether Gemini answered, and which key number and model did. It never shows the keys.

Without Gemini keys, every AI output uses the built-in rules and says so on screen.

---

## The problem

Finding and living with a flatmate in Indian metro cities is risky and messy. People face fake listings, advance-payment scams, deposit disputes, strangers who steal money or phones, and roommates who don't repay shared costs. Women and single professionals also face extra screening and safety concerns when renting. Existing platforms focus on listings and brokerage, not on trust or on managing money after people move in.

Evidence (see `research-links.md`): deposit deductions and non-returns are a recurring complaint in Bengaluru, Mumbai and Gurugram; fake flatmates and roommate fraud have led to real financial loss; single women are turned down or screened more heavily by landlords.

## The solution

Domus is a web app (a PWA) built on one idea: **verify first, then match, then manage.**

| Step | What Domus does |
|---|---|
| **Verify** | Phone sign-in with a one-time code, and an ID check step. *In this demo both are mocked and labelled as such.* |
| **Match** | Structured preferences, a ranked feed with match scores, and a Gemini-written match note on each profile. |
| **Protect** | A scam checker for listings and messages, with the reasons it gives. |
| **Manage** | A shared-expense ledger with balances, a roommate agreement draft, and a deposit field. |

Domus is an MVP for one city (Bengaluru). Real payments, live ID verification and chat are out of scope for the demo.

## What is built (status)

| Feature | Status |
|---|---|
| Phone sign-in (mock code shown on screen in demo mode), lockout after five wrong codes, 30-second resend cooldown | Built |
| Mock ID verification step | Built (mocked) |
| Profile and preferences form, with a Gemini summary and suggested filters from the "about me" text | Built |
| Discover: ranked matches, gender preference respected, search and filters | Built |
| Profile view with match score and Gemini match note; "Send Request" | Built |
| Scam checker with Gemini and a rule-based fallback | Built |
| Shared-expense ledger, members, balances ("who owes whom") | Built |
| Roommate agreement draft (marked as a draft, not legal advice), print to PDF | Built |
| Privacy: consent, visibility toggles, export and delete account, PII redaction before AI | Built |
| One-click judge demo with sample data | Built |
| Policies: privacy, terms, cookies, acceptable use and AI | Built (draft, for legal review) |
| Real SMS, real ID verification, payments, in-app chat | Not in the demo |

## Google AI and how Domus uses Gemini

- **Google AI Studio:** used to create the Gemini API keys and to prototype the prompts for the summary, match note, scam checker and agreement drafts.
- **Gemini API** is called from the server for four tasks: profile summary, match notes, scam assessments and agreement drafts.
- **Up to three keys, one waterfall.** Domus tries key 1 with its first model, then its second model, then key 2, then key 3. A key or model that returns a quota or access error is paused for 60 seconds.
- **Per-person limits:** 5 AI calls a minute and 30 a day by default, so one user can't use up the shared keys.
- **Built-in rules fallback:** if every call fails, Domus answers with rules and says why on screen, so the demo keeps working when free-tier limits run out.
- **Keys stay on the server.** They are stored as Cloudflare Worker secrets, sent only in a request header to Google, and never reach the browser.
- **Minimal, redacted input:** phone numbers, emails, UPI IDs, links and ID-style numbers are removed before any text goes to Gemini. Names, phone numbers and exact areas are not sent.

**Status:** the Gemini code path is built and tested for failure and fallback. Live Gemini calls need your own keys. Put them in `.dev.vars` (local) or set them as secrets (deployed), then check the status line.

Google AI tools planned for the build: Google Antigravity (agent-assisted development) and Google Agent Skills (shared scam-check and agreement logic). These were planned in the submission draft and are not yet confirmed as used.

## Privacy and security

Full model in `process/privacy.md` (kept in the team's private folder, not in this repo). In short:

- Session tokens live only in an HttpOnly, Secure, SameSite=Strict cookie. The server stores only a hash.
- Phone numbers are stored as an HMAC keyed with `PRIVACY_PEPPER`, plus the last four digits for display.
- Visibility toggles (show me in Discover, show my area, show my budget) are enforced on the server.
- Export your data as JSON, or delete your account and its data in one step.
- CSRF protection (Origin check and JSON-only writes), a content security policy, and other security headers on every response.
- Gemini usage limits per user and retention rules for OTPs, sessions and usage counters.

## Architecture

```
[Browser: PWA at /app/, marketing site at /]
        |  HTTPS (session cookie)
        v
[Cloudflare Worker: src/worker.js]
  - JSON API under /api
  - Static assets (Workers Static Assets)
  - Security headers, CSRF checks, rate limits
        |                    |
        v                    v
[D1 database]          [Gemini API, up to 3 keys x 2 models]
 users, profiles,       summaries, match notes,
 ledger, agreements     scam checks, agreement drafts
                              |
                              v
                       [Built-in rules, if all else fails]
```

- Frontend: plain HTML, CSS and JavaScript (no build step). Design tokens and components from the UI kit.
- Backend: Cloudflare Workers (free tier) with D1 (SQLite).
- Tests: `scripts/smoke-test.mjs` covers auth, lockout, cooldown, rate limits, cross-user access, privacy controls, the demo path and AI fallback.

## Scalability

- **City by city:** Bengaluru first, then Pune, Mumbai, Delhi NCR, Hyderabad and Chennai.
- **Technical:** Workers and D1 scale with usage. Gemini calls are per request, so cost scales with active users. Repeated scam checks and match notes are cached.
- **Business (later):** premium verification, deposit-protection partnerships, and agreement templates reviewed by lawyers.

## Competitors

| Competitor | What they do | Gap Domus addresses |
|---|---|---|
| NoBroker | Rentals and roommate listings | Verification and money management are not their focus (per a competitor blog; verify before pitching). |
| FlatMate.in | Shared-living platform with a "Verify Your Tenant" feature | Narrower focus on verification; limited shared-money tools seen in research. |
| FlatX | Flatmate and listing platform, plus blog content | Not a verified-first, money-managed product (verify before pitching). |
| Roomfast | Roommate platform on Product Hunt | Positioning and features to be checked. |
| MagicBricks / 99acres | Listings with roommate sections | Broker-led listings, no trust or money tools. |
| Facebook and WhatsApp groups | Informal flatmate search | No verification, high scam risk. |

Competitor features should be checked directly before any pitch.

---

## Run locally

Needs Node.js 18 or newer.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars    # then set PRIVACY_PEPPER (16+ characters); optionally add GEMINI_KEY_1..3
npm run db:init:local
npm run dev                               # open http://localhost:8787
```

Test the API with the dev server running:

```powershell
node scripts/smoke-test.mjs
```

## Deploy to Cloudflare Workers

```powershell
npx wrangler login
npx wrangler d1 create domus-db           # paste the database_id into wrangler.jsonc
npm run db:init
npx wrangler secret put PRIVACY_PEPPER    # 16+ random characters
npx wrangler secret put GEMINI_KEY_1      # optional, add _2 and _3 too
npm run deploy
```

Before real users: set `DEMO_MODE` to `"false"` in `wrangler.jsonc` (this turns off demo sign-in and the on-screen code), and complete the open items in the privacy policy.

## Configuration (`wrangler.jsonc` → `vars`)

| Name | Default | Meaning |
|---|---|---|
| `DEMO_MODE` | `"true"` | Shows sign-in codes on screen and enables the one-click demo. |
| `GEMINI_MODELS` | `gemini-2.5-flash,gemini-2.5-flash-lite` | Models tried in order for each key. |
| `AI_LIMIT_PER_MINUTE` | `5` | Gemini calls per user per minute. |
| `AI_LIMIT_PER_DAY` | `30` | Gemini calls per user per day. |
| `ADMIN_PHONES` | empty | Comma-separated admin phone numbers. |

Secrets: `PRIVACY_PEPPER`, `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`.

## Pages

| Path | What it is |
|---|---|
| `/` | Landing page: product, how it works, privacy, how Gemini keys are used, FAQ |
| `/app/` | The app (sign-in, Discover, Matches, Home, Expenses, Agreement, Scam Check, Profile) |
| `/privacy.html`, `/terms.html`, `/cookies.html`, `/acceptable-use.html` | Policies (drafts for legal review) |

## API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/send-otp` | none | Send (or show) a sign-in code |
| POST | `/api/auth/verify-otp` | none | Sign in; sets the session cookie |
| POST | `/api/auth/logout` | yes | End the session |
| POST | `/api/demo/login` | none (demo only) | One-click demo account |
| GET | `/api/ai-status` | none (demo only) | Live Gemini check per key and model; no keys shown |
| GET | `/api/me` | yes | Current user and profile |
| PUT | `/api/profile` | yes | Save preferences (consent required the first time) |
| POST | `/api/verify-id` | yes | Mock ID verification |
| GET | `/api/discover?q=&gender=` | yes | Ranked match list |
| GET | `/api/profiles/:id` | yes | Profile with score and match note |
| POST | `/api/requests` | yes | Send a request |
| POST | `/api/scam-check` | yes | Scan a listing or message |
| GET / POST | `/api/expenses` | yes | Ledger, balances, add expense |
| POST | `/api/expenses/sample` | yes | Load a sample ledger |
| POST | `/api/members` | yes | Add a flatmate to the ledger |
| GET / POST | `/api/agreement` | yes | Read or generate the agreement draft |
| GET | `/api/home` | yes | Dashboard numbers and activity |
| GET | `/api/account/export` | yes | Download your data as JSON |
| DELETE | `/api/account` | yes | Delete your account (body `{"confirm":"DELETE"}`) |
| GET | `/api/admin/usage` | admin | Today's Gemini calls per user (masked) |

## Known limits

- Sign-in codes are shown on screen in demo mode, so anyone who knows a number could sign in as it. Turn demo mode off before real users.
- ID verification is a mock. The verified badge does not mean identity was checked.
- Rate limits are approximate: two requests that arrive together can both pass.
- Gemini quotas on the free tier are small and change over time.
- Seed profiles (Riya, Sneha, Rohan, Arjun, Meera, Karthik) and the sample homes are fictional demo data.
- Agreement drafts and scam assessments are advisory. They are not legal advice.
- Policy pages are drafts and need legal review before launch.

## Repository layout

```
src/worker.js          API, privacy, Gemini waterfall, rules fallback
schema.sql             D1 tables
wrangler.jsonc         Worker config (assets, D1 binding, vars)
public/                Frontend: /app/ (PWA), landing page, policy pages, assets
scripts/smoke-test.mjs API tests
.dev.vars.example      Local secrets template (copy to .dev.vars; never commit it)
research-links.md      Research sources
```

Private working folders (`design/`, `process/`, `submission-draft.md`) are kept out of the repository by `.gitignore`.
