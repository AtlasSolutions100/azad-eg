---
name: Package billing burden-rate gotcha
description: Why BART package documents can show $0 for Overhead/FCCM even when generation "works".
---

# Package billing burden-rate gotcha (azad-invoice)

The five BART package documents aggregate from timesheet hours × employee rates ×
work-plan **burden rates**. The manual workflow needs no Procas/API — Procas only
automates the timesheet-hours entry step; everything downstream is identical.

## Rule: nullable burden rates produce $0 silently
Work-plan `overheadRate` and `fccmRate` are nullable with **no default**, while
`fringeRate` (120.58) and `fixedFeeRate` (8) have defaults. If overhead/FCCM are
not set on the work plan, those lines render as **$0** in every generated document
even though the document otherwise looks correct.

**Why:** users reported "numbers not populating" — the engine was fine, but the
work-plan form historically didn't expose the burden-rate inputs, so overhead/FCCM
stayed null.

**How to apply:**
- The work-plan form must expose fringe/overhead/fixed-fee/FCCM (as percentages).
- Hydrate nullable rate fields in edit mode with `?? undefined`, never raw — the
  update body type forbids `null`, so a persisted `null` causes a 400 on save.
