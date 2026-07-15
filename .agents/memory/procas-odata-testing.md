---
name: Procas OData test mocks
description: Gotchas when asserting OData $filter contents in fetch mocks
---
URLSearchParams encodes spaces as `+`, and decodeURIComponent does NOT turn `+` back into spaces. Test mocks that match decoded OData filters (e.g. "TransDate ge ...") must do `decodeURIComponent(url.replace(/\+/g, " "))` first or every filter match silently fails.
**How to apply:** any fetch-mock helper that inspects Procas/OData query strings.

E2E: /procas/connect validates credentials against the real Procas API, so a failing live sync can't be set up through the UI. Instead seed the single procas_connection row (id=1) directly via @workspace/db with connected=true and bogus plaintext credentials — plaintext passwords are tolerated as legacy and re-sealed on first read. Restore the exact original row (ciphertext untouched) afterwards; the dev DB is shared.
