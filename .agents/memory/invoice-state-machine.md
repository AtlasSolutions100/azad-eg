---
name: Invoice status state machine
description: How invoice status transitions are guarded in the api-server invoice routes.
---

Invoice status enum: `draft | in_review | approved | exported`.

The rule: status changes flow only through dedicated endpoints, never the generic update.

- `PATCH /invoices/:id` must NOT write `status` — it is stripped from the body before
  the DB update. (If status was the only field sent, the handler selects the current row
  instead of issuing an empty `.set({})`, which Drizzle rejects.)
- `POST /invoices/:id/approve` only allowed from `draft` or `in_review`; otherwise 409.
- `POST /invoices/:id/generate` always produces the file (preview is allowed at any
  status) but only advances status to `exported` when the invoice is already `approved`.

**Why:** A draft must not reach `exported`/billed state without going through approval,
or dashboard billing metrics and the audit trail get polluted. The generic PATCH
accepting an arbitrary `status` was the bypass that broke this.

**How to apply:** Any new status-changing behavior belongs in its own endpoint with an
explicit allowed-prior-status check, not added to the generic update body.
