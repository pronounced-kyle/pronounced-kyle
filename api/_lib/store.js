import crypto from "node:crypto";

import { createHttpError } from "./http.js";
import { readSeedBooks, readSeedCoverCache, readSeedSiteData, writeLocalBooks, writeLocalSiteData } from "./seed.js";
import {
  buildGroupedTimeline,
  buildSortDate,
  ensureTimelineIds,
  flattenTimelineEntries,
  normalizeCoverKey,
  normalizeSourceKey,
  parseInteger,
  slugify,
  sortTimelineEntries,
  stripHtml,
  timelineEntryId,
  toParagraphHtml,
  uniqueStrings
} from "./utils.js";

const STATE_BLOB_PATH = process.env.PKYLE_STATE_BLOB_PATH || "pronounced-kyle/site-state.json";

let coverCachePromise;

function sortedBooks(books) {
  return [...books].sort((left, right) => {
    const sortDelta = (Number(right.sortDate) || 0) - (Number(left.sortDate) || 0);
    if (sortDelta !== 0) {
      return sortDelta;
    }

    const rowDelta = (Number(right.rowIndex) || 0) - (Number(left.rowIndex) || 0);
    if (rowDelta !== 0) {
      return rowDelta;
    }

    return String(left.title || "").localeCompare(String(right.title || ""));
  });
}

function normalizeSheet(sheet) {
  return {
    id: String(sheet?.id || "").trim(),
    gid: String(sheet?.gid || "").trim()
  };
}

function normalizeTimeline(siteData) {
  const normalized = {
    sheet: normalizeSheet(siteData?.sheet || {}),
    timeline: Array.isArray(siteData?.timeline) ? structuredClone(siteData.timeline) : []
  };
  ensureTimelineIds(normalized);
  return normalized;
}

function blankBook(source = "manual") {
  return {
    id: "",
    slug: "",
    title: "",
    author: "",
    year: "Unknown",
    genre: "Unfiled",
    rating: "-",
    description: "No tl;dr yet.",
    descriptionHtml: "<p>No tl;dr yet.</p>",
    memories: "",
    memoriesHtml: "",
    favoriteQuote: "",
    favoriteQuoteHtml: "",
    pages: "",
    completed: "",
    amazonUrl: "",
    coverUrl: "",
    coverOptions: [],
    sortDate: 0,
    rowIndex: 0,
    source,
    sourceKey: source === "sheet" ? "" : ""
  };
}

function normalizeBookRecord(record, index = 0) {
  const base = { ...blankBook(record?.source || "manual"), ...(record || {}) };
  const title = String(base.title || "").trim();
  const author = String(base.author || "").trim();
  const year = String(base.year || "").trim() || "Unknown";
  const descriptionHtml = String(base.descriptionHtml || "").trim();
  const memoriesHtml = String(base.memoriesHtml || "").trim();
  const favoriteQuoteHtml = String(base.favoriteQuoteHtml || "").trim();
  const description = String(base.description || "").trim() || stripHtml(descriptionHtml) || "No tl;dr yet.";
  const memories = String(base.memories || "").trim() || stripHtml(memoriesHtml);
  const favoriteQuote = String(base.favoriteQuote || "").trim() || stripHtml(favoriteQuoteHtml);
  const rowIndex = parseInteger(base.rowIndex, index) ?? index;
  const completed = String(base.completed || "").trim();
  const source = String(base.source || "manual").trim() || "manual";
  const coverUrl = String(base.coverUrl || "").trim();
  const coverOptions = uniqueStrings([...(Array.isArray(base.coverOptions) ? base.coverOptions : []), coverUrl]);
  const sortDate = parseInteger(base.sortDate, buildSortDate(year, completed, rowIndex));
  const sourceKey = String(base.sourceKey || "").trim() || normalizeSourceKey(title, author, year);

  return {
    id: String(base.id || "").trim() || `bk-${crypto.randomUUID().slice(0, 12)}`,
    slug: String(base.slug || "").trim() || slugify(`${title}-${author}`),
    title,
    author,
    year,
    genre: String(base.genre || "").trim() || "Unfiled",
    rating: String(base.rating || "").trim() || "-",
    description,
    descriptionHtml: descriptionHtml || toParagraphHtml(description),
    memories,
    memoriesHtml: memoriesHtml || (memories ? toParagraphHtml(memories) : ""),
    favoriteQuote,
    favoriteQuoteHtml: favoriteQuoteHtml || (favoriteQuote ? toParagraphHtml(favoriteQuote) : ""),
    pages: parseInteger(base.pages, "") ?? "",
    completed,
    amazonUrl: String(base.amazonUrl || "").trim(),
    coverUrl,
    coverOptions,
    sortDate,
    rowIndex,
    source,
    sourceKey
  };
}

function normalizeState(input) {
  const state = input || {};
  const booksInput = Array.isArray(state.books) ? state.books : [];
  const siteDataInput = state.siteData || {
    sheet: state.sheet || {},
    timeline: state.timeline || []
  };

  return {
    version: 1,
    updatedAt: state.updatedAt || new Date().toISOString(),
    books: sortedBooks(booksInput.map((book, index) => normalizeBookRecord(book, index))),
    siteData: normalizeTimeline(siteDataInput)
  };
}

function isBlobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function getBlobSdk() {
  return await import("@vercel/blob");
}

async function readBlobState() {
  if (!isBlobConfigured()) {
    return null;
  }

  try {
    const { list, getDownloadUrl } = await getBlobSdk();
    const { blobs } = await list({ prefix: STATE_BLOB_PATH, limit: 1 });
    if (!blobs.length) {
      return null;
    }

    const downloadUrl = await getDownloadUrl(blobs[0].url);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    if (!String(text || "").trim()) {
      return null;
    }

    return normalizeState(JSON.parse(text));
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/not found/i.test(message)) {
      return null;
    }
    throw error;
  }
}

async function writeBlobState(state) {
  const { put } = await getBlobSdk();
  const normalized = normalizeState({
    ...state,
    updatedAt: new Date().toISOString()
  });
  await put(STATE_BLOB_PATH, JSON.stringify(normalized, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
  return normalized;
}

async function readLocalState() {
  return normalizeState({
    books: await readSeedBooks(),
    siteData: await readSeedSiteData()
  });
}

async function writeLocalState(state) {
  const normalized = normalizeState({
    ...state,
    updatedAt: new Date().toISOString()
  });
  await writeLocalBooks(normalized.books);
  await writeLocalSiteData(normalized.siteData);
  return normalized;
}

async function readCoverCache() {
  if (!coverCachePromise) {
    coverCachePromise = readSeedCoverCache();
  }
  return await coverCachePromise;
}

function buildCoverUrlsFromDoc(doc) {
  const candidates = [];

  if (doc.cover_i) {
    candidates.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg?default=false`);
  }

  (doc.isbn || []).slice(0, 2).forEach((isbn) => {
    candidates.push(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`);
  });

  (doc.edition_key || []).slice(0, 1).forEach((edition) => {
    candidates.push(`https://covers.openlibrary.org/b/olid/${edition}-L.jpg?default=false`);
  });

  return candidates;
}

async function fetchOpenLibraryCoverOptions(title, author) {
  const cleanTitle = String(title || "").trim();
  const cleanAuthor = String(author || "").trim();
  if (!cleanTitle) {
    return [];
  }

  const query = new URLSearchParams({
    title: cleanTitle,
    author: cleanAuthor,
    limit: "8"
  });

  const response = await fetch(`https://openlibrary.org/search.json?${query}`, {
    headers: {
      "User-Agent": "PronouncedKyleAdmin/1.0"
    }
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  return uniqueStrings(
    (payload.docs || [])
      .slice(0, 8)
      .flatMap((doc) => buildCoverUrlsFromDoc(doc))
  );
}

export async function buildCoverOptions(title, author, coverUrl = "", { includeRemote = false } = {}) {
  const cache = await readCoverCache();
  const cached = cache[normalizeCoverKey(title, author)] || "";
  let options = uniqueStrings([coverUrl, cached]);
  if (includeRemote) {
    options = uniqueStrings(options.concat(await fetchOpenLibraryCoverOptions(title, author)));
  }
  return options;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

async function fetchSheetRows(sheet) {
  const sheetId = String(sheet?.id || "").trim();
  const gid = String(sheet?.gid || "").trim();
  if (!sheetId || !gid) {
    throw createHttpError(500, "Google Sheet config is missing.");
  }

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "PronouncedKyleAdmin/1.0"
    }
  });

  if (!response.ok) {
    throw createHttpError(502, "Could not refresh the Google Sheet preview.");
  }

  return parseCsv(await response.text());
}

function firstValue(record, keys) {
  for (const key of keys) {
    if (record[key]) {
      return record[key];
    }
  }
  return "";
}

async function sheetRowToBook(row, headers, index) {
  const record = {};
  headers.forEach((header, headerIndex) => {
    if (!header) {
      return;
    }
    record[header] = String(row[headerIndex] || "").trim();
  });

  const title = firstValue(record, ["title"]);
  if (!title) {
    return null;
  }

  const author = firstValue(record, ["the-ck-library-author", "author"]) || "Unknown author";
  const year = firstValue(record, ["year"]) || "Unknown";
  const description = firstValue(record, ["description"]) || "No tl;dr yet.";
  const memories = firstValue(record, ["memories"]);
  const favoriteQuote = firstValue(record, ["favorite-quote"]);
  const completed = firstValue(record, ["completed"]);
  const coverUrl = firstValue(record, ["cover-url", "cover", "image-url", "image"]);
  const coverOptions = await buildCoverOptions(title, author, coverUrl, { includeRemote: false });

  return normalizeBookRecord(
    {
      title,
      author,
      year,
      genre: firstValue(record, ["genre"]) || "Unfiled",
      rating: firstValue(record, ["rating"]) || "-",
      description,
      descriptionHtml: toParagraphHtml(description),
      memories,
      memoriesHtml: memories ? toParagraphHtml(memories) : "",
      favoriteQuote,
      favoriteQuoteHtml: favoriteQuote ? toParagraphHtml(favoriteQuote) : "",
      pages: parseInteger(firstValue(record, ["pages"]), ""),
      completed,
      amazonUrl: firstValue(record, ["amazon-url", "amazon", "url", "link"]),
      coverUrl: coverUrl || coverOptions[0] || "",
      coverOptions,
      sortDate: buildSortDate(year, completed, index),
      rowIndex: index,
      source: "sheet",
      sourceKey: normalizeSourceKey(title, author, year)
    },
    index
  );
}

export async function readAppState() {
  const blobState = await readBlobState();
  return blobState || (await readLocalState());
}

export async function writeAppState(state) {
  if (isBlobConfigured()) {
    return await writeBlobState(state);
  }

  if (process.env.VERCEL) {
    throw createHttpError(500, "Blob storage is not configured. Add BLOB_READ_WRITE_TOKEN to enable live admin writes.");
  }

  return await writeLocalState(state);
}

export function getPublicBooks(state) {
  return sortedBooks(state.books).map((book) => ({
    id: book.id,
    slug: book.slug,
    title: book.title,
    author: book.author,
    year: book.year,
    genre: book.genre,
    rating: book.rating,
    description: book.description,
    pages: book.pages,
    completed: book.completed,
    coverUrl: book.coverUrl,
    sortDate: book.sortDate,
    rowIndex: book.rowIndex
  }));
}

export function getAdminBooks(state) {
  return sortedBooks(state.books).map((book, index) => normalizeBookRecord(book, index));
}

export function getPublicSiteData(state) {
  return {
    timeline: normalizeTimeline(state.siteData).timeline
  };
}

export function getTimelineEntries(state) {
  return flattenTimelineEntries(normalizeState(state).siteData);
}

export function sanitizeBookPayload(payload) {
  const title = String(payload?.title || "").trim();
  const author = String(payload?.author || "").trim();
  if (!title || !author) {
    throw createHttpError(400, "Title and author are required.");
  }

  const year = String(payload?.year || "").trim() || "Unknown";
  const descriptionHtml = String(payload?.descriptionHtml || "").trim();
  const memoriesHtml = String(payload?.memoriesHtml || "").trim();
  const favoriteQuoteHtml = String(payload?.favoriteQuoteHtml || "").trim();
  const description = String(payload?.description || "").trim() || stripHtml(descriptionHtml) || "No tl;dr yet.";
  const memories = String(payload?.memories || "").trim() || stripHtml(memoriesHtml);
  const favoriteQuote = String(payload?.favoriteQuote || "").trim() || stripHtml(favoriteQuoteHtml);
  const source = String(payload?.source || "manual").trim() || "manual";
  const completed = String(payload?.completed || "").trim();
  const rowIndex = parseInteger(payload?.rowIndex, 0) ?? 0;

  return normalizeBookRecord(
    {
      id: String(payload?.id || "").trim(),
      slug: slugify(`${title}-${author}`),
      title,
      author,
      year,
      genre: String(payload?.genre || "").trim() || "Unfiled",
      rating: String(payload?.rating || "").trim() || "-",
      description,
      descriptionHtml: descriptionHtml || toParagraphHtml(description),
      memories,
      memoriesHtml: memoriesHtml || (memories ? toParagraphHtml(memories) : ""),
      favoriteQuote,
      favoriteQuoteHtml: favoriteQuoteHtml || (favoriteQuote ? toParagraphHtml(favoriteQuote) : ""),
      pages: parseInteger(payload?.pages, ""),
      completed,
      amazonUrl: String(payload?.amazonUrl || "").trim(),
      coverUrl: String(payload?.coverUrl || "").trim(),
      coverOptions: Array.isArray(payload?.coverOptions) ? payload.coverOptions : [],
      sortDate: parseInteger(payload?.sortDate, buildSortDate(year, completed, rowIndex)),
      rowIndex,
      source,
      sourceKey: String(payload?.sourceKey || "").trim() || (source === "sheet" ? normalizeSourceKey(title, author, year) : "")
    },
    rowIndex
  );
}

function duplicateSourceKeyExists(books, sourceKey, ignoreId = "") {
  const key = String(sourceKey || "").trim();
  if (!key) {
    return false;
  }
  return books.some((book) => book.sourceKey && book.sourceKey === key && book.id !== ignoreId);
}

export async function createBook(payload) {
  const state = await readAppState();
  const book = sanitizeBookPayload(payload);
  if (duplicateSourceKeyExists(state.books, book.sourceKey)) {
    throw createHttpError(409, "This book appears to have already been imported.");
  }

  const created = normalizeBookRecord(
    {
      ...book,
      id: book.id || `bk-${crypto.randomUUID().slice(0, 12)}`
    },
    state.books.length
  );

  state.books.push(created);
  await writeAppState(state);
  return created;
}

export async function updateBook(id, payload) {
  const state = await readAppState();
  const index = state.books.findIndex((book) => book.id === id);
  if (index === -1) {
    throw createHttpError(404, "Book not found");
  }

  const book = sanitizeBookPayload(payload);
  if (duplicateSourceKeyExists(state.books, book.sourceKey, id)) {
    throw createHttpError(409, "This import key is already in use.");
  }

  const updated = normalizeBookRecord(
    {
      ...state.books[index],
      ...book,
      id
    },
    index
  );

  state.books[index] = updated;
  await writeAppState(state);
  return updated;
}

export async function deleteBook(id) {
  const state = await readAppState();
  const nextBooks = state.books.filter((book) => book.id !== id);
  if (nextBooks.length === state.books.length) {
    throw createHttpError(404, "Book not found");
  }
  state.books = nextBooks;
  await writeAppState(state);
  return { ok: true };
}

export async function getSheetPreviewBooks() {
  const state = await readAppState();
  const rows = await fetchSheetRows(state.siteData.sheet);
  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map((value) => slugify(value));
  const existingKeys = new Set(state.books.map((book) => book.sourceKey).filter(Boolean));
  const candidates = [];

  for (let index = 1; index < rows.length; index += 1) {
    const book = await sheetRowToBook(rows[index], headers, index - 1);
    if (!book || (book.sourceKey && existingKeys.has(book.sourceKey))) {
      continue;
    }
    candidates.push(book);
  }

  return candidates;
}

export function sanitizeTimelinePayload(payload) {
  const year = String(payload?.year || "").trim() || "Unknown";
  const tone = String(payload?.tone || "lore").trim().toLowerCase() || "lore";
  const text = String(payload?.text || "");
  const suffix = String(payload?.suffix || "");
  const chipLabel = String(payload?.chipLabel || "").trim();
  const chipHref = String(payload?.chipHref || "").trim();
  const chipColor = String(payload?.chipColor || "").trim();

  if (!text.trim() && !chipLabel && !suffix.trim()) {
    throw createHttpError(400, "Timeline entries need some text.");
  }

  return {
    id: String(payload?.id || "").trim(),
    year,
    date: String(payload?.date || "").trim(),
    tone: ["media", "lore", "present"].includes(tone) ? tone : "lore",
    text,
    suffix,
    chipLabel,
    chipHref,
    chipColor
  };
}

export async function createTimelineEntry(payload) {
  const state = await readAppState();
  const entries = flattenTimelineEntries(state.siteData);
  const record = sanitizeTimelinePayload(payload);
  record.id = record.id || timelineEntryId(record.year, record, entries.length);
  entries.push(record);
  state.siteData.timeline = buildGroupedTimeline(sortTimelineEntries(entries));
  await writeAppState(state);
  return record;
}

export async function updateTimelineEntry(id, payload) {
  const state = await readAppState();
  const entries = flattenTimelineEntries(state.siteData);
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw createHttpError(404, "Timeline entry not found");
  }

  const record = sanitizeTimelinePayload(payload);
  record.id = id;
  entries[index] = record;
  state.siteData.timeline = buildGroupedTimeline(sortTimelineEntries(entries));
  await writeAppState(state);
  return record;
}

export async function deleteTimelineEntry(id) {
  const state = await readAppState();
  const entries = flattenTimelineEntries(state.siteData);
  const nextEntries = entries.filter((entry) => entry.id !== id);
  if (nextEntries.length === entries.length) {
    throw createHttpError(404, "Timeline entry not found");
  }
  state.siteData.timeline = buildGroupedTimeline(sortTimelineEntries(nextEntries));
  await writeAppState(state);
  return { ok: true };
}
