(function () {
  const state = {
    user: null,
    mode: "library",
    libraryBooks: [],
    sheetCandidates: [],
    timelineEntries: [],
    selectedRecord: null,
    search: "",
    coverLookupNonce: 0
  };

  const loginCard = document.getElementById("login-card");
  const dashboard = document.getElementById("dashboard");
  const loginForm = document.getElementById("login-form");
  const loginMessage = document.getElementById("login-message");
  const editorMessage = document.getElementById("editor-message");
  const sessionUser = document.getElementById("session-user");
  const recordList = document.getElementById("record-list");
  const searchInput = document.getElementById("search-input");
  const listTitle = document.getElementById("list-title");
  const editorTitle = document.getElementById("editor-title");
  const saveButton = document.getElementById("save-button");
  const deleteButton = document.getElementById("delete-button");
  const logoutButton = document.getElementById("logout-button");
  const refreshButton = document.getElementById("refresh-button");
  const newBookButton = document.getElementById("new-book-button");
  const bookPreviewWorkspace = document.getElementById("book-preview-workspace");
  const form = document.getElementById("book-form");
  const timelineEditor = document.getElementById("timeline-editor");
  const timelineForm = document.getElementById("timeline-form");
  const timelinePreview = document.getElementById("timeline-preview");
  const coverStage = document.getElementById("cover-stage");
  const coverStatus = document.getElementById("cover-status");
  const coverStrip = document.getElementById("cover-strip");
  const bookPreview = document.getElementById("book-preview");
  const coverPrevButton = document.getElementById("cover-prev-button");
  const coverNextButton = document.getElementById("cover-next-button");
  const findCoversButton = document.getElementById("find-covers-button");
  const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
  const editors = Object.fromEntries(
    Array.from(document.querySelectorAll("[data-editor]")).map((node) => [node.dataset.editor, node])
  );

  document.querySelectorAll(".toolbar").forEach((toolbar) => {
    toolbar.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) {
        return;
      }

      const editor = editors[toolbar.dataset.target];
      if (!editor) {
        return;
      }

      editor.focus();
      if (button.dataset.command === "createLink") {
        const url = window.prompt("Link URL");
        if (url) {
          document.execCommand("createLink", false, url);
        }
      } else {
        document.execCommand(button.dataset.command, false, null);
      }

      window.setTimeout(syncSelectedRecordFromForm, 0);
    });
  });

  Object.values(editors).forEach((editor) => {
    editor.addEventListener("input", syncSelectedRecordFromForm);
  });

  form.addEventListener("input", syncSelectedRecordFromForm);
  form.addEventListener("change", syncSelectedRecordFromForm);
  timelineForm.addEventListener("input", syncSelectedRecordFromForm);
  timelineForm.addEventListener("change", syncSelectedRecordFromForm);

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  loginForm.addEventListener("submit", handleLogin);
  logoutButton.addEventListener("click", handleLogout);
  refreshButton.addEventListener("click", refreshCurrentMode);
  newBookButton.addEventListener("click", () => {
    if (state.mode === "timeline") {
      selectRecord(blankTimelineEntry());
      return;
    }
    selectRecord(blankBook("manual"), { forceCoverLookup: false });
  });
  saveButton.addEventListener("click", saveCurrentRecord);
  deleteButton.addEventListener("click", deleteCurrentRecord);
  coverPrevButton.addEventListener("click", () => cycleCover(-1));
  coverNextButton.addEventListener("click", () => cycleCover(1));
  findCoversButton.addEventListener("click", () => hydrateCoverOptions({ force: true }));
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value.trim().toLowerCase();
    renderRecordList();
  });

  bootstrap();

  async function bootstrap() {
    try {
      const me = await request("/api/me");
      if (me.authenticated) {
        state.user = me;
        showDashboard();
        syncModeChrome();
        await loadLibraryBooks();
        selectRecord(state.libraryBooks[0] || blankBook("manual"));
      } else {
        showLogin();
      }
    } catch (error) {
      loginMessage.textContent = error.message;
      showLogin();
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    loginMessage.textContent = "";

    const formData = new FormData(loginForm);
    try {
      const me = await request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password")
        })
      });

      state.user = me;
      showDashboard();
      syncModeChrome();
      await loadLibraryBooks();
      selectRecord(state.libraryBooks[0] || blankBook("manual"));
    } catch (error) {
      loginMessage.textContent = error.message;
    }
  }

  async function handleLogout() {
    await request("/api/logout", { method: "POST" });
    state.user = null;
    showLogin();
  }

  function showLogin() {
    loginCard.classList.remove("hidden");
    dashboard.classList.add("hidden");
  }

  function showDashboard() {
    loginCard.classList.add("hidden");
    dashboard.classList.remove("hidden");
    sessionUser.textContent = state.user ? `Signed in as ${state.user.username}` : "";
  }

  async function setMode(mode) {
    state.mode = mode;
    syncModeChrome();

    if (mode === "sheet") {
      await loadSheetCandidates();
      selectRecord(state.sheetCandidates[0] || blankBook("sheet"));
    } else if (mode === "timeline") {
      await loadTimelineEntries();
      selectRecord(state.timelineEntries[0] || blankTimelineEntry());
    } else {
      await loadLibraryBooks();
      selectRecord(state.libraryBooks[0] || blankBook("manual"), { forceCoverLookup: false });
    }
  }

  async function refreshCurrentMode() {
    const previousKey = recordIdentity(state.selectedRecord);

    if (state.mode === "sheet") {
      await loadSheetCandidates();
      editorMessage.textContent = "Pulled the latest rows from your Google Sheet.";
      const next = state.sheetCandidates.find((record) => recordIdentity(record) === previousKey) || state.sheetCandidates[0] || blankBook("sheet");
      selectRecord(next);
      return;
    }

    if (state.mode === "timeline") {
      await loadTimelineEntries();
      editorMessage.textContent = "Timeline refreshed.";
      const next = state.timelineEntries.find((record) => recordIdentity(record) === previousKey) || state.timelineEntries[0] || blankTimelineEntry();
      selectRecord(next);
      return;
    }

    await loadLibraryBooks();
    editorMessage.textContent = "Library refreshed.";
    const next = state.libraryBooks.find((record) => recordIdentity(record) === previousKey) || state.libraryBooks[0] || blankBook("manual");
    selectRecord(next, { forceCoverLookup: false });
  }

  async function loadLibraryBooks() {
    state.libraryBooks = (await request("/api/admin/books")).map(normalizeRecord);
    renderRecordList();
  }

  async function loadSheetCandidates() {
    state.sheetCandidates = (await request("/api/admin/sheet-preview")).map(normalizeRecord);
    renderRecordList();
  }

  async function loadTimelineEntries() {
    state.timelineEntries = (await request("/api/admin/timeline")).map(normalizeTimelineEntry);
    renderRecordList();
  }

  function syncModeChrome() {
    modeButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === state.mode);
    });

    if (state.mode === "sheet") {
      listTitle.textContent = "Sheet preview";
      editorTitle.textContent = "Review before import";
      refreshButton.textContent = "Refresh sheet";
      newBookButton.classList.add("hidden");
      bookPreviewWorkspace.classList.remove("hidden");
      form.classList.remove("hidden");
      timelineEditor.classList.add("hidden");
    } else if (state.mode === "timeline") {
      listTitle.textContent = "Timeline entries";
      editorTitle.textContent = "Timeline editor";
      refreshButton.textContent = "Refresh timeline";
      newBookButton.classList.remove("hidden");
      newBookButton.textContent = "New entry";
      bookPreviewWorkspace.classList.add("hidden");
      form.classList.add("hidden");
      timelineEditor.classList.remove("hidden");
    } else {
      listTitle.textContent = "Published books";
      editorTitle.textContent = "Book editor";
      refreshButton.textContent = "Refresh library";
      newBookButton.classList.remove("hidden");
      newBookButton.textContent = "New";
      bookPreviewWorkspace.classList.remove("hidden");
      form.classList.remove("hidden");
      timelineEditor.classList.add("hidden");
    }
  }

  function renderRecordList() {
    const records = getVisibleRecords();
    recordList.innerHTML = records
      .map((record) => {
        const active = state.selectedRecord && recordIdentity(state.selectedRecord) === recordIdentity(record);
        const primary = state.mode === "timeline"
          ? [record.year, record.date].filter(Boolean).join(" / ") || "Timeline entry"
          : record.title || "Untitled book";
        const secondary = state.mode === "timeline"
          ? buildTimelineSummary(record)
          : `${record.author || "Unknown author"} / ${record.year || ""}`;
        return `
          <button class="record-item ${active ? "is-active" : ""}" type="button" data-record-key="${escapeAttr(recordIdentity(record))}">
            <strong>${escapeHtml(primary)}</strong>
            <span>${escapeHtml(secondary)}</span>
          </button>
        `;
      })
      .join("");

    Array.from(recordList.querySelectorAll(".record-item")).forEach((button) => {
      button.addEventListener("click", () => {
        const record = getVisibleRecords().find((entry) => recordIdentity(entry) === button.dataset.recordKey);
        if (record) {
          selectRecord(record);
        }
      });
    });
  }

  function getVisibleRecords() {
    const source = state.mode === "sheet"
      ? state.sheetCandidates
      : state.mode === "timeline"
        ? state.timelineEntries
        : state.libraryBooks;
    if (!state.search) {
      return source;
    }

    return source.filter((record) => {
      const haystack = state.mode === "timeline"
        ? `${record.year || ""} ${record.date || ""} ${record.text || ""} ${record.chipLabel || ""} ${record.suffix || ""}`.toLowerCase()
        : `${record.title || ""} ${record.author || ""}`.toLowerCase();
      return haystack.includes(state.search);
    });
  }

  function selectRecord(record, options = {}) {
    if (state.mode === "timeline") {
      state.selectedRecord = normalizeTimelineEntry({ ...blankTimelineEntry(), ...record });
      populateTimelineForm(state.selectedRecord);
      syncActionButtons();
      renderRecordList();
      renderTimelinePreview(state.selectedRecord);
      return;
    }

    state.selectedRecord = normalizeRecord({ ...blankBook(record.source || state.mode), ...record });
    populateForm(state.selectedRecord);
    syncActionButtons();
    renderRecordList();
    renderPreviewWorkspace(state.selectedRecord);

    if (options.forceCoverLookup !== false) {
      hydrateCoverOptions({ force: false });
    }
  }

  function populateForm(record) {
    Array.from(form.elements).forEach((element) => {
      if (!element.name) {
        return;
      }
      element.value = record[element.name] ?? "";
    });

    editors.descriptionHtml.innerHTML = record.descriptionHtml || "<p></p>";
    editors.memoriesHtml.innerHTML = record.memoriesHtml || "<p></p>";
    editors.favoriteQuoteHtml.innerHTML = record.favoriteQuoteHtml || "<p></p>";
  }

  function populateTimelineForm(record) {
    Array.from(timelineForm.elements).forEach((element) => {
      if (!element.name) {
        return;
      }
      element.value = record[element.name] ?? "";
    });
  }

  function syncActionButtons() {
    const selected = state.selectedRecord || (state.mode === "timeline" ? blankTimelineEntry() : blankBook("manual"));
    if (state.mode === "timeline") {
      deleteButton.classList.toggle("hidden", !selected.id);
      saveButton.textContent = selected.id ? "Save" : "Create";
      return;
    }

    deleteButton.classList.toggle("hidden", state.mode !== "library" || !selected.id);
    saveButton.textContent = state.mode === "sheet" ? "Add to library" : selected.id ? "Save" : "Create";
  }

  function collectFormData() {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.descriptionHtml = editors.descriptionHtml.innerHTML.trim();
    payload.memoriesHtml = editors.memoriesHtml.innerHTML.trim();
    payload.favoriteQuoteHtml = editors.favoriteQuoteHtml.innerHTML.trim();
    return payload;
  }

  function syncSelectedRecordFromForm() {
    if (!state.selectedRecord) {
      return;
    }

    state.selectedRecord = state.mode === "timeline" ? getWorkingTimelineEntry() : getWorkingRecord();
    syncActionButtons();
    if (state.mode === "timeline") {
      renderTimelinePreview(state.selectedRecord);
    } else {
      renderPreviewWorkspace(state.selectedRecord);
    }
    renderRecordList();
  }

  function getWorkingRecord() {
    const payload = collectFormData();
    const nextRecord = normalizeRecord({ ...state.selectedRecord, ...payload });
    if (String(payload.coverUrl || "").trim() === "") {
      nextRecord.coverUrl = "";
    }
    return nextRecord;
  }

  function collectTimelineFormData() {
    const formData = new FormData(timelineForm);
    return Object.fromEntries(formData.entries());
  }

  function getWorkingTimelineEntry() {
    return normalizeTimelineEntry({ ...state.selectedRecord, ...collectTimelineFormData() });
  }

  function renderPreviewWorkspace(record) {
    renderCoverStage(record);
    renderBookPreview(record);
  }

  function renderTimelinePreview(record) {
    const tone = record.tone || "lore";
    const yearLabel = record.year ? `<span class="timeline-preview-year">${escapeHtml(record.year)}</span>` : "";
    const linkMarkup = record.chipHref
      ? `<a class="timeline-preview-link" href="${escapeAttr(record.chipHref)}" target="_blank" rel="noreferrer">${escapeHtml(record.chipLabel || "")}</a>`
      : escapeHtml(record.chipLabel || "");

    timelinePreview.innerHTML = `
      <div class="timeline-preview-entry timeline-preview-entry--${escapeAttr(tone)}">
        ${yearLabel}${escapeHtml(record.text || "")}${linkMarkup}${escapeHtml(record.suffix || "")}
      </div>
    `;
  }

  function renderCoverStage(record) {
    const options = record.coverOptions || [];
    const hasCover = Boolean(record.coverUrl);
    const currentIndex = hasCover ? Math.max(options.indexOf(record.coverUrl), 0) : -1;

    coverStage.innerHTML = hasCover
      ? `
        <div class="cover-image">
          <img src="${escapeAttr(record.coverUrl)}" alt="${escapeAttr(`Cover of ${record.title || "Untitled book"}`)}" referrerpolicy="no-referrer" />
        </div>
      `
      : `
        <div class="cover-fallback">
          <strong>${escapeHtml(record.title || "Untitled book")}</strong>
          <span>${escapeHtml(record.author || "Unknown author")}</span>
        </div>
      `;

    coverStatus.textContent = hasCover && options.length
      ? `Cover ${currentIndex + 1} of ${options.length}`
      : options.length
        ? `${options.length} cover options ready`
        : "No cover options yet";

    coverPrevButton.disabled = options.length < 2;
    coverNextButton.disabled = options.length < 2;
    findCoversButton.disabled = !String(record.title || "").trim();

    coverStrip.innerHTML = options
      .map((url, index) => {
        const active = url === record.coverUrl;
        return `
          <button class="cover-thumb ${active ? "is-active" : ""}" type="button" data-cover-index="${index}">
            <img src="${escapeAttr(url)}" alt="${escapeAttr(`Cover option ${index + 1}`)}" referrerpolicy="no-referrer" />
          </button>
        `;
      })
      .join("");

    Array.from(coverStrip.querySelectorAll(".cover-thumb")).forEach((button) => {
      button.addEventListener("click", () => {
        applyCoverSelection(Number(button.dataset.coverIndex));
      });
    });
  }

  function renderBookPreview(record) {
    const description = stripHtml(record.descriptionHtml || record.description || "No tl;dr yet.").trim() || "No tl;dr yet.";

    bookPreview.innerHTML = `
      ${renderPreviewCover(record)}
      <div class="book-preview-copy">
        <h3 class="book-preview-title">${escapeHtml(record.title || "Untitled book")}</h3>
        <p class="book-preview-author">${escapeHtml(record.author || "Unknown author")}</p>
        <p class="book-preview-summary">${escapeHtml(description)}</p>
        <ul class="book-preview-meta">
          <li>Year: ${escapeHtml(record.year || "Unknown")}</li>
          <li>Genre: ${escapeHtml(record.genre || "Unfiled")}</li>
          <li>Rating: ${escapeHtml(record.rating || "-")}</li>
          <li>Pages: ${escapeHtml(record.pages || "-")}</li>
        </ul>
      </div>
    `;
  }

  function renderPreviewCover(record) {
    if (record.coverUrl) {
      return `
        <div class="cover-image">
          <img src="${escapeAttr(record.coverUrl)}" alt="${escapeAttr(`Cover of ${record.title || "Untitled book"}`)}" referrerpolicy="no-referrer" />
        </div>
      `;
    }

    return `
      <div class="cover-fallback">
        <strong>${escapeHtml(record.title || "Untitled book")}</strong>
        <span>${escapeHtml(record.author || "Unknown author")}</span>
      </div>
    `;
  }

  function cycleCover(direction) {
    const record = getWorkingRecord();
    const options = record.coverOptions || [];
    if (options.length < 2) {
      return;
    }

    const currentIndex = Math.max(options.indexOf(record.coverUrl), 0);
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    applyCoverSelection(nextIndex, record);
  }

  function applyCoverSelection(index, record = getWorkingRecord()) {
    const options = record.coverOptions || [];
    if (!options.length || !options[index]) {
      return;
    }

    const nextRecord = normalizeRecord({
      ...record,
      coverUrl: options[index],
      coverOptions: options
    });

    state.selectedRecord = nextRecord;
    if (form.elements.coverUrl) {
      form.elements.coverUrl.value = nextRecord.coverUrl;
    }
    renderPreviewWorkspace(nextRecord);
    renderRecordList();
  }

  async function hydrateCoverOptions({ force }) {
    if (!state.selectedRecord) {
      return;
    }

    const working = getWorkingRecord();
    if (!String(working.title || "").trim()) {
      return;
    }

    if (!force && (working.coverOptions || []).length > 1) {
      return;
    }

    const requestKey = recordIdentity(working);
    const requestTitle = String(working.title || "").trim();
    const requestAuthor = String(working.author || "").trim();
    const nonce = ++state.coverLookupNonce;

    coverStatus.textContent = "Looking for cover options...";
    findCoversButton.disabled = true;

    try {
      const payload = await request("/api/admin/cover-options", {
        method: "POST",
        body: JSON.stringify({
          title: requestTitle,
          author: requestAuthor,
          coverUrl: working.coverUrl || ""
        })
      });

      if (nonce !== state.coverLookupNonce) {
        return;
      }

      const current = getWorkingRecord();
      if (recordIdentity(current) !== requestKey || String(current.title || "").trim() !== requestTitle || String(current.author || "").trim() !== requestAuthor) {
        return;
      }

      state.selectedRecord = normalizeRecord({
        ...current,
        coverUrl: payload.coverUrl || current.coverUrl,
        coverOptions: payload.coverOptions || current.coverOptions
      });

      if (form.elements.coverUrl) {
        form.elements.coverUrl.value = state.selectedRecord.coverUrl || "";
      }

      renderPreviewWorkspace(state.selectedRecord);
    } catch (error) {
      coverStatus.textContent = "Could not load more covers right now.";
      editorMessage.textContent = error.message;
    } finally {
      if (nonce === state.coverLookupNonce) {
        findCoversButton.disabled = !String(getWorkingRecord().title || "").trim();
      }
    }
  }

  async function saveCurrentRecord() {
    if (state.mode === "timeline") {
      const payload = collectTimelineFormData();

      try {
        const saved = payload.id
          ? await request(`/api/admin/timeline/${payload.id}`, {
              method: "PUT",
              body: JSON.stringify(payload)
            })
          : await request("/api/admin/timeline", {
              method: "POST",
              body: JSON.stringify(payload)
            });

        await loadTimelineEntries();
        editorMessage.textContent = payload.id ? "Saved." : "Created.";
        const next = state.timelineEntries.find((entry) => recordIdentity(entry) === recordIdentity(saved)) || saved;
        selectRecord(next);
      } catch (error) {
        editorMessage.textContent = error.message;
      }
      return;
    }

    const payload = collectFormData();
    const wasSheetImport = state.mode === "sheet";

    try {
      let saved;
      if (state.mode === "library" && payload.id) {
        saved = await request(`/api/admin/books/${payload.id}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        await loadLibraryBooks();
      } else {
        saved = await request("/api/admin/books", {
          method: "POST",
          body: JSON.stringify(payload)
        });

        if (state.mode === "sheet") {
          state.mode = "library";
          syncModeChrome();
          await loadSheetCandidates();
          await loadLibraryBooks();
        } else {
          await loadLibraryBooks();
        }
      }

      editorMessage.textContent = wasSheetImport ? "Imported." : "Saved.";
      selectRecord(saved, { forceCoverLookup: false });
    } catch (error) {
      editorMessage.textContent = error.message;
    }
  }

  async function deleteCurrentRecord() {
    if (!state.selectedRecord || !state.selectedRecord.id) {
      return;
    }

    const label = state.mode === "timeline"
      ? buildTimelineSummary(state.selectedRecord)
      : state.selectedRecord.title;
    const confirmed = window.confirm(`Delete "${label}"?`);
    if (!confirmed) {
      return;
    }

    try {
      if (state.mode === "timeline") {
        await request(`/api/admin/timeline/${state.selectedRecord.id}`, { method: "DELETE" });
        await loadTimelineEntries();
        selectRecord(state.timelineEntries[0] || blankTimelineEntry());
        editorMessage.textContent = "Deleted.";
        return;
      }

      await request(`/api/admin/books/${state.selectedRecord.id}`, { method: "DELETE" });
      await loadLibraryBooks();
      selectRecord(state.libraryBooks[0] || blankBook("manual"), { forceCoverLookup: false });
      editorMessage.textContent = "Deleted.";
    } catch (error) {
      editorMessage.textContent = error.message;
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }
    return payload;
  }

  function normalizeRecord(record) {
    const base = { ...blankBook(record.source || state.mode), ...record };
    const coverOptions = uniqueStrings([...(Array.isArray(base.coverOptions) ? base.coverOptions : []), base.coverUrl]);
    const coverUrl = String(base.coverUrl || "").trim() || coverOptions[0] || "";

    return {
      ...base,
      coverUrl,
      coverOptions
    };
  }

  function normalizeTimelineEntry(record) {
    const base = { ...blankTimelineEntry(), ...record };
    return {
      ...base,
      id: String(base.id || "").trim(),
      year: String(base.year || "").trim(),
      date: String(base.date || "").trim(),
      tone: String(base.tone || "lore").trim().toLowerCase() || "lore",
      text: String(base.text || ""),
      suffix: String(base.suffix || ""),
      chipLabel: String(base.chipLabel || ""),
      chipHref: String(base.chipHref || "").trim(),
      chipColor: String(base.chipColor || "").trim()
    };
  }

  function blankBook(source) {
    return {
      id: "",
      title: "",
      author: "",
      year: "",
      genre: "",
      rating: "",
      descriptionHtml: "<p></p>",
      memoriesHtml: "<p></p>",
      favoriteQuoteHtml: "<p></p>",
      pages: "",
      completed: "",
      amazonUrl: "",
      coverUrl: "",
      coverOptions: [],
      sortDate: "",
      rowIndex: 0,
      source: source === "sheet" ? "sheet" : "manual",
      sourceKey: ""
    };
  }

  function blankTimelineEntry() {
    return {
      id: "",
      year: "",
      date: "",
      tone: "lore",
      text: "",
      suffix: "",
      chipLabel: "",
      chipHref: "",
      chipColor: ""
    };
  }

  function recordIdentity(record) {
    if (!record) {
      return "";
    }
    return String(record.id || record.sourceKey || `${record.title || ""}::${record.author || ""}::${record.year || ""}`);
  }

  function buildTimelineSummary(record) {
    const body = `${record.text || ""}${record.chipLabel || ""}${record.suffix || ""}`.trim() || "Timeline entry";
    return body.length > 92 ? `${body.slice(0, 89)}...` : body;
  }

  function uniqueStrings(values) {
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

  function stripHtml(value) {
    const div = document.createElement("div");
    div.innerHTML = value || "";
    return div.textContent || div.innerText || "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
