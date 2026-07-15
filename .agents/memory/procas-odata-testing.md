---
name: Procas OData test mocks
description: Gotchas when asserting OData $filter contents in fetch mocks
---
URLSearchParams encodes spaces as `+`, and decodeURIComponent does NOT turn `+` back into spaces. Test mocks that match decoded OData filters (e.g. "TransDate ge ...") must do `decodeURIComponent(url.replace(/\+/g, " "))` first or every filter match silently fails.
**How to apply:** any fetch-mock helper that inspects Procas/OData query strings.
