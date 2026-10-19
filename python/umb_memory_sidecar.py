#!/usr/bin/env python3
"""Versioned JSONL spaCy worker. No persistence, networking, or request logging."""
from __future__ import annotations

import json
import sys
import platform
import hashlib
import os
import re
import argparse
from pathlib import Path
from typing import Any, Callable

PROTOCOL_VERSION = 3
MAX_LINE_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 64 * 1024
MAX_SPANS = 1000
RULES_VERSION = "1"
MAX_PATTERN_BYTES = 256 * 1024
MAX_RULES = 128
MAX_TOKENS = 32
MAX_OUTPUT_BYTES = 512 * 1024
ENTITY_LABELS = {"PAGE", "ACTION", "FIELD", "RULE", "LOCATOR", "TEST", "AC"}
RELATIONS = {"HAS_ACTION": {("PAGE", "ACTION")}, "NAVIGATES_TO": {("ACTION", "PAGE"), ("PAGE", "PAGE")},
             "HAS_VALIDATION": {("FIELD", "RULE")}, "BELONGS_TO": {("LOCATOR", "PAGE")}, "COVERS": {("TEST", "AC")}}


def _read_patterns(path: str | Path | None) -> tuple[dict[str, Any], str]:
    default_path = Path(__file__).with_name("patterns-v1.json")
    try:
        raw = default_path.read_bytes()
        defaults = _validate_rules(raw)
        combined = defaults
        if path is not None:
            custom_path = Path(path)
            if not custom_path.is_file():
                raise ValueError("configured pattern file missing")
            custom = _validate_rules(custom_path.read_bytes())
            ids = {r["id"] for group in (defaults["entity_rules"], defaults["relation_rules"]) for r in group}
            new_ids = [r["id"] for group in (custom["entity_rules"], custom["relation_rules"]) for r in group]
            if ids.intersection(new_ids):
                raise ValueError("custom pattern ID collides with default")
            combined = {"schema_version": 1,
                        "entity_rules": defaults["entity_rules"] + custom["entity_rules"],
                        "relation_rules": defaults["relation_rules"] + custom["relation_rules"]}
            if len(combined["entity_rules"]) + len(combined["relation_rules"]) > MAX_RULES:
                raise ValueError("too many combined rules")
        digest = hashlib.sha256(json.dumps(combined, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return combined, digest
    except Exception as exc:
        raise ValueError("invalid configured patterns") from exc


def _validate_rules(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_PATTERN_BYTES:
        raise ValueError("pattern file too large")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    data = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    if not isinstance(data, dict) or set(data) != {"schema_version", "entity_rules", "relation_rules"} or type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError("invalid pattern schema")
    if not isinstance(data["entity_rules"], list) or not isinstance(data["relation_rules"], list) or len(data["entity_rules"])+len(data["relation_rules"]) > MAX_RULES:
        raise ValueError("invalid pattern lists")
    ids = set()
    for rule in data["entity_rules"]:
        if not isinstance(rule, dict) or set(rule) - {"id", "label", "phrase", "tokens", "case_sensitive"} or set(rule) & {"phrase", "tokens"} not in ({"phrase"}, {"tokens"}): raise ValueError("invalid entity rule")
        if rule.get("label") not in ENTITY_LABELS: raise ValueError("unsupported entity label")
        tokens = rule.get("tokens", rule.get("phrase"))
        if isinstance(tokens, str): tokens = tokens.split()
        if not isinstance(tokens, list) or not tokens or len(tokens) > MAX_TOKENS: raise ValueError("invalid entity tokens")
        if any(not isinstance(t, str) or not t or len(t) > 128 for t in tokens): raise ValueError("invalid entity token")
        if "case_sensitive" in rule and type(rule["case_sensitive"]) is not bool: raise ValueError("invalid case policy")
        rule["_case_sensitive"] = rule.get("case_sensitive", rule["label"] in {"LOCATOR", "TEST", "AC"})
        rule["_tokens"] = tokens if rule["_case_sensitive"] else [t.lower() for t in tokens]
        _check_id(rule, ids)
    for rule in data["relation_rules"]:
        if not isinstance(rule, dict) or set(rule) != {"id", "relation", "source", "target", "cue", "max_gap"}: raise ValueError("invalid relation rule")
        signature = (rule["source"], rule["target"])
        if rule["relation"] not in RELATIONS or signature not in RELATIONS[rule["relation"]]: raise ValueError("unsupported relation signature")
        cue = rule["cue"]
        if not isinstance(cue, list) or not cue or len(cue) > MAX_TOKENS or any(not isinstance(t, str) or not t or len(t) > 128 for t in cue): raise ValueError("invalid cue")
        if type(rule["max_gap"]) is not int or not 0 <= rule["max_gap"] <= 12: raise ValueError("invalid gap")
        rule["_cue"] = [t.lower() for t in cue]
        _check_id(rule, ids)
    return data


def _check_id(rule: dict[str, Any], ids: set[str]) -> None:
    value = rule.get("id")
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", value) or value in ids: raise ValueError("invalid or duplicate rule ID")
    ids.add(value)


def _default_loader(model_name: str) -> tuple[Any, str]:
    import spacy  # imported lazily; never downloads a model
    return spacy.load(model_name), spacy.__version__


class Sidecar:
    def __init__(self, model_name: str = "en_core_web_sm", loader: Callable[[str], tuple[Any, str]] = _default_loader,
                 patterns_file: str | Path | None = None):
        self.model_name = model_name
        self.loader = loader
        self.nlp: Any = None
        self.spacy_version = "unavailable"
        self.model_version = "unavailable"
        self.patterns_file = patterns_file if patterns_file is not None else os.environ.get("UMB_MEMORY_PATTERNS_FILE")
        self.rules: dict[str, Any] | None = None
        self.rules_digest: str | None = None
        self.pattern_count = 0
        self.rules_error = False

    def _load(self) -> Any:
        if self.nlp is None:
            try:
                self.rules, self.rules_digest = _read_patterns(self.patterns_file)
                self.pattern_count = sum(len(self.rules[k]) for k in ("entity_rules", "relation_rules"))
            except Exception:
                self.rules_error = True
                raise
            nlp, spacy_version = self.loader(self.model_name)
            version = nlp.meta.get("version") if isinstance(getattr(nlp, "meta", None), dict) else None
            if not isinstance(version, str) or not version:
                raise RuntimeError("model version unavailable")
            if hasattr(nlp, "add_pipe") and "entity_ruler" not in getattr(nlp, "pipe_names", []):
                ruler = nlp.add_pipe("entity_ruler", name="umb_entity_ruler", config={"overwrite_ents": False})
                patterns = []
                for rule in self.rules["entity_rules"]:
                    key = "TEXT" if rule["_case_sensitive"] else "LOWER"
                    literal = " ".join(rule["_tokens"])
                    tokenized = nlp.make_doc(literal) if hasattr(nlp, "make_doc") else None
                    tokens = [t.text for t in tokenized if not t.is_space] if tokenized is not None else rule["_tokens"]
                    if key == "LOWER": tokens = [t.lower() for t in tokens]
                    patterns.append({"label": rule["label"], "id": rule["id"], "pattern": [{key: token} for token in tokens]})
                ruler.add_patterns(patterns)
            self.nlp, self.spacy_version, self.model_version = nlp, spacy_version, version
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
                # Exercise the loaded pipeline as part of readiness, without exposing output.
                self.nlp("UMB sidecar readiness check.")
                ready = self.rules is not None and self.rules_digest is not None
            except Exception:
                ready = False
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": True, "op": "health", "health": {
                "protocol": PROTOCOL_VERSION, "python": platform.python_version(), "spacy": self.spacy_version,
                "model": self.model_name, "model_version": self.model_version, "rules": RULES_VERSION,
                "patterns_schema_version": 1, "patterns_digest": self.rules_digest or hashlib.sha256(b"invalid-patterns").hexdigest(),
                "pattern_count": self.pattern_count,
                # Normalization readiness is distinct from extraction readiness:
                # candidates require a valid entity ruleset and a loaded/inferred model.
                "patterns_ready": bool(ready and self.rules is not None and self.rules_digest and self.rules["entity_rules"]), "ready": ready,
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
            normalized_tokens = []
            for token in doc:
                if token.is_space:
                    continue
                if len(tokens) >= MAX_SPANS:
                    break
                surface = token.text
                tokens.append({"start": int(token.idx), "end": int(token.idx + len(surface)), "text": surface, "label": "TOKEN"})
                normalized_tokens.append(token.lemma_ or surface)
            candidates = self._entity_candidates(text, doc)
            relations = self._relation_candidates(text, candidates, doc)
            # Enforce the protocol output budget without emitting broken relation
            # indices: trim entities first, then retain only in-range relations.
            candidates = candidates[:MAX_SPANS]
            relations = [r for r in relations if r["from_index"] < len(candidates) and r["to_index"] < len(candidates)][:MAX_SPANS]
            normalized = " ".join(normalized_tokens)
            normalized = normalized[:MAX_TEXT_BYTES]
            response = {"version": PROTOCOL_VERSION, "id": safe_id, "ok": True, "op": "analyze", "normalized": normalized,
                        "tokens": tokens, "entities": candidates, "relations": relations}
            while len(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_OUTPUT_BYTES:
                if relations:
                    relations.pop()
                elif candidates:
                    candidates.pop()
                    relations = [r for r in relations if r["from_index"] < len(candidates) and r["to_index"] < len(candidates)]
                elif tokens:
                    tokens.pop()
                    normalized_tokens.pop()
                    response["normalized"] = " ".join(normalized_tokens)[:MAX_TEXT_BYTES]
                else:
                    return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "unavailable"}
            return response
        except Exception:
            return {"version": PROTOCOL_VERSION, "id": safe_id, "ok": False, "error": "unavailable"}

    def _entity_candidates(self, text: str, doc: Any) -> list[dict[str, Any]]:
        out = []
        rules = {r["id"]: r for r in self.rules["entity_rules"]}
        for ent in getattr(doc, "ents", ()):
            rule_id = getattr(ent, "ent_id_", "")
            rule = rules.get(rule_id)
            if rule is None or ent.label_ != rule["label"]: continue
            start, end = int(ent.start_char), int(ent.end_char)
            if start < 0 or end <= start or end > len(text): continue
            out.append({"label": rule["label"], "rule_id": rule_id, "text": text[start:end],
                        "normalized": " ".join(rule["_tokens"]).lower(), "start": start, "end": end})
            if len(out) >= MAX_SPANS: break
        return sorted(out, key=lambda c: (c["start"], c["end"], c["rule_id"]))[:MAX_SPANS]

    def _relation_candidates(self, text: str, candidates: list[dict[str, Any]], doc: Any) -> list[dict[str, Any]]:
        out = []
        for rule in self.rules["relation_rules"]:
            token_seq = [t for t in doc if not getattr(t, "is_space", False)]
            cue_spans = []
            for i in range(max(0, len(token_seq) - len(rule["_cue"]) + 1)):
                if i >= MAX_SPANS: break
                segment = token_seq[i:i + len(rule["_cue"])]
                if [t.text.lower() for t in segment] == rule["_cue"]:
                    cue_spans.append((int(segment[0].idx), int(segment[-1].idx + len(segment[-1].text))))
            for cue_start, cue_end in cue_spans:
                sentence = next((s for s in getattr(doc, "sents", ()) if s.start_char <= cue_start < s.end_char), None)
                if sentence is None: continue
                endpoints = [c for c in candidates if sentence.start_char <= c["start"] < sentence.end_char]
                pairs = []
                for a in endpoints:
                    if a["label"] != rule["source"] or a["end"] > cue_start:
                        continue
                    for b in endpoints:
                        if b["label"] != rule["target"] or cue_end > b["start"]:
                            continue
                        between_tokens = [t for t in token_seq if a["end"] <= t.idx and t.idx + len(t.text) <= b["start"]]
                        if len(between_tokens) - len(rule["_cue"]) <= rule["max_gap"]:
                            pairs.append((a, b))
                            if len(pairs) > 1:
                                break
                    if len(pairs) > 1:
                        break
                if len(pairs) != 1: continue
                source, target = pairs[0]
                out.append({"type": rule["relation"], "rule_id": rule["id"],
                            "from_index": candidates.index(source), "to_index": candidates.index(target),
                            "evidence": {"start": cue_start, "end": cue_end, "text": text[cue_start:cue_end]}})
                if len(out) >= MAX_SPANS: return out
        return out


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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Local UMB spaCy sidecar")
    parser.add_argument("--patterns-file", type=Path)
    args = parser.parse_args(argv)
    run(sidecar=Sidecar(patterns_file=args.patterns_file))


if __name__ == "__main__":
    main()
