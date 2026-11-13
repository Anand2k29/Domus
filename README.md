# Domus

**Find. Share. Belong.**

Domus helps people find a flatmate they can trust, then manages the shared parts of the home: bills, deposits and the house agreement.

**Team:** SoftTouch

**Live demo:** https://domus.collegee.workers.dev

---

## Live links

| Page | URL |
|---|---|
| Landing page | https://domus.collegee.workers.dev |
| Application | https://domus.collegee.workers.dev/app/ |
| Mobile landing page | https://domus.collegee.workers.dev/m/ |
| AI status check | https://domus.collegee.workers.dev/api/ai-status |

## Try the demo

Open the application and choose **Try the live demo**. No sign-up is needed, and each click creates a separate demo account with sample data.

The Home screen has a short guide (about three minutes). Its status line shows whether Gemini is answering and which key and model did. Keys are never displayed.

Without Gemini keys, every AI output uses the built-in rules and says so on screen.

---

## The problem

Finding a flatmate in an Indian metro city carries real risk. Fake listings, advance-payment scams and people who aren't who they claim to be are common. After move-in, deposit disputes, unpaid shares and unwritten house rules cause most of the conflict. Existing platforms focus on listings and brokerage, and do little to build trust or manage money once people live together.

## The solution

Domus works in three steps: **verify**, **match** and **manage**.

| Step | What Domus does |
|---|---|
| **Verify** | Phone sign-in with a one-time code, and an identity-check step. In this demo, the identity check is mocked and labelled as such. |
| **Match** | Preferences, a ranked feed with match scores, and a Gemini-written note on each match. |
| **Protect** | A scam checker for listings and messages. It returns reasons, and Gemini explains them in plain language. |
| **Manage** | A shared-expense ledger with balances, and a roommate agreement draft marked for review. |

The MVP targets Bengaluru. Live payments, live identity verification and in-app chat are outside the current scope.

## Features

| Area | Capability | Status |
|---|---|---|
| Sign-in | Phone sign-in with a one-time code; lockout after five wrong attempts; 30-second resend cooldown | Built (code shown on screen in demo mode) |
| Identity | Identity-check step | Built (mocked) |
| Profile | Preferences form; Gemini summary and suggested filters from the "about me" text | Built |
| Discover | Ranked matches; gender preference respected; search and filters | Built |
| Matches | Profile view with score and match note; send a request | Built |
| Scam check | Warning signals with reasons; Gemini explanation; rules fallback | Built |
| Expenses | Shared ledger, members, running balances | Built |
| Agreement | Roommate agreement draft, marked as a draft; print to PDF | Built |
| Privacy | Consent; visibility controls; data export; account deletion; personal details removed before AI calls | Built |
| Mobile | Mobile landing page; phone-first app layout; installable PWA | Built |
| Policies | Privacy policy, terms, cookie policy, acceptable use and AI policy | Drafts pending legal review |
| Payments, live identity verification, chat | | Out of scope for the demo |

## Architecture

```
Browser (PWA at /app/, landing page at /, mobile landing at /m/)
        │  HTTPS, HttpOnly session cookie
        ▼
Cloudflare Worker (src/worker.js)
  • JSON API under /api
  • Static assets (Workers Static Assets)
  • Security headers, CSRF checks, per-user AI limits
        │                              │
        ▼                              ▼
Cloudflare D1 (SQLite)         Google Gemini API
  users, profiles, ledger,       up to 3 keys × 2 models,
  agreements, usage counters     with a rules-based fallback
```

**Stack:** plain HTML, CSS and JavaScript (no build step) for the frontend; Cloudflare Workers and D1 for the backend; Google Gemini for language tasks.

## Google AI

Domus calls the Gemini API from the server for four tasks: profile summaries, match notes, scam assessments and agreement drafts.

- **Models:** Gemini 2.5 Flash first, with Gemini 2.5 Flash-Lite as backup.
- **Key waterfall:** key 1 with each model, then key 2, then key 3. A key or model that returns a quota or access error is paused for 60 seconds.
- **Per-user limits:** 5 AI calls a minute and 30 a day by default.
- **Fallback:** if every call fails, built-in rules answer and say so on screen.
- **Key handling:** keys are stored as Cloudflare Worker secrets, sent only in a request header to Google, and never reach the browser.
- **Input minimisation:** phone numbers, emails, UPI IDs, links and ID-style numbers are removed before text is sent.

**Tools used:** Google AI Studio for keys and prompt testing; Google Argon for UI design; Google Antigravity for building the prototype; Google DeepMind's Argan for planning.

## Privacy and security

- Session tokens live in an HttpOnly, Secure, SameSite=Strict cookie. The server stores only a hash of each token.
- Phone numbers are stored as an HMAC keyed with a server secret. Only the last four digits are kept for display.
- Visibility controls (show me in Discover, show my area, show my budget) are enforced on the server.
- Users can export their data as JSON, or delete their account and all related data.
- Requests must be JSON and come from the same origin. Every response carries a content security policy and other security headers.
- Retention limits apply to one-time codes, sessions and usage counters.

The full privacy model is kept in the team's internal notes.

## Getting started

Requirements: Node.js 18 or later.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # set PRIVACY_PEPPER (16+ characters); optionally add GEMINI_KEY_1 to GEMINI_KEY_3
npm run db:init:local
npm run dev                              # http://localhost:8787
```

Run the test suite while the dev server is running:

```powershell
node scripts/smoke-test.mjs
```

## Deployment

Deployment uses the Cloudflare account that owns the `domus` Worker and the `domus-db` D1 database.

```powershell
npx wrangler login
npm run db:init                          # create tables in the remote database
npx wrangler secret put PRIVACY_PEPPER
npx wrangler secret put GEMINI_KEY_1     # optional: GEMINI_KEY_2 and GEMINI_KEY_3
npm run deploy
```

Enter each secret value at the prompt. Secrets are never written to the repository.

Check the live AI status at `/api/ai-status`. The `live` field shows whether a key and model answered.

A Git-connected build in the Cloudflare dashboard is not currently in use, because its deploy step failed. Deploy from the terminal with `npm run deploy` until that is fixed.

Before real users arrive, set `DEMO_MODE` to `"false"` in `wrangler.jsonc` and redeploy.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEMO_MODE` | `"true"` | Enables the demo login and on-screen sign-in codes |
| `GEMINI_MODELS` | `gemini-2.5-flash,gemini-2.5-flash-lite` | Models tried in order for each key |
| `AI_LIMIT_PER_MINUTE` | `5` | AI calls per user per minute |
| `AI_LIMIT_PER_DAY` | `30` | AI calls per user per day |
| `ADMIN_PHONES` | empty | Comma-separated admin phone numbers |

Secrets: `PRIVACY_PEPPER`, `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`.

## Pages

| Path | Description |
|---|---|
| `/` | Landing page: overview, how it works, privacy, Gemini key usage, FAQ |
| `/m/` | Mobile landing page with the same content, laid out for phones |
| `/app/` | Application: sign-in, Discover, Matches, Home, Expenses, Agreement, Scam Check, Profile |
| `/privacy.html`, `/terms.html`, `/cookies.html`, `/acceptable-use.html` | Policy pages (drafts) |

## API

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/api/auth/send-otp` | Public | Send or display a sign-in code |
| POST | `/api/auth/verify-otp` | Public | Sign in and set the session cookie |
| POST | `/api/auth/logout` | Signed in | End the session |
| POST | `/api/demo/login` | Demo mode | Create a demo account |
| GET | `/api/ai-status` | Demo mode | Check each Gemini key and model; keys are never returned |
| GET | `/api/me` | Signed in | Current user and profile |
| PUT | `/api/profile` | Signed in | Save preferences (consent required on first save) |
| POST | `/api/verify-id` | Signed in | Mock identity verification |
| GET | `/api/discover` | Signed in | Ranked matches; query: `q`, `gender` |
| GET | `/api/profiles/:id` | Signed in | Profile with score and match note |
| POST | `/api/requests` | Signed in | Send a request |
| POST | `/api/scam-check` | Signed in | Assess a listing or message |
| GET, POST | `/api/expenses` | Signed in | Ledger and balances; add an expense |
| POST | `/api/expenses/sample` | Signed in | Load sample ledger data |
| POST | `/api/members` | Signed in | Add a member to the ledger |
| GET, POST | `/api/agreement` | Signed in | Read or generate the agreement draft |
| GET | `/api/home` | Signed in | Dashboard summary |
| GET | `/api/account/export` | Signed in | Download personal data as JSON |
| DELETE | `/api/account` | Signed in | Delete the account (body: `{"confirm":"DELETE"}`) |
| GET | `/api/admin/usage` | Admin | Gemini usage per user, phone numbers masked |

## Known limitations

- In demo mode, sign-in codes are shown on screen, so anyone who knows a number could sign in as it. Disable demo mode before any real use.
- The identity check is mocked. The verified badge does not mean that identity was confirmed.
- Usage limits are approximate: two requests that arrive together can both pass.
- Free-tier Gemini quotas are small and change over time.
- Live Gemini answers still need to be confirmed with working keys, using `/api/ai-status`.
- Profiles and sample homes in the demo are fictional.
- Agreement drafts and scam assessments are advisory, not legal advice.
- Policy pages are drafts that need legal review before launch.

## Project structure

```
src/worker.js            API, privacy controls, Gemini integration, fallbacks
schema.sql               D1 database schema
wrangler.jsonc           Worker configuration (assets, database binding, variables)
public/                  Frontend: application (/app/), landing pages (/ and /m/), policy pages, assets
scripts/smoke-test.mjs   API test suite
.dev.vars.example        Template for local secrets (copy to .dev.vars; never commit it)
research-links.md        Market and background research sources
```

Team and project working files, including the design source and planning documents, are kept outside the public repository by `.gitignore`.

## Team

**SoftTouch**: five students with experience in backend and database design, frontend and mobile interfaces, AI integration, and testing and security.

---

© SoftTouch. Demonstration build. All rights reserved.
