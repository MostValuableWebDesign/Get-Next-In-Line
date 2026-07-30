# Launch Report — Get Next In Line
**Date:** 2026-07-28  
**Deployment target:** Autoscale  
**Production domain:** getnextinline.com  

---

## Configuration completed

### Deployment configuration
| Item | Status | Notes |
|------|--------|-------|
| Deployment target | ✅ Autoscale | Set in `.replit` `deploymentTarget = "autoscale"` |
| API server production build | ✅ | `pnpm --filter @workspace/api-server run build` (esbuild bundle) |
| SPA production build | ✅ | `pnpm --filter @workspace/gnil-os run build` → static files |
| SPA static serving | ✅ | Artifact serves `artifacts/gnil-os/dist/public` as static, with `/* → /index.html` rewrite |
| API health startup probe | ✅ Updated | Path: `/api/healthz/ready` (checks DB + concierge worker; previously `/api/healthz`) |

### Environment variables set
| Variable | Environment | Value |
|----------|-------------|-------|
| `APP_BASE_URL` | production | `https://getnextinline.com` |

### Secrets confirmed present
| Secret | Status |
|--------|--------|
| `SESSION_SECRET` | ✅ Set |
| `ADMIN_PASSWORD` | ✅ Set |
| `DATABASE_URL` | ✅ Runtime-managed by Replit |
| Stripe keys | ✅ Via Replit Stripe integration (auto-injected) |

### Outbound services
| Service | Mode | Action needed |
|---------|------|---------------|
| Stripe | 🟢 Live | Configured via Replit integration |
| SMS (Twilio) | 🟢 Live | Credentials via Replit Twilio connector + `TWILIO_PHONE_NUMBER` secret |
| Email (Resend) | 🟡 Simulated | Set `RESEND_API_KEY` to go live |
| AI / OpenAI | 🟡 Simulated | Set `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY` to go live |

---

## Steps to go live

### 1. Migrate the production database (before first publish)
The server checks for schema drift at startup and **refuses to boot** if the production DB is behind.
On first deploy Replit provisions the production DB from development, so this is automatic.
On subsequent deploys where schema changed, run:
```
pnpm run db:push   # against production DATABASE_URL
```

### 2. Click Publish
Open **Publishing** → click **Publish** to trigger the autoscale deployment.

### 3. Bind the custom domain
After publish, open **Publishing → Domains** and add `getnextinline.com`.
Add the DNS records shown by Replit at your registrar:
- `A` record: `getnextinline.com` → Replit IP
- `CNAME` record: `www.getnextinline.com` → your `.replit.app` subdomain

TLS is issued automatically once DNS propagates (~2–15 minutes).

### 4. Stripe webhook endpoint
Register `https://getnextinline.com/api/webhooks/stripe` in the Stripe dashboard
(Developers → Webhooks). The `stripe-replit-sync` library auto-registers managed
webhooks at startup, so this may already be handled.

---

## Smoke test checklist (run against live domain once deployed)

```
# 1. Liveness
curl -s https://getnextinline.com/api/healthz
# expect: {"status":"ok"}

# 2. Readiness (DB + concierge worker)
curl -s https://getnextinline.com/api/healthz/ready
# expect: {"status":"ok"} — 503 means DB or worker issue

# 3. SPA loads
curl -sI https://getnextinline.com/
# expect: 200, Content-Type: text/html

# 4. SPA deep-link rewrite (wouter client-side route)
curl -sI https://getnextinline.com/some/deep/route
# expect: 200 (rewritten to index.html, not 404)

# 5. CORS — disallowed origin must be rejected
curl -sI -H "Origin: https://evil.example.com" \
     https://getnextinline.com/api/healthz
# expect: no Access-Control-Allow-Origin header

# 6. Admin login (session cookie)
curl -sc /tmp/cookies.txt \
     -X POST https://getnextinline.com/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"password":"<ADMIN_PASSWORD>"}' | head -c 200
# expect: 200 + Set-Cookie: connect.sid with Secure; SameSite=None

# 7. Authenticated admin request
curl -sb /tmp/cookies.txt https://getnextinline.com/api/auth/me
# expect: 200 with admin identity

# 8. Stripe webhook reachability
curl -sI -X POST https://getnextinline.com/api/webhooks/stripe \
     -H "stripe-signature: t=0,v1=test"
# expect: 400 (invalid sig) not 404 — confirms route exists
```

---

## Non-blocking findings

1. **SMS and email run in simulated mode** — provide Twilio and Resend credentials to activate live sends. No functionality is blocked; messages are logged/discarded instead.
2. **AI receptionist in fallback mode** — AI parsing uses a rule-based fallback without OpenAI keys. Provide `AI_INTEGRATIONS_OPENAI_*` env vars for full AI parsing.
3. **Production DB migration must be manual on schema changes** — the server refuses to auto-migrate in production (by design). Establish an operational runbook: run `pnpm run db:push` against the production DATABASE_URL before deploying schema changes.
4. **Custom domain DNS propagation** — allow up to 15 minutes for TLS certificate issuance after DNS records are added.
