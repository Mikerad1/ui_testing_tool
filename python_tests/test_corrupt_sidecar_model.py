import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "corrupt-sidecar-model.py"
SPEC = importlib.util.spec_from_file_location("corrupt_sidecar_model", SCRIPT)
corrupt_model = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(corrupt_model)


class CorruptSidecarModelTests(unittest.TestCase):
    def test_removes_correct_package_from_copy_and_keeps_executable(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            output = root / "copy"
            package = source / "_internal" / "en_core_web_sm"
            package.mkdir(parents=True)
            (package / "meta.json").write_text(
                json.dumps({"name": "core_web_sm", "version": "3.8.0"}),
                encoding="utf-8",
            )
            executable_name = "umb-memory-sidecar.exe" if os.name == "nt" else "umb-memory-sidecar"
            (source / executable_name).write_text("runtime", encoding="utf-8")

            with patch.object(sys, "argv", [str(SCRIPT), "--source", str(source), "--output", str(output)]):
                corrupt_model.main()

            self.assertTrue((source / "_internal" / "en_core_web_sm" / "meta.json").is_file())
            self.assertFalse((output / "_internal" / "en_core_web_sm").exists())
            self.assertEqual((output / executable_name).read_text(encoding="utf-8"), "runtime")

    def test_rejects_wrong_version_and_wrong_package_directory(self):
        with TemporaryDirectory() as temporary:
            onedir = Path(temporary)
            wrong_version = onedir / "_internal" / "en_core_web_sm" / "meta.json"
            wrong_version.parent.mkdir(parents=True)
            wrong_version.write_text('{"name":"core_web_sm","version":"3.7.0"}', encoding="utf-8")
            wrong_package = onedir / "_internal" / "some_other_model" / "meta.json"
            wrong_package.parent.mkdir(parents=True)
            wrong_package.write_text('{"name":"core_web_sm","version":"3.8.0"}', encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "cannot find en_core_web_sm 3.8.0 metadata"):
                corrupt_model.remove_model_package(onedir)

            self.assertTrue(wrong_version.is_file())
            self.assertTrue(wrong_package.is_file())


if __name__ == "__main__":
    unittest.main()
