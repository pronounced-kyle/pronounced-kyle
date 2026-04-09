#!/usr/bin/env python3

import csv
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "site.db"
SITE_DATA_PATH = DATA_DIR / "site-data.js"
BOOKS_JSON_PATH = DATA_DIR / "books.json"
COVER_CACHE_PATH = DATA_DIR / "cover-cache.js"

SESSION_COOKIE = "pkyle_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

_COVER_CACHE = None


def now_ts():
    return int(time.time())


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def slugify(value):
    return re.sub(r"(^-+|-+$)", "", re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower()))


def normalize_source_key(title, author, year):
    return "::".join([slugify(title), slugify(author), slugify(year)])


def normalize_cover_key(title, author):
    return f"{html.unescape(str(title or '')).strip().lower()}::{html.unescape(str(author or '')).strip().lower()}"


def strip_html(value):
    text = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def parse_int(value, default=None):
    if value in (None, "", "-"):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def unique_strings(values):
    results = []
    seen = set()
    for value in values:
        candidate = str(value or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        results.append(candidate)
    return results


def numeric_year(value):
    match = re.search(r"\d{4}", str(value))
    return int(match.group(0)) if match else None


def build_sort_date(year, completed, fallback_index):
    base_year = numeric_year(year) or 1970
    parts = re.match(r"^(\d{1,2})-([A-Za-z]{3})$", str(completed or ""))
    if parts:
        months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        month_name = parts.group(2).lower()
        if month_name in months:
            month_index = months.index(month_name) + 1
            day = int(parts.group(1))
            return int(f"{base_year:04d}{month_index:02d}{day:02d}")

    safe_day = min(fallback_index + 1, 28)
    return int(f"{base_year:04d}01{safe_day:02d}")


def load_cover_cache():
    global _COVER_CACHE
    if _COVER_CACHE is not None:
        return _COVER_CACHE

    cache = {}
    if COVER_CACHE_PATH.exists():
        try:
            raw = COVER_CACHE_PATH.read_text(encoding="utf-8")
            start = raw.find("{")
            end = raw.rfind("}")
            if start != -1 and end != -1:
                payload = json.loads(raw[start : end + 1])
                for key, url in payload.items():
                    title, _, author = html.unescape(key).partition("::")
                    if not author:
                        continue
                    cache[normalize_cover_key(title, author)] = str(url).strip()
        except (OSError, json.JSONDecodeError):
            cache = {}

    _COVER_CACHE = cache
    return _COVER_CACHE


def build_cover_urls_from_doc(doc):
    candidates = []

    cover_id = doc.get("cover_i")
    if cover_id:
        candidates.append(f"https://covers.openlibrary.org/b/id/{cover_id}-L.jpg?default=false")

    for isbn in (doc.get("isbn") or [])[:2]:
        candidates.append(f"https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg?default=false")

    for edition in (doc.get("edition_key") or [])[:1]:
        candidates.append(f"https://covers.openlibrary.org/b/olid/{edition}-L.jpg?default=false")

    return candidates


def fetch_open_library_cover_options(title, author):
    title = str(title or "").strip()
    author = str(author or "").strip()
    if not title:
        return []

    query = urllib.parse.urlencode({"title": title, "author": author, "limit": 8})
    request = urllib.request.Request(
        f"https://openlibrary.org/search.json?{query}",
        headers={"User-Agent": "PronouncedKyleAdmin/1.0"},
    )

    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []

    candidates = []
    for doc in payload.get("docs", [])[:8]:
        candidates.extend(build_cover_urls_from_doc(doc))
    return unique_strings(candidates)


def build_cover_options(title, author, cover_url="", include_remote=False):
    cached = load_cover_cache().get(normalize_cover_key(title, author), "")
    options = unique_strings([cover_url, cached])
    if include_remote:
        options = unique_strings(options + fetch_open_library_cover_options(title, author))
    return options


def hash_password(password, salt=None, iterations=200000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations))
        return hmac.compare_digest(candidate.hex(), expected)
    except ValueError:
        return False


def parse_site_data_file():
    raw = SITE_DATA_PATH.read_text(encoding="utf-8")
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError("Could not parse data/site-data.js")

    object_literal = raw[start : end + 1]
    json_like = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', object_literal)
    return json.loads(json_like)


def write_site_data_file(payload):
    SITE_DATA_PATH.write_text(f"window.siteData = {json.dumps(payload, indent=2, ensure_ascii=True)};\n", encoding="utf-8")


def timeline_entry_seed(group_year, item, index):
    return "::".join(
        [
            str(group_year or "").strip(),
            str(item.get("date", "") or "").strip(),
            str(item.get("text", "") or "").strip(),
            str((item.get("chip") or {}).get("label", "") or "").strip(),
            str(item.get("suffix", "") or "").strip(),
            str(index),
        ]
    )


def timeline_entry_id(group_year, item, index):
    digest = hashlib.sha1(timeline_entry_seed(group_year, item, index).encode("utf-8")).hexdigest()
    return f"tl-{digest[:12]}"


def ensure_timeline_ids(site_data):
    changed = False
    for group_index, group in enumerate(site_data.get("timeline", [])):
        for item_index, item in enumerate(group.get("items", [])):
            if not item.get("id"):
                item["id"] = timeline_entry_id(group.get("year", ""), item, f"{group_index}-{item_index}")
                changed = True
    return changed


def load_site_data():
    site_data = parse_site_data_file()
    if ensure_timeline_ids(site_data):
        write_site_data_file(site_data)
    return site_data


def flatten_timeline_entries(site_data):
    entries = []
    for group in site_data.get("timeline", []):
        year = str(group.get("year", "")).strip() or "Unknown"
        for item in group.get("items", []):
            chip = item.get("chip") or {}
            entries.append(
                {
                    "id": str(item.get("id", "")).strip(),
                    "year": year,
                    "date": str(item.get("date", "")).strip(),
                    "tone": str(item.get("tone", "lore")).strip() or "lore",
                    "text": str(item.get("text", "")).strip(),
                    "suffix": str(item.get("suffix", "")).strip(),
                    "chipLabel": str(chip.get("label", "")).strip(),
                    "chipHref": str(chip.get("href", "")).strip(),
                    "chipColor": str(chip.get("color", "")).strip(),
                }
            )
    return entries


def build_grouped_timeline(entries):
    groups = []
    group_map = {}

    for entry in entries:
        year = str(entry.get("year", "")).strip() or "Unknown"
        group = group_map.get(year)
        if not group:
            group = {"year": year, "items": []}
            group_map[year] = group
            groups.append(group)

        item = {
            "id": str(entry.get("id", "")).strip() or timeline_entry_id(year, entry, len(group["items"])),
            "tone": str(entry.get("tone", "lore")).strip() or "lore",
            "date": str(entry.get("date", "")).strip(),
            "text": str(entry.get("text", "")).strip(),
        }

        chip_label = str(entry.get("chipLabel", "")).strip()
        chip_href = str(entry.get("chipHref", "")).strip()
        chip_color = str(entry.get("chipColor", "")).strip()
        if chip_label or chip_href or chip_color:
            item["chip"] = {}
            if chip_label:
                item["chip"]["label"] = chip_label
            if chip_href:
                item["chip"]["href"] = chip_href
            if chip_color:
                item["chip"]["color"] = chip_color

        suffix = str(entry.get("suffix", "")).strip()
        if suffix:
            item["suffix"] = suffix

        group["items"].append(item)

    return groups


def timeline_year_rank(value):
    match = re.search(r"\d{4}", str(value or ""))
    return int(match.group(0)) if match else -1


def sort_timeline_entries(entries):
    return [entry for _, entry in sorted(enumerate(entries), key=lambda pair: (-timeline_year_rank(pair[1].get("year")), pair[0]))]


def sanitize_timeline_payload(payload):
    year = str(payload.get("year", "")).strip() or "Unknown"
    tone = str(payload.get("tone", "lore")).strip().lower() or "lore"
    if tone not in {"media", "lore", "present"}:
        tone = "lore"

    text = str(payload.get("text", "")).strip()
    suffix = str(payload.get("suffix", "")).strip()
    chip_label = str(payload.get("chipLabel", "")).strip()
    chip_href = str(payload.get("chipHref", "")).strip()
    chip_color = str(payload.get("chipColor", "")).strip()

    if not text and not chip_label and not suffix:
        raise ValueError("Timeline entries need some text.")

    return {
        "id": str(payload.get("id", "")).strip(),
        "year": year,
        "date": str(payload.get("date", "")).strip(),
        "tone": tone,
        "text": text,
        "suffix": suffix,
        "chipLabel": chip_label,
        "chipHref": chip_href,
        "chipColor": chip_color,
    }


def read_sheet_config():
    site_data = load_site_data()
    sheet = site_data.get("sheet") or {}
    sheet_id = str(sheet.get("id", "")).strip()
    gid = str(sheet.get("gid", "")).strip()
    if not sheet_id or not gid:
        raise RuntimeError("Could not read Google Sheet config from data/site-data.js")
    return {"id": sheet_id, "gid": gid}


def fetch_sheet_rows():
    config = read_sheet_config()
    url = f'https://docs.google.com/spreadsheets/d/{config["id"]}/gviz/tq?tqx=out:csv&gid={config["gid"]}'
    with urllib.request.urlopen(url) as response:
        text = response.read().decode("utf-8")
    return list(csv.reader(text.splitlines()))


def first_value(record, keys):
    for key in keys:
        if record.get(key):
            return record[key]
    return ""


def build_amazon_url(title, author):
    encoded = urllib.parse.urlencode({"k": f"{title} {author}"})
    return f"https://www.amazon.com/s?{encoded}"


def sheet_row_to_book(row, headers, index):
    record = {}
    for header_index, header in enumerate(headers):
        if not header:
            continue
        record[header] = (row[header_index] if header_index < len(row) else "").strip()

    title = first_value(record, ["title"])
    if not title:
        return None

    author = first_value(record, ["the-ck-library-author", "author"]) or "Unknown author"
    year = first_value(record, ["year"]) or "Unknown"
    description = first_value(record, ["description"]) or "No tl;dr yet."
    memories = first_value(record, ["memories"])
    favorite_quote = first_value(record, ["favorite-quote"])
    pages = parse_int(first_value(record, ["pages"]))
    completed = first_value(record, ["completed"])
    cover_url = first_value(record, ["cover-url", "cover", "image-url", "image"])
    cover_options = build_cover_options(title, author, cover_url=cover_url, include_remote=False)
    if not cover_url and cover_options:
        cover_url = cover_options[0]

    return {
        "title": title,
        "author": author,
        "year": year,
        "genre": first_value(record, ["genre"]) or "Unfiled",
        "rating": first_value(record, ["rating"]) or "-",
        "description": description,
        "descriptionHtml": f"<p>{html.escape(description)}</p>",
        "memories": memories,
        "memoriesHtml": f"<p>{html.escape(memories)}</p>" if memories else "",
        "favoriteQuote": favorite_quote,
        "favoriteQuoteHtml": f"<p>{html.escape(favorite_quote)}</p>" if favorite_quote else "",
        "pages": pages,
        "completed": completed,
        "amazonUrl": first_value(record, ["amazon-url", "amazon", "url", "link"]) or build_amazon_url(title, author),
        "coverUrl": cover_url,
        "coverOptions": cover_options,
        "sortDate": build_sort_date(year, completed, index),
        "rowIndex": index,
        "source": "sheet",
        "sourceKey": normalize_source_key(title, author, year)
    }


def sanitize_book_payload(payload):
    title = str(payload.get("title", "")).strip()
    author = str(payload.get("author", "")).strip()
    if not title or not author:
        raise ValueError("Title and author are required.")

    year = str(payload.get("year", "")).strip() or "Unknown"
    description_html = payload.get("descriptionHtml", "") or ""
    memories_html = payload.get("memoriesHtml", "") or ""
    favorite_quote_html = payload.get("favoriteQuoteHtml", "") or ""

    description = str(payload.get("description", "")).strip() or strip_html(description_html) or "No tl;dr yet."
    memories = str(payload.get("memories", "")).strip() or strip_html(memories_html)
    favorite_quote = str(payload.get("favoriteQuote", "")).strip() or strip_html(favorite_quote_html)
    completed = str(payload.get("completed", "")).strip()
    pages = parse_int(payload.get("pages"))
    row_index = parse_int(payload.get("rowIndex"), 0) or 0

    source = str(payload.get("source", "manual")).strip() or "manual"
    source_key = str(payload.get("sourceKey", "")).strip() or (normalize_source_key(title, author, year) if source == "sheet" else None)

    return {
        "slug": slugify(f"{title}-{author}"),
        "title": title,
        "author": author,
        "year": year,
        "genre": str(payload.get("genre", "")).strip() or "Unfiled",
        "rating": str(payload.get("rating", "")).strip() or "-",
        "description": description,
        "description_html": description_html or f"<p>{html.escape(description)}</p>",
        "memories": memories,
        "memories_html": memories_html,
        "favorite_quote": favorite_quote,
        "favorite_quote_html": favorite_quote_html,
        "pages": pages,
        "completed": completed,
        "amazon_url": str(payload.get("amazonUrl", "")).strip() or build_amazon_url(title, author),
        "cover_url": str(payload.get("coverUrl", "")).strip(),
        "sort_date": parse_int(payload.get("sortDate"), build_sort_date(year, completed, row_index)),
        "row_index": row_index,
        "source": source,
        "source_key": source_key
    }


def book_row_to_dict(row):
    cover_options = build_cover_options(row["title"], row["author"], cover_url=row["cover_url"] or "", include_remote=False)
    return {
        "id": row["id"],
        "slug": row["slug"],
        "title": row["title"],
        "author": row["author"],
        "year": row["year"],
        "genre": row["genre"],
        "rating": row["rating"],
        "description": row["description"],
        "descriptionHtml": row["description_html"] or "",
        "memories": row["memories"] or "",
        "memoriesHtml": row["memories_html"] or "",
        "favoriteQuote": row["favorite_quote"] or "",
        "favoriteQuoteHtml": row["favorite_quote_html"] or "",
        "pages": row["pages"],
        "completed": row["completed"] or "",
        "amazonUrl": row["amazon_url"] or "",
        "coverUrl": row["cover_url"] or "",
        "coverOptions": cover_options,
        "sortDate": row["sort_date"] or 0,
        "rowIndex": row["row_index"] or 0,
        "source": row["source"] or "manual",
        "sourceKey": row["source_key"] or ""
    }


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_connection() as connection:
        connection.executescript(
            """
            create table if not exists users (
              id integer primary key autoincrement,
              username text not null unique,
              password_hash text not null,
              created_at integer not null
            );

            create table if not exists sessions (
              token text primary key,
              user_id integer not null references users(id) on delete cascade,
              expires_at integer not null,
              created_at integer not null
            );

            create table if not exists books (
              id integer primary key autoincrement,
              slug text not null,
              title text not null,
              author text not null,
              year text not null,
              genre text,
              rating text,
              description text,
              description_html text,
              memories text,
              memories_html text,
              favorite_quote text,
              favorite_quote_html text,
              pages integer,
              completed text,
              amazon_url text,
              cover_url text,
              sort_date integer,
              row_index integer default 0,
              source text,
              source_key text unique,
              created_at integer not null,
              updated_at integer not null
            );
            """
        )

        username = os.environ.get("PKYLE_ADMIN_USERNAME", "admin")
        password = os.environ.get("PKYLE_ADMIN_PASSWORD", "changeme")
        existing_user = connection.execute("select id from users where username = ?", (username,)).fetchone()
        if not existing_user:
            connection.execute(
                "insert into users (username, password_hash, created_at) values (?, ?, ?)",
                (username, hash_password(password), now_ts()),
            )

        books_count = connection.execute("select count(*) from books").fetchone()[0]
        if books_count == 0 and BOOKS_JSON_PATH.exists():
            books = json.loads(BOOKS_JSON_PATH.read_text(encoding="utf-8"))
            for entry in books:
                title = entry.get("title", "")
                author = entry.get("author", "")
                year = entry.get("year", "Unknown")
                source_key = normalize_source_key(title, author, year)
                timestamp = now_ts()
                connection.execute(
                    """
                    insert into books (
                      slug, title, author, year, genre, rating, description, description_html,
                      memories, memories_html, favorite_quote, favorite_quote_html, pages, completed,
                      amazon_url, cover_url, sort_date, row_index, source, source_key, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        slugify(f"{title}-{author}"),
                        title,
                        author,
                        year,
                        entry.get("genre", "Unfiled"),
                        entry.get("rating", "-"),
                        entry.get("description", "No tl;dr yet."),
                        f"<p>{html.escape(entry.get('description', 'No tl;dr yet.'))}</p>",
                        entry.get("memories", ""),
                        f"<p>{html.escape(entry.get('memories', ''))}</p>" if entry.get("memories") else "",
                        entry.get("favoriteQuote", ""),
                        f"<p>{html.escape(entry.get('favoriteQuote', ''))}</p>" if entry.get("favoriteQuote") else "",
                        parse_int(entry.get("pages")),
                        entry.get("completed", ""),
                        entry.get("amazonUrl", ""),
                        entry.get("coverUrl", ""),
                        parse_int(entry.get("sortDate"), 0),
                        parse_int(entry.get("rowIndex"), 0) or 0,
                        entry.get("source", "seed"),
                        source_key,
                        timestamp,
                        timestamp,
                    ),
                )


class PronouncedKyleHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/admin":
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", "/admin/")
            self.end_headers()
            return

        if path.startswith("/api/"):
            self.handle_api("GET", path)
            return

        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("POST", path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("PUT", path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("DELETE", path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_api(self, method, path):
        try:
            if path == "/api/books" and method == "GET":
                return self.handle_public_books()
            if path == "/api/me" and method == "GET":
                return self.handle_me()
            if path == "/api/login" and method == "POST":
                return self.handle_login()
            if path == "/api/logout" and method == "POST":
                return self.handle_logout()
            if path == "/api/admin/books" and method == "GET":
                return self.handle_admin_books()
            if path == "/api/admin/books" and method == "POST":
                return self.handle_create_book()
            if path == "/api/admin/sheet-preview" and method == "GET":
                return self.handle_sheet_preview()
            if path == "/api/admin/timeline" and method == "GET":
                return self.handle_admin_timeline()
            if path == "/api/admin/timeline" and method == "POST":
                return self.handle_create_timeline_entry()
            if path == "/api/admin/cover-options" and method == "POST":
                return self.handle_cover_options()

            if path.startswith("/api/admin/books/"):
                book_id = path.rsplit("/", 1)[-1]
                if method == "PUT":
                    return self.handle_update_book(book_id)
                if method == "DELETE":
                    return self.handle_delete_book(book_id)

            if path.startswith("/api/admin/timeline/"):
                entry_id = path.rsplit("/", 1)[-1]
                if method == "PUT":
                    return self.handle_update_timeline_entry(entry_id)
                if method == "DELETE":
                    return self.handle_delete_timeline_entry(entry_id)

            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        except Exception as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def send_json(self, status, payload, extra_headers=None, cookies_to_set=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        if cookies_to_set:
            for morsel in cookies_to_set.values():
                self.send_header("Set-Cookie", morsel.OutputString())
        self.end_headers()
        self.wfile.write(body)

    def read_session_token(self):
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def get_current_user(self):
        token = self.read_session_token()
        if not token:
            return None
        with get_connection() as connection:
            connection.execute("delete from sessions where expires_at <= ?", (now_ts(),))
            session = connection.execute(
                """
                select users.id, users.username
                from sessions
                join users on users.id = sessions.user_id
                where sessions.token = ? and sessions.expires_at > ?
                """,
                (token, now_ts()),
            ).fetchone()
            return dict(session) if session else None

    def require_auth(self):
        user = self.get_current_user()
        if not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return None
        return user

    def handle_public_books(self):
        with get_connection() as connection:
            rows = connection.execute(
                """
                select id, slug, title, author, year, genre, rating, description,
                       pages, completed, amazon_url, cover_url, sort_date, row_index
                from books
                order by sort_date desc, row_index desc, id desc
                """
            ).fetchall()
        books = [
            {
                "id": row["id"],
                "slug": row["slug"],
                "title": row["title"],
                "author": row["author"],
                "year": row["year"],
                "genre": row["genre"],
                "rating": row["rating"],
                "description": row["description"],
                "pages": row["pages"],
                "completed": row["completed"] or "",
                "amazonUrl": row["amazon_url"] or "",
                "coverUrl": row["cover_url"] or "",
                "sortDate": row["sort_date"] or 0,
                "rowIndex": row["row_index"] or 0,
            }
            for row in rows
        ]
        self.send_json(HTTPStatus.OK, books)

    def handle_me(self):
        user = self.get_current_user()
        if not user:
            self.send_json(HTTPStatus.OK, {"authenticated": False})
            return
        self.send_json(HTTPStatus.OK, {"authenticated": True, "username": user["username"]})

    def handle_login(self):
        payload = self.read_json()
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        with get_connection() as connection:
            user = connection.execute("select * from users where username = ?", (username,)).fetchone()
            if not user or not verify_password(password, user["password_hash"]):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Invalid credentials"})
                return

            token = secrets.token_urlsafe(32)
            expires_at = now_ts() + SESSION_TTL_SECONDS
            connection.execute(
                "insert into sessions (token, user_id, expires_at, created_at) values (?, ?, ?, ?)",
                (token, user["id"], expires_at, now_ts()),
            )

        cookie = SimpleCookie()
        cookie[SESSION_COOKIE] = token
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        cookie[SESSION_COOKIE]["max-age"] = str(SESSION_TTL_SECONDS)
        self.send_json(HTTPStatus.OK, {"ok": True, "username": username}, cookies_to_set=cookie)

    def handle_logout(self):
        token = self.read_session_token()
        if token:
            with get_connection() as connection:
                connection.execute("delete from sessions where token = ?", (token,))
        cookie = SimpleCookie()
        cookie[SESSION_COOKIE] = ""
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        cookie[SESSION_COOKIE]["max-age"] = "0"
        self.send_json(HTTPStatus.OK, {"ok": True}, cookies_to_set=cookie)

    def handle_admin_books(self):
        if not self.require_auth():
            return
        with get_connection() as connection:
            rows = connection.execute("select * from books order by sort_date desc, row_index desc, id desc").fetchall()
        self.send_json(HTTPStatus.OK, [book_row_to_dict(row) for row in rows])

    def handle_create_book(self):
        if not self.require_auth():
            return
        payload = sanitize_book_payload(self.read_json())
        timestamp = now_ts()
        with get_connection() as connection:
            try:
                cursor = connection.execute(
                    """
                    insert into books (
                      slug, title, author, year, genre, rating, description, description_html,
                      memories, memories_html, favorite_quote, favorite_quote_html, pages, completed,
                      amazon_url, cover_url, sort_date, row_index, source, source_key, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["slug"],
                        payload["title"],
                        payload["author"],
                        payload["year"],
                        payload["genre"],
                        payload["rating"],
                        payload["description"],
                        payload["description_html"],
                        payload["memories"],
                        payload["memories_html"],
                        payload["favorite_quote"],
                        payload["favorite_quote_html"],
                        payload["pages"],
                        payload["completed"],
                        payload["amazon_url"],
                        payload["cover_url"],
                        payload["sort_date"],
                        payload["row_index"],
                        payload["source"],
                        payload["source_key"],
                        timestamp,
                        timestamp,
                    ),
                )
            except sqlite3.IntegrityError:
                self.send_json(HTTPStatus.CONFLICT, {"error": "This book appears to have already been imported."})
                return

            row = connection.execute("select * from books where id = ?", (cursor.lastrowid,)).fetchone()
        self.send_json(HTTPStatus.CREATED, book_row_to_dict(row))

    def handle_update_book(self, book_id):
        if not self.require_auth():
            return
        payload = sanitize_book_payload(self.read_json())
        timestamp = now_ts()
        with get_connection() as connection:
            try:
                connection.execute(
                    """
                    update books
                    set slug = ?, title = ?, author = ?, year = ?, genre = ?, rating = ?, description = ?, description_html = ?,
                        memories = ?, memories_html = ?, favorite_quote = ?, favorite_quote_html = ?, pages = ?, completed = ?,
                        amazon_url = ?, cover_url = ?, sort_date = ?, row_index = ?, source = ?, source_key = ?, updated_at = ?
                    where id = ?
                    """,
                    (
                        payload["slug"],
                        payload["title"],
                        payload["author"],
                        payload["year"],
                        payload["genre"],
                        payload["rating"],
                        payload["description"],
                        payload["description_html"],
                        payload["memories"],
                        payload["memories_html"],
                        payload["favorite_quote"],
                        payload["favorite_quote_html"],
                        payload["pages"],
                        payload["completed"],
                        payload["amazon_url"],
                        payload["cover_url"],
                        payload["sort_date"],
                        payload["row_index"],
                        payload["source"],
                        payload["source_key"],
                        timestamp,
                        int(book_id),
                    ),
                )
            except sqlite3.IntegrityError:
                self.send_json(HTTPStatus.CONFLICT, {"error": "This import key is already in use."})
                return
            row = connection.execute("select * from books where id = ?", (int(book_id),)).fetchone()
        if not row:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Book not found"})
            return
        self.send_json(HTTPStatus.OK, book_row_to_dict(row))

    def handle_delete_book(self, book_id):
        if not self.require_auth():
            return
        with get_connection() as connection:
            connection.execute("delete from books where id = ?", (int(book_id),))
        self.send_json(HTTPStatus.OK, {"ok": True})

    def handle_sheet_preview(self):
        if not self.require_auth():
            return
        rows = fetch_sheet_rows()
        if not rows:
            self.send_json(HTTPStatus.OK, [])
            return

        headers = [slugify(value) for value in rows[0]]
        with get_connection() as connection:
            existing_keys = {
                row["source_key"]
                for row in connection.execute("select source_key from books where source_key is not null").fetchall()
            }

        candidates = []
        for index, row in enumerate(rows[1:]):
            book = sheet_row_to_book(row, headers, index)
            if not book:
                continue
            if book["sourceKey"] in existing_keys:
                continue
            candidates.append(book)

        self.send_json(HTTPStatus.OK, candidates)

    def handle_admin_timeline(self):
        if not self.require_auth():
            return
        site_data = load_site_data()
        self.send_json(HTTPStatus.OK, flatten_timeline_entries(site_data))

    def handle_create_timeline_entry(self):
        if not self.require_auth():
            return

        site_data = load_site_data()
        entries = flatten_timeline_entries(site_data)
        payload = sanitize_timeline_payload(self.read_json())
        payload["id"] = payload["id"] or timeline_entry_id(payload["year"], payload, len(entries))
        entries.append(payload)
        site_data["timeline"] = build_grouped_timeline(sort_timeline_entries(entries))
        write_site_data_file(site_data)
        self.send_json(HTTPStatus.CREATED, payload)

    def handle_update_timeline_entry(self, entry_id):
        if not self.require_auth():
            return

        site_data = load_site_data()
        entries = flatten_timeline_entries(site_data)
        payload = sanitize_timeline_payload(self.read_json())
        payload["id"] = entry_id

        updated = False
        for index, entry in enumerate(entries):
            if entry.get("id") == entry_id:
                entries[index] = payload
                updated = True
                break

        if not updated:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Timeline entry not found"})
            return

        site_data["timeline"] = build_grouped_timeline(sort_timeline_entries(entries))
        write_site_data_file(site_data)
        self.send_json(HTTPStatus.OK, payload)

    def handle_delete_timeline_entry(self, entry_id):
        if not self.require_auth():
            return

        site_data = load_site_data()
        entries = flatten_timeline_entries(site_data)
        filtered = [entry for entry in entries if entry.get("id") != entry_id]
        if len(filtered) == len(entries):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Timeline entry not found"})
            return

        site_data["timeline"] = build_grouped_timeline(sort_timeline_entries(filtered))
        write_site_data_file(site_data)
        self.send_json(HTTPStatus.OK, {"ok": True})

    def handle_cover_options(self):
        if not self.require_auth():
            return

        payload = self.read_json()
        title = str(payload.get("title", "")).strip()
        author = str(payload.get("author", "")).strip()
        cover_url = str(payload.get("coverUrl", "")).strip()

        if not title:
            self.send_json(HTTPStatus.OK, {"coverOptions": unique_strings([cover_url]), "coverUrl": cover_url})
            return

        options = build_cover_options(title, author, cover_url=cover_url, include_remote=True)
        selected_cover = cover_url if cover_url and cover_url in options else (options[0] if options else cover_url)
        self.send_json(
            HTTPStatus.OK,
            {
                "coverOptions": options,
                "coverUrl": selected_cover,
            },
        )


def main():
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), PronouncedKyleHandler)
    print(f"Pronounced Kyle server running at http://127.0.0.1:{port}")
    print("Default admin login: admin / changeme")
    server.serve_forever()


if __name__ == "__main__":
    main()
