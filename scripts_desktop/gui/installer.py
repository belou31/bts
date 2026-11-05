#!/usr/bin/env python3
"""
BTS Desktop Installer — Tkinter GUI to set up automation_client credentials,
install the LibreOffice macros + Add-ons menu, and point to the Excel VBA /
Apple Numbers AppleScript stubs. Stdlib-only (tkinter), same constraint as
the rest of scripts_desktop/.

Usage:
    python3 scripts_desktop/gui/installer.py
"""

from __future__ import annotations

import inspect
import os
import platform
import shutil
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk
from typing import Dict, Optional


def _module_dir() -> Path:
    try:
        return Path(__file__).resolve().parent
    except NameError:
        frame = inspect.currentframe()
        if frame is None:
            raise
        return Path(inspect.getfile(frame)).resolve().parent


REPO_ROOT = _module_dir().parent.parent  # scripts_desktop/gui -> scripts_desktop -> repo root

try:
    from automation_client import AutomationClient, AutomationConfig, AutomationError, default_env_path
except ImportError:
    if str(REPO_ROOT) not in sys.path:
        sys.path.append(str(REPO_ROOT))
    from automation_client import AutomationClient, AutomationConfig, AutomationError, default_env_path  # type: ignore

OS_NAME = platform.system()  # 'Linux', 'Windows', 'Darwin'

AUTOMATION_CLIENT_DIR = REPO_ROOT / 'automation_client'
LIBREOFFICE_SRC_DIR = REPO_ROOT / 'scripts_desktop' / 'libreoffice'
CLI_SRC_DIR = REPO_ROOT / 'scripts_desktop' / 'cli'
MICROSOFT_SRC_DIR = REPO_ROOT / 'scripts_desktop' / 'microsoft_excel'
NUMBERS_SRC_DIR = REPO_ROOT / 'scripts_desktop' / 'apple_numbers'
OXT_PATH = LIBREOFFICE_SRC_DIR / 'bts-menu.oxt'

DEFAULT_SCOPES = 'automation:jobs:write automation:jobs:run automation:jobs:read'


# === Path helpers ============================================================

def libreoffice_scripts_dir() -> Path:
    if OS_NAME == 'Windows':
        base = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
        return Path(base) / 'LibreOffice' / '4' / 'user' / 'Scripts' / 'python'
    if OS_NAME == 'Darwin':
        return Path.home() / 'Library' / 'Application Support' / 'LibreOffice' / '4' / 'user' / 'Scripts' / 'python'
    return Path.home() / '.config' / 'libreoffice' / '4' / 'user' / 'Scripts' / 'python'


def find_unopkg() -> Optional[Path]:
    on_path = shutil.which('unopkg')
    if on_path:
        return Path(on_path)

    candidates = []
    if OS_NAME == 'Windows':
        candidates = [
            Path('C:/Program Files/LibreOffice/program/unopkg.com'),
            Path('C:/Program Files (x86)/LibreOffice/program/unopkg.com'),
        ]
    elif OS_NAME == 'Darwin':
        candidates = [Path('/Applications/LibreOffice.app/Contents/MacOS/unopkg')]
    else:
        candidates = [Path('/usr/bin/unopkg'), Path('/usr/lib/libreoffice/program/unopkg')]
        candidates += sorted(Path('/opt').glob('libreoffice*/program/unopkg'))

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


# === automation.env read/write ==============================================

def read_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_env_file(path: Path, values: Dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ['# Written by scripts_desktop/gui/installer.py']
    for key, value in values.items():
        lines.append(f'{key}={value}')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best-effort on platforms without POSIX permissions (e.g. Windows)


# === Install actions ==========================================================

_IGNORE_PATTERNS = shutil.ignore_patterns('__pycache__', '*.pyc', 'bts-menu-creation', '*.oxt')


def install_libreoffice_macros(target_dir: Path, log) -> None:
    desktop_target = target_dir / 'scripts_desktop'
    log(f'Copying automation_client -> {target_dir / "automation_client"}')
    shutil.copytree(AUTOMATION_CLIENT_DIR, target_dir / 'automation_client',
                     dirs_exist_ok=True, ignore=_IGNORE_PATTERNS)
    log(f'Copying scripts_desktop/libreoffice -> {desktop_target / "libreoffice"}')
    shutil.copytree(LIBREOFFICE_SRC_DIR, desktop_target / 'libreoffice',
                     dirs_exist_ok=True, ignore=_IGNORE_PATTERNS)
    log(f'Copying scripts_desktop/cli -> {desktop_target / "cli"}')
    shutil.copytree(CLI_SRC_DIR, desktop_target / 'cli',
                     dirs_exist_ok=True, ignore=_IGNORE_PATTERNS)
    log('Macros installed. Restart LibreOffice/Calc to pick them up.')


def install_addons_extension(unopkg_path: Path, log) -> None:
    if not OXT_PATH.is_file():
        raise RuntimeError(f'Extension archive not found: {OXT_PATH}')
    log(f'Running: {unopkg_path} add --force "{OXT_PATH}"')
    result = subprocess.run(
        [str(unopkg_path), 'add', '--force', str(OXT_PATH)],
        capture_output=True, text=True, timeout=60,
    )
    for line in (result.stdout or '').splitlines():
        log(f'  {line}')
    for line in (result.stderr or '').splitlines():
        log(f'  {line}')
    if result.returncode != 0:
        raise RuntimeError(f'unopkg exited with code {result.returncode} (close LibreOffice first if it is running)')
    log('Add-ons menu installed.')


def test_connection(base_url: str, secret: str, issuer: str, audience: str, scopes: str, log) -> None:
    config = AutomationConfig(
        base_url=base_url, secret=secret, issuer=issuer, audience=audience,
        scopes=tuple(scopes.split()),
    )
    client = AutomationClient(config, integration='bts-installer', requested_by='bts-installer')
    response = client.list_scripts()
    scripts = response.get('scripts', [])
    log(f'Connected. Server knows {len(scripts)} automation script(s):')
    for entry in scripts[:10]:
        log(f"  - {entry.get('id', '?')}")
    if len(scripts) > 10:
        log(f'  ... and {len(scripts) - 10} more.')


# === GUI ======================================================================

class InstallerApp(ttk.Frame):
    def __init__(self, master: tk.Tk) -> None:
        super().__init__(master, padding=10)
        self.master = master
        master.title('BTS Desktop Installer')
        master.geometry('720x620')
        self.pack(fill='both', expand=True)

        self.env_path = default_env_path()
        existing = read_env_file(self.env_path)

        self.base_url_var = tk.StringVar(value=existing.get('BTS_BASE_URL', 'http://127.0.0.1:8080'))
        self.secret_var = tk.StringVar(value=existing.get('AUTOMATION_JWT_SECRET', ''))
        self.issuer_var = tk.StringVar(value=existing.get('AUTOMATION_JWT_ISS', ''))
        self.audience_var = tk.StringVar(value=existing.get('AUTOMATION_JWT_AUD', 'bts-automation'))
        self.scopes_var = tk.StringVar(value=existing.get('AUTOMATION_JWT_SCOPES', DEFAULT_SCOPES))

        self.lo_target_var = tk.StringVar(value=str(libreoffice_scripts_dir()))
        found_unopkg = find_unopkg()
        self.unopkg_var = tk.StringVar(value=str(found_unopkg) if found_unopkg else '')

        notebook = ttk.Notebook(self)
        notebook.pack(fill='both', expand=True)

        self._build_credentials_tab(notebook)
        self._build_libreoffice_tab(notebook)
        self._build_excel_tab(notebook)
        self._build_numbers_tab(notebook)

        ttk.Label(self, text='Log').pack(anchor='w', pady=(10, 0))
        self.log_widget = scrolledtext.ScrolledText(self, height=10, state='disabled', wrap='word')
        self.log_widget.pack(fill='both', expand=False)

        self.log(f'OS detected: {OS_NAME}')
        self.log(f'Credentials file: {self.env_path}')

    def log(self, message: str) -> None:
        self.log_widget.configure(state='normal')
        self.log_widget.insert('end', message + '\n')
        self.log_widget.see('end')
        self.log_widget.configure(state='disabled')
        self.log_widget.update_idletasks()

    # --- Credentials tab -----------------------------------------------------

    def _build_credentials_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=10)
        notebook.add(tab, text='Credentials')

        ttk.Label(tab, text=f'Written to: {self.env_path}', foreground='#555').grid(
            row=0, column=0, columnspan=2, sticky='w', pady=(0, 10))

        self._labeled_entry(tab, 1, 'BTS base URL', self.base_url_var)
        self._labeled_entry(tab, 2, 'JWT secret (AUTOMATION_JWT_SECRET)', self.secret_var, show='*')
        self._labeled_entry(tab, 3, 'Issuer (optional)', self.issuer_var)
        ttk.Label(
            tab,
            text='Leave blank: each tool (LibreOffice, CLI, ...) uses its own default. Only set this\n'
                 'if you specifically want every local tool to report the same issuer.',
            foreground='#555', justify='left',
        ).grid(row=4, column=0, columnspan=2, sticky='w', pady=(0, 3))
        self._labeled_entry(tab, 5, 'Audience', self.audience_var)
        self._labeled_entry(tab, 6, 'Scopes (space-separated)', self.scopes_var)

        button_row = ttk.Frame(tab)
        button_row.grid(row=7, column=0, columnspan=2, sticky='w', pady=(15, 0))
        ttk.Button(button_row, text='Save credentials', command=self.on_save_credentials).pack(side='left')
        ttk.Button(button_row, text='Test connection', command=self.on_test_connection).pack(side='left', padx=(10, 0))

        tab.columnconfigure(1, weight=1)

    def _labeled_entry(self, parent: ttk.Frame, row: int, label: str, var: tk.StringVar, show: str = '') -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky='w', pady=3)
        entry = ttk.Entry(parent, textvariable=var, show=show)
        entry.grid(row=row, column=1, sticky='ew', pady=3, padx=(10, 0))

    def on_save_credentials(self) -> None:
        if not self.secret_var.get().strip():
            messagebox.showerror('Missing secret', 'AUTOMATION_JWT_SECRET is required.')
            return
        values = {
            'BTS_BASE_URL': self.base_url_var.get().strip(),
            'AUTOMATION_JWT_SECRET': self.secret_var.get().strip(),
            'AUTOMATION_JWT_AUD': self.audience_var.get().strip(),
            'AUTOMATION_JWT_SCOPES': self.scopes_var.get().strip(),
        }
        # Only persist an issuer override if the operator actually typed one —
        # otherwise each tool's own default (libreoffice / bts-cli / ...) applies.
        issuer = self.issuer_var.get().strip()
        if issuer:
            values['AUTOMATION_JWT_ISS'] = issuer
        try:
            write_env_file(self.env_path, values)
            self.log(f'Credentials written to {self.env_path}')
        except OSError as err:
            messagebox.showerror('Write failed', str(err))

    def on_test_connection(self) -> None:
        if not self.secret_var.get().strip():
            messagebox.showerror('Missing secret', 'AUTOMATION_JWT_SECRET is required.')
            return
        try:
            test_connection(
                self.base_url_var.get().strip(),
                self.secret_var.get().strip(),
                self.issuer_var.get().strip(),
                self.audience_var.get().strip(),
                self.scopes_var.get().strip(),
                self.log,
            )
        except AutomationError as err:
            self.log(f'Connection test failed: {err}')
            messagebox.showerror('Connection failed', str(err))

    # --- LibreOffice tab -------------------------------------------------------

    def _build_libreoffice_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=10)
        notebook.add(tab, text='LibreOffice')

        ttk.Label(tab, text='Macro install location (Scripts/python):').grid(row=0, column=0, sticky='w')
        row1 = ttk.Frame(tab)
        row1.grid(row=1, column=0, columnspan=2, sticky='ew', pady=(3, 15))
        ttk.Entry(row1, textvariable=self.lo_target_var).pack(side='left', fill='x', expand=True)
        ttk.Button(row1, text='Browse…', command=self._browse_lo_target).pack(side='left', padx=(5, 0))
        ttk.Button(tab, text='Install macros', command=self.on_install_macros).grid(row=2, column=0, sticky='w')

        ttk.Separator(tab, orient='horizontal').grid(row=3, column=0, columnspan=2, sticky='ew', pady=15)

        ttk.Label(tab, text='unopkg (LibreOffice extension installer):').grid(row=4, column=0, sticky='w')
        row2 = ttk.Frame(tab)
        row2.grid(row=5, column=0, columnspan=2, sticky='ew', pady=(3, 15))
        ttk.Entry(row2, textvariable=self.unopkg_var).pack(side='left', fill='x', expand=True)
        ttk.Button(row2, text='Browse…', command=self._browse_unopkg).pack(side='left', padx=(5, 0))
        ttk.Button(tab, text='Install Add-ons menu (.oxt)', command=self.on_install_addons).grid(row=6, column=0, sticky='w')
        ttk.Label(tab, text='Close LibreOffice before installing the extension.', foreground='#a00').grid(
            row=7, column=0, columnspan=2, sticky='w', pady=(5, 0))

        tab.columnconfigure(0, weight=1)

    def _browse_lo_target(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.lo_target_var.get() or str(Path.home()))
        if chosen:
            self.lo_target_var.set(chosen)

    def _browse_unopkg(self) -> None:
        chosen = filedialog.askopenfilename(initialdir=str(Path.home()))
        if chosen:
            self.unopkg_var.set(chosen)

    def on_install_macros(self) -> None:
        target = Path(self.lo_target_var.get().strip())
        try:
            install_libreoffice_macros(target, self.log)
            messagebox.showinfo('Done', 'LibreOffice macros installed. Restart Calc to pick them up.')
        except OSError as err:
            self.log(f'Install failed: {err}')
            messagebox.showerror('Install failed', str(err))

    def on_install_addons(self) -> None:
        unopkg_str = self.unopkg_var.get().strip()
        if not unopkg_str:
            messagebox.showerror('unopkg not found', 'Locate unopkg manually via Browse… (ships inside your LibreOffice install).')
            return
        try:
            install_addons_extension(Path(unopkg_str), self.log)
            messagebox.showinfo('Done', 'Add-ons menu installed. Restart LibreOffice.')
        except (RuntimeError, OSError, subprocess.SubprocessError) as err:
            self.log(f'Install failed: {err}')
            messagebox.showerror('Install failed', str(err))

    # --- Excel tab ---------------------------------------------------------

    def _build_excel_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=10)
        notebook.add(tab, text='Excel (VBA)')

        text = (
            'Excel VBA modules aren\u2019t auto-installed (importing a .bas module into a\n'
            'workbook needs COM automation on Windows or AppleScript on Mac \u2014 more moving\n'
            'parts than the 15-second manual step below).\n\n'
            f'Source folder:\n{MICROSOFT_SRC_DIR}\n\n'
            'To install by hand, in Excel:\n'
            '  1. Alt+F11 to open the VBA editor.\n'
            '  2. File \u2192 Import File\u2026, pick BTSMenu.bas (and any module under\n'
            '     03-season-management/).\n'
            '  3. Run InstallBtsMenu once to create the BTS menu.\n'
        )
        label = ttk.Label(tab, text=text, justify='left')
        label.pack(anchor='w')
        ttk.Button(tab, text='Open source folder', command=lambda: self._open_folder(MICROSOFT_SRC_DIR)).pack(
            anchor='w', pady=(10, 0))

    # --- Numbers tab ---------------------------------------------------------

    def _build_numbers_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=10)
        notebook.add(tab, text='Numbers (AppleScript)')

        os_note = '' if OS_NAME == 'Darwin' else '\n(This machine is not macOS — informational only.)\n'
        text = (
            'Placeholder — not implemented yet. Numbers has no embedded macro language,\n'
            'so automation lives outside the document as an AppleScript triggered from the\n'
            'macOS Script Menu, not a macro attached to the file (see apple_numbers/README.md).\n'
            f'{os_note}\n'
            f'Source folder:\n{NUMBERS_SRC_DIR}\n\n'
            'To install once a script is implemented:\n'
            '  1. Open Script Editor, paste the script, File → Save As… (Format: Script)\n'
            '     into ~/Library/Scripts/Applications/Numbers/.\n'
            '  2. Script Editor → Preferences → General → enable "Show Script menu\n'
            '     in menu bar" (one-time).\n'
            '  3. With a document open, find it under the Script Menu → Numbers.\n'
        )
        label = ttk.Label(tab, text=text, justify='left')
        label.pack(anchor='w')
        ttk.Button(tab, text='Open source folder', command=lambda: self._open_folder(NUMBERS_SRC_DIR)).pack(
            anchor='w', pady=(10, 0))

    def _open_folder(self, path: Path) -> None:
        path_str = str(path)
        try:
            if OS_NAME == 'Windows':
                os.startfile(path_str)  # type: ignore[attr-defined]
            elif OS_NAME == 'Darwin':
                subprocess.run(['open', path_str], check=False)
            else:
                subprocess.run(['xdg-open', path_str], check=False)
        except OSError as err:
            messagebox.showerror('Could not open folder', str(err))


def main() -> None:
    root = tk.Tk()
    InstallerApp(root)
    root.mainloop()


if __name__ == '__main__':
    main()
