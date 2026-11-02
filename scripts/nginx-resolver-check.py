#!/usr/bin/env python3
"""Prove the web nginx config re-resolves the API host instead of pinning an IP.

Renders apps/web/nginx.conf.template the way the container entrypoint does, then
points that config at a tiny DNS server. The hostname stays the same; the A
record flips from one local listener to another. A second request must follow
the new address without an nginx reload.
"""

from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "apps" / "web" / "nginx.conf.template"
ENTRYPOINT = ROOT / "apps" / "web" / "docker-entrypoint.sh"
WORKDIR = Path("/tmp/hearth-nginx-check")
IP_PATH = Path("/tmp/hearth-nginx-upstream-ip")
DNS_PORT = 15353
HTTP_PORT = 18081
WEB_PORT = 18080
HOST = "upstream.test"


def fail(message: str) -> None:
    print(f"FAIL {message}", file=sys.stderr)
    sys.exit(1)


def run_entrypoint(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    merged["HEARTH_ENTRYPOINT_DRY_RUN"] = "1"
    return subprocess.run(
        [str(ENTRYPOINT)],
        check=False,
        capture_output=True,
        text=True,
        env=merged,
    )


def parse_exports(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def check_entrypoint() -> None:
    cases = [
        ({"API_UPSTREAM": "http://api:3001"}, {"API_SCHEME": "http", "API_HOST": "api", "API_PORT": "3001"}),
        (
            {"API_UPSTREAM": "http://api.railway.internal:4321/"},
            {"API_SCHEME": "http", "API_HOST": "api.railway.internal", "API_PORT": "4321"},
        ),
        ({"API_UPSTREAM": "https://example.com"}, {"API_SCHEME": "https", "API_HOST": "example.com", "API_PORT": "443"}),
        ({"API_HOST": "foo.internal", "API_PORT": "9"}, {"API_SCHEME": "http", "API_HOST": "foo.internal", "API_PORT": "9"}),
        ({}, {"API_SCHEME": "http", "API_HOST": "api", "API_PORT": "3001"}),
    ]
    # Drop inherited API_* so the default case is actually empty.
    base_clear = {name: "" for name in ("API_UPSTREAM", "API_HOST", "API_PORT", "API_SCHEME", "NGINX_RESOLVER")}
    for extra, expect in cases:
        result = run_entrypoint({**base_clear, **extra})
        if result.returncode != 0:
            fail(f"entrypoint failed for {extra}: {result.stderr}")
        got = parse_exports(result.stdout)
        for key, value in expect.items():
            if got.get(key) != value:
                fail(f"entrypoint {extra}: {key}={got.get(key)!r}, expected {value!r}\n{result.stdout}")
        if not got.get("NGINX_RESOLVER"):
            fail("entrypoint did not choose a resolver")

    bad = run_entrypoint({**base_clear, "API_UPSTREAM": "http://api:3001/prefix"})
    if bad.returncode == 0:
        fail("entrypoint accepted an API_UPSTREAM path")
    print("entrypoint parsing ok")


def render_template() -> str:
    values = {
        "PORT": str(WEB_PORT),
        "NGINX_RESOLVER": f"127.0.0.1:{DNS_PORT}",
        "API_HOST": HOST,
        "API_PORT": str(HTTP_PORT),
        "API_SCHEME": "http",
    }
    text = TEMPLATE.read_text()
    for key, value in values.items():
        text = text.replace("${" + key + "}", value)
    if "${" in text:
        fail(f"unsubstituted template variable:\n{text}")
    required = [
        f"resolver 127.0.0.1:{DNS_PORT} valid=1s ipv6=on;",
        f'set $hearth_api_host "{HOST}";',
        f'set $hearth_api_port "{HTTP_PORT}";',
        "rewrite ^/api/(.*)$ /$1 break;",
        "proxy_pass http://$hearth_api_host:$hearth_api_port;",
    ]
    for snippet in required:
        if snippet not in text:
            fail(f"rendered config missing {snippet!r}\n{text}")
    if "proxy_pass http://api" in text or f"proxy_pass http://{HOST}" in text:
        fail("proxy_pass still uses a literal host")
    print("rendered config resolves the API host through a variable")
    return text


def decode_name(data: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    while True:
        length = data[offset]
        offset += 1
        if length == 0:
            break
        if length & 0xC0:
            raise RuntimeError("compressed name in query")
        labels.append(data[offset : offset + length].decode())
        offset += length
    return ".".join(labels), offset


class DnsServer(threading.Thread):
    def __init__(self, ip_path: Path) -> None:
        super().__init__(daemon=True)
        self.ip_path = ip_path
        self.queries: list[tuple[str, int, str]] = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", DNS_PORT))

    def run(self) -> None:
        while True:
            try:
                data, addr = self.sock.recvfrom(512)
            except OSError:
                return
            self.sock.sendto(self.answer(data), addr)

    def answer(self, data: bytes) -> bytes:
        name, offset = decode_name(data, 12)
        qtype = int.from_bytes(data[offset : offset + 2], "big")
        question = data[12 : offset + 4]
        flags = 0x8400 | (int.from_bytes(data[2:4], "big") & 0x0100)
        header = data[:2] + flags.to_bytes(2, "big")
        if qtype == 1 and name == HOST:
            ip = self.ip_path.read_text().strip()
            self.queries.append((name, qtype, ip))
            answer = b"\xc0\x0c" + (1).to_bytes(2, "big") + (1).to_bytes(2, "big")
            answer += (1).to_bytes(4, "big") + (4).to_bytes(2, "big") + bytes(int(part) for part in ip.split("."))
            counts = (1).to_bytes(2, "big") + (1).to_bytes(2, "big") + (0).to_bytes(2, "big") + (0).to_bytes(2, "big")
            return header + counts + question + answer
        counts = (1).to_bytes(2, "big") + (0).to_bytes(2, "big") + (0).to_bytes(2, "big") + (0).to_bytes(2, "big")
        return header + counts + question

    def close(self) -> None:
        self.sock.close()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = f"{self.server.label} {self.path}".encode()  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def serve(ip: str, label: str) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((ip, HTTP_PORT), Handler)
    server.label = label  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def start_nginx(server_conf: str) -> subprocess.Popen[str]:
    if WORKDIR.exists():
        shutil.rmtree(WORKDIR)
    for name in ("client", "proxy", "fastcgi", "uwsgi", "scgi"):
        (WORKDIR / name).mkdir(parents=True)
    (WORKDIR / "html").mkdir()
    (WORKDIR / "default.conf").write_text(server_conf)
    (WORKDIR / "nginx.conf").write_text(
        textwrap.dedent(
            f"""
            worker_processes 1;
            error_log {WORKDIR / "error.log"} info;
            pid {WORKDIR / "nginx.pid"};
            events {{ worker_connections 64; }}
            http {{
              access_log {WORKDIR / "access.log"};
              client_body_temp_path {WORKDIR / "client"};
              proxy_temp_path {WORKDIR / "proxy"};
              fastcgi_temp_path {WORKDIR / "fastcgi"};
              uwsgi_temp_path {WORKDIR / "uwsgi"};
              scgi_temp_path {WORKDIR / "scgi"};
              include {WORKDIR / "default.conf"};
            }}
            """
        )
    )
    nginx = shutil.which("nginx")
    if not nginx:
        fail("nginx is not installed")
    proc = subprocess.Popen([nginx, "-c", str(WORKDIR / "nginx.conf"), "-g", "daemon off;"], text=True)
    deadline = time.time() + 5
    while time.time() < deadline:
        if proc.poll() is not None:
            fail(f"nginx exited\n{(WORKDIR / 'error.log').read_text()}")
        try:
            with socket.create_connection(("127.0.0.1", WEB_PORT), timeout=0.2):
                return proc
        except OSError:
            time.sleep(0.05)
    fail(f"nginx did not listen\n{(WORKDIR / 'error.log').read_text()}")
    raise AssertionError("unreachable")


def fetch(path: str) -> str:
    with socket.create_connection(("127.0.0.1", WEB_PORT), timeout=3) as sock:
        sock.sendall(f"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode())
        data = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].decode()
    if not status.endswith("200 OK"):
        fail(f"{path} -> {status}\n{(WORKDIR / 'error.log').read_text()}")
    return body.decode()


def main() -> None:
    check_entrypoint()
    rendered = render_template()
    IP_PATH.write_text("127.0.0.2\n")
    dns = DnsServer(IP_PATH)
    dns.start()
    one = serve("127.0.0.2", "one")
    two = serve("127.0.0.3", "two")
    nginx = start_nginx(rendered)
    try:
        health = fetch("/health")
        if health != "ok\n":
            fail(f"health body {health!r}")
        first = fetch("/api/tasks?team=1")
        if first != "one /tasks?team=1":
            fail(f"first proxy {first!r}")
        IP_PATH.write_text("127.0.0.3\n")
        # valid=1s caps the resolver cache. Poll past that window instead of
        # assuming a single sleep, so a slow worker still has to follow DNS.
        second = ""
        deadline = time.time() + 5
        while time.time() < deadline:
            time.sleep(0.5)
            second = fetch("/api/tasks?team=1")
            if second == "two /tasks?team=1":
                break
        else:
            fail(
                "nginx kept the old upstream IP after DNS changed.\n"
                f"got {second!r}\ndns {dns.queries}\n{(WORKDIR / 'error.log').read_text()}"
            )
    finally:
        nginx.send_signal(signal.SIGTERM)
        nginx.wait(timeout=5)
        one.shutdown()
        two.shutdown()
        dns.close()
    print("nginx followed the API hostname onto the new address without a reload")


if __name__ == "__main__":
    main()
