import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SidecarPackagingInputTests(unittest.TestCase):
    def test_target_locks_pin_every_resolved_requirement_with_hashes(self):
        for target in ("windows-x64", "linux-x64"):
            lock = ROOT / "python" / f"requirements-{target}.lock"
            text = lock.read_text(encoding="utf-8")
            blocks = re.split(r"(?m)(?=^[A-Za-z0-9_.-]+(?:==| @ ))", text)
            requirements = [block for block in blocks if re.match(r"^[A-Za-z0-9_.-]+(?:==| @ )", block)]
            self.assertGreater(len(requirements), 40, target)
            for block in requirements:
                self.assertRegex(block, r"--hash=sha256:[0-9a-f]{64}", block.splitlines()[0])
            for package, version in (
                ("click", "8.3.1"), ("spacy", "3.8.9"), ("pyinstaller", "6.22.3"),
                ("pyinstaller-hooks-contrib", "2026.8"),
            ):
                self.assertRegex(text, rf"(?m)^{re.escape(package)}=={re.escape(version)} \\")
            self.assertIn("500bd58c7bf7e584a8435adccbd763a0b918d5c12b08d74ff50fd79b2915458b", text)
            self.assertIn("451a4ae14b719365bf1a2f0a99dae7b3463060061c3a394c70d5264cfb439528", text)
            self.assertIn("fcae3e5a378003172b5cab0a3631cf98a0c1b158655949262859a4fae780ca2d", text)
            self.assertIn("8c5565fedcf3219f73dde9c18187e5c5534d3f9029a19907909af693badb3bed", text)
            self.assertIn("en_core_web_sm-3.8.0-py3-none-any.whl#sha256=1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85", text)

    def test_runtime_archives_and_model_are_hash_pinned_and_collected_explicitly(self):
        manifest = json.loads((ROOT / "python/runtime-artifacts.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "3.13.16")
        self.assertEqual(manifest["targets"]["windows-x64"]["sha256"], "80566a71bdc2f5e446daceb1c832e0f52d56cee8ff0e40de1d54131d5c68c487")
        self.assertEqual(manifest["targets"]["linux-x64"]["sha256"], "1b505e67454851c1a91774a23d4cf9615db2d48a90fc0f50579e35c28e9e91b0")
        self.assertIn('collect_all("en_core_web_sm")', (ROOT / "python/umb_memory_sidecar.spec").read_text(encoding="utf-8"))
        build = (ROOT / "scripts/build-memory-sidecar.py").read_text(encoding="utf-8")
        self.assertIn('"--require-hashes"', build)
        self.assertIn('"en-core-web-sm": "3.8.0"', build)


if __name__ == "__main__":
    unittest.main()
