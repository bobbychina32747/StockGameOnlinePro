#!/usr/bin/env python3
"""Offline contract checks for the portal cache headers.

The test reads the real nginx configuration and evaluates the ``map`` blocks
in ``site-maps.conf`` with a small, generic nginx-map interpreter.  The cache
rules therefore come from the deployed configuration instead of being
reimplemented as Python cache functions.

Run with::

    python deploy/tests/portal-cache.test.py

No nginx binary, network access, credentials or user data are used.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
NGINX_DIR = TESTS_DIR.parent / "nginx"

CONFIG_FILES = {
    "site-maps.conf": NGINX_DIR / "site-maps.conf",
    "portal-cache.conf": NGINX_DIR / "portal-cache.conf",
    "portal.conf": NGINX_DIR / "portal.conf",
    "blog.conf": NGINX_DIR / "blog.conf",
    "chat.conf": NGINX_DIR / "chat.conf",
    "sgp-local-proxy.conf": NGINX_DIR / "sgp-local-proxy.conf",
}

# Native request variables that matter to the portal_* maps.  The values are
# test inputs; $arg_v is supplied directly by each case.
DEFAULT_ENV = {
    "uri": "/",
    "request_method": "GET",
    "status": "200",
    "sent_http_content_type": "text/html",
    "arg_v": "",
    "http_authorization": "",
    "http_cookie": "",
    "upstream_http_set_cookie": "",
    "upstream_addr": "",
}

BROWSER_PUBLIC = "no-cache"
EDGE_HTML = "public, max-age=60"
BROWSER_ASSET = "public, max-age=3600"
EDGE_ASSET = "public, max-age=86400"
VERSIONED = "public, max-age=604800"
PRIVATE_BROWSER = "private, no-store"
PRIVATE_EDGE = "no-store"

REQUIRED_MAPS = {
    "portal_cache_path",
    "portal_cache_kind",
    "portal_cache_versioned",
    "portal_browser_policy",
    "portal_edge_policy",
    "portal_cache_method_ok",
    "portal_cache_status_ok",
    "portal_cache_static_ok",
    "portal_browser_cache",
    "portal_edge_cache",
}

_ESCAPES = {
    "n": "\n",
    "r": "\r",
    "t": "\t",
    '"': '"',
    "'": "'",
    "\\": "\\",
}


def read_config(name: str) -> str:
    return CONFIG_FILES[name].read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    """Remove nginx comments while preserving quoted strings and newlines."""
    out = []
    i = 0
    quote = None
    while i < len(text):
        char = text[i]
        if quote is not None:
            out.append(char)
            if char == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if char == quote:
                quote = None
            i += 1
            continue
        if char in "\"'":
            quote = char
            out.append(char)
            i += 1
        elif char == "#":
            while i < len(text) and text[i] not in "\r\n":
                i += 1
        else:
            out.append(char)
            i += 1
    return "".join(out)


def tokenize(text: str) -> list[str]:
    """Tokenize enough nginx syntax for map blocks and location headers."""
    tokens = []
    i = 0
    while i < len(text):
        char = text[i]
        if char.isspace():
            i += 1
            continue
        if char in "{};":
            tokens.append(char)
            i += 1
            continue
        if char in "\"'":
            quote = char
            i += 1
            buf = []
            while i < len(text):
                current = text[i]
                if current == "\\" and i + 1 < len(text):
                    following = text[i + 1]
                    buf.append(_ESCAPES.get(following, "\\" + following))
                    i += 2
                elif current == quote:
                    i += 1
                    break
                else:
                    buf.append(current)
                    i += 1
            else:
                raise ValueError("unterminated quoted string")
            tokens.append("".join(buf))
            continue
        start = i
        while i < len(text) and not text[i].isspace() and text[i] not in "{};":
            i += 1
        tokens.append(text[start:i])
    return tokens


class MapDef:
    def __init__(self, source: str, target: str) -> None:
        self.source = source
        self.target = target
        self.entries: list[tuple[str, str]] = []
        self.default: str | None = None


def parse_maps(text: str) -> dict[str, MapDef]:
    tokens = tokenize(strip_comments(text))
    maps: dict[str, MapDef] = {}
    i = 0
    while i < len(tokens):
        if tokens[i] != "map":
            i += 1
            continue
        if i + 3 >= len(tokens):
            raise ValueError("truncated map directive")
        source, target = tokens[i + 1], tokens[i + 2]
        if tokens[i + 3] != "{":
            raise ValueError(f"map {target}: expected '{{'")
        if not target.startswith("$"):
            raise ValueError(f"map target is not a variable: {target}")
        current = MapDef(source, target[1:])
        i += 4
        while i < len(tokens) and tokens[i] != "}":
            if i + 2 >= len(tokens):
                raise ValueError(f"truncated entry in map {target}")
            key, value, terminator = tokens[i], tokens[i + 1], tokens[i + 2]
            if terminator != ";":
                raise ValueError(f"map {target}: expected ';' after {key}")
            i += 3
            if key == "default":
                current.default = value
            else:
                current.entries.append((key, value))
        if i >= len(tokens):
            raise ValueError(f"map {target}: missing '}}'")
        i += 1
        maps[current.target] = current
    return maps


class MapEvaluator:
    """Minimal evaluator for nginx map output variables.

    Supports exact keys, ``default``, ``~`` / ``~*`` regex keys, variable
    expansion in the source and in the result, and dependent maps.  Exact
    keys are looked up first (as nginx does), then regex keys in config order.
    """

    def __init__(self, maps: dict[str, MapDef], native: dict[str, str]) -> None:
        self.maps = maps
        self.native = native
        self._cache: dict[str, str] = {}
        self._stack: list[str] = []

    def get(self, name: str) -> str:
        name = name[1:] if name.startswith("$") else name
        if name in self.maps:
            return self._map_value(name)
        return self.native.get(name, "")

    def expand(self, expression: str, match: re.Match[str] | None = None) -> str:
        def replace(found: re.Match[str]) -> str:
            token = found.group(1)
            if token.isdigit():
                index = int(token)
                if match is not None and index <= (match.re.groups or 0):
                    return match.group(index) or ""
                return found.group(0)
            return self.get(token)

        return re.sub(r"\$([A-Za-z0-9_]+)", replace, expression)

    def _map_value(self, name: str) -> str:
        if name in self._cache:
            return self._cache[name]
        if name in self._stack:
            raise ValueError("cyclic map dependency: " + " -> ".join(self._stack + [name]))
        definition = self.maps[name]
        self._stack.append(name)
        try:
            source = self.expand(definition.source)
            result = None
            # Exact string keys win over regular expressions in nginx.
            for key, value in definition.entries:
                if not key.startswith("~") and source.casefold() == key.casefold():
                    result = self.expand(value)
                    break
            if result is None:
                for key, value in definition.entries:
                    if not key.startswith("~"):
                        continue
                    ignore_case = key.startswith("~*")
                    pattern = key[2:] if ignore_case else key[1:]
                    found = re.search(
                        pattern,
                        source,
                        re.IGNORECASE if ignore_case else 0,
                    )
                    if found:
                        result = self.expand(value, found)
                        break
            if result is None:
                result = self.expand(definition.default) if definition.default is not None else ""
        finally:
            self._stack.pop()
        self._cache[name] = result
        return result


def extract_block(text: str, header: str, start: int = 0) -> str:
    """Return the body of a brace block whose header starts at ``start``."""
    position = text.find(header, start)
    if position < 0:
        raise AssertionError(f"configuration block not found: {header!r}")
    brace = text.find("{", position)
    if brace < 0:
        raise AssertionError(f"configuration block has no body: {header!r}")
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace + 1 : index]
    raise AssertionError(f"unbalanced configuration block: {header!r}")


class PortalCachePolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = {name: read_config(name) for name in CONFIG_FILES}
        cls.maps = parse_maps(cls.config["site-maps.conf"])

    def evaluate(
        self,
        uri: str,
        *,
        method: str = "GET",
        status: int = 200,
        content_type: str = "text/html",
        version: str = "",
        variables: dict[str, str] | None = None,
    ) -> tuple[str, str]:
        native = dict(DEFAULT_ENV)
        native.update(
            uri=uri,
            request_method=method,
            status=str(status),
            sent_http_content_type=content_type,
            arg_v=version,
        )
        if variables:
            native.update(variables)
        evaluator = MapEvaluator(self.maps, native)
        return (
            evaluator.get("portal_browser_cache"),
            evaluator.get("portal_edge_cache"),
        )

    def assert_policy(
        self,
        uri: str,
        browser: str,
        edge: str,
        **kwargs,
    ) -> None:
        actual = self.evaluate(uri, **kwargs)
        details = ", ".join(f"{key}={value!r}" for key, value in kwargs.items())
        self.assertEqual(
            (browser, edge),
            actual,
            f"{uri} ({details})",
        )

    # ------------------------------------------------------------------
    # Public HTML
    # ------------------------------------------------------------------

    def test_public_html_browser_revalidates_and_edge_caches_60s(self) -> None:
        for uri in (
            "/",
            "/index.html",
            "/posts/hello/",
            "/posts/hello/index.html",
            "/games/foo/",
            "/resources/",
            "/sponsor/",
            "/hosted/example/",
        ):
            with self.subTest(uri=uri):
                self.assert_policy(uri, BROWSER_PUBLIC, EDGE_HTML)

        # Charset parameters and ?v= must not turn HTML into a long-lived asset.
        self.assert_policy(
            "/",
            BROWSER_PUBLIC,
            EDGE_HTML,
            content_type="text/html; charset=utf-8",
        )
        self.assert_policy(
            "/posts/hello/",
            BROWSER_PUBLIC,
            EDGE_HTML,
            version="release-20261010",
        )

    def test_unknown_html_and_json_do_not_enter_cdn(self) -> None:
        for uri in (
            "/about",
            "/nope/deep/path",
            "/posts",
            "/assets/readme.html",
        ):
            with self.subTest(uri=uri, content_type="text/html"):
                self.assert_policy(uri, BROWSER_PUBLIC, PRIVATE_EDGE)

        for uri in (
            "/data.json",
            "/assets/data.json",
            "/posts/hello/data.json",
        ):
            with self.subTest(uri=uri, content_type="application/json"):
                self.assert_policy(
                    uri,
                    BROWSER_PUBLIC,
                    PRIVATE_EDGE,
                    content_type="application/json",
                )

    # ------------------------------------------------------------------
    # Static assets
    # ------------------------------------------------------------------

    def test_unversioned_assets_cache_3600_browser_86400_edge(self) -> None:
        cases = (
            ("/assets/app.css", "text/css"),
            ("/assets/app.js", "application/javascript"),
            ("/assets/app.mjs", "text/javascript"),
            ("/assets/app.js", "application/x-javascript"),
            ("/assets/pic.png", "image/png"),
            ("/assets/icon.svg", "image/svg+xml"),
            ("/assets/font.woff2", "font/woff2"),
            ("/assets/font.woff", "application/font-woff"),
            ("/assets/mod.wasm", "application/wasm"),
            ("/assets/clip.mp4", "video/mp4"),
            ("/assets/track.mp3", "audio/mpeg"),
            ("/media/photo.webp", "image/webp"),
        )
        for uri, content_type in cases:
            with self.subTest(uri=uri, content_type=content_type):
                self.assert_policy(
                    uri,
                    BROWSER_ASSET,
                    EDGE_ASSET,
                    content_type=content_type,
                )

        # Partial responses follow the same anonymous static policy.
        self.assert_policy(
            "/assets/clip.mp4",
            BROWSER_ASSET,
            EDGE_ASSET,
            status=206,
            content_type="video/mp4",
        )

    def test_versioned_assets_cache_604800_without_immutable(self) -> None:
        for version in ("1", "20261010-1", "abc.def_1", "x" * 96):
            with self.subTest(version=version):
                browser, edge = self.evaluate(
                    "/assets/app.js",
                    version=version,
                    content_type="application/javascript",
                )
                self.assertEqual(VERSIONED, browser)
                self.assertEqual(VERSIONED, edge)
                self.assertNotIn("immutable", browser.lower())
                self.assertNotIn("immutable", edge.lower())

        # The ?v= convention is fixed-length and character-limited.
        for version in ("", "-bad", "x" * 97):
            with self.subTest(version=version or "<empty>"):
                self.assert_policy(
                    "/assets/app.js",
                    BROWSER_ASSET,
                    EDGE_ASSET,
                    version=version,
                    content_type="application/javascript",
                )

        self.assert_policy(
            "/assets/mod.wasm",
            VERSIONED,
            VERSIONED,
            version="build.42",
            content_type="application/wasm",
        )

    def test_mime_mismatch_never_forces_html_into_asset_cache(self) -> None:
        cases = (
            ("/assets/app.js", "text/html"),
            ("/assets/app.js", "text/html; charset=utf-8"),
            ("/assets/app.css", "application/json"),
            ("/assets/pic.png", "text/plain"),
            ("/assets/mod.wasm", "application/octet-stream"),
            ("/index.html", "application/javascript"),
            ("/posts/hello/", "application/json"),
        )
        for uri, content_type in cases:
            with self.subTest(uri=uri, content_type=content_type):
                self.assert_policy(
                    uri,
                    BROWSER_PUBLIC,
                    PRIVATE_EDGE,
                    content_type=content_type,
                )

    # ------------------------------------------------------------------
    # Private / excluded paths
    # ------------------------------------------------------------------

    def test_private_and_hidden_paths_are_never_cached(self) -> None:
        paths = (
            "/api",
            "/api/",
            "/api/foo",
            "/api/chat/stream",
            "/oauth",
            "/oauth/access_token",
            "/admin",
            "/admin/",
            "/admin/index.html",
            "/account",
            "/account/settings",
            "/login",
            "/register",
            "/reset-password",
            "/verify-email",
            "/chat",
            "/chat/room",
            "/mail",
            "/mail/inbox",
            "/secret",
            "/secret/key",
            "/socket.io",
            "/socket.io/",
            "/.git/config",
            "/.env",
            "/assets/.hidden",
            "/posts/.draft/",
            "/sw.js",
            "/service-worker.js",
            "/retire-remaster-sw.js",
            "/assets/sw.js",
            "/site.webmanifest",
            "/app.webmanifest",
            "/assets/app.js.map",
            "/assets/app.css.map",
        )
        for uri in paths:
            with self.subTest(uri=uri):
                self.assert_policy(uri, PRIVATE_BROWSER, PRIVATE_EDGE)

        # Private classification is independent of the version query.
        self.assert_policy(
            "/api/foo",
            PRIVATE_BROWSER,
            PRIVATE_EDGE,
            version="v1",
            content_type="application/javascript",
        )
        self.assert_policy(
            "/admin/",
            PRIVATE_BROWSER,
            PRIVATE_EDGE,
            status=304,
            content_type="",
        )

    # ------------------------------------------------------------------
    # Method, status and response metadata
    # ------------------------------------------------------------------

    def test_head_is_treated_like_get(self) -> None:
        self.assert_policy(
            "/assets/app.css",
            BROWSER_ASSET,
            EDGE_ASSET,
            method="HEAD",
            content_type="text/css",
        )
        self.assert_policy("/", BROWSER_PUBLIC, EDGE_HTML, method="HEAD")
        self.assert_policy(
            "/api/foo",
            PRIVATE_BROWSER,
            PRIVATE_EDGE,
            method="HEAD",
        )

    def test_write_methods_and_error_statuses_are_private(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            with self.subTest(method=method, uri="/assets/app.css"):
                self.assert_policy(
                    "/assets/app.css",
                    PRIVATE_BROWSER,
                    PRIVATE_EDGE,
                    method=method,
                    content_type="text/css",
                )
            with self.subTest(method=method, uri="/"):
                self.assert_policy("/", PRIVATE_BROWSER, PRIVATE_EDGE, method=method)

        for status in (403, 404, 500, 502):
            with self.subTest(status=status, uri="/assets/app.css"):
                self.assert_policy(
                    "/assets/app.css",
                    PRIVATE_BROWSER,
                    PRIVATE_EDGE,
                    status=status,
                    content_type="text/html",
                )
            with self.subTest(status=status, uri="/"):
                self.assert_policy(
                    "/",
                    PRIVATE_BROWSER,
                    PRIVATE_EDGE,
                    status=status,
                )

    def test_304_without_content_type_keeps_url_classification(self) -> None:
        self.assert_policy(
            "/assets/app.css",
            BROWSER_ASSET,
            EDGE_ASSET,
            status=304,
            content_type="",
        )
        self.assert_policy(
            "/assets/app.css",
            VERSIONED,
            VERSIONED,
            status=304,
            content_type="",
            version="v1",
        )
        self.assert_policy(
            "/posts/hello/",
            BROWSER_PUBLIC,
            EDGE_HTML,
            status=304,
            content_type="",
        )
        self.assert_policy(
            "/",
            BROWSER_PUBLIC,
            EDGE_HTML,
            status=304,
            content_type="",
        )
        self.assert_policy(
            "/data.json",
            BROWSER_PUBLIC,
            PRIVATE_EDGE,
            status=304,
            content_type="",
        )
        self.assert_policy(
            "/api/foo",
            PRIVATE_BROWSER,
            PRIVATE_EDGE,
            status=304,
            content_type="",
        )

    def test_session_or_upstream_metadata_disables_shared_cache(self) -> None:
        cases = (
            {"http_authorization": "Bearer test-token"},
            {"http_cookie": "sid=test-session"},
            {"upstream_http_set_cookie": "sid=test-session; Path=/"},
            {"upstream_addr": "127.0.0.1:8000"},
        )
        for headers in cases:
            with self.subTest(headers=headers, uri="/assets/app.css"):
                self.assert_policy(
                    "/assets/app.css",
                    PRIVATE_BROWSER,
                    PRIVATE_EDGE,
                    variables=headers,
                )
            with self.subTest(headers=headers, uri="/"):
                self.assert_policy(
                    "/",
                    PRIVATE_BROWSER,
                    PRIVATE_EDGE,
                    variables=headers,
                )

        # Still private when the response is a 304 for a cacheable asset.
        self.assert_policy(
            "/assets/app.css",
            PRIVATE_BROWSER,
            PRIVATE_EDGE,
            status=304,
            content_type="",
            variables={"http_cookie": "sid=test-session"},
        )


class PortalCacheConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = {name: read_config(name) for name in CONFIG_FILES}
        cls.maps = parse_maps(cls.config["site-maps.conf"])
        cls.portal = cls.config["portal.conf"]
        cls.blog = cls.config["blog.conf"]
        cls.chat = cls.config["chat.conf"]
        cls.local = cls.config["sgp-local-proxy.conf"]

    def test_expected_portal_maps_are_declared(self) -> None:
        for name in REQUIRED_MAPS:
            with self.subTest(map=name):
                self.assertIn(name, self.maps)

    def test_cache_headers_are_driven_by_maps(self) -> None:
        cache = self.config["portal-cache.conf"]
        self.assertRegex(
            cache,
            r"(?m)^\s*add_header\s+Cache-Control\s+\$portal_browser_cache\s+always;",
        )
        self.assertRegex(
            cache,
            r"(?m)^\s*add_header\s+Cloudflare-CDN-Cache-Control\s+\$portal_edge_cache\s+always;",
        )
        self.assertEqual(
            1,
            len(re.findall(r"(?m)^\s*add_header\s+Cache-Control\s", cache)),
        )
        self.assertEqual(
            1,
            len(
                re.findall(
                    r"(?m)^\s*add_header\s+Cloudflare-CDN-Cache-Control\s",
                    cache,
                )
            ),
        )
        self.assertNotRegex(cache, r"max-age=")

    def test_no_expires_directives_that_could_duplicate_cache_headers(self) -> None:
        for name, text in self.config.items():
            with self.subTest(file=name):
                self.assertEqual(
                    [],
                    re.findall(r"(?m)^\s*expires\s+[^;]*;", text),
                )

    def test_api_and_chat_have_explicit_private_no_store(self) -> None:
        api = extract_block(self.portal, "location /api/ {")
        self.assertRegex(api, r'add_header\s+Cache-Control\s+"no-store"\s+always;')
        self.assertRegex(
            api,
            r'add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;',
        )
        self.assertRegex(api, r"proxy_pass\s+\$api_up\$request_uri;")
        self.assertNotIn("portal-cache.conf", api)
        self.assertNotIn("portal_browser_cache", api)

        oauth = extract_block(self.portal, "location = /oauth/access_token {")
        self.assertRegex(oauth, r'add_header\s+Cache-Control\s+"no-store"\s+always;')
        self.assertRegex(
            oauth,
            r'add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;',
        )

        device = extract_block(self.portal, "location = /login/device/code {")
        self.assertRegex(device, r'add_header\s+Cache-Control\s+"no-store"\s+always;')

        chat = extract_block(self.chat, "location ^~ /api/chat/ {")
        self.assertRegex(
            chat,
            r'add_header\s+Cache-Control\s+"private, no-store"\s+always;',
        )
        self.assertRegex(
            chat,
            r'add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;',
        )
        self.assertRegex(chat, r"proxy_buffering\s+off;")
        self.assertRegex(chat, r"proxy_cache\s+off;")
        self.assertRegex(chat, r"proxy_request_buffering\s+off;")
        self.assertRegex(chat, r"proxy_hide_header\s+Cache-Control;")
        self.assertRegex(chat, r"proxy_pass\s+http://127\.0\.0\.1:8000;")

    def test_local_api_proxy_hides_upstream_cache_headers(self) -> None:
        for header in ("Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"):
            self.assertRegex(self.local, rf"proxy_hide_header\s+{re.escape(header)};")
            self.assertRegex(self.chat, rf"proxy_hide_header\s+{re.escape(header)};")
        self.assertRegex(
            self.local,
            r'add_header\s+Cache-Control\s+"private, no-store"\s+always;',
        )
        self.assertRegex(
            self.local,
            r'add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;',
        )
        self.assertRegex(self.local, r"proxy_cache\s+off;")
        self.assertRegex(self.local, r"proxy_pass\s+http://127\.0\.0\.1:8000;")

    def test_static_routes_and_aliases_are_preserved(self) -> None:
        self.assertRegex(self.portal, r"(?m)^\s*root\s+/var/www/portal;")
        https_start = self.portal.index("root /var/www/portal;")

        root_location = extract_block(self.portal, "location / {", https_start)
        self.assertRegex(
            root_location,
            r"include\s+/etc/nginx/snippets/portal-cache\.conf;",
        )
        self.assertRegex(
            root_location,
            r"try_files\s+\$uri\s+\$uri/\s+=404;",
        )

        index_location = extract_block(self.portal, "location = /index.html {")
        self.assertRegex(
            index_location,
            r"include\s+/etc/nginx/snippets/portal-cache\.conf;",
        )

        self.assertRegex(
            self.portal,
            r"location\s*=\s*/blog\s*\{\s*return\s+301\s+https://bobbychina\.github\.io/;",
        )

        for header in ("location ^~ /assets/", "location ^~ /i18n/"):
            with self.subTest(block=header):
                block = extract_block(self.blog, header)
                self.assertRegex(
                    block,
                    r"include\s+/etc/nginx/snippets/portal-cache\.conf;",
                )

        posts = extract_block(self.blog, "location ^~ /posts/ {")
        self.assertRegex(posts, r"alias\s+/opt/stockgame/blog-dist/posts/;")
        self.assertRegex(posts, r"try_files\s+\$uri\s+\$uri/\s+=404;")
        self.assertRegex(
            posts,
            r"include\s+/etc/nginx/snippets/portal-cache\.conf;",
        )

        media = extract_block(self.blog, "location ^~ /media/ {")
        self.assertRegex(media, r"alias\s+/opt/stockgame/blog-dist/media/;")
        self.assertRegex(
            media,
            r"include\s+/etc/nginx/snippets/portal-cache\.conf;",
        )

        admin = extract_block(self.blog, "location ^~ /admin/ {")
        self.assertRegex(admin, r"alias\s+/var/www/portal/admin/;")
        self.assertRegex(admin, r"try_files\s+\$uri\s+\$uri/\s+/admin/index\.html;")
        self.assertRegex(admin, r'add_header\s+Cache-Control\s+"no-store"\s+always;')
        self.assertRegex(
            admin,
            r'add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;',
        )
        self.assertNotIn("portal-cache.conf", admin)

        self.assertRegex(
            self.blog,
            r"location\s*=\s*/admin\s*\{\s*return\s+301\s+/admin/;",
        )

        feed = extract_block(self.blog, "location = /feed.xml {")
        self.assertRegex(feed, r"alias\s+/opt/stockgame/blog-dist/feed\.xml;")
        self.assertRegex(feed, r'add_header\s+Cache-Control\s+"no-cache"\s+always;')

        sitemap = extract_block(self.blog, "location = /sitemap.xml {")
        self.assertRegex(sitemap, r"alias\s+/opt/stockgame/blog-dist/sitemap\.xml;")
        self.assertRegex(sitemap, r'add_header\s+Cache-Control\s+"no-cache"\s+always;')


if __name__ == "__main__":
    unittest.main(verbosity=2)
