#!/usr/bin/env python3
"""Simple static file server for LegalDraft AI frontend."""
import os, http.server, socketserver

PORT = 3000
DIR  = os.path.dirname(os.path.abspath(__file__))

os.chdir(DIR)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[legaldraft-frontend] {self.address_string()} — {fmt % args}")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"[legaldraft-frontend] Serving on http://localhost:{PORT}")
    httpd.serve_forever()
