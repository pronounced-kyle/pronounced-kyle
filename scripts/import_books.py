#!/usr/bin/env python3

import csv
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SITE_DATA_PATH = ROOT / "data" / "site-data.js"
BOOKS_PATH = ROOT / "data" / "books.json"
BOOKS_DATA_JS_PATH = ROOT / "data" / "books-data.js"
COVER_CACHE_PATH = ROOT / "data" / "cover-cache.js"


def main() -> None:
    sheet = read_sheet_config()
    rows = fetch_csv_rows(sheet["id"], sheet["gid"])
    headers = [slugify(value) for value in rows[0]]
    cover_cache = read_cover_cache()

    books = []
    for index, row in enumerate(rows[1:]):
        record = {}
        for header_index, header in enumerate(headers):
            if not header:
                continue
            record[header] = (row[header_index] if header_index < len(row) else "").strip()

        title = first_value(record, ["title"])
        if not title:
            continue

        author = first_value(record, ["the-ck-library-author", "author"]) or "Unknown author"
        year = first_value(record, ["year"]) or "Unknown"
        completed = first_value(record, ["completed"])
        book = {
            "id": f"{slugify(title)}-{slugify(author)}-{index}",
            "title": title,
            "author": author,
            "year": year,
            "genre": first_value(record, ["genre"]) or "Unfiled",
            "rating": first_value(record, ["rating"]) or "-",
            "description": first_value(record, ["description"]) or "No tl;dr yet.",
            "memories": first_value(record, ["memories"]),
            "pages": first_value(record, ["pages"]) or "-",
            "completed": completed,
            "amazonUrl": first_value(record, ["amazon-url", "amazon", "url", "link"]) or build_amazon_url(title, author),
            "coverUrl": first_value(record, ["cover-url", "cover", "image-url", "image"]) or cover_cache.get(cover_key(title, author), ""),
            "sortDate": build_sort_date(year, completed, index),
            "rowIndex": index
        }
        books.append(book)

    books_json = json.dumps(books, indent=2, ensure_ascii=False)
    BOOKS_PATH.write_text(books_json + "\n", encoding="utf-8")
    BOOKS_DATA_JS_PATH.write_text("window.booksData = " + books_json + ";\n", encoding="utf-8")
    print(f"Wrote {len(books)} books to {BOOKS_PATH}")
    print(f"Wrote {len(books)} books to {BOOKS_DATA_JS_PATH}")


def read_sheet_config() -> dict:
    contents = SITE_DATA_PATH.read_text(encoding="utf-8")
    match = re.search(r'id:\s*"([^"]+)".*?gid:\s*"([^"]+)"', contents, re.S)
    if not match:
        raise RuntimeError("Could not read Google Sheet config from data/site-data.js")
    return {"id": match.group(1), "gid": match.group(2)}


def fetch_csv_rows(sheet_id: str, gid: str) -> list:
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&gid={gid}"
    with urllib.request.urlopen(url) as response:
        text = response.read().decode("utf-8")
    return list(csv.reader(text.splitlines()))


def read_cover_cache() -> dict:
    contents = COVER_CACHE_PATH.read_text(encoding="utf-8")
    prefix = "window.bookCoverCache = "
    if not contents.startswith(prefix):
        return {}
    return json.loads(contents[len(prefix):].rstrip(";\n"))


def first_value(record: dict, keys: list) -> str:
    for key in keys:
        value = record.get(key, "")
        if value:
            return value
    return ""


def build_amazon_url(title: str, author: str) -> str:
    return "https://www.amazon.com/s?" + urllib.parse.urlencode({"k": f"{title} {author}"})


def build_sort_date(year: str, completed: str, fallback_index: int) -> int:
    numeric = numeric_year(year)
    base_year = numeric if numeric is not None else 1970

    if completed:
        parts = re.match(r"^(\d{1,2})-([A-Za-z]{3})$", completed)
        if parts:
            month_index = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].index(parts.group(2).lower())
            day = int(parts.group(1))
            return int(f"{base_year:04d}{month_index + 1:02d}{day:02d}")

    safe_day = min(fallback_index + 1, 28)
    return int(f"{base_year:04d}01{safe_day:02d}")


def numeric_year(value: str):
    match = re.search(r"\d{4}", str(value))
    return int(match.group(0)) if match else None


def slugify(value: str) -> str:
    return re.sub(r"(^-+|-+$)", "", re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower()))


def cover_key(title: str, author: str) -> str:
    return f"{title.strip().lower()}::{author.strip().lower()}"


if __name__ == "__main__":
    main()
