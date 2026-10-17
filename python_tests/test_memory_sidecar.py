import io
import json
import unittest

from python.umb_memory_sidecar import Sidecar, run


class Token:
    def __init__(self, text, idx, lemma=None):
        self.text, self.idx, self.lemma_ = text, idx, lemma or text.lower()
        self.is_space = False


class Entity:
    start_char, end_char, text, label_ = 0, 5, "Hello", "GREET"


class Doc(list):
    ents = [Entity()]
    meta = {"version": "3.8.0"}


def fake_loader(_name):
    class Pipeline:
        meta = {"version": "3.8.0"}
        def __call__(self, _text):
            return Doc([Token("Hello", 0, "hello"), Token("world", 6, "world")])
    return Pipeline(), "test-spacy"


class SidecarTests(unittest.TestCase):
    def test_analyze_returns_normalized_bounded_spans(self):
        worker = Sidecar(loader=fake_loader)
        result = worker.handle({"version": 2, "id": "a", "op": "analyze", "text": "Hello world"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["normalized"], "hello world")
        self.assertEqual(result["tokens"][0]["start"], 0)
        self.assertEqual(result["entities"][0]["label"], "GREET")

    def test_health_loads_lazily_and_reports_readiness(self):
        calls = []
        def loader(name):
            calls.append(name)
            return fake_loader(name)
        worker = Sidecar(loader=loader)
        self.assertEqual(calls, [])
        health = worker.handle({"version": 2, "id": "h", "op": "health"})
        self.assertTrue(health["health"]["ready"])
        self.assertEqual(health["health"]["spacy"], "test-spacy")
        self.assertEqual(health["health"]["model_version"], "3.8.0")
        self.assertEqual(len(calls), 1)

    def test_health_runs_inference_and_fails_when_pipeline_inference_fails(self):
        class Broken:
            meta = {"version": "3.8.0"}
            def __call__(self, _text):
                raise RuntimeError("private")
        health = Sidecar(loader=lambda _name: (Broken(), "3.8.9")).handle({"version": 2, "id": "h", "op": "health"})
        self.assertFalse(health["health"]["ready"])

    def test_invalid_request_and_loader_errors_are_generic(self):
        self.assertEqual(Sidecar(loader=lambda _name: (_ for _ in ()).throw(RuntimeError("secret"))).handle(
            {"version": 2, "id": "x", "op": "analyze", "text": "secret"})["error"], "unavailable")
        self.assertEqual(Sidecar().handle({"version": 2, "id": "x", "op": "analyze"})["error"], "invalid_request")

    def test_jsonl_shutdown(self):
        source = io.BytesIO((json.dumps({"version": 2, "id": "s", "op": "shutdown"}) + "\n").encode())
        output = io.StringIO()
        run(source, output, Sidecar(loader=fake_loader))
        self.assertEqual(json.loads(output.getvalue())["op"], "shutdown")

    def test_malformed_json_and_utf8_return_generic_errors_then_continue(self):
        source = io.BytesIO(b'{bad json}\n\xff\n' + (json.dumps({"version": 2, "id": "s", "op": "shutdown"}) + "\n").encode())
        output = io.StringIO()
        run(source, output, Sidecar(loader=fake_loader))
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), 3)
        self.assertEqual([response["error"] for response in responses[:2]], ["invalid_request", "invalid_request"])
        self.assertEqual(responses[2]["op"], "shutdown")


if __name__ == "__main__":
    unittest.main()
