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
        self.assertEqual(health["pattern_count"], 14)
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

    def test_packaged_ontology_literals_and_relation_controls(self):
        cases = [
            ("action_page", "submit button opens login page.",
             [("ACTION", "submit button"), ("PAGE", "login page")],
             ("NAVIGATES_TO", 0, 1, "relation.action_navigates_page", "opens")),
            ("page_page", "login page links to checkout page.",
             [("PAGE", "login page"), ("PAGE", "checkout page")],
             ("NAVIGATES_TO", 0, 1, "relation.page_navigates_page", "links to")),
            ("field_rule", "email address must be required field.",
             [("FIELD", "email address"), ("RULE", "required field")],
             ("HAS_VALIDATION", 0, 1, "relation.field_has_validation", "must be")),
            ("locator_page", "#SaveBtn belongs to checkout page.",
             [("LOCATOR", "#SaveBtn"), ("PAGE", "checkout page")],
             ("BELONGS_TO", 0, 1, "relation.locator_belongs_page", "belongs to")),
            ("test_ac", "TC-Login-01 covers AC-17.",
             [("TEST", "TC-Login-01"), ("AC", "AC-17")],
             ("COVERS", 0, 1, "relation.test_covers_ac", "covers")),
        ]
        negative = [
            "email address required field.",
            "required field must be email address.",
            "email address. must be required field.",
            "email address must be required field and email address must be required field.",
            "submit button login page.",
            "login page opens submit button.",
            "#savebtn belongs to checkout page. tc-login-01 covers ac-17.",
        ]
        requests = [{"version": 3, "id": name, "op": "analyze", "text": text}
                    for name, text, _, _ in cases]
        requests += [{"version": 3, "id": f"negative-{i}", "op": "analyze", "text": text}
                     for i, text in enumerate(negative)]
        requests += [{"version": 3, "id": "stop", "op": "shutdown"}]
        process = subprocess.run(
            [sys.executable, str(SIDECAR)], input="".join(json.dumps(r) + "\n" for r in requests),
            capture_output=True, text=True, cwd=ROOT, timeout=60, check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertLessEqual(len(process.stdout.encode("utf-8")), 512 * 1024)
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(responses), len(requests))
        self.assertTrue(responses[0]["ok"])
        for response, (name, text, expected_entities, expected_relation) in zip(responses, cases):
            self.assertEqual(response["id"], name)
            entities = response["entities"]
            self.assertEqual([(e["label"], e["text"]) for e in entities], expected_entities)
            for entity in entities:
                self.assertEqual(text[entity["start"]:entity["end"]], entity["text"])
            if name == "locator_page":
                locator, = [entity for entity in entities if entity["label"] == "LOCATOR"]
                self.assertEqual(locator["rule_id"], "locator.save_button")
                self.assertEqual((locator["text"], locator["start"], locator["end"]),
                                 ("#SaveBtn", 0, len("#SaveBtn")))
            relation, = response["relations"]
            self.assertEqual((relation["type"], relation["from_index"], relation["to_index"],
                              relation["rule_id"]), expected_relation[:4])
            evidence = relation["evidence"]
            self.assertEqual((evidence["text"], text[evidence["start"]:evidence["end"]]),
                             (expected_relation[4], expected_relation[4]))
        for response in responses[len(cases):-1]:
            self.assertEqual(response["relations"], [], response["id"])
        case_mismatch = responses[len(cases) + len(negative) - 1]
        self.assertEqual([(entity["label"], entity["text"]) for entity in case_mismatch["entities"]],
                         [("PAGE", "checkout page")])
        self.assertEqual(responses[-1]["op"], "shutdown")


if __name__ == "__main__":
    unittest.main()
