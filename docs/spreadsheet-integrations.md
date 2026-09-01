---
title: Spreadsheet Integrations
nav_order: 100
---

# Spreadsheet Integrations

## Code areas

- `automation_client/` — shared Python client (config resolution, JWT signing, HTTP calls to `/api/automation`, env/log helpers), used by every `scripts_desktop/` surface so this glue isn't re-implemented per platform.
- `scripts_desktop/` — surfaces that run on an operator's machine:
  - `libreoffice/` — LibreOffice/OpenOffice Calc macros (Python).
  - `microsoft_excel/` — Excel desktop macros (VBA). Placeholder stubs only.
  - `apple_numbers/` — Apple Numbers macros (AppleScript, macOS only). Placeholder stubs only.
  - `cli/` — local command line (Python, reads CSVs off disk).
  - `gui/` — Tkinter installer that sets up credentials and installs the LibreOffice macros/menu.
- `scripts_online/` — surfaces that only exist in a browser/cloud runtime:
  - `google/` — Google Sheets (Apps Script).
  - `microsoft_excel/` — Excel Online/365 (Office Scripts, TypeScript).

## Current model

These integrations map spreadsheet actions to BTS automation jobs so operators can trigger imports and renewal campaigns from office tools.

## Shared dependency

They rely on the automation API and shared JWT-style secrets documented in [README.md](../README.md).
