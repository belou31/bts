"""
LibreOffice-specific: show a message box for the user, falling back to a
printed (logged) message if no UI is available. UNO-coupled, so this stays
here rather than in `automation_client` (which has no UNO dependency).
"""

from __future__ import annotations

import traceback

import uno

from automation_client import current_log_path


def _window_from_document(document) -> object:
    """Best-effort: the window that owns the document's own frame, if any."""
    controller = getattr(document, 'CurrentController', None)
    frame = getattr(controller, 'Frame', None) if controller is not None else None
    return getattr(frame, 'ContainerWindow', None) if frame is not None else None


def _window_from_desktop() -> object:
    """
    Fallback: the desktop's globally "current" frame. Bootstrapped via
    `uno.getComponentContext()` rather than the `XSCRIPTCONTEXT` global,
    since that global only exists in the namespace of whichever module
    LibreOffice directly invoked — it is not available to an imported
    helper like this one.
    """
    ctx = uno.getComponentContext()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
    frame = desktop.getCurrentFrame()
    return frame.getContainerWindow() if frame is not None else None


def notify(message: str, *, document=None) -> None:
    """
    Show a message box. Pass the macro's own `document` (from
    `XSCRIPTCONTEXT.getDocument()`) when available — its frame resolves far
    more reliably than the desktop's "current frame", which can be stale or
    unset depending on how the script was invoked (Add-ons menu vs.
    Tools > Macros vs. headless).
    """
    log_path = current_log_path()
    if log_path:
        message = f'{message}\n\nLog file: {log_path}'
    try:
        window = _window_from_document(document) if document is not None else None
        if window is None:
            window = _window_from_desktop()
        if window is None:
            raise RuntimeError('No window available to parent the message box.')
        toolkit = window.getToolkit()
        # MessageBoxType is a UNO *enum*, not a constants group — uno.getConstantByName()
        # raises for it (confirmed: pyuno.getConstantByName: ...INFOBOX is not a constant).
        # MessageBoxButtons genuinely is a constants group, so getConstantByName is correct there.
        box_type = uno.Enum('com.sun.star.awt.MessageBoxType', 'INFOBOX')
        buttons = uno.getConstantByName('com.sun.star.awt.MessageBoxButtons.BUTTONS_OK')
        msgbox = toolkit.createMessageBox(window, box_type, buttons, 'BTS Automation', str(message))
        msgbox.execute()
    except Exception:
        # Never let a UI failure hide the actual result from the log — print
        # both the intended message and the real reason the message box failed.
        print(f'[BTS Automation] {message}')
        print('[BTS Automation] notify() could not show a message box:')
        traceback.print_exc()


__all__ = ['notify']
