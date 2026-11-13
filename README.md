# Domus

**Find. Share. Belong.**

Domus helps people find a flatmate they can trust, then manages the shared parts of the home: bills, deposits and the house agreement.

**Team:** SoftTouch

---

## Overview

Finding a flatmate in an Indian metro city is risky. People encounter fake listings, advance-payment scams, deposit disputes and roommates who do not pay their share. Existing platforms focus on listings and brokerage, not on trust or on money after move-in.

Domus is built on three steps:

1. **Verify.** Phone sign-in and an identity-check step. *In this demo, both are mocked and labelled as such.*
2. **Match.** Structured preferences, a ranked feed with match scores, and a Gemini-written note on each match.
3. **Manage.** A shared-expense ledger with balances, a roommate agreement draft, and a scam checker for listings and messages.

The scope is an MVP for Bengaluru. Live payments, live identity verification and in-app chat are outside this demo.

## Try the demo

Open the app and choose **Try the live demo**. No sign-up is needed. Each click creates a separate demo account with sample data, so reviewers do not share state.

The Home screen includes a guided walkthrough (about three minutes). The status line shows whether Gemini is answering, and which key number and model did. Keys are never displayed.

## Features

| Area | Capability | Status |
|---|---|---|
| Authentication | Phone sign-in with a one-time code, lockout after five wrong attempts, 30-second resend cooldown | Built (code shown on screen in demo mode) |
| Verification | Identity-check step | Built (mocked) |
| Profile | Preferences form, with a Gemini summary and filter suggestions from the "about me" text | Built |
| Discover | Ranked matches, gender preference respected, search and filters | Built |
| Matching | Profile view with match score and Gemini match note; send a request | Built |
| Safety | Scam checker for listings and messages, with reasons; Gemini with a rule-based fallback | Built |
| Expenses | Shared ledger, members, running balances ("who owes whom") | Built |
| Agreement | Roommate agreement draft, marked as a draft; print to PDF | Built |
| Privacy | Consent, visibility controls, data export, account deletion, PII redaction before AI calls | Built |
| Policies | Privacy, terms, cookies, acceptable use and AI policy | Built (draft pending legal review) |
| Payments, live verification, chat | — | Out of scope for this demo |

## Architecture

```
Browser (PWA at /app/, landing page at /)
        │  HTTPS, HttpOnly session cookie
        ▼
Cloudflare Worker  (src/worker.js)
  • JSON API under /api
  • Static assets (Workers Static Assets)
  • Security headers, CSRF checks, per-user AI limits
        │                              │
        ▼                              ▼
Cloudflare D1 (SQLite)        Google Gemini API
  users, profiles, ledger,      up to 3 keys × 2 models,
  agreements, usage counters    with a rule-based fallback
```

**Stack:** HTML, CSS and vanilla JavaScript for the frontend (no build step); Cloudflare Workers (free tier) and D1 for the backend; Google Gemini for language tasks.

## Google AI

Domus calls the Gemini API from the server for four tasks: profile summary, match notes, scam assessments and agreement drafts.

- **Key waterfall.** Up to three keys and two models are tried in order: key 1 with model A, key 1 with model B, key 2 with model A, and so on. A key or model that returns a quota or access error is paused for 60 seconds.
- **Per-user limits.** Five AI calls per minute and 30 per day by default, so one account cannot exhaust the shared keys.
- **Fallback.** When every call fails, the app answers with built-in rules and states why on screen. The demo keeps working when free-tier limits run out.
- **Key handling.** Keys are stored as Cloudflare Worker secrets. They are sent only in a request header to Google and are never exposed to the browser.
- **Input minimisation.** Phone numbers, email addresses, UPI IDs, links and ID-style numbers are removed before any text is sent. Names, phone numbers and exact areas are not sent.

**Tools used:** Google AI Studio for the API keys and prompt design.

## Privacy and security

- Session tokens are kept in an HttpOnly, Secure, SameSite=Strict cookie. The server stores only a hash of each token.
- Phone numbers are stored as an HMAC keyed with a server secret, with the last four digits kept for display.
- Visibility controls (show me in Discover, show my area, show my budget) are enforced on the server.
- Users can export their data as JSON and delete their account and all related data.
- Writes require JSON and a matching origin (CSRF protection). Every response carries a content security policy and other security headers.
- Retention limits apply to one-time codes, sessions and usage counters.

The full privacy model is documented in the project's internal notes.

## Getting started

Requirements: Node.js 18 or later.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # set PRIVACY_PEPPER (16+ characters); optionally add GEMINI_KEY_1 to _3
npm run db:init:local
npm run dev                              # http://localhost:8787
```

Run the test suite while the dev server is running:

```powershell
node scripts/smoke-test.mjs
```

## Deployment

```powershell
npx wrangler login
npx wrangler d1 create domus-db          # copy the database_id into wrangler.jsonc
npm run db:init
npx wrangler secret put PRIVACY_PEPPER
npx wrangler secret put GEMINI_KEY_1     # optional: GEMINI_KEY_2, GEMINI_KEY_3
npm run deploy
```

Before onboarding real users, set `DEMO_MODE` to `"false"` in `wrangler.jsonc`. This disables the one-click demo and stops showing sign-in codes on screen. Complete the open items in the policy pages, which are drafts pending legal review.

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
| `/` | Landing page: product overview, how it works, privacy, Gemini key usage, FAQ |
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
- Profiles and sample homes in the demo are fictional.
- Agreement drafts and scam assessments are advisory and are not legal advice.
- Policy pages are drafts that require legal review.

## Project structure

```
src/worker.js            API, privacy controls, Gemini integration, fallbacks
schema.sql               D1 database schema
wrangler.jsonc           Worker configuration (assets, database binding, variables)
public/                  Frontend: application (/app/), landing page, policy pages, assets
scripts/smoke-test.mjs   API test suite
.dev.vars.example        Template for local secrets (copy to .dev.vars; never commit it)
research-links.md        Market and background research sources
```

## Team

**SoftTouch**

---

© SoftTouch. Demonstration build. All rights reserved.
