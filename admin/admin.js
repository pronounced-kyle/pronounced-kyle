(function () {
  const state = {
    mode: "sheet",
    libraryBooks: [],
    sheetCandidates: [],
    selected: null,
    search: "",
    coverNonce: 0
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
  const form = document.getElementById("book-form");
  const coverStage = document.getElementById("cover-stage");
  const coverStatus = document.getElementById("cover-status");
  const coverStrip = document.getElementById("cover-strip");
  const bookPreview = document.getElementById("book-preview");
  const coverPrevButton = document.getElementById("cover-prev-button");
  const coverNextButton = document.getElementById("cover-next-button");
  const findCoversButton = document.getElementById("find-covers-button");
  const modeButtons = Array.from(document.querySelectorAll(".mode-button"));

  loginForm.addEventListener("submit", handleLogin);
  logoutButton.addEventListener("click", handleLogout);
  refreshButton.addEventListener("click", refresh);
  saveButton.addEventListener("click", save);
  deleteButton.addEventListener("click", del);
  coverPrevButton.addEventListener("click", () => cycleCover(-1));
  coverNextButton.addEventListener("click", () => cycleCover(1));
  findCoversButton.addEventListener("click", () => fetchCovers(true));
  form.addEventListener("input", onFormChange);
  form.addEventListener("change", onFormChange);
  searchInput.addEventListener("input", () => { state.search = searchInput.value.toLowerCase(); renderList(); });
  modeButtons.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

  bootstrap();

  async function bootstrap() {
    try {
      const me = await api("/api/me");
      if (me.authenticated) {
        sessionUser.textContent = `${me.username}`;
        showDashboard();
        await setMode("sheet");
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    loginMessage.textContent = "";
    const data = new FormData(loginForm);
    try {
      const me = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: data.get("username"), password: data.get("password") })
      });
      sessionUser.textContent = `${me.username}`;
      showDashboard();
      await setMode("sheet");
    } catch (err) {
      loginMessage.textContent = err.message;
    }
  }

  async function handleLogout() {
    await api("/api/logout", { method: "POST" });
    showLogin();
  }

  function showLogin() {
    loginCard.classList.remove("hidden");
    dashboard.classList.add("hidden");
  }

  function showDashboard() {
    loginCard.classList.add("hidden");
    dashboard.classList.remove("hidden");
  }

  async function setMode(mode) {
    state.mode = mode;
    modeButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.mode === mode));

    if (mode === "sheet") {
      listTitle.textContent = "New from sheet";
      saveButton.textContent = "Add to library";
      deleteButton.classList.add("hidden");
      await loadSheet();
      select(state.sheetCandidates[0] || null);
    } else {
      listTitle.textContent = "Library";
      saveButton.textContent = "Save";
      await loadLibrary();
      select(state.libraryBooks[0] || null);
    }
  }

  async function refresh() {
    if (state.mode === "sheet") {
      await loadSheet();
      editorMessage.textContent = "Sheet refreshed.";
    } else {
      await loadLibrary();
      editorMessage.textContent = "Library refreshed.";
    }
    renderList();
  }

  async function loadSheet() {
    state.sheetCandidates = await api("/api/admin/sheet-preview");
    renderList();
  }

  async function loadLibrary() {
    state.libraryBooks = await api("/api/admin/books");
    renderList();
  }

  function records() {
    const src = state.mode === "sheet" ? state.sheetCandidates : state.libraryBooks;
    if (!state.search) return src;
    return src.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(state.search));
  }

  function renderList() {
    const list = records();
    if (!list.length) {
      recordList.innerHTML = `<div class="record-list-empty">${state.mode === "sheet" ? "No new books in the sheet." : "No books in the library."}</div>`;
      return;
    }

    recordList.innerHTML = list.map((book) => {
      const active = state.selected && identity(state.selected) === identity(book);
      return `
        <button class="record-item ${active ? "is-active" : ""}" type="button" data-key="${escAttr(identity(book))}">
          <div class="record-item-main">
            <strong class="record-item-title">${esc(book.title || "Untitled")}</strong>
            <span class="record-item-subtitle">${esc(book.author || "")} ${book.year ? `· ${esc(book.year)}` : ""}</span>
          </div>
        </button>`;
    }).join("");

    recordList.querySelectorAll(".record-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const book = records().find((b) => identity(b) === btn.dataset.key);
        if (book) select(book);
      });
    });
  }

  function select(book) {
    state.selected = book ? { ...book } : null;
    editorMessage.textContent = "";
    editorMessage.classList.remove("is-error");

    if (!book) {
      editorTitle.textContent = "No selection";
      form.reset();
      renderCover(null);
      renderPreview(null);
      return;
    }

    editorTitle.textContent = book.title || "Book";
    populateForm(book);
    renderList();
    renderCover(book);
    renderPreview(book);

    if (state.mode === "sheet") {
      fetchCovers(false);
    }

    deleteButton.classList.toggle("hidden", state.mode !== "library" || !book.id);
    saveButton.textContent = state.mode === "sheet" ? "Add to library" : (book.id ? "Save" : "Create");
  }

  function populateForm(book) {
    ["id", "title", "author", "year", "genre", "rating", "pages", "completed",
     "coverUrl", "description", "source", "sourceKey", "rowIndex", "sortDate"
    ].forEach((field) => {
      if (form.elements[field] !== undefined) {
        form.elements[field].value = book[field] ?? "";
      }
    });
  }

  function formData() {
    return Object.fromEntries(new FormData(form).entries());
  }

  function workingBook() {
    const data = formData();
    return { ...state.selected, ...data, coverOptions: state.selected ? (state.selected.coverOptions || []) : [] };
  }

  function onFormChange() {
    if (!state.selected) return;
    const book = workingBook();
    renderCover(book);
    renderPreview(book);
  }

  async function save() {
    const data = formData();
    editorMessage.textContent = "";
    editorMessage.classList.remove("is-error");

    try {
      if (state.mode === "library" && data.id) {
        const saved = await api(`/api/admin/books/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
        await loadLibrary();
        select(saved);
        editorMessage.textContent = "Saved.";
      } else {
        const saved = await api("/api/admin/books", { method: "POST", body: JSON.stringify(data) });
        if (state.mode === "sheet") {
          await loadSheet();
          await loadLibrary();
          state.mode = "library";
          modeButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.mode === "library"));
          listTitle.textContent = "Library";
        } else {
          await loadLibrary();
        }
        select(saved);
        editorMessage.textContent = "Added.";
      }
    } catch (err) {
      console.error("Save failed:", err);
      editorMessage.classList.add("is-error");
      editorMessage.textContent = err.message || "Save failed.";
    }
  }

  async function del() {
    if (!state.selected?.id) return;
    if (!confirm(`Delete "${state.selected.title}"?`)) return;
    editorMessage.classList.remove("is-error");
    try {
      await api(`/api/admin/books/${state.selected.id}`, { method: "DELETE" });
      await loadLibrary();
      select(state.libraryBooks[0] || null);
      editorMessage.textContent = "Deleted.";
    } catch (err) {
      console.error("Delete failed:", err);
      editorMessage.classList.add("is-error");
      editorMessage.textContent = err.message || "Delete failed.";
    }
  }

  async function fetchCovers(force) {
    if (!state.selected) return;
    const book = workingBook();
    if (!book.title) return;
    if (!force && (book.coverOptions || []).length > 1) return;

    const nonce = ++state.coverNonce;
    coverStatus.textContent = "Finding covers...";
    findCoversButton.disabled = true;

    try {
      const result = await api("/api/admin/cover-options", {
        method: "POST",
        body: JSON.stringify({ title: book.title, author: book.author, coverUrl: book.coverUrl || "" })
      });
      if (nonce !== state.coverNonce) return;

      state.selected = { ...state.selected, coverUrl: result.coverUrl || state.selected.coverUrl, coverOptions: result.coverOptions || [] };
      if (form.elements.coverUrl) form.elements.coverUrl.value = state.selected.coverUrl || "";
      renderCover(state.selected);
    } catch {
      coverStatus.textContent = "Could not find covers.";
    } finally {
      if (nonce === state.coverNonce) findCoversButton.disabled = false;
    }
  }

  function cycleCover(dir) {
    const book = workingBook();
    const opts = book.coverOptions || [];
    if (opts.length < 2) return;
    const idx = Math.max(opts.indexOf(book.coverUrl), 0);
    const next = (idx + dir + opts.length) % opts.length;
    state.selected = { ...state.selected, coverUrl: opts[next] };
    if (form.elements.coverUrl) form.elements.coverUrl.value = opts[next];
    renderCover(state.selected);
  }

  function renderCover(book) {
    const opts = book?.coverOptions || [];
    const url = book?.coverUrl || "";
    const idx = url ? Math.max(opts.indexOf(url), 0) : -1;

    coverStage.innerHTML = url
      ? `<div class="cover-image"><img src="${escAttr(url)}" alt="Cover" referrerpolicy="no-referrer" /></div>`
      : `<div class="cover-fallback"><strong>${esc(book?.title || "No book selected")}</strong></div>`;

    coverStatus.textContent = url && opts.length
      ? `${idx + 1} of ${opts.length}`
      : opts.length ? `${opts.length} options` : "No covers";

    coverPrevButton.disabled = opts.length < 2;
    coverNextButton.disabled = opts.length < 2;
    findCoversButton.disabled = !book?.title;

    coverStrip.innerHTML = opts.map((u, i) =>
      `<button class="cover-thumb ${u === url ? "is-active" : ""}" type="button" data-i="${i}">
        <img src="${escAttr(u)}" referrerpolicy="no-referrer" />
      </button>`
    ).join("");

    coverStrip.querySelectorAll(".cover-thumb").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.i);
        state.selected = { ...state.selected, coverUrl: opts[idx] };
        if (form.elements.coverUrl) form.elements.coverUrl.value = opts[idx];
        renderCover(state.selected);
      });
    });
  }

  function renderPreview(book) {
    if (!book) { bookPreview.innerHTML = ""; return; }
    bookPreview.innerHTML = `
      ${book.coverUrl
        ? `<div class="cover-image"><img src="${escAttr(book.coverUrl)}" referrerpolicy="no-referrer" /></div>`
        : `<div class="cover-fallback"><strong>${esc(book.title || "")}</strong></div>`}
      <div class="book-preview-copy">
        <h3 class="book-preview-title">${esc(book.title || "Untitled")}</h3>
        <p class="book-preview-author">${esc(book.author || "")}</p>
        <p class="book-preview-summary">${esc(book.description || "")}</p>
        <ul class="book-preview-meta">
          <li>${esc(book.year || "—")}</li>
          <li>${esc(book.genre || "—")}</li>
          <li>Rating: ${esc(book.rating || "—")}</li>
        </ul>
      </div>`;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function identity(book) {
    return book.id || book.sourceKey || `${book.title}::${book.author}::${book.year}`;
  }

  function esc(v) {
    return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escAttr(v) { return esc(v); }
})();
