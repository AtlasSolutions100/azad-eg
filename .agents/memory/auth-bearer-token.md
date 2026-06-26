---
name: Web→API auth needs Bearer token, not just cookie
description: Why the azad-invoice web app must attach a Clerk Bearer token to API calls instead of relying on the session cookie.
---

# Web→API auth: attach Clerk Bearer token

The `@workspace/api-client-react` `customFetch` supports two auth modes: an
automatic browser session cookie (default) and an explicit Bearer token via
`setAuthTokenGetter`. The web app originally wired only `setBaseUrl` and relied
on the cookie.

**Rule:** the web frontend must call `setAuthTokenGetter(() => getToken())`
(Clerk `useAuth().getToken`) so every API request carries
`Authorization: Bearer <token>`.

**Why:** the cookie-only path silently fails (every `/api` call returns 401)
whenever the app is NOT a top-level same-origin tab — most notably inside the
Replit canvas iframe (third-party cookies blocked) and cross-origin
deployments. The server (`@clerk/express` `getAuth`) accepts the Bearer token
in all those contexts; the cookie is not sent. Symptom looked like a feature
bug ("packages won't load / nothing aggregates") but was global 401s.

**How to apply:** register the getter inside `ClerkProvider` using the reactive
`useAuth()` hook (not `useClerk().session`, which may not re-render on sign-in),
re-registering when `getToken`/`isSignedIn` change. `getToken()` returns a
fresh, unexpired token per call and null when signed out, and `customFetch`
invokes the getter before every request — so token expiry is handled.
