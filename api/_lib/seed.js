import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const SITE_DATA_PATH = path.join(DATA_DIR, "site-data.js");
const BOOKS_JSON_PATH = path.join(DATA_DIR, "books.json");
const BOOKS_DATA_PATH = path.join(DATA_DIR, "books-data.js");
const COVER_CACHE_PATH = path.join(DATA_DIR, "cover-cache.js");

async function readWindowAssignment(filePath, propertyName) {
  const source = await fs.readFile(filePath, "utf8");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: filePath });
  return context.window[propertyName];
}

export async function readSeedSiteData() {
  return structuredClone((await readWindowAssignment(SITE_DATA_PATH, "siteData")) || {});
}

export async function readSeedBooks() {
  return JSON.parse(await fs.readFile(BOOKS_JSON_PATH, "utf8"));
}

export async function readSeedCoverCache() {
  return structuredClone((await readWindowAssignment(COVER_CACHE_PATH, "bookCoverCache")) || {});
}

export async function writeLocalSiteData(siteData) {
  await fs.writeFile(SITE_DATA_PATH, `window.siteData = ${JSON.stringify(siteData, null, 2)};\n`, "utf8");
}

export async function writeLocalBooks(books) {
  const payload = `${JSON.stringify(books, null, 2)}\n`;
  await fs.writeFile(BOOKS_JSON_PATH, payload, "utf8");
  await fs.writeFile(BOOKS_DATA_PATH, `window.booksData = ${JSON.stringify(books, null, 2)};\n`, "utf8");
}
