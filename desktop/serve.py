#!/usr/bin/env python3
"""Tiny local web server for Pindou Studio.

Serves the app folder on 127.0.0.1 only (other computers can't reach it), tells
browsers to re-check files on every visit (so an update always shows up), and
refuses directory listings. Installed and started by desktop/install.sh.

    python3 serve.py --port 8642 --dir ~/.local/share/pindou-studio/app
"""
import argparse
import functools
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Revalidate every time: unchanged files cost a quick "304 Not Modified".
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format, *args):
        pass  # keep the journal quiet; errors still surface through systemd


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8642)
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=args.dir)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
