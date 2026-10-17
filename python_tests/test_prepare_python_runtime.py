import importlib.util
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/prepare-python-runtime.py"
SPEC = importlib.util.spec_from_file_location("prepare_python_runtime", SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(prepare)


class PrepareWindowsRuntimeTests(unittest.TestCase):
    version = "3.13.16"
    installer_name = "python-3.13.16-amd64.exe"

    def make_zip(self, root: Path, entries):
        archive = root / "runtime.zip"
        with zipfile.ZipFile(archive, "w") as output:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name, payload in entries:
                    output.writestr(name, payload)
        return archive

    def test_extracts_only_expected_full_installer_and_never_setup_script(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.make_zip(root, [(self.installer_name, b"installer-binary"), ("setup.ps1", b"must-not-run")])
            staging = root / "staging"
            result = prepare.extract_windows_installer(archive, staging, self.version)
            self.assertEqual(result.name, self.installer_name)
            self.assertEqual(result.read_bytes(), b"installer-binary")
            self.assertEqual(sorted(item.name for item in staging.iterdir()), [self.installer_name])

    def test_rejects_missing_or_ambiguous_installer_and_unexpected_paths(self):
        cases = [
            [("setup.ps1", b"setup")],
            [(self.installer_name, b"one"), (self.installer_name, b"two"), ("setup.ps1", b"setup")],
            [(self.installer_name, b"installer"), ("setup.ps1", b"setup"), ("extra.txt", b"unexpected")],
            [(f"nested/{self.installer_name}", b"installer"), ("setup.ps1", b"setup")],
            [(self.installer_name, b"installer"), ("../setup.ps1", b"setup")],
        ]
        for entries in cases:
            with self.subTest(entries=[name for name, _ in entries]), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.make_zip(root, entries)
                with self.assertRaises((ValueError, KeyError)):
                    prepare.extract_windows_installer(archive, root / "stage", self.version)

    def test_installer_command_is_quiet_per_user_pip_enabled_and_path_neutral(self):
        command = prepare.windows_installer_command(Path("installer.exe"), Path("target dir"))
        self.assertEqual(command, [
            "installer.exe", "/quiet", "TargetDir=target dir", "InstallAllUsers=0",
            "Include_pip=1", "Include_launcher=0", "PrependPath=0", "AppendPath=0",
        ])

    def test_installer_runner_uses_argument_list_sanitized_env_and_checks_exit_status(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        original_env = {"PATH": "system-path", "PYTHONPATH": "hostile", "PYTHONHOME": "hostile-home", "VIRTUAL_ENV": "bad"}
        command, exit_status = prepare.run_windows_installer(Path("installer.exe"), Path("target"), runner=runner, environment=original_env)
        actual_command, kwargs = calls[0]
        self.assertEqual(actual_command, command)
        self.assertEqual(exit_status, 0)
        self.assertIsInstance(actual_command, list)
        self.assertFalse(kwargs.get("shell", False))
        self.assertNotIn("PYTHONPATH", kwargs["env"])
        self.assertNotIn("PYTHONHOME", kwargs["env"])
        self.assertNotIn("VIRTUAL_ENV", kwargs["env"])
        self.assertEqual(kwargs["env"]["PYTHONNOUSERSITE"], "1")
        self.assertEqual(kwargs["env"]["PATH"], "system-path")

        def failed_runner(command, **kwargs):
            return SimpleNamespace(returncode=1603, stdout="", stderr="install failed")

        with self.assertRaisesRegex(RuntimeError, "status 1603: install failed"):
            prepare.run_windows_installer(Path("installer.exe"), Path("target"), runner=failed_runner)

    def test_python_checks_return_version_and_venv_output_with_sanitized_environment(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            output = "pip 25.0 from target\\Lib\\site-packages\\pip (python 3.13)" if "pip" in command else "venv help"
            return SimpleNamespace(returncode=0, stdout=output, stderr="")

        result = prepare.run_python_check(Path("target/python.exe"), ["-m", "pip", "--version"], runner=runner, environment={"PYTHONPATH": "hostile"})
        self.assertTrue(result.startswith("pip 25.0"))
        self.assertNotIn("PYTHONPATH", calls[0][1]["env"])
        self.assertEqual(calls[0][0], ["target/python.exe", "-m", "pip", "--version"])


if __name__ == "__main__":
    unittest.main()
