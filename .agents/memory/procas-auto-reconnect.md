---
name: Procas auto-reconnect & fixed company code
description: How the Procas connection self-heals and why the connect form has no company code field.
---

The Procas OData feed URL is fixed per customer (`…/ProcasData/v1/<company>`), company `AZADEN` here (env `PROCAS_COMPANY_CODE`, default "AZADEN"). The connect form asks only username + password.

**Auto-reconnect:** if `PROCAS_USERNAME` / `PROCAS_PASSWORD` Replit secrets are set, the server restores a lost connection automatically — at startup and on each scheduler cycle when disconnected (fresh DB, disconnect, unreadable credential after key rotation). Verified live: full library import created ~509 work plans.

**Why:** the dev DB has been reset repeatedly, wiping the `procas_connection` row; Julie should never have to re-enter credentials.

**How to apply:** never store the Procas password in memory/files — it lives encrypted in the DB and as Replit secrets. If the connection looks down, check the secrets exist and restart the API workflow rather than asking Julie for credentials.
