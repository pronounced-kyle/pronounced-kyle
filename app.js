(function () {
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
  const statusEl = document.getElementById("bookshelf-status");
  const yearsEl = document.getElementById("bookshelf-years");
  const timelineEl = document.getElementById("timeline");
  const timelinePanelEl = document.getElementById("timeline-panel");
  const timelineScrollEl = document.getElementById("timeline-scroll");
  const timelinePanelScrollEl = document.getElementById("timeline-panel-scroll");
  const bookshelfScrollEl = document.getElementById("bookshelf-scroll");
  const bookshelfScrollContentEl = document.getElementById("bookshelf-scroll-content");
  const tabRails = Array.from(document.querySelectorAll(".tab-rail"));
  const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  const stackedMedia = window.matchMedia("(max-width: 1040px)");

  const coverCache = new Map(Object.entries(window.bookCoverCache || {}));
  const openLibrarySearchCache = new Map();

  renderTimeline((window.siteData && window.siteData.timeline) || []);
  setupTabs();
  setupResponsiveTabs();
  setupSmoothScroll();
  setupMobileTopbar();
  loadSiteData();
  loadBookshelf();

  function setupTabs() {
    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (button.classList.contains("is-locked")) {
          return;
        }

        setActiveTab(button.dataset.tab);
      });
    });

    window.addEventListener("resize", syncIndicators);
    syncIndicators();
  }

  function setActiveTab(tabName) {
    tabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tabName);
    });

    panels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === tabName);
    });

    syncIndicators();
  }

  function syncIndicators() {
    tabRails.forEach((tabRail) => {
      const indicator = tabRail.querySelector(".tab-indicator");
      const active = tabRail.querySelector(".tab-button.is-active");

      if (!active || !indicator) {
        return;
      }

      const railRect = tabRail.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      tabRail.style.setProperty("--indicator-x", `${activeRect.left - railRect.left}px`);
      tabRail.style.setProperty("--indicator-width", `${activeRect.width}px`);
    });
  }

  function setupResponsiveTabs() {
    const syncResponsiveTabs = () => {
      if (!stackedMedia.matches && activeTabName() === "about") {
        setActiveTab("bookshelf");
      }

      syncIndicators();
    };

    if (typeof stackedMedia.addEventListener === "function") {
      stackedMedia.addEventListener("change", syncResponsiveTabs);
    } else {
      window.addEventListener("resize", syncResponsiveTabs);
    }

    syncResponsiveTabs();
  }

  function setupSmoothScroll() {
    if (!window.Lenis) {
      return;
    }

    const baseOptions = {
      autoRaf: true,
      duration: 1.02,
      easing: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
      wheelMultiplier: 0.95,
      allowNestedScroll: true
    };

    if (timelineScrollEl && timelineEl) {
      new window.Lenis({
        ...baseOptions,
        wrapper: timelineScrollEl,
        content: timelineEl
      });
    }

    if (!stackedMedia.matches && timelinePanelScrollEl && timelinePanelEl) {
      new window.Lenis({
        ...baseOptions,
        wrapper: timelinePanelScrollEl,
        content: timelinePanelEl
      });
    }

    if (!stackedMedia.matches && bookshelfScrollEl && bookshelfScrollContentEl) {
      new window.Lenis({
        ...baseOptions,
        wrapper: bookshelfScrollEl,
        content: bookshelfScrollContentEl
      });
    }
  }

  function setupMobileTopbar() {
    if (!stackedMedia.matches) return;

    // Show the fixed compact topbar once the full identity header scrolls away
    const identity = document.querySelector(".identity");
    if (identity && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        ([entry]) => document.body.classList.toggle("topbar-visible", !entry.isIntersecting),
        { threshold: 0 }
      );
      observer.observe(identity);
    }


    stackedMedia.addEventListener("change", () => {
      if (!stackedMedia.matches) {
        document.body.classList.remove("topbar-visible");
      }
    });
  }

  async function loadBookshelf() {
    try {
      const books = await fetchBooksFromStore();
      renderBookshelf(books);
      statusEl.textContent = "";
    } catch (error) {
      console.error(error);
      statusEl.textContent = "Could not load the local library store right now.";
      yearsEl.innerHTML = '<div class="empty-state">The local book library was unavailable in this session.</div>';
    }
  }

  async function loadSiteData() {
    try {
      const siteData = await fetchSiteData();
      renderTimeline(siteData.timeline || []);
    } catch (error) {
      console.warn("Live site data unavailable, using local fallback.", error);
    }
  }

  async function fetchBooksFromStore() {
    try {
      const response = await fetch("/api/books");
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.warn("Backend books API unavailable, using local fallback.", error);
    }

    if (Array.isArray(window.booksData) && window.booksData.length) {
      return window.booksData.map((book) => ({ ...book }));
    }

    throw new Error("booksData is missing");
  }

  async function fetchSiteData() {
    try {
      const response = await fetch("/api/site-data");
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.warn("Backend site-data API unavailable, using local fallback.", error);
    }

    if (window.siteData && Array.isArray(window.siteData.timeline)) {
      return { timeline: window.siteData.timeline };
    }

    throw new Error("siteData is missing");
  }

  async function hydrateMissingCovers(books) {
    const tasks = books.map(async (book) => {
      if (book.coverUrl) {
        return;
      }

      const cacheKey = coverKey(book.title, book.author);
      if (coverCache.has(cacheKey)) {
        book.coverUrl = coverCache.get(cacheKey);
        return;
      }

      const cover = await lookupOpenLibraryCover(book.title, book.author);
      if (cover) {
        coverCache.set(cacheKey, cover);
        book.coverUrl = cover;
      }
    });

    await Promise.all(tasks);
  }

  async function lookupOpenLibraryCover(title, author) {
    const cacheKey = coverKey(title, author);
    if (openLibrarySearchCache.has(cacheKey)) {
      return openLibrarySearchCache.get(cacheKey);
    }

    try {
      const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&limit=1`;
      const response = await fetch(url);
      if (!response.ok) {
        openLibrarySearchCache.set(cacheKey, "");
        return "";
      }

      const payload = await response.json();
      const doc = payload.docs && payload.docs[0];

      if (!doc) {
        openLibrarySearchCache.set(cacheKey, "");
        return "";
      }

      const edition = Array.isArray(doc.isbn) && doc.isbn.length ? doc.isbn[0] : "";
      const olid = Array.isArray(doc.edition_key) && doc.edition_key.length ? doc.edition_key[0] : "";

      let coverUrl = "";
      if (edition) {
        coverUrl = `https://covers.openlibrary.org/b/isbn/${edition}-L.jpg?default=false`;
      } else if (olid) {
        coverUrl = `https://covers.openlibrary.org/b/olid/${olid}-L.jpg?default=false`;
      }

      openLibrarySearchCache.set(cacheKey, coverUrl);
      return coverUrl;
    } catch (error) {
      console.warn("Cover lookup failed", title, error);
      openLibrarySearchCache.set(cacheKey, "");
      return "";
    }
  }

  function renderBookshelf(books) {
    if (!books.length) {
      yearsEl.innerHTML = '<div class="empty-state">No books were found in the local library store.</div>';
      return;
    }

    const grouped = groupByYear(books);
    yearsEl.innerHTML = grouped.map(renderYearSection).join("");
  }

  function renderYearSection([year, books]) {
    const sortedBooks = books
      .slice()
      .sort((left, right) => {
        const ratingDelta = parseRating(right.rating) - parseRating(left.rating);
        if (ratingDelta !== 0) {
          return ratingDelta;
        }
        return right.sortDate - left.sortDate || right.rowIndex - left.rowIndex;
      });

    return `
      <section class="year-section">
        <div class="year-divider">
          <h3 class="year-pill">${escapeHtml(year)} READS</h3>
        </div>
        <div class="books-grid">
          ${sortedBooks.map(renderBookCard).join("")}
        </div>
      </section>
    `;
  }

  function renderBookCard(book) {
    const face = book.coverUrl
      ? `<div class="book-face"><img src="${escapeAttribute(book.coverUrl)}" alt="${escapeAttribute(`Cover of ${book.title}`)}" loading="lazy" referrerpolicy="no-referrer" /></div>`
      : `
        <div class="book-face book-face--fallback">
          <strong>${escapeHtml(book.title)}</strong>
          <span>${escapeHtml(book.author)}</span>
        </div>
      `;

    return `
      <article class="book-card">
        ${face}
        <div class="book-review">
          <div class="review-title">${escapeHtml(book.title)}</div>
          <div class="review-author">${escapeHtml(book.author)}</div>
          <div class="review-summary">tl;dr: ${escapeHtml(book.description)}</div>
          <table class="review-meta">
            <tr><td class="review-meta-label">Rating</td><td class="review-meta-value">${escapeHtml(book.rating)}/100</td></tr>
            <tr><td class="review-meta-label">Genre</td><td class="review-meta-value">${escapeHtml(book.genre)}</td></tr>
            <tr><td class="review-meta-label">Pages</td><td class="review-meta-value">${escapeHtml(book.pages || "—")}</td></tr>
          </table>
        </div>
      </article>
    `;
  }

  function renderTimeline(entries) {
    if (!entries.length) {
      const emptyState = '<div class="empty-state">Add timeline entries in <code>data/site-data.js</code>.</div>';
      if (timelineEl) {
        timelineEl.innerHTML = emptyState;
      }
      if (timelinePanelEl) {
        timelinePanelEl.innerHTML = emptyState;
      }
      return;
    }

    const markup = entries
      .map((entry) => {
        const items = entry.items
          .map((item) => {
            const tone = item.tone || "present";
            const linkLabel = item.chip ? escapeHtml(String(item.chip.label || "").trim()) : "";
            const chip = item.chip
              ? item.chip.href
                ? `<a class="timeline-link timeline-link--${escapeAttribute(tone)}" href="${escapeAttribute(item.chip.href)}" target="_blank" rel="noreferrer">${linkLabel}</a>`
                : linkLabel
              : "";
            const yearLabel = entry.year
              ? `<span class="timeline-item__year">${escapeHtml(entry.year)}</span>`
              : "";

            return `
              <div class="timeline-item timeline-item--${escapeAttribute(tone)}">
                <div class="timeline-item__copy">
                  ${yearLabel}${escapeHtml(item.text || "")}${chip}${escapeHtml(item.suffix || "")}
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <section class="timeline-year">
            <div class="timeline-list">${items}</div>
          </section>
        `;
      })
      .join("");

    if (timelineEl) {
      timelineEl.innerHTML = markup;
    }

    if (timelinePanelEl) {
      timelinePanelEl.innerHTML = markup;
    }
  }

  function activeTabName() {
    const active = tabButtons.find((button) => button.classList.contains("is-active") && !button.classList.contains("is-locked"));
    return active ? active.dataset.tab : "bookshelf";
  }

  function groupByYear(books) {
    const map = new Map();

    books.forEach((book) => {
      if (!map.has(book.year)) {
        map.set(book.year, []);
      }

      map.get(book.year).push(book);
    });

    return Array.from(map.entries()).sort((left, right) => numericYear(right[0]) - numericYear(left[0]));
  }

  function getSortDate(year, completed, fallbackIndex) {
    const numeric = numericYear(year);
    const base = Number.isFinite(numeric) ? numeric : 0;

    if (!completed) {
      return new Date(base || 1970, 0, Math.min(fallbackIndex + 1, 28)).getTime();
    }

    const parsed = parseMonthDay(completed, base);
    if (parsed) {
      return parsed.getTime();
    }

    return new Date(base || 1970, 0, Math.min(fallbackIndex + 1, 28)).getTime();
  }

  function parseMonthDay(value, year) {
    const match = value.match(/^(\d{1,2})-([A-Za-z]{3})$/);
    if (!match) {
      return null;
    }

    const monthIndex = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].toLowerCase());
    if (monthIndex === -1) {
      return null;
    }

    return new Date(year, monthIndex, Number(match[1]));
  }

  function buildAmazonSearchUrl(title, author) {
    return `https://www.amazon.com/s?k=${encodeURIComponent(`${title} ${author}`)}`;
  }

  function parseRating(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -Infinity;
  }

  function coverKey(title, author) {
    return `${String(title).trim().toLowerCase()}::${String(author).trim().toLowerCase()}`;
  }

  function numericYear(value) {
    const match = String(value).match(/\d{4}/);
    return match ? Number(match[0]) : -Infinity;
  }

  function slugify(value) {
    return String(value)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
