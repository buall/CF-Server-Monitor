"""Local visual proof only: original theme + injected adapter + synthetic REST data.

No production authentication, Access, SSH, D1 or working realtime implementation.
Downloaded theme files stay outside the repository and must match evidence.json.
"""
import argparse
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
EVIDENCE = json.loads((HERE / "evidence.json").read_text())
NODE_ID = "11111111-1111-4111-8111-111111111111"


def prepare(cache, download):
    for entry in EVIDENCE["dist_files"]:
        path = cache / entry["path"]
        if not path.is_file() and download:
            url = (
                "https://raw.githubusercontent.com/"
                f"{EVIDENCE['theme_repository']}/{EVIDENCE['theme_dist_commit']}/"
                f"{entry['path']}"
            )
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        if not path.is_file():
            raise SystemExit(f"Missing {path}; run with --download first")
        data = path.read_bytes()
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if blob != entry["git_blob_sha1"]:
            raise SystemExit(f"Original theme hash mismatch: {path}")


def fixture(path):
    now = int(time.time() * 1000)
    if path == "/api/config":
        return {
            "version": "2.8.7 Beta6",
            "is_public": True,
            "authorization": False,
            "turnstile_enabled": False,
            "default_language": "zh",
            "site_title": "ShellAtlas visual proof — fixture data",
            "preferred_theme": "light",
            "latency_window": {"points": 20, "hours": 2},
            "theme_options": {},
        }
    if path != "/api/servers":
        return None
    node = {
        "id": NODE_ID,
        "name": "腾讯云轻量-锐驰-广州",
        "region": "CN",
        "os": "Debian GNU/Linux 12",
        "ip_v4": "1",
        "ip_v6": "1",
        "cpu": 2.55,
        "cpu_cores": 2,
        "ram_used": 1484,
        "ram_total": 1968,
        "disk_used": 21299,
        "disk_total": 40243,
        "load_avg": "0.11 0.08 0.02",
        "net_out_speed": 1005568,
        "net_in_speed": 1028096,
        "net_tx_monthly": 15354508083,
        "net_rx_monthly": 15139759718,
        "tcp_conn": 393,
        "udp_conn": 69,
        "boot_time": str(now - 355 * 86400000),
        "last_updated": now,
        "tags": "腾讯云,广州,200Mbps,不限流量",
        "price": "459",
        "billing_cycle": "yearly",
        "currency": "¥",
        "expire_date": "2029-12-20",
        "ping_ct": 20,
        "ping_cu": 9,
        "ping_cm": 4,
        "loss_ct": 0,
        "loss_cu": 0,
        "loss_cm": 0,
        "traffic_limit": "0",
        "is_hidden": "0",
    }
    node["ping"] = [
        dict(ts=now - (20 - i) * 360000, ct=20, cu=9, cm=4) for i in range(20)
    ]
    node["loss"] = [
        dict(ts=now - (20 - i) * 360000, ct=0, cu=0, cm=0) for i in range(20)
    ]
    return {
        "servers": [node],
        "stats": {"total": 1, "online": 1, "offline": 0},
        "regionStats": {"CN": 1},
        "sysConfig": {
            "show_three_net_details": True,
            "show_price": True,
            "show_tf": True,
            "show_expire": True,
        },
        "latestReportUpdates": [],
    }


def run(cache, port):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(cache), **kwargs)

        def respond(self, data, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/api/ws":
                self.respond(b"Realtime is outside this visual proof", "text/plain", 426)
                return
            if path.startswith("/api/"):
                data = fixture(path)
                self.respond(
                    json.dumps(data if data is not None else {"error": "Not in visual proof"}).encode(),
                    "application/json",
                    200 if data is not None else 404,
                )
                return
            if path == "/":
                html = (cache / "index.html").read_text()
                script = (HERE / "adapter.js").read_text()
                self.respond(html.replace("</head>", f"<script>{script}</script></head>").encode(), "text/html; charset=utf-8")
                return
            if path.startswith(("/flags/", "/os-icons/")):
                public = HERE.parents[2] / "public"
                asset = (public / path.lstrip("/")).resolve()
                if asset.is_relative_to(public) and asset.is_file() and asset.suffix == ".svg":
                    self.respond(asset.read_bytes(), "image/svg+xml")
                    return
            super().do_GET()

    print(f"Visual proof only: http://127.0.0.1:{port}/#/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Download the pinned original theme files")
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / "cfsm-shellatlas-theme-proof")
    parser.add_argument("--port", type=int, default=18987)
    args = parser.parse_args()
    prepare(args.cache_dir, args.download)
    run(args.cache_dir, args.port)
