from PyInstaller.utils.hooks import collect_all

spacy_datas, spacy_binaries, spacy_hiddenimports = collect_all("spacy")
model_datas, model_binaries, model_hiddenimports = collect_all("en_core_web_sm")

analysis = Analysis(
    ["umb_memory_sidecar.py"],
    pathex=["."],
    binaries=spacy_binaries + model_binaries,
    datas=spacy_datas + model_datas,
    hiddenimports=sorted(set(spacy_hiddenimports + model_hiddenimports + ["en_core_web_sm"])),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="umb-memory-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="umb-memory-sidecar",
)
