"""Tiny local recorder for owner speech samples (turn/STT benchmarks).

Run: python3 bench/recorder/server.py   ->  http://localhost:8797
Each upload is saved to bench/data/owner/ as the browser's webm and a
16 kHz mono wav. Nothing leaves the machine.
"""
import http.server
import json
import os
import re
import subprocess
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "data", "owner"))
PORT = 8797
os.makedirs(OUT, exist_ok=True)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def do_GET(self):
        if self.path == "/saved":
            files = sorted(f for f in os.listdir(OUT) if f.endswith(".wav"))
            return self._json({"saved": files})
        return super().do_GET()

    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        prompt = re.sub(r"[^0-9]", "", q.get("prompt", ["0"])[0]) or "0"
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        stem = os.path.join(OUT, f"p{int(prompt):02d}-{time.strftime('%H%M%S')}")
        with open(stem + ".webm", "wb") as f:
            f.write(body)
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", stem + ".webm",
                            "-ac", "1", "-ar", "16000", stem + ".wav"],
                           capture_output=True, text=True)
        if r.returncode:
            return self._json({"ok": False, "error": r.stderr[-300:]}, 500)
        return self._json({"ok": True, "file": os.path.basename(stem) + ".wav"})

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
