#!/usr/bin/env python3
"""Local human review of Jester's offline conversation simulation.

The page follows Drew's Eval's one-case-at-a-time grading pattern. It is
deliberately localhost-only and never talks to Discord, EBI, or a model.
"""
import html
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent
REPORT = ROOT / "results" / "latest.json"
LABELS = ROOT / "results" / "review.json"


def read_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def save_labels(data):
    LABELS.parent.mkdir(parents=True, exist_ok=True)
    temp = LABELS.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(temp, LABELS)


def escape(value):
    return html.escape(str(value), quote=True)


def page(report, labels):
    cases = report.get("results", [])
    reviewed = labels.get("labels", {})
    cards = []
    for case in cases:
        rows = []
        for step in case["steps"]:
            actual = step["actual"]
            issues = " · ".join(step["failures"]) or "No automated mismatch"
            rows.append("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                escape(step["speaker"]), escape(step["text"]),
                escape((" | ".join(actual["speech"]) or "(silent)") +
                       (" [scripted Luna reply]" if actual["brain"] else "")),
                escape(" | ".join([*("{} → {} [{}]: {}".format(w["kind"], w["target"], w.get("threadId","?"), w["text"])
                                   for w in actual["writes"]),
                                   *("watch: " + ", ".join(w) for w in actual.get("watches", [])),
                                   *("group: " + ", ".join(g["sources"]) + " → " + g["destinationId"] + ": " + g["task"]
                                     for g in actual.get("groups", []))]) or "(none)"), escape(issues)))
        prior = reviewed.get(case["id"], {})
        badge = "PASS" if case["passed"] else "FAIL"
        cards.append(f'''<section class="card" id="{escape(case['id'])}">
<div class="top"><strong>{escape(case['title'])}</strong><span class="badge {'ok' if case['passed'] else 'bad'}">Auto {badge}</span></div>
<table><thead><tr><th>Speaker</th><th>Heard</th><th>Jester said</th><th>EBI action</th><th>Check</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
<form method="post" action="/label"><input type="hidden" name="id" value="{escape(case['id'])}">
<label>Your note <textarea name="note" rows="2" placeholder="What sounds wrong or is missing?">{escape(prior.get('note', ''))}</textarea></label>
<div class="buttons"><button name="decision" value="pass">Looks right</button>
<button name="decision" value="fail">Needs change</button>
<button name="decision" value="defer">Unsure</button></div></form>
<small>Your mark: {escape(prior.get('decision', 'not reviewed'))}</small></section>''')
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jester conversation review</title><style>
body{{font:16px/1.45 system-ui,sans-serif;background:#f5f6f8;color:#202530;margin:0 auto;padding:24px;max-width:1180px}}
h1{{margin:0 0 6px}}p{{margin:6px 0 20px}}.summary{{background:white;border-radius:10px;padding:16px;margin:18px 0}}
.card{{background:white;border:1px solid #d8dce3;border-radius:10px;padding:18px;margin:18px 0;overflow-x:auto}}
.top{{display:flex;justify-content:space-between;gap:20px;margin-bottom:12px}}.badge{{font-size:12px;padding:4px 8px;border-radius:5px}}
.ok{{background:#dff3e5;color:#12652e}}.bad{{background:#ffebe8;color:#a52a1d}}
table{{border-collapse:collapse;width:100%;min-width:800px}}th,td{{text-align:left;vertical-align:top;border-bottom:1px solid #e8ebef;padding:8px}}
th{{font-size:12px;color:#58606e}}td{{font-size:13px;max-width:290px;overflow-wrap:anywhere}}
textarea{{display:block;box-sizing:border-box;width:100%;margin:6px 0 10px;padding:8px;font:inherit}}
form{{margin-top:14px}}button{{padding:8px 12px;margin-right:8px;border:1px solid #aab3bf;border-radius:6px;background:white;cursor:pointer}}
small{{color:#58606e}}</style></head><body>
<h1>Jester conversation review</h1>
<p>These are offline scripted conversations through Jester's actual routing code, with fake Discord, Luna and EBI. Nothing here touched real sessions.</p>
<div class="summary"><strong>{report.get('passed',0)} of {report.get('total',0)} scenarios passed automated checks.</strong>
 Your marks saved: {len(reviewed)}. Generated: {escape(report.get('generated_at','unknown'))}.<br>
Read each turn, the spoken answer and the exact fake EBI action. Mark anything that sounds wrong or misses a behavior you expect.</div>
{''.join(cards)}</body></html>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        if not REPORT.exists():
            self.send_error(503, "Run node sim/run.mjs first")
            return
        body = page(read_json(REPORT, {}), read_json(LABELS, {"labels": {}})).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/label":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16_384:
            self.send_error(413)
            return
        data = parse_qs(self.rfile.read(length).decode("utf-8"))
        case_id = data.get("id", [""])[0]
        decision = data.get("decision", [""])[0]
        valid_ids = {case["id"] for case in read_json(REPORT, {}).get("results", [])}
        if case_id not in valid_ids or decision not in {"pass", "fail", "defer"}:
            self.send_error(400)
            return
        labels = read_json(LABELS, {"labels": {}})
        labels["labels"][case_id] = {"decision": decision, "note": data.get("note", [""])[0][:2000]}
        save_labels(labels)
        self.send_response(303)
        self.send_header("Location", f"/#{case_id}")
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    print(f"Jester review: http://localhost:{port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
