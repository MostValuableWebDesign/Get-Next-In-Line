---
name: Artifact path shadowing
description: An artifact's registered previewPath prefix shadows same-prefix routes in the root web app.
---

The proxy routes by path prefix from each artifact's `artifact.toml` `paths`. If a standalone artifact owns `/foo/`, the root app's client-side routes at `/foo/*` are unreachable — the proxy sends `/foo` and `/foo/` to that artifact first.

**Why:** hit this when merging the SOS app into GNIL OS — GNIL's new `/sos` routes were shadowed by the retired SOS artifact still registered at `/sos/`.

**How to apply:** when merging/retiring an artifact whose old path should now be handled by the root app, change the retired artifact's `previewPath`/`paths` (via `verifyAndReplaceArtifactToml`) to a non-conflicting prefix (e.g. `/sos-legacy/`) so the path falls through to the root app. Wouter/regexparam routes tolerate trailing slashes, so `/sos/` matches a `/sos` route.
