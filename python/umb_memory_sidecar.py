#!/usr/bin/env python3
"""Versioned JSONL spaCy worker. No persistence, networking, or request logging."""
from __future__ import annotations

import json
import sys
import platform
from typing import Any, Callable

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 64 * 1024
MAX_SPANS = 1000
RULES_VERSION = "1"


def _default_loader(model_name: str) -> tuple[Any, str]:
    import spacy  # imported lazily; never downloads a model
    return spacy.load(model_name), spacy.__version__


class Sidecar:
    def __init__(self, model_name: str = "en_core_web_sm", loader: Callable[[str], tuple[Any, str]] = _default_loader):
        self.model_name = model_name
        self.loader = loader
        self.nlp: Any = None
        self.spacy_version = "unavailable"

    def _load(self) -> Any:
        if self.nlp is None:
            self.nlp, self.spacy_version = self.loader(self.model_name)
        return self.nlp

    def handle(self, request: Any) -> dict[str, Any]:
        request_id = request.get("id") if isinstance(request, dict) else None
        safe_id = request_id if isinstance(request_id, str) and 0 < len(request_id) <= 128 else "invalid"
        if not isinstance(request, dict) or request.get("version") != PROTOCOL_VERSION:
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "invalid_request"}
        op = request.get("op")
        if op == "health":
            try:
                self._load()
                ready = True
            except Exception:
                ready = False
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": True, "op": "health", "health": {
                "protocol": PROTOCOL_VERSION, "python": platform.python_version(), "spacy": self.spacy_version,
                "model": self.model_name, "rules": RULES_VERSION, "ready": ready,
            }}
        if op == "shutdown":
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": True, "op": "shutdown"}
        if op != "analyze" or not isinstance(request.get("text"), str):
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "invalid_request"}
        text = request["text"]
        if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "invalid_request"}
        try:
            doc = self._load()(text)
            tokens = []
            for token in doc:
                if token.is_space:
                    continue
                if len(tokens) >= MAX_SPANS:
                    break
                tokens.append({"start": int(token.idx), "end": int(token.idx + len(token.text)), "text": token.lemma_ or token.text, "label": "TOKEN"})
            entities = [{"start": int(ent.start_char), "end": int(ent.end_char), "text": ent.text, "label": ent.label_}
                        for ent in list(doc.ents)[:MAX_SPANS]]
            normalized = " ".join(token["text"] for token in tokens)
            normalized = normalized[:MAX_TEXT_BYTES]
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": True, "op": "analyze", "normalized": normalized,
                    "tokens": tokens, "entities": entities}
        except Exception:
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "unavailable"}


def run(stdin: Any = sys.stdin, stdout: Any = sys.stdout, sidecar: Sidecar | None = None) -> None:
    worker = sidecar or Sidecar()
    stream = stdin.buffer if hasattr(stdin, "buffer") else stdin
    while True:
        # A bounded read avoids allocating an arbitrarily large protocol line.
        raw_line = stream.readline(MAX_LINE_BYTES + 1)
        if not raw_line:
            break
        request = None
        if len(raw_line) > MAX_LINE_BYTES:
            # Consume the remainder in bounded chunks so the next read starts on a frame.
            while not raw_line.endswith(b"\n" if isinstance(raw_line, bytes) else "\n"):
                raw_line = stream.readline(MAX_LINE_BYTES + 1)
                if not raw_line:
                    break
            response = {"version": PROTOCOL_VERSION, "id": "invalid", "ok": False, "error": "invalid_request"}
        else:
            try:
                request = json.loads(raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line)
                response = worker.handle(request)
            except Exception:
                response = {"version": PROTOCOL_VERSION, "id": "invalid", "ok": False, "error": "invalid_request"}
        try:
            stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            stdout.flush()
        except Exception:
            break
        if isinstance(request, dict) and request.get("op") == "shutdown":
            break


if __name__ == "__main__":
    run()
