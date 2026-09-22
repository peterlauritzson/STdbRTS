"""Serves the built Vite client (`dist/`) on PythonAnywhere.

PythonAnywhere runs a WSGI application, so it can host the static client but
not the SpacetimeDB host itself: it offers no arbitrary listening ports and no
WebSocket support. The browser connects straight to SpacetimeDB instead, so
this process only ever hands out HTML, JS, CSS, and fonts.

Copy the contents of this file into the WSGI configuration file that
PythonAnywhere generates for the web app (Web tab, "WSGI configuration file",
usually /var/www/<user>_pythonanywhere_com_wsgi.py) and edit DIST below.

Uses only the standard library, so no virtualenv is required.
"""

import mimetypes
import os
import posixpath

# Absolute path to the uploaded `dist/` directory.
DIST = "/home/YOURUSERNAME/stdbrts/dist"

# PythonAnywhere's Python may not know these by default.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")

# Vite fingerprints everything under assets/, so it can be cached forever.
IMMUTABLE = "public, max-age=31536000, immutable"
# The entry document must never be cached, or a redeploy strands old clients.
NO_STORE = "no-cache, no-store, must-revalidate"

_ROOT = os.path.realpath(DIST)


def _resolve(url_path):
    """Map a URL path to a file inside DIST, or None if it escapes or is absent."""
    relative = posixpath.normpath(url_path).lstrip("/")
    if not relative or relative == ".":
        return None
    candidate = os.path.realpath(os.path.join(_ROOT, *relative.split("/")))
    if candidate != _ROOT and not candidate.startswith(_ROOT + os.sep):
        return None
    return candidate if os.path.isfile(candidate) else None


def _respond(start_response, status, headers, body, include_body):
    headers.append(("Content-Length", str(len(body))))
    start_response(status, headers)
    return [body] if include_body else [b""]


def application(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET")
    if method not in ("GET", "HEAD"):
        return _respond(
            start_response,
            "405 Method Not Allowed",
            [("Content-Type", "text/plain; charset=utf-8"), ("Allow", "GET, HEAD")],
            b"Method not allowed\n",
            True,
        )

    url_path = environ.get("PATH_INFO", "/") or "/"
    target = _resolve(url_path)
    cache = IMMUTABLE if target and url_path.startswith("/assets/") else NO_STORE
    if target is None:
        # Single-page client: anything unrecognised falls back to the entry
        # document so deep links and reloads work.
        target = os.path.join(_ROOT, "index.html")
        if not os.path.isfile(target):
            return _respond(
                start_response,
                "500 Internal Server Error",
                [("Content-Type", "text/plain; charset=utf-8")],
                b"dist/index.html is missing. Upload the output of `npm run build`.\n",
                method == "GET",
            )

    content_type, encoding = mimetypes.guess_type(target)
    content_type = content_type or "application/octet-stream"
    if content_type.startswith("text/") or content_type in (
        "text/javascript",
        "application/json",
        "image/svg+xml",
    ):
        content_type += "; charset=utf-8"

    with open(target, "rb") as handle:
        body = handle.read()

    headers = [
        ("Content-Type", content_type),
        ("Cache-Control", cache),
        # The client is self-contained; it only reaches out over WebSocket.
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ]
    if encoding:
        headers.append(("Content-Encoding", encoding))
    return _respond(start_response, "200 OK", headers, body, method == "GET")
