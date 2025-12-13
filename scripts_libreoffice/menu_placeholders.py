"""
LibreOffice helper macros that surface BTS CLI commands.

Each handler displays the canonical Node.js script invocation so operators
can copy/paste it from LibreOffice. The menu extension wires these placeholders
to the Add-ons → BTS submenu until native automations are implemented.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

import uno


def _module_dir() -> Path:
    try:
        return Path(__file__).resolve().parent
    except NameError:
        frame = inspect.currentframe()
        if frame is None:
            raise
        return Path(inspect.getfile(frame)).resolve().parent


try:
    from scripts_libreoffice.env_loader import ensure_loaded as _ensure_env_loaded
    from scripts_libreoffice.log_utils import capture_logs, current_log_path
except ImportError:
    module_dir = _module_dir()
    parent_dir = module_dir.parent
    for candidate in (module_dir, parent_dir):
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.append(candidate_str)
    from env_loader import ensure_loaded as _ensure_env_loaded  # type: ignore
    from log_utils import capture_logs, current_log_path  # type: ignore

_ensure_env_loaded()


def _notify(message: str) -> None:
    """Show a message box in LibreOffice (fallback to stdout in headless mode)."""
    log_path = current_log_path()
    if log_path:
        message = f"{message}\n\nLog file: {log_path}"

    try:
        desktop = XSCRIPTCONTEXT.getDesktop()
        frame = desktop.getCurrentFrame()
        window = frame.getContainerWindow()
        if window is None:
            raise RuntimeError("No active window")
        toolkit = window.getToolkit()
        box_type = uno.getConstantByName("com.sun.star.awt.MessageBoxType.INFOBOX")
        buttons = uno.getConstantByName("com.sun.star.awt.MessageBoxButtons.BUTTONS_OK")
        box = toolkit.createMessageBox(window, box_type, buttons, "BTS Scripts", message)
        box.execute()
    except Exception:
        print(f"[BTS Scripts] {message}")


def _make_handler(name: str, title: str, command: str):
    """Factory to generate per-command menu handlers."""

    def handler() -> None:
        with capture_logs(name):
            print(f"[BTS Scripts] Selected menu '{title}' -> {command}")
            _notify(f"{title}\n\nRun from BTS workspace:\n{command}")

    handler.__name__ = name
    return handler


_COMMAND_SPECS = [
    # 02 — Tariff Management
    ("tariff_import_tariffs", "Import tariffs catalog (CSV)", "node scripts/02-tariff-management/import-tariffs.js tariff_catalog.csv"),
    ("tariff_export_tariffs", "Export tariffs catalog (CSV)", "node scripts/02-tariff-management/export-tariffs.js --out=tariff_catalog.csv"),
    ("tariff_import_tariff_prices", "Import tariff prices catalog", "node scripts/02-tariff-management/import-tariff-prices.js <catalogSlug> prices.csv [--venue=<slug>]"),
    ("tariff_export_zone_tariffs", "Export zone tariffs (CSV)", "node scripts/02-tariff-management/export-zone-tariffs.js <season> <venueSlug> --out=prices.csv"),
    ("tariff_export_zone_matrix", "Export tariff × zone matrix", "node scripts/02-tariff-management/export-zone-tariffs-matrix.js <season> <venueSlug> [out.csv]"),
    ("tariff_clone_zone_tariffs", "Clone tariffs between zones", "node scripts/02-tariff-management/clone-zone-tariffs.mjs --season=<code> --venue=<slug> --from-zone=<A1> --to-zones=<B1,B2>"),
    # 03 — Season Management (core setup)
    ("season_upsert", "Create season definition", "node scripts/03-season-management/create-season.js <season> --name=\"...\" [--active=true]"),
    ("season_instantiate_venue", "Instantiate venue data for season", "node scripts/03-season-management/instantiate-venue-for-season.js <season> <slug> [--skip-seats] [--skip-zones]"),
    ("season_instantiate_tariffs", "Instantiate tariffs for season", "node scripts/03-season-management/instantiate-tariffs.js <season> <slug> --catalog=<slug[,slug2]> [--clear]"),
    ("season_import_subscription_orders", "Import subscription orders (CSV)", "node scripts/03-season-management/import-subscription-orders.js orders.csv [--season=...] [--venue=...] [--status=paid] [--commit] [--sendEmails]"),
    ("season_export_subscribers", "Export subscribers (CSV)", "node scripts/03-season-management/export-subscribers.js [--season=...] [--venue=...] [--activeOnly]"),
    ("season_export_subscription_orders", "Export subscription orders (CSV)", "node scripts/03-season-management/export-subscription-orders.js [--season=...] [--venue=...] [--status=paid]"),
    ("season_provision_seats", "Provision season seats", "node scripts/03-season-management/provision-season-seats.js [--apply]"),
    # 03 — Season Management (renewal workflow)
    ("renew_import_flat", "Import renewal subscribers (flat CSV)", "node scripts/03-season-management/import-renewers-flat.js subscribers.csv <season> --venue=<slug>"),
    ("renew_provision_seats", "Provision seats for renewal", "node scripts/03-season-management/renewal-provision-seats.js <season> --venue=<slug> [--apply]"),
    ("renew_export_groups", "Export renewal groups (CSV)", "node scripts/03-season-management/export-renew-groups.js <season> --venue=<slug> --base=<https://host/bts>"),
    ("renew_export_seats", "Export renewal seats (CSV)", "node scripts/03-season-management/export-renew-seats.js <season> --venue=<slug>"),
    ("renew_close_phase", "Close renewal phase", "node scripts/03-season-management/renewal-close-phase.js <season> [--venue=<slug>]"),
    # 04 — Event Management
    ("event_create", "Create event", "node scripts/04-event-management/create.js --slug=... --name=\"...\" --date=ISO --season=<code> --venue=<slug> [--price-table=<key>]"),
    ("event_instantiate_tariffs", "Instantiate event tariffs", "node scripts/04-event-management/instantiate-tariffs.js --event=<slug> --catalog=<slug[,slug2]> [--clear] [--dry-run]"),
    ("event_build_allowed_from_prices", "Recompute allowed-from prices", "node scripts/04-event-management/build-allowed-from-prices.js --event=<slug>"),
    ("event_set_onsale", "Toggle event on sale", "node scripts/04-event-management/set-onsale.js --event=<slug|ObjectId> --open"),
    ("event_import_qr_bank", "Import QR bank (CSV)", "node scripts/04-event-management/import-qr-bank.js --event=<slug> --csv=<codes.csv>"),
    ("event_seats_hold_release", "Manage event seat holds", "node scripts/04-event-management/seats-hold-release.js --file=holds.csv [--commit] [--force]"),
    ("event_send_all_season_tickets", "Send all season tickets for event", "node scripts/04-event-management/send-all-season-tickets-for-event.js --event=<slug> [--limit=200] [--dry-run]"),
    ("event_import_orders", "Import event orders (CSV)", "node scripts/04-event-management/import-orders.js <orders.csv> [--status=paid] [--commit] [--force] [--sendEmail]"),
    ("event_export_orders", "Export event orders (CSV)", "node scripts/04-event-management/export-orders.js --event=<slug> [--status=paid] [--out=orders.csv]"),
    ("event_resend_event_tickets", "Resend event tickets", "node scripts/04-event-management/resend-event-tickets.js --event=<slug> --order=<orderId[,orderId2]> [--status=paid] [--dry-run]"),
    ("event_tickets_pdf", "Generate tickets PDF for order", "node scripts/04-event-management/tickets-pdf.js <orderId>"),
]


for name, title, command in _COMMAND_SPECS:
    globals()[name] = _make_handler(name, title, command)


g_exportedScripts = tuple(globals()[name] for name, _, _ in _COMMAND_SPECS)
