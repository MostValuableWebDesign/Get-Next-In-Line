---
name: Testing admin APIs with curl
description: How to authenticate curl requests against the session-protected API server in dev
---

All `/api` routes (except login) require a session. The session cookie is marked Secure, so it is dropped over plain `http://localhost:80`.

**How to apply:** login and test over HTTPS via the dev domain:
```bash
curl -c jar.txt -X POST "https://$REPLIT_DEV_DOMAIN/api/auth/login" -H 'Content-Type: application/json' -d "{\"password\":\"$ADMIN_PASSWORD\"}"
curl -b jar.txt "https://$REPLIT_DEV_DOMAIN/api/..."
```
Screenshots of the web app also land on the login screen; API-level verification is the practical path.

## Supertest and the Secure session cookie
In-process supertest requests look like plain HTTP, so express-session (Secure cookie + `trust proxy`) sends no Set-Cookie on login. Set `X-Forwarded-Proto: https` on the login request, then replay the raw cookie value via `.set("Cookie", ...)` (superagent won't replay Secure cookies over http).
