"""Exercise packaged defaults through the actual JSONL sidecar process."""
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "python" / "umb_memory_sidecar.py"
RULES = ROOT / "python" / "patterns-v1.json"
HAS_RUNTIME = importlib.util.find_spec("spacy") is not None and importlib.util.find_spec("en_core_web_sm") is not None


@unittest.skipUnless(HAS_RUNTIME, "spaCy and en_core_web_sm are not installed; real extraction unavailable")
class RealSubprocessSidecarTests(unittest.TestCase):
    def test_packaged_rules_extract_redacted_spans_and_supported_relation(self):
        sensitive = "PRIVATE_SENTINEL_9f27"
        raw = f"🌞 checkout page has submit button. {sensitive}"
        # Model the upstream redaction boundary: only this redacted string is sent.
        redacted = raw.replace(sensitive, "[REDACTED]")
        requests = [
            {"version": 3, "id": "health", "op": "health"},
            {"version": 3, "id": "extract", "op": "analyze", "text": redacted},
            {"version": 3, "id": "stop", "op": "shutdown"},
        ]
        process = subprocess.run(
            [sys.executable, str(SIDECAR)], input="".join(json.dumps(r) + "\n" for r in requests),
            capture_output=True, text=True, cwd=ROOT, timeout=60, check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertNotIn(sensitive, process.stdout + process.stderr)
        self.assertLessEqual(len(process.stdout.encode("utf-8")), 512 * 1024)
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(responses), 3)
        health = responses[0]["health"]
        self.assertTrue(health["ready"])
        self.assertTrue(health["patterns_ready"])
        self.assertEqual(health["pattern_count"], 6)
        result = responses[1]
        self.assertTrue(result["ok"])
        entities = result["entities"]
        expected = [("PAGE", "checkout page"), ("ACTION", "submit button")]
        self.assertEqual([(e["label"], e["text"]) for e in entities], expected)
        for entity in entities:
            self.assertEqual(redacted[entity["start"]:entity["end"]], entity["text"])
        self.assertEqual(entities[0]["start"], len("🌞 "))
        relation, = result["relations"]
        self.assertEqual((relation["type"], relation["from_index"], relation["to_index"]), ("HAS_ACTION", 0, 1))
        evidence = relation["evidence"]
        self.assertEqual(redacted[evidence["start"]:evidence["end"]], "has")
        self.assertEqual(responses[2]["op"], "shutdown")


if __name__ == "__main__":
    unittest.main()
