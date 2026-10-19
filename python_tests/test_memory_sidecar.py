import io
import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from python import umb_memory_sidecar as sidecar_module
from python.umb_memory_sidecar import Sidecar, run, MAX_SPANS


class Token:
    def __init__(self, text, idx, lemma=None):
        self.text, self.idx, self.lemma_ = text, idx, lemma or text.lower()
        self.is_space = False


class Entity:
    def __init__(self, start, end, label, rule_id):
        self.start_char, self.end_char, self.label_, self.ent_id_ = start, end, label, rule_id


class Doc(list):
    meta = {"version": "3.8.0"}
    def __init__(self, tokens, ents=(), text=""):
        super().__init__(tokens)
        self.ents = ents
        self.text = text
        self.sents = [type("Sentence", (), {"start_char": 0, "end_char": len(text)})()]


def fake_loader(_name):
    class Pipeline:
        meta = {"version": "3.8.0"}
        pipe_names = []
        def add_pipe(self, *_args, **_kwargs):
            class Ruler:
                patterns = []
                def add_patterns(self, patterns): self.patterns = patterns
            self.ruler = Ruler()
            return self.ruler
        def __call__(self, text):
            import re
            lemmas = {"users": "user", "clicked": "click"}
            tokens = [Token(m.group(), m.start(), lemmas.get(m.group().lower())) for m in re.finditer(r"\S+", text)]
            ents = []
            for pattern in getattr(getattr(self, "ruler", None), "patterns", []):
                value = " ".join(item.get("TEXT", item.get("LOWER")) for item in pattern["pattern"])
                flags = 0 if "TEXT" in pattern["pattern"][0] else re.IGNORECASE
                for match in re.finditer(r"(?<!\w)" + re.escape(value).replace(r"\ ", r"\s+") + r"(?!\w)", text, flags):
                    ents.append(Entity(match.start(), match.end(), pattern["label"], pattern["id"]))
            return Doc(tokens, ents, text)
    return Pipeline(), "test-spacy"


class SidecarTests(unittest.TestCase):
    def test_packaged_defaults_cover_approved_labels_and_relation_signatures(self):
        cases = [
            ("login page links to checkout page.", {"PAGE"}, "relation.page_navigates_page", "links to"),
            ("submit button opens login page.", {"ACTION", "PAGE"}, "relation.action_navigates_page", "opens"),
            ("email address must be required field.", {"FIELD", "RULE"}, "relation.field_has_validation", "must be"),
            ("#SaveBtn belongs to checkout page.", {"LOCATOR", "PAGE"}, "relation.locator_belongs_page", "belongs to"),
            ("TC-Login-01 covers AC-17.", {"TEST", "AC"}, "relation.test_covers_ac", "covers"),
        ]
        for i, (text, expected_labels, rule_id, cue) in enumerate(cases):
            with self.subTest(rule=rule_id):
                result = Sidecar(loader=fake_loader).handle(
                    {"version": 3, "id": f"ontology-{i}", "op": "analyze", "text": text})
                self.assertTrue(result["ok"])
                self.assertEqual({entity["label"] for entity in result["entities"]}, expected_labels)
                relation, = result["relations"]
                self.assertEqual(relation["rule_id"], rule_id)
                self.assertEqual(relation["evidence"]["text"], cue)
                self.assertEqual(text[relation["evidence"]["start"]:relation["evidence"]["end"]], cue)

    def test_packaged_identifier_literals_remain_case_sensitive(self):
        text = "#SaveBtn #savebtn TC-Login-01 tc-login-01 AC-17 ac-17"
        result = Sidecar(loader=fake_loader).handle(
            {"version": 3, "id": "case", "op": "analyze", "text": text})
        self.assertEqual([(e["label"], e["text"]) for e in result["entities"]], [
            ("LOCATOR", "#SaveBtn"), ("TEST", "TC-Login-01"), ("AC", "AC-17")])

    def test_demo_project_patterns_extract_entities_and_relations(self):
        patterns = Path(__file__).parents[1] / "examples" / "demo-project" / "memory-patterns-v1.json"
        text = "The account page offers save changes. The email address must be a valid email."
        result = Sidecar(loader=fake_loader, patterns_file=patterns).handle(
            {"version": 3, "id": "demo", "op": "analyze", "text": text})

        self.assertTrue(result["ok"])
        self.assertEqual([(entity["label"], entity["text"]) for entity in result["entities"]], [
            ("PAGE", "account page"), ("ACTION", "save changes"),
            ("FIELD", "email address"), ("RULE", "valid email"),
        ])
        actual_relations = [
            (relation["type"], relation["from_index"], relation["to_index"], relation["rule_id"],
             relation["evidence"]["start"], relation["evidence"]["end"], relation["evidence"]["text"])
            for relation in result["relations"]
        ]
        self.assertCountEqual(actual_relations, [
            ("HAS_ACTION", 0, 1, "demo.relation.page_has_action", text.index("offers"),
             text.index("offers") + len("offers"), "offers"),
            # The packaged FIELD→RULE rule precedes and wins over the demo's
            # identical signature/cue rule; only one candidate is emitted.
            ("HAS_VALIDATION", 2, 3, "relation.field_has_validation", text.index("must be"),
             text.index("must be") + len("must be"), "must be"),
        ])

    @staticmethod
    def custom_file(directory):
        path = Path(directory) / "custom.json"
        path.write_text(json.dumps({"schema_version": 1,
            "entity_rules": [{"id": "custom.page", "label": "PAGE", "phrase": "account page"},
                             {"id": "custom.action", "label": "ACTION", "phrase": "save changes"}],
            "relation_rules": [{"id": "custom.has_action", "relation": "HAS_ACTION", "source": "PAGE", "target": "ACTION",
                                 "cue": ["offers"], "max_gap": 12}]}), encoding="utf-8")
        return path

    def test_protocol_v3_candidates_relation_indices_and_unicode_spans(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.custom_file(tmp)
            text = "🙂 The account page offers save changes."
            result = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "a", "op": "analyze", "text": text})
        self.assertTrue(result["ok"])
        self.assertEqual(result["version"], 3)
        self.assertEqual([(e["label"], e["text"], e["start"], e["end"]) for e in result["entities"]],
                         [("PAGE", "account page", 6, 18), ("ACTION", "save changes", 26, 38)])
        self.assertEqual(result["entities"][0]["normalized"], "account page")
        relation = result["relations"][0]
        self.assertEqual((relation["type"], relation["from_index"], relation["to_index"]), ("HAS_ACTION", 0, 1))
        self.assertEqual(relation["evidence"], {"start": 19, "end": 25, "text": "offers"})

    def test_default_rules_do_not_match_generic_words_and_custom_literal_does(self):
        default = Sidecar(loader=fake_loader).handle({"version": 3, "id": "a", "op": "analyze", "text": "The page has an action in this test field."})
        self.assertEqual(default["entities"], [])
        with tempfile.TemporaryDirectory() as tmp:
            path = self.custom_file(tmp)
            custom = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "a", "op": "analyze", "text": "Visit the account page."})
            self.assertEqual(custom["entities"][0]["text"], "account page")

    def test_entity_and_relation_outputs_are_capped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.custom_file(tmp)
            text = " ".join(["account page"] * (MAX_SPANS + 10))
            result = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "a", "op": "analyze", "text": text})
            self.assertLessEqual(len(result["entities"]), MAX_SPANS)
            self.assertLessEqual(len(result["relations"]), MAX_SPANS)

    def test_ambiguous_multiple_endpoint_pairs_do_not_emit_relations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.custom_file(tmp)
            text = "account page offers save changes and account page offers save changes"
            result = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "a", "op": "analyze", "text": text})
            self.assertEqual(len(result["entities"]), 4)
            self.assertEqual(result["relations"], [])

    def test_cli_accepts_patterns_file_and_rejects_unknown_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.custom_file(tmp)
            with patch.object(sidecar_module, "run") as run_mock:
                sidecar_module.main(["--patterns-file", str(path)])
                self.assertEqual(run_mock.call_args.kwargs["sidecar"].patterns_file, path)
            with self.assertRaises(SystemExit):
                sidecar_module.main(["--unknown"])

    def test_configured_invalid_pattern_fails_health_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps({"schema_version": 1, "entity_rules": [{"id": "x", "label": "SCREEN", "phrase": "x"}], "relation_rules": []}))
            health = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "h", "op": "health"})
            self.assertFalse(health["health"]["ready"])
            self.assertFalse(health["health"]["patterns_ready"])
            self.assertEqual(health["health"]["patterns_schema_version"], 1)
            self.assertRegex(health["health"]["patterns_digest"], r"^[0-9a-f]{64}$")
            self.assertEqual(health["health"]["pattern_count"], 0)
            self.assertNotIn(str(path), json.dumps(health))

    def test_empty_patterns_are_normalization_ready_but_extraction_not_ready(self):
        empty = {"schema_version": 1, "entity_rules": [], "relation_rules": []}
        with patch.object(sidecar_module, "_read_patterns", return_value=(empty, "a" * 64)):
            health = Sidecar(loader=fake_loader).handle({"version": 3, "id": "h", "op": "health"})["health"]
        self.assertTrue(health["ready"])
        self.assertFalse(health["patterns_ready"])
        self.assertEqual(health["pattern_count"], 0)

    def test_boolean_schema_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text('{"schema_version":true,"entity_rules":[],"relation_rules":[]}', encoding="utf-8")
            health = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "h", "op": "health"})["health"]
            self.assertFalse(health["ready"])
            self.assertRegex(health["patterns_digest"], r"^[0-9a-f]{64}$")

    def test_identifier_patterns_are_case_sensitive_entity_ruler_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ids.json"
            path.write_text(json.dumps({"schema_version": 1,
                "entity_rules": [{"id": "locator.save", "label": "LOCATOR", "phrase": "#CustomSaveBtn"}],
                "relation_rules": []}), encoding="utf-8")
            result = Sidecar(loader=fake_loader, patterns_file=path).handle({"version": 3, "id": "a", "op": "analyze", "text": "Use #CustomSaveBtn, not #customsavebtn."})
        self.assertEqual([(e["rule_id"], e["text"]) for e in result["entities"]],
                         [("locator.save", "#CustomSaveBtn")])

    def test_analyze_returns_normalized_bounded_spans(self):
        worker = Sidecar(loader=fake_loader)
        result = worker.handle({"version": 3, "id": "a", "op": "analyze", "text": "Hello world"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["normalized"], "hello world")
        self.assertEqual(result["tokens"][0]["start"], 0)
        self.assertEqual(result["entities"], [])

    def test_token_text_preserves_surface_while_normalization_uses_lemmas(self):
        text = "Users clicked"
        result = Sidecar(loader=fake_loader).handle({"version": 3, "id": "a", "op": "analyze", "text": text})
        self.assertTrue(result["ok"])
        self.assertEqual([token["text"] for token in result["tokens"]], ["Users", "clicked"])
        self.assertEqual([text[token["start"]:token["end"]] for token in result["tokens"]], ["Users", "clicked"])
        self.assertEqual(result["normalized"], "user click")

    def test_health_loads_lazily_and_reports_readiness(self):
        calls = []
        def loader(name):
            calls.append(name)
            return fake_loader(name)
        worker = Sidecar(loader=loader)
        self.assertEqual(calls, [])
        health = worker.handle({"version": 3, "id": "h", "op": "health"})
        self.assertTrue(health["health"]["ready"])
        self.assertEqual(health["health"]["spacy"], "test-spacy")
        self.assertEqual(health["health"]["model_version"], "3.8.0")
        self.assertTrue(health["health"]["patterns_ready"])
        self.assertIn("patterns_digest", health["health"])
        self.assertEqual(len(calls), 1)

    def test_health_runs_inference_and_fails_when_pipeline_inference_fails(self):
        class Broken:
            meta = {"version": "3.8.0"}
            def __call__(self, _text):
                raise RuntimeError("private")
        health = Sidecar(loader=lambda _name: (Broken(), "3.8.9")).handle({"version": 3, "id": "h", "op": "health"})
        self.assertFalse(health["health"]["ready"])

    def test_invalid_request_and_loader_errors_are_generic(self):
        self.assertEqual(Sidecar(loader=lambda _name: (_ for _ in ()).throw(RuntimeError("secret"))).handle(
            {"version": 3, "id": "x", "op": "analyze", "text": "secret"})["error"], "unavailable")
        self.assertEqual(Sidecar().handle({"version": 3, "id": "x", "op": "analyze"})["error"], "invalid_request")

    def test_jsonl_shutdown(self):
        source = io.BytesIO((json.dumps({"version": 3, "id": "s", "op": "shutdown"}) + "\n").encode())
        output = io.StringIO()
        run(source, output, Sidecar(loader=fake_loader))
        self.assertEqual(json.loads(output.getvalue())["op"], "shutdown")

    def test_malformed_json_and_utf8_return_generic_errors_then_continue(self):
        source = io.BytesIO(b'{bad json}\n\xff\n' + (json.dumps({"version": 3, "id": "s", "op": "shutdown"}) + "\n").encode())
        output = io.StringIO()
        run(source, output, Sidecar(loader=fake_loader))
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), 3)
        self.assertEqual([response["error"] for response in responses[:2]], ["invalid_request", "invalid_request"])
        self.assertEqual(responses[2]["op"], "shutdown")

    def test_wrong_protocol_version_is_rejected(self):
        result = Sidecar(loader=fake_loader).handle({"version": 2, "id": "a", "op": "shutdown"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["version"], 3)


if __name__ == "__main__":
    unittest.main()
