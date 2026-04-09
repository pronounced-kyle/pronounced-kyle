import crypto from "node:crypto";

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseInteger(value, fallback = null) {
  if (value === "" || value === null || value === undefined || value === "-") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function uniqueStrings(values) {
  const results = [];
  const seen = new Set();

  values.forEach((value) => {
    const candidate = String(value || "").trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    results.push(candidate);
  });

  return results;
}

export function numericYear(value) {
  const match = String(value || "").match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function parseMonthDay(value, year) {
  const match = String(value || "").match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!match) {
    return null;
  }

  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthIndex = months.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) {
    return null;
  }

  return Number(`${String(year || 1970).padStart(4, "0")}${String(monthIndex + 1).padStart(2, "0")}${String(match[1]).padStart(2, "0")}`);
}

export function buildSortDate(year, completed, fallbackIndex) {
  const baseYear = numericYear(year) || 1970;
  return parseMonthDay(completed, baseYear) || Number(`${String(baseYear).padStart(4, "0")}01${String(Math.min((fallbackIndex || 0) + 1, 28)).padStart(2, "0")}`);
}

export function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toParagraphHtml(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "<p></p>";
  }

  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function normalizeSourceKey(title, author, year) {
  return [slugify(title), slugify(author), slugify(year)].join("::");
}

export function normalizeCoverKey(title, author) {
  return `${String(title || "").trim().toLowerCase()}::${String(author || "").trim().toLowerCase()}`;
}

export function timelineEntryId(groupYear, item, index) {
  const digest = crypto
    .createHash("sha1")
    .update(
      [
        String(groupYear || "").trim(),
        String(item?.date || "").trim(),
        String(item?.text || "").trim(),
        String(item?.chip?.label || item?.chipLabel || "").trim(),
        String(item?.suffix || "").trim(),
        String(index)
      ].join("::")
    )
    .digest("hex");
  return `tl-${digest.slice(0, 12)}`;
}

export function ensureTimelineIds(siteData) {
  const target = siteData || {};
  const groups = Array.isArray(target.timeline) ? target.timeline : [];
  let changed = false;

  groups.forEach((group, groupIndex) => {
    const items = Array.isArray(group.items) ? group.items : [];
    items.forEach((item, itemIndex) => {
      if (!item.id) {
        item.id = timelineEntryId(group.year, item, `${groupIndex}-${itemIndex}`);
        changed = true;
      }
    });
  });

  return changed;
}

export function flattenTimelineEntries(siteData) {
  const groups = Array.isArray(siteData?.timeline) ? siteData.timeline : [];
  return groups.flatMap((group) => {
    const year = String(group.year || "").trim() || "Unknown";
    const items = Array.isArray(group.items) ? group.items : [];
    return items.map((item, index) => ({
      id: String(item.id || "").trim() || timelineEntryId(year, item, index),
      year,
      date: String(item.date || "").trim(),
      tone: String(item.tone || "lore").trim().toLowerCase() || "lore",
      text: String(item.text || ""),
      suffix: String(item.suffix || ""),
      chipLabel: String(item.chip?.label || "").trim(),
      chipHref: String(item.chip?.href || "").trim(),
      chipColor: String(item.chip?.color || "").trim()
    }));
  });
}

export function buildGroupedTimeline(entries) {
  const groups = [];
  const groupMap = new Map();

  entries.forEach((entry, index) => {
    const year = String(entry.year || "").trim() || "Unknown";
    if (!groupMap.has(year)) {
      const group = { year, items: [] };
      groupMap.set(year, group);
      groups.push(group);
    }

    const group = groupMap.get(year);
    const item = {
      id: String(entry.id || "").trim() || timelineEntryId(year, entry, index),
      tone: String(entry.tone || "lore").trim().toLowerCase() || "lore",
      date: String(entry.date || "").trim(),
      text: String(entry.text || "")
    };

    const chipLabel = String(entry.chipLabel || "").trim();
    const chipHref = String(entry.chipHref || "").trim();
    const chipColor = String(entry.chipColor || "").trim();
    if (chipLabel || chipHref || chipColor) {
      item.chip = {};
      if (chipLabel) {
        item.chip.label = chipLabel;
      }
      if (chipHref) {
        item.chip.href = chipHref;
      }
      if (chipColor) {
        item.chip.color = chipColor;
      }
    }

    const suffix = String(entry.suffix || "").trim();
    if (suffix) {
      item.suffix = suffix;
    }

    group.items.push(item);
  });

  return groups;
}

export function timelineYearRank(value) {
  return numericYear(value) || -1;
}

export function sortTimelineEntries(entries) {
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const yearDelta = timelineYearRank(right.entry.year) - timelineYearRank(left.entry.year);
      if (yearDelta !== 0) {
        return yearDelta;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}
