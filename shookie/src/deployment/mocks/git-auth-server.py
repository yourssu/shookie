#!/usr/bin/env python3
"""Tiny authenticated smart-HTTP git server for tests (wraps `git http-backend`).

usage: git-auth-server.py <projects-root> <expected-user> <expected-token-file> <port-file>
Requires HTTP Basic auth user:token (token read from a file so it never appears on a command line).
Prints each received Authorization state to stderr for debugging. Binds 0.0.0.0 on an ephemeral port
and writes the port number to <port-file> once ready.
"""
import base64
import http.server
import os
import subprocess
import sys

root, user, token_file, port_file = sys.argv[1:5]
token = open(token_file, encoding="utf-8").read()
expected = "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()
backend = subprocess.check_output(["git", "--exec-path"], text=True).strip() + "/git-http-backend"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def handle_any(self):
        if self.headers.get("Authorization") != expected:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="git"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        env = {
            "PATH": os.environ["PATH"],
            "GIT_PROJECT_ROOT": root,
            "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": self.command,
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(length),
            "REMOTE_USER": user,
            "REMOTE_ADDR": "127.0.0.1",
        }
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        out = subprocess.run([backend], input=body, env=env, capture_output=True).stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        status, headers = 200, []
        for line in head.decode().split("\r\n"):
            name, _, value = line.partition(": ")
            if name.lower() == "status":
                status = int(value.split()[0])
            elif name:
                headers.append((name, value))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = handle_any


server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Handler)
open(port_file, "w").write(str(server.server_address[1]))
server.serve_forever()
