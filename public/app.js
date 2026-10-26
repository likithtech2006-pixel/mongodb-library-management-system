const $ = id => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const VIEWS = ["dashboard", "books", "circulation", "reservations", "fines", "borrowers", "authors", "activity", "system"];

const state = {
  view: null,
  rules: { loanDays: 14, maxActiveLoans: 3, finePerDay: 10, holdDays: 3 },
  books: { page: 1, status: "", sort: "title", query: "", items: new Map(), token: 0 },
  loans: [],
  loanFilter: "all",
  borrowers: [],
  editingBookId: null,
  editingBorrowerId: null,
  reservationScope: "active",
  reserveBookId: null,
  activityEntity: "",
  qrKind: null
};

// Name shown in the audit log for actions taken in this browser (not a login)
function staffName() {
  try { return localStorage.getItem("staffName") || ""; } catch { return ""; }
}

// ---------------- HELPERS ----------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

const icon = name => `<svg class="icon"><use href="#i-${name}"/></svg>`;
const rupees = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const fmtDate = d => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtShort = d => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Stable colour per name, used for book covers and avatars
function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(s) {
  return String(s).split(/\s+/).filter(w => /\w/.test(w)).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (staffName()) headers["X-Staff-Name"] = encodeURIComponent(staffName());
  const r = await fetch(url, { headers, ...options });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

const send = (url, body, method = "POST") => api(url, { method, body: JSON.stringify(body) });

function animateNumber(el, to, format = n => n.toLocaleString()) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (reduceMotion || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const tick = now => {
    const t = Math.min(1, (now - start) / 900);
    el.textContent = format(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function toast(text, type = "success", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-icon">${icon(type === "success" ? "check" : "alert")}</span>
    <p>${escapeHtml(text)}</p><span class="t-bar" style="animation-duration:${ms}ms"></span>`;
  $("toasts").append(el);

  const remove = () => {
    el.classList.add("leaving");
    el.addEventListener("animationend", e => { if (e.target === el) el.remove(); });
  };
  const timer = setTimeout(remove, ms);
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

function shake(el) {
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

async function withBusy(btn, work) {
  btn.classList.add("busy");
  btn.disabled = true;
  try {
    return await work();
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
}

// Material-style ripple on every button
document.addEventListener("pointerdown", e => {
  const btn = e.target.closest(".btn");
  if (!btn || reduceMotion) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
  btn.append(ripple);
  ripple.addEventListener("animationend", () => ripple.remove());
});

// ---------------- THEME ----------------

function updateThemeLabel() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("themeLabel").textContent = dark ? "Light mode" : "Dark mode";
  $("themeToggle").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}

function setTheme(theme, x, y) {
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    updateThemeLabel();
  };
  if (!document.startViewTransition || reduceMotion) return apply();

  // Circular reveal growing out of the toggle button
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(apply).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: "cubic-bezier(.22, 1, .36, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  });
}

$("themeToggle").addEventListener("click", e => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("theme", next); } catch {}
  const rect = e.currentTarget.getBoundingClientRect();
  setTheme(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
});

// Follow the OS setting until the user picks a theme
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  if (!saved) setTheme(e.matches ? "dark" : "light", innerWidth / 2, 0);
});

// ---------------- NAVIGATION ----------------

function moveNavIndicator() {
  const active = document.querySelector("#nav a.active");
  const indicator = $("navIndicator");
  if (!active) return;
  indicator.style.transform = `translateY(${active.offsetTop}px)`;
  indicator.style.height = `${active.offsetHeight}px`;
  indicator.style.opacity = 1;
}

function updateGlider(group) {
  const active = group.querySelector("button.active");
  const glider = group.querySelector(".seg-glider");
  if (!active || !active.offsetWidth) return;
  glider.style.width = `${active.offsetWidth}px`;
  glider.style.transform = `translateX(${active.offsetLeft}px)`;
}

const updateGliders = () => document.querySelectorAll(".segmented").forEach(updateGlider);

function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function route() {
  const name = location.hash.slice(1);
  showView(VIEWS.includes(name) ? name : "dashboard");
}

function showView(view) {
  const changed = view !== state.view;
  state.view = view;
  const section = $(`view-${view}`);

  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  moveNavIndicator();

  if (changed) {
    $("pageTitle").textContent = section.dataset.title;
    $("pageSubtitle").textContent = section.dataset.subtitle;
    document.title = `${section.dataset.title} · LibraryDB`;
    replay(document.querySelector(".title-block"), "swap");
    replay(section, "entering");
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  requestAnimationFrame(updateGliders);
  load(view);
}

const loaders = {
  dashboard: loadDashboard,
  books: loadBooks,
  circulation: loadCirculation,
  reservations: loadReservations,
  fines: loadFines,
  borrowers: loadBorrowers,
  authors: loadAuthors,
  activity: loadActivity,
  system: loadSystem
};

function load(view) {
  return loaders[view]().catch(err => toast(err.message, "error"));
}

function refreshAfterChange() {
  return Promise.all([load(state.view), loadBadge()]);
}

function setBadge(badge, count, label) {
  badge.hidden = !count;
  if (count && badge.textContent !== String(count)) {
    badge.textContent = count;
    replay(badge, "nav-badge");
  }
  badge.title = plural(count, label);
}

async function loadBadge() {
  try {
    const [{ count }, queue] = await Promise.all([api("/api/loans/overdue"), api("/api/reservations")]);
    setBadge($("overdueBadge"), count, "overdue loan");
    setBadge($("readyBadge"), queue.filter(r => r.status === "ready").length, "reservation ready to collect");
  } catch {}
}

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { moveNavIndicator(); updateGliders(); });

// ---------------- DASHBOARD ----------------

async function loadDashboard() {
  const [a, overdue] = await Promise.all([api("/api/analytics"), api("/api/loans/overdue")]);

  animateNumber($("statTitles"), a.totals.titles);
  $("statCopies").textContent = `${a.totals.copies} ${a.totals.copies === 1 ? "copy" : "copies"} in total`;

  const share = a.totals.copies ? a.totals.available / a.totals.copies : 0;
  const circumference = 2 * Math.PI * 18;
  animateNumber($("statAvailable"), a.totals.available);
  $("statAvailablePct").textContent = `${Math.round(share * 100)}% of all copies`;
  requestAnimationFrame(() => {
    $("availRing").style.strokeDasharray = `${share * circumference} ${circumference}`;
  });

  animateNumber($("statActive"), a.loans.active);
  $("statBorrowers").textContent = `across ${plural(a.activeBorrowers.length, "borrower")}`;
  animateNumber($("statOverdue"), a.loans.overdue);
  $("statOverdueFines").textContent = overdue.totalFines ? `${rupees(overdue.totalFines)} in fines building` : "everything on time";
  animateNumber($("statFines"), a.loans.finesCollected, rupees);
  $("statFinesSub").textContent = a.loans.finesOutstanding ? `${rupees(a.loans.finesOutstanding)} still unpaid` : "no unpaid fines";

  renderMonthChart(a.loansPerMonth);
  renderDonut(a.popularity);
  renderRank("mostBorrowed", a.mostBorrowed.map(b => ({
    name: b.title, value: b.borrowCount, label: plural(b.borrowCount, "loan")
  })));
  renderRank("topAuthors", a.topAuthors.map(au => ({
    name: au.name, value: au.borrows, label: `${plural(au.borrows, "loan")} · ${plural(au.titles, "title")}`
  })));
  renderOverduePreview(overdue);
}

function renderMonthChart(months) {
  const max = Math.max(1, ...months.map(m => m.loans));
  $("monthChart").innerHTML = months.map((m, i) => {
    const label = new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
    return `<div class="bar-col">
      <div class="bar-track">
        <div class="bar ${i === months.length - 1 ? "current" : ""}" style="--v:${m.loans / max};--i:${i}" title="${plural(m.loans, "loan")} in ${label}"><b>${m.loans}</b></div>
      </div>
      <span>${label}</span>
    </div>`;
  }).join("");
}

function renderDonut(buckets) {
  const colors = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const C = 2 * Math.PI * 52;
  let offset = 0;

  const segments = buckets.map((b, i) => {
    const len = total ? (b.count / total) * C : 0;
    const seg = `<circle class="seg" cx="66" cy="66" r="52" stroke="${colors[i % 4]}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" style="--i:${i};--c:${C}">
      <title>${escapeHtml(b.label)}: ${b.count}</title></circle>`;
    offset += len;
    return seg;
  }).join("");

  $("popularityChart").innerHTML = `
    <div class="donut-center">
      <svg class="donut" viewBox="0 0 132 132"><circle cx="66" cy="66" r="52" stroke="var(--surface-3)"/>${segments}</svg>
      <div><b>${total}</b><small>titles</small></div>
    </div>
    <ul class="legend">${buckets.map((b, i) =>
      `<li><i style="background:${colors[i % 4]}"></i>${escapeHtml(b.label)}<b>${b.count}</b></li>`).join("")}
    </ul>`;
}

function renderRank(id, rows) {
  const max = Math.max(1, ...rows.map(r => r.value));
  $(id).innerHTML = rows.length
    ? rows.map((r, i) => `<li style="--i:${i}">
        <span class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        <span class="value">${escapeHtml(r.label)}</span>
        <div class="meter"><span style="--p:${r.value / max};--i:${i}"></span></div>
      </li>`).join("")
    : `<div class="empty">No data yet</div>`;
}

function renderOverduePreview(overdue) {
  $("overduePreview").innerHTML = overdue.loans.length
    ? overdue.loans.slice(0, 4).map(l => `<div class="mini-item">
        <span class="avatar" style="--h:${hue(l.borrowerEmail)};width:34px;height:34px;font-size:12px">${escapeHtml(initials(l.borrowerName))}</span>
        <div><b>${escapeHtml(l.bookTitle)}</b><small>${escapeHtml(l.borrowerName)} · ${plural(l.overdueDays, "day")} late</small></div>
        <span class="badge danger">${rupees(l.fine)}</span>
      </div>`).join("") + (overdue.count > 4 ? `<a class="muted" href="#circulation">+${overdue.count - 4} more →</a>` : "")
    : `<div class="empty">${icon("check")}<span>Every book is on time</span></div>`;
}

// ---------------- BOOKS ----------------

async function loadBooks() {
  const b = state.books;
  const token = ++b.token;
  const grid = $("bookGrid");
  if (!grid.children.length) grid.innerHTML = `<div class="skeleton"></div>`.repeat(6);
  $("sortSelect").disabled = Boolean(b.query);
  $("explainCard").hidden = !b.query;

  if (b.query) {
    let results = await api(`/api/search?q=${encodeURIComponent(b.query)}`);
    if (token !== b.token) return;
    if (b.status === "available") results = results.filter(x => x.availableCopies > 0);
    if (b.status === "out") results = results.filter(x => x.availableCopies === 0);
    $("resultMeta").innerHTML = `${icon("zap")}<span>${plural(results.length, "result")} for “${escapeHtml(b.query)}”, ranked by <code>textScore</code></span>`;
    renderBooks(results);
    $("pager").innerHTML = "";
    loadExplain(b.query, token);
    return;
  }

  const params = new URLSearchParams({ page: b.page, limit: 9, status: b.status, sort: b.sort });
  const data = await api(`/api/books?${params}`);
  if (token !== b.token) return;
  if (!data.items.length && b.page > 1) {
    b.page = data.pages;
    return loadBooks();
  }
  const from = (data.page - 1) * 9 + 1;
  const range = data.total ? `${from}–${from + data.items.length - 1} of ` : "";
  $("resultMeta").innerHTML = `${icon("layers")}<span>Showing ${range}${plural(data.total, "book")} · paginated with <code>$facet</code></span>`;
  renderBooks(data.items);
  renderPager(data.page, data.pages);
}

function renderBooks(items) {
  state.books.items = new Map(items.map(x => [x._id, x]));
  $("bookGrid").innerHTML = items.length
    ? items.map(bookCard).join("")
    : `<div class="empty card" style="grid-column:1/-1">${icon("search")}<b>No books found</b><span>Try a different search or filter.</span></div>`;
}

function bookCard(b, i) {
  const share = b.totalCopies ? b.availableCopies / b.totalCopies : 0;
  const tone = b.availableCopies === 0 ? "out" : share < 0.5 ? "low" : "ok";
  const held = b.heldCopies ? ` · ${b.heldCopies} held` : "";
  const label = (b.availableCopies === 0 ? "All copies out" : `${b.availableCopies} of ${b.totalCopies} available`) + held;
  const surname = String(b.author).split(" ").pop();

  return `<article class="book-card" style="--i:${i}" data-book-card="${b._id}">
    <div class="cover" style="--h:${hue(b.title)}"><span>${escapeHtml(initials(b.title))}</span><small>${escapeHtml(surname)}</small></div>
    <div class="book-body">
      <h3>${escapeHtml(b.title)}</h3>
      <p class="author">by ${escapeHtml(b.author)}</p>
      ${b.description ? `<p class="desc">${escapeHtml(b.description)}</p>` : ""}
      <div class="avail ${tone}"><span>${label}</span><div class="avail-bar"><span style="--p:${share}"></span></div></div>
      <div class="book-meta">
        <span class="mono">${escapeHtml(b.isbn)}</span>
        <span>${plural(b.borrowCount, "loan")}</span>
        ${b.score ? `<span class="score">score ${b.score.toFixed(2)}</span>` : ""}
        <span class="card-actions">
          ${b.availableCopies === 0 ? `<button class="icon-btn" type="button" data-reserve-book="${b._id}" aria-label="Reserve ${escapeHtml(b.title)}" title="Reserve">${icon("bookmark")}</button>` : ""}
          <button class="icon-btn" type="button" data-qr-book="${b._id}" aria-label="QR label for ${escapeHtml(b.title)}" title="QR label">${icon("qr")}</button>
          <button class="icon-btn" type="button" data-edit-book="${b._id}" aria-label="Edit ${escapeHtml(b.title)}" title="Edit">${icon("edit")}</button>
          <button class="icon-btn danger" type="button" data-delete-book="${b._id}" aria-label="Delete ${escapeHtml(b.title)}" title="Delete">${icon("trash")}</button>
        </span>
      </div>
    </div>
  </article>`;
}

function renderPager(page, pages) {
  if (pages <= 1) {
    $("pager").innerHTML = "";
    return;
  }
  const button = (content, target, { active = false, disabled = false, label = `Page ${target}` } = {}) =>
    `<button type="button" data-page="${target}" class="${active ? "active" : ""}" ${disabled ? "disabled" : ""} aria-label="${label}">${content}</button>`;

  let html = button(icon("left"), page - 1, { disabled: page === 1, label: "Previous page" });
  for (let p = 1; p <= pages; p++) html += button(p, p, { active: p === page });
  html += button(icon("right"), page + 1, { disabled: page === pages, label: "Next page" });
  $("pager").innerHTML = html;
}

async function loadExplain(q, token) {
  try {
    const e = await api(`/api/search/explain?q=${encodeURIComponent(q)}`);
    if (token !== state.books.token) return;

    const metric = (label, value, max) => `<div class="plan-metric"><span>${label}</span>
      <div class="plan-bar"><span style="--p:${max ? Math.min(1, value / max) : 0}"></span></div><b>${value}</b></div>`;

    const plan = (title, p, good) => `<div class="plan ${good ? "good" : "bad"}">
      <h3>${title}<span class="badge ${good ? "ok" : "danger"}">${good ? "uses index" : "full scan"}</span></h3>
      <div class="stages">${p.stages.slice().reverse().map(s => `<code>${escapeHtml(s)}</code>`).join('<span class="arrow">→</span>')}</div>
      ${metric("Docs examined", p.docsExamined, e.totalDocuments)}
      ${metric("Index keys read", p.keysExamined, Math.max(e.totalDocuments, p.keysExamined))}
      ${metric("Docs returned", p.returned, e.totalDocuments)}
      <small class="muted">${p.indexes.length ? `Index: <code>${p.indexes.map(escapeHtml).join(", ")}</code>` : "No index can serve a case-insensitive regex"}</small>
    </div>`;

    $("explainBody").innerHTML =
      plan("$text search", e.textIndex, true) +
      plan("Regex on title / author / description", e.regexScan, false);
  } catch (err) {
    $("explainBody").innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

let searchTimer;
$("searchBox").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.books.query = e.target.value.trim();
    state.books.page = 1;
    load("books");
  }, 280);
});

$("sortSelect").addEventListener("change", e => {
  state.books.sort = e.target.value;
  state.books.page = 1;
  load("books");
});

document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  if (state.view !== "books") location.hash = "books";
  setTimeout(() => $("searchBox").focus(), 60);
});

// ---------------- BOOK DIALOG ----------------

async function openBookDialog(book) {
  state.editingBookId = book?._id || null;
  $("bookDialogTitle").textContent = book ? "Edit book" : "Add a book";
  $("bookSubmit").textContent = book ? "Save changes" : "Add book";
  $("bookTitle").value = book?.title || "";
  $("bookAuthor").value = book?.author || "";
  $("bookIsbn").value = book?.isbn || "";
  $("bookCopies").value = book?.totalCopies || 1;
  $("bookCopies").min = book ? Math.max(1, book.totalCopies - book.availableCopies) : 1;
  $("bookDescription").value = book?.description || "";
  openDialog($("bookDialog"));
  setTimeout(() => $("bookTitle").focus(), 50);

  try {
    const authors = await api("/api/authors");
    $("authorOptions").innerHTML = authors.map(a => `<option value="${escapeHtml(a.name)}">`).join("");
  } catch {}
}

$("bookForm").addEventListener("submit", async e => {
  e.preventDefault();
  const body = {
    title: $("bookTitle").value,
    author: $("bookAuthor").value,
    isbn: $("bookIsbn").value,
    totalCopies: $("bookCopies").value,
    description: $("bookDescription").value
  };
  const id = state.editingBookId;
  try {
    await withBusy($("bookSubmit"), () => id ? send(`/api/books/${id}`, body, "PUT") : send("/api/books", body));
    closeDialog($("bookDialog"));
    toast(id ? `“${body.title}” updated` : `“${body.title}” added to the catalogue`);
    refreshAfterChange();
  } catch (err) {
    shake($("bookDialog"));
    toast(err.message, "error");
  }
});

async function deleteBook(id) {
  const book = state.books.items.get(id);
  const ok = await confirmAction({
    title: "Delete this book?",
    message: `“${book?.title}” will be removed from the catalogue. Past loan records are kept.`
  });
  if (!ok) return;
  try {
    await api(`/api/books/${id}`, { method: "DELETE" });
    const card = document.querySelector(`[data-book-card="${id}"]`);
    if (card && !reduceMotion) {
      await card.animate(
        [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.92) translateY(8px)" }],
        { duration: 280, easing: "ease-in", fill: "forwards" }
      ).finished;
    }
    toast(`“${book?.title}” deleted`);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- CIRCULATION ----------------

function fillSelect(select, placeholder, options) {
  const previous = select.value;
  select.innerHTML = `<option value="" disabled selected>${placeholder}</option>` + options.join("");
  if (previous && [...select.options].some(o => o.value === previous && !o.disabled)) select.value = previous;
}

async function loadCirculation() {
  const [books, borrowers, active, overdue] = await Promise.all([
    api("/api/books/options"), api("/api/borrowers"), api("/api/loans/active"), api("/api/loans/overdue")
  ]);
  const max = state.rules.maxActiveLoans;

  // Books with a copy on the shelf, or a copy held for a reservation (only its holder can take that one)
  const available = books.filter(b => b.availableCopies > 0 || b.heldCopies > 0);
  fillSelect($("issueBook"), available.length ? "Choose a book…" : "No copies available",
    available.map(b => `<option value="${b._id}">${escapeHtml(b.title)} — ${b.availableCopies} left${b.heldCopies ? `, ${b.heldCopies} held for a reservation` : ""}</option>`));
  fillSelect($("issueBorrower"), borrowers.length ? "Choose a borrower…" : "Register a borrower first",
    borrowers.map(b => `<option value="${b._id}" ${b.activeLoans >= max ? "disabled" : ""}>
      ${escapeHtml(b.name)} (${b.activeLoans}/${max} books)${b.activeLoans >= max ? " — at limit" : ""}</option>`));

  state.loans = active;
  renderLoans();

  const banner = $("overdueBanner");
  banner.hidden = !overdue.count;
  banner.innerHTML = `${icon("alert")}<span><b>${plural(overdue.count, "loan")} overdue</b>, with ${rupees(overdue.totalFines)} in fines building at ${rupees(overdue.finePerDay)}/day.</span>`;
}

function statusBadge(l) {
  if (l.overdue) return `<span class="badge danger">${l.overdueDays}d overdue · ${rupees(l.fine)}</span>`;
  const left = Math.ceil((new Date(l.dueDate) - Date.now()) / DAY_MS);
  if (left <= 2) return `<span class="badge warn">Due ${left <= 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`}</span>`;
  return `<span class="badge ok">${left} days left</span>`;
}

function renderLoans() {
  const rows = state.loanFilter === "overdue" ? state.loans.filter(l => l.overdue) : state.loans;
  $("loansBody").innerHTML = rows.length
    ? rows.map((l, i) => `<tr style="--i:${i}" data-loan-row="${l._id}">
        <td class="cell-strong">${escapeHtml(l.bookTitle)}</td>
        <td>${escapeHtml(l.borrowerName)}<small>${escapeHtml(l.borrowerEmail)}</small></td>
        <td class="nowrap" title="Issued ${fmtDate(l.issuedAt)}, due ${fmtDate(l.dueDate)}">${fmtShort(l.issuedAt)} → <b>${fmtShort(l.dueDate)}</b></td>
        <td>${statusBadge(l)}</td>
        <td><button class="btn btn-ghost btn-sm" type="button" data-return="${l._id}">${icon("return")}Return</button></td>
      </tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">${icon("check")}<span>${state.loanFilter === "overdue" ? "No overdue loans" : "No books are out right now"}</span></div></td></tr>`;
}

function updateDuePreview() {
  const days = Number($("issueDays").value);
  $("daysOut").textContent = plural(days, "day");
  $("duePreview").textContent = new Date(Date.now() + days * DAY_MS)
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

$("issueDays").addEventListener("input", updateDuePreview);

$("issueForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  try {
    const data = await withBusy(btn, () => send("/api/loans/issue", {
      bookId: $("issueBook").value,
      borrowerId: $("issueBorrower").value,
      days: $("issueDays").value
    }));
    toast(data.message);
    $("issueBook").value = "";
    refreshAfterChange();
  } catch (err) {
    shake(e.target);
    toast(err.message, "error");
  }
});

async function returnLoan(id, btn) {
  try {
    const data = await withBusy(btn, () => send("/api/loans/return", { loanId: id }));
    const row = document.querySelector(`[data-loan-row="${id}"]`);
    if (row && !reduceMotion) {
      row.classList.add("leaving");
      await new Promise(r => setTimeout(r, 420));
    }
    toast(data.message, data.fine > 0 ? "error" : "success", data.fine > 0 ? 5500 : 3800);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- BORROWERS ----------------

async function loadBorrowers() {
  state.borrowers = await api("/api/borrowers");
  renderBorrowers();
}

function renderBorrowers() {
  const filter = $("borrowerFilter").value.trim().toLowerCase();
  const max = state.rules.maxActiveLoans;
  const list = state.borrowers.filter(b => !filter || b.name.toLowerCase().includes(filter) || b.email.includes(filter));

  $("borrowerList").innerHTML = list.length
    ? list.map((b, i) => `<div class="person" style="--i:${i}">
        <span class="avatar" style="--h:${hue(b.email)}">${escapeHtml(initials(b.name))}</span>
        <div class="person-info"><b>${escapeHtml(b.name)}</b><small>${escapeHtml(b.email)}${b.phone ? ` · ${escapeHtml(b.phone)}` : ""}</small></div>
        <div class="loan-dots ${b.activeLoans >= max ? "full" : ""}" title="${b.activeLoans} of ${max} books on loan">
          ${Array.from({ length: max }, (_, k) => `<i class="${k < b.activeLoans ? "on" : ""}" style="animation-delay:${k * 90}ms"></i>`).join("")}
        </div>
        <div class="row-actions">
          <button class="icon-btn" type="button" data-qr-borrower="${b._id}" aria-label="Library card for ${escapeHtml(b.name)}" title="Library card">${icon("card")}</button>
          <button class="icon-btn" type="button" data-history="${b._id}" aria-label="Loan history of ${escapeHtml(b.name)}" title="Loan history">${icon("history")}</button>
          <button class="icon-btn" type="button" data-edit-borrower="${b._id}" aria-label="Edit ${escapeHtml(b.name)}" title="Edit">${icon("edit")}</button>
          <button class="icon-btn danger" type="button" data-delete-borrower="${b._id}" aria-label="Delete ${escapeHtml(b.name)}" ${b.activeLoans ? "disabled" : 'title="Delete"'}>${icon("trash")}</button>
        </div>
      </div>`).join("")
    : `<div class="empty">${icon("users")}<span>${state.borrowers.length ? "No borrowers match" : "No borrowers yet"}</span></div>`;
}

$("borrowerFilter").addEventListener("input", renderBorrowers);

$("borrowerForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  try {
    const data = await withBusy(btn, () => send("/api/borrowers", {
      name: $("borrowerName").value,
      email: $("borrowerEmail").value,
      phone: $("borrowerPhone").value
    }));
    e.target.reset();
    toast(`${data.borrower.name} registered`);
    refreshAfterChange();
  } catch (err) {
    shake(e.target);
    toast(err.message, "error");
  }
});

function openBorrowerDialog(id) {
  const b = state.borrowers.find(x => x._id === id);
  if (!b) return;
  state.editingBorrowerId = id;
  $("editBorrowerName").value = b.name;
  $("editBorrowerEmail").value = b.email;
  $("editBorrowerPhone").value = b.phone || "";
  openDialog($("borrowerDialog"));
}

$("borrowerEditForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  try {
    await withBusy(btn, () => send(`/api/borrowers/${state.editingBorrowerId}`, {
      name: $("editBorrowerName").value,
      email: $("editBorrowerEmail").value,
      phone: $("editBorrowerPhone").value
    }, "PUT"));
    closeDialog($("borrowerDialog"));
    toast("Borrower updated");
    refreshAfterChange();
  } catch (err) {
    shake($("borrowerDialog"));
    toast(err.message, "error");
  }
});

async function deleteBorrower(id) {
  const b = state.borrowers.find(x => x._id === id);
  const ok = await confirmAction({
    title: `Delete ${b?.name}?`,
    message: "Their account will be removed. Past loan records are kept for reports."
  });
  if (!ok) return;
  try {
    await api(`/api/borrowers/${id}`, { method: "DELETE" });
    toast(`${b?.name} deleted`);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function openHistory(id) {
  try {
    const { borrower, loans } = await api(`/api/borrowers/${id}/loans`);
    const fines = loans.reduce((s, l) => s + (l.fine || 0), 0);
    $("historyTitle").textContent = borrower.name;
    $("historySub").textContent = `${borrower.email} · ${plural(loans.length, "loan")} · ${rupees(fines)} in fines`;

    $("historyList").innerHTML = loans.length
      ? loans.map((l, i) => {
          let cls = "", badge;
          if (!l.returned && l.overdue) { cls = "overdue"; badge = `<span class="badge danger">Overdue · ${rupees(l.fine)}</span>`; }
          else if (!l.returned) { cls = "active"; badge = `<span class="badge ok">On loan</span>`; }
          else if (l.fine && l.finePaid) badge = `<span class="badge ok">Fine ${rupees(l.fine)} paid</span>`;
          else if (l.fine) badge = `<span class="badge warn">Unpaid fine · ${rupees(l.fine)}</span>`;
          else badge = `<span class="badge neutral">Returned</span>`;
          return `<li class="${cls}" style="--i:${i}">
            <div class="t-head"><b>${escapeHtml(l.bookTitle)}</b>${badge}</div>
            <small>Issued ${fmtDate(l.issuedAt)} · due ${fmtDate(l.dueDate)}${l.returnedAt ? ` · returned ${fmtDate(l.returnedAt)}` : ""}</small>
          </li>`;
        }).join("")
      : `<li><small>No loans yet.</small></li>`;

    openDialog($("historyDialog"));
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- AUTHORS ----------------

async function loadAuthors() {
  const authors = await api("/api/authors");
  $("authorGrid").innerHTML = authors.length
    ? authors.map((a, i) => `<article class="author-card" style="--i:${i}">
        <span class="avatar" style="--h:${hue(a.name)}">${escapeHtml(initials(a.name))}</span>
        <h3>${escapeHtml(a.name)}</h3>
        <div class="author-stats">
          <div><b>${a.bookCount}</b><small>${a.bookCount === 1 ? "title" : "titles"}</small></div>
          <div><b>${a.totalBorrows}</b><small>loans</small></div>
        </div>
        <button class="icon-btn danger" type="button" data-delete-author="${a._id}" data-name="${escapeHtml(a.name)}"
          aria-label="Delete ${escapeHtml(a.name)}" ${a.bookCount ? "disabled" : 'title="Delete author"'}>${icon("trash")}</button>
      </article>`).join("")
    : `<div class="empty card" style="grid-column:1/-1">${icon("pen")}<span>Authors appear here when you add books.</span></div>`;
}

async function deleteAuthor(id, name) {
  if (!(await confirmAction({ title: `Delete ${name}?`, message: "This author has no books left in the catalogue." }))) return;
  try {
    await api(`/api/authors/${id}`, { method: "DELETE" });
    toast(`${name} deleted`);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- SCAN DESK ----------------

async function previewCode(input, target) {
  const code = input.value.trim();
  target.textContent = "";
  target.className = "scan-preview";
  if (!code) return null;
  try {
    const found = await api(`/api/scan/resolve?code=${encodeURIComponent(code)}`);
    target.textContent = `${found.label}`;
    target.title = found.detail;
    target.classList.add("ok");
    return found;
  } catch (err) {
    target.textContent = err.message;
    target.classList.add("bad");
    return null;
  }
}

$("scanMember").addEventListener("change", () => previewCode($("scanMember"), $("memberPreview")));
$("scanBook").addEventListener("change", () => previewCode($("scanBook"), $("bookPreview")));

// Barcode scanners type the code and press Enter: move on to the book field
$("scanMember").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  previewCode($("scanMember"), $("memberPreview"));
  $("scanBook").focus();
});

$("scanForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  try {
    const data = await withBusy(btn, () => send("/api/scan", {
      memberCode: $("scanMember").value,
      bookCode: $("scanBook").value,
      days: $("issueDays").value
    }));
    toast(data.message, data.action === "return" && /Fine/.test(data.message) ? "error" : "success", 5000);
    $("scanBook").value = "";
    $("bookPreview").textContent = "";
    $("scanBook").focus();
    refreshAfterChange();
  } catch (err) {
    shake(e.target);
    toast(err.message, "error");
  }
});

const camera = { stream: null, timer: null };

async function startCamera() {
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    toast("Camera scanning needs Chrome or Edge. A USB barcode scanner or typing the code works in any browser.", "error", 6000);
    return;
  }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const detector = new BarcodeDetector({ formats: ["qr_code", "ean_13", "ean_8", "code_128"].filter(f => supported.includes(f)) });
    camera.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("cameraVideo");
    video.srcObject = camera.stream;
    await video.play();
    $("camera").hidden = false;

    camera.timer = setInterval(async () => {
      const [code] = await detector.detect(video).catch(() => []);
      if (!code) return;
      // The first scan fills the library card, the second the book
      const field = $("scanMember").value.trim() ? $("scanBook") : $("scanMember");
      if (field.value === code.rawValue) return;
      field.value = code.rawValue;
      const found = await previewCode(field, field === $("scanMember") ? $("memberPreview") : $("bookPreview"));
      if (found && field === $("scanBook")) {
        stopCamera();
        $("scanForm").requestSubmit();
      }
    }, 300);
  } catch (err) {
    stopCamera();
    toast(`Camera unavailable: ${err.message}`, "error");
  }
}

function stopCamera() {
  clearInterval(camera.timer);
  camera.stream?.getTracks().forEach(t => t.stop());
  camera.stream = null;
  $("camera").hidden = true;
}

$("cameraBtn").addEventListener("click", startCamera);
$("cameraStop").addEventListener("click", stopCamera);
window.addEventListener("hashchange", stopCamera);

// ---------------- RESERVATIONS ----------------

function startReservation(bookId) {
  state.reserveBookId = bookId;
  location.hash = "reservations";
}

function reservationStatus(r) {
  if (r.status === "ready") {
    const left = Math.ceil((new Date(r.holdUntil) - Date.now()) / DAY_MS);
    return `<span class="badge ok">Ready · held until ${fmtShort(r.holdUntil)}${left <= 1 ? " (last day)" : ""}</span>`;
  }
  if (r.status === "waiting") return `<span class="badge warn">#${r.position} in queue</span>`;
  const labels = { fulfilled: "Collected", cancelled: "Cancelled", expired: "Expired" };
  return `<span class="badge neutral">${labels[r.status]}${r.closedAt ? ` · ${fmtShort(r.closedAt)}` : ""}</span>`;
}

async function loadReservations() {
  const [queue, books, borrowers] = await Promise.all([
    api(`/api/reservations${state.reservationScope === "all" ? "?scope=all" : ""}`),
    api("/api/books/options"),
    api("/api/borrowers")
  ]);

  const out = books.filter(b => b.availableCopies === 0);
  fillSelect($("reserveBook"), out.length ? "Choose a book…" : "Every book has a copy on the shelf",
    out.map(b => `<option value="${b._id}">${escapeHtml(b.title)}${b.heldCopies ? " (copy held for someone)" : ""}</option>`));
  fillSelect($("reserveBorrower"), "Choose a borrower…",
    borrowers.map(b => `<option value="${b._id}">${escapeHtml(b.name)} (${escapeHtml(b.email)})</option>`));
  if (state.reserveBookId) {
    if ([...$("reserveBook").options].some(o => o.value === state.reserveBookId)) $("reserveBook").value = state.reserveBookId;
    state.reserveBookId = null;
    $("reserveBorrower").focus();
  }

  $("reservationsBody").innerHTML = queue.length
    ? queue.map((r, i) => `<tr style="--i:${i}" data-reservation-row="${r._id}">
        <td class="cell-strong">${escapeHtml(r.bookTitle)}</td>
        <td>${escapeHtml(r.borrowerName)}<small>${escapeHtml(r.borrowerEmail || "")}</small></td>
        <td class="nowrap">${fmtDate(r.createdAt)}</td>
        <td>${reservationStatus(r)}</td>
        <td>${["waiting", "ready"].includes(r.status) ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel-reservation="${r._id}">${icon("x")}Cancel</button>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">${icon("bookmark")}<span>${state.reservationScope === "all" ? "No reservations yet" : "Nobody is waiting for a book"}</span></div></td></tr>`;
}

$("reserveForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  try {
    const data = await withBusy(btn, () => send("/api/reservations", {
      bookId: $("reserveBook").value,
      borrowerId: $("reserveBorrower").value
    }));
    toast(data.message);
    refreshAfterChange();
  } catch (err) {
    shake(e.target);
    toast(err.message, "error");
  }
});

async function cancelReservation(id, btn) {
  if (!(await confirmAction({ title: "Cancel this reservation?", message: "If a copy is being held for it, the copy goes to the next person waiting.", confirmLabel: "Cancel reservation" }))) return;
  try {
    const data = await withBusy(btn, () => api(`/api/reservations/${id}`, { method: "DELETE" }));
    toast(data.message);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- FINES ----------------

async function loadFines() {
  const f = await api("/api/fines");
  animateNumber($("fineOutstanding"), f.totalOutstanding, rupees);
  $("fineOutstandingSub").textContent = `${plural(f.outstanding.length, "unpaid fine")} · borrowing blocked above ${rupees(f.maxUnpaid)}`;
  animateNumber($("fineCollected"), f.collected, rupees);
  $("fineCollectedSub").textContent = plural(f.paymentCount, "payment");
  animateNumber($("fineRunning"), f.runningOnOverdue, rupees);

  $("finesBody").innerHTML = f.outstanding.length
    ? f.outstanding.map((l, i) => `<tr style="--i:${i}" data-fine-row="${l._id}">
        <td class="cell-strong">${escapeHtml(l.borrowerName)}<small>${escapeHtml(l.borrowerEmail || "")}</small></td>
        <td>${escapeHtml(l.bookTitle)}</td>
        <td class="nowrap">${fmtShort(l.returnedAt)}<small>due ${fmtShort(l.dueDate)}</small></td>
        <td><span class="badge danger">${rupees(l.fine)}</span></td>
        <td><div class="pay-cell">
          <select aria-label="Payment method" data-method-for="${l._id}"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
          <button class="btn btn-primary btn-sm" type="button" data-pay="${l._id}">${icon("check")}Paid</button>
        </div></td>
      </tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">${icon("check")}<span>No unpaid fines</span></div></td></tr>`;

  $("paymentsList").innerHTML = f.payments.length
    ? f.payments.map(p => `<div class="mini-item">
        <span class="avatar" style="--h:${hue(p.borrowerName)};width:34px;height:34px;font-size:12px">${escapeHtml(initials(p.borrowerName))}</span>
        <div><b>${escapeHtml(p.borrowerName)} paid ${rupees(p.amount)}</b><small>${escapeHtml(p.bookTitle)} · ${p.method.toUpperCase()} · ${fmtDate(p.paidAt)}${p.receivedBy ? ` · by ${escapeHtml(p.receivedBy)}` : ""}</small></div>
        <span class="badge ok">${rupees(p.amount)}</span>
      </div>`).join("")
    : `<div class="empty">No payments yet</div>`;
}

async function payFine(loanId, btn) {
  const method = document.querySelector(`[data-method-for="${loanId}"]`)?.value || "cash";
  try {
    const data = await withBusy(btn, () => send(`/api/loans/${loanId}/pay`, { method }));
    const row = document.querySelector(`[data-fine-row="${loanId}"]`);
    if (row && !reduceMotion) {
      row.classList.add("leaving");
      await new Promise(r => setTimeout(r, 420));
    }
    toast(data.message);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------- ACTIVITY ----------------

const ACTION_TONES = { issue: "active", return: "", pay: "", reserve: "active", cancel: "overdue", expire: "overdue", delete: "overdue" };

async function loadActivity() {
  const entries = await api(`/api/audit?limit=150${state.activityEntity ? `&entity=${state.activityEntity}` : ""}`);
  $("activityList").innerHTML = entries.length
    ? entries.map((a, i) => `<li class="${ACTION_TONES[a.action] ?? ""}" style="--i:${Math.min(i, 20)}">
        <div class="t-head"><b>${escapeHtml(a.summary)}</b><span class="badge neutral">${escapeHtml(a.action)}</span></div>
        <small>${new Date(a.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${escapeHtml(a.actor)} · ${escapeHtml(a.entity)}</small>
      </li>`).join("")
    : `<li><small>Nothing recorded yet.</small></li>`;
}

// ---------------- SYSTEM ----------------

const kb = n => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

async function loadSystem() {
  $("staffName").value = staffName();
  const [backups, outbox] = await Promise.all([api("/api/backups"), api("/api/notifications")]);

  const ch = outbox.channels;
  $("channelStatus").innerHTML = [["Email", ch.email, "SMTP_HOST"], ["SMS", ch.sms, "TWILIO_*"]].map(([name, on, env]) =>
    `<span class="badge ${on ? "ok" : "neutral"}" title="${on ? "Configured" : `Set ${env} in .env to send for real`}">${name}: ${on ? "sending" : "outbox only"}</span>`).join("");
  const sched = state.health?.schedule;
  const onVercel = sched?.runtime === "vercel";
  $("reminderSchedule").textContent = sched?.enabled
    ? `Checked automatically every ${sched.reminderCheckMinutes} min: a reminder before the due date, a notice once overdue, and "ready" alerts for reservations.`
    : onVercel
      ? "On Vercel these checks run once a day (Vercel Cron). Use the button to run them now."
      : "Automatic checks are off (SCHEDULER=off). Use the button to run them.";
  $("backupSchedule").textContent = backups.scheduled
    ? `Automatic backup every ${backups.intervalHours} h; the newest ${backups.keep} are kept. Restore with: npm run restore -- backups/<file> --force`
    : onVercel
      ? "On Vercel, backups go to temporary storage and disappear when the function restarts, so download each one straight away."
      : `Automatic backups are off. The newest ${backups.keep} are kept.`;

  $("backupList").innerHTML = backups.files.length
    ? backups.files.map(f => `<div class="mini-item">
        <span class="stat-icon tone-success" style="width:34px;height:34px">${icon("download")}</span>
        <div><b>${escapeHtml(f.file)}</b><small>${fmtDate(f.createdAt)}, ${new Date(f.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ${kb(f.size)}</small></div>
        <a class="btn btn-ghost btn-sm" href="/api/backups/${encodeURIComponent(f.file)}" download>Download</a>
      </div>`).join("")
    : `<div class="empty">No backups yet</div>`;

  $("outboxBody").innerHTML = outbox.items.length
    ? outbox.items.map((n, i) => `<tr style="--i:${Math.min(i, 15)}">
        <td class="nowrap">${fmtShort(n.createdAt)}<small>${n.type.replace("_", " ")}</small></td>
        <td>${escapeHtml(n.borrowerName || "")}<small>${n.channel === "sms" ? "SMS" : "Email"} · ${escapeHtml(n.to)}</small></td>
        <td class="outbox-msg"><b>${escapeHtml(n.subject)}</b><small>${escapeHtml(n.body)}</small></td>
        <td><span class="badge ${n.status === "sent" ? "ok" : n.status === "failed" ? "danger" : "neutral"}" title="${escapeHtml(n.error || "")}">${n.status}</span></td>
      </tr>`).join("")
    : `<tr><td colspan="4"><div class="empty">${icon("send")}<span>No reminders yet</span></div></td></tr>`;
}

$("staffForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("staffName").value.trim();
  try { name ? localStorage.setItem("staffName", name) : localStorage.removeItem("staffName"); } catch {}
  toast(name ? `Activity will be recorded as ${name}` : "Activity will be recorded as Librarian");
});

$("backupNow").addEventListener("click", async e => {
  try {
    const data = await withBusy(e.currentTarget, () => send("/api/backups", {}));
    toast(data.message);
    load("system");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("runReminders").addEventListener("click", async e => {
  try {
    const data = await withBusy(e.currentTarget, () => send("/api/notifications/run", {}));
    toast(data.message);
    refreshAfterChange();
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---------------- QR LABELS ----------------

async function openQr(kind, id) {
  let name, detail;
  if (kind === "book") {
    const b = state.books.items.get(id);
    name = b?.title;
    detail = `ISBN ${b?.isbn} · ${b?.author}`;
  } else {
    const b = state.borrowers.find(x => x._id === id);
    name = b?.name;
    detail = `Library card · ${b?.email}`;
  }
  $("qrTitle").textContent = kind === "book" ? "Book label" : "Library card";
  $("qrName").textContent = name || "";
  $("qrDetail").textContent = detail;
  $("qrImage").src = `/api/qr/${kind}/${id}`;
  openDialog($("qrDialog"));
}

$("qrPrint").addEventListener("click", () => {
  document.body.classList.add("printing-qr");
  window.print();
  document.body.classList.remove("printing-qr");
});

// ---------------- DIALOGS ----------------

function openDialog(d) {
  d.classList.remove("closing");
  if (!d.open) d.showModal();
}

function closeDialog(d) {
  if (!d || !d.open || d.classList.contains("closing")) return;
  if (reduceMotion) return d.close();
  d.classList.add("closing");
  d.addEventListener("animationend", function done(e) {
    if (e.target !== d) return;
    d.removeEventListener("animationend", done);
    d.classList.remove("closing");
    d.close();
  });
}

document.querySelectorAll("dialog").forEach(d => {
  d.addEventListener("cancel", e => { e.preventDefault(); closeDialog(d); });
  d.addEventListener("click", e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d);
  });
});

function confirmAction({ title, message, confirmLabel = "Delete" }) {
  const d = $("confirmDialog");
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmYes").textContent = confirmLabel;

  return new Promise(resolve => {
    const onClick = e => {
      const answer = e.target.closest("[data-answer]");
      if (answer) finish(answer.dataset.answer === "yes");
    };
    const onClose = () => finish(false);
    function finish(value) {
      d.removeEventListener("click", onClick);
      d.removeEventListener("close", onClose);
      closeDialog(d);
      resolve(value);
    }
    d.addEventListener("click", onClick);
    d.addEventListener("close", onClose);
    openDialog(d);
    setTimeout(() => d.querySelector("[data-answer=no]").focus(), 50);
  });
}

// ---------------- CLICK HANDLING ----------------

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  const data = t.dataset;

  if ("close" in data) return closeDialog(t.closest("dialog"));
  if (data.action === "add-book") return openBookDialog();
  if (data.editBook) return openBookDialog(state.books.items.get(data.editBook));
  if (data.deleteBook) return deleteBook(data.deleteBook);
  if (data.return) return returnLoan(data.return, t);
  if (data.history) return openHistory(data.history);
  if (data.editBorrower) return openBorrowerDialog(data.editBorrower);
  if (data.deleteBorrower) return deleteBorrower(data.deleteBorrower);
  if (data.deleteAuthor) return deleteAuthor(data.deleteAuthor, data.name);
  if (data.reserveBook) return startReservation(data.reserveBook);
  if (data.cancelReservation) return cancelReservation(data.cancelReservation, t);
  if (data.pay) return payFine(data.pay, t);
  if (data.qrBook) return openQr("book", data.qrBook);
  if (data.qrBorrower) return openQr("borrower", data.qrBorrower);

  if (data.page) {
    state.books.page = Number(data.page);
    load("books");
    $("bookGrid").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    return;
  }

  const group = t.closest(".segmented");
  if (group) {
    group.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === t));
    updateGlider(group);
    if (group.id === "statusFilter") {
      state.books.status = data.status;
      state.books.page = 1;
      load("books");
    } else if (group.id === "loanFilter") {
      state.loanFilter = data.filter;
      renderLoans();
    } else if (group.id === "reservationFilter") {
      state.reservationScope = data.scope;
      load("reservations");
    } else if (group.id === "activityFilter") {
      state.activityEntity = data.entity;
      load("activity");
    }
  }
});

// ---------------- START ----------------

(async function init() {
  updateThemeLabel();
  try {
    const health = await api("/api/health");
    state.rules = health.rules;
    $("dbStatus").className = "db-status ok";
    $("dbStatusText").textContent = "Connected";
    $("dbStatusSub").textContent = `${health.database} · ${health.transactions ? "transactions on" : "standalone"}`;
    $("ruleMax").textContent = health.rules.maxActiveLoans;
    $("ruleFine").textContent = rupees(health.rules.finePerDay);
    $("ruleTx").textContent = health.transactions ? "ON" : "OFF";
    $("issueDays").value = health.rules.loanDays;
    $("ruleHold").textContent = `${health.rules.holdDays}d`;
    state.health = health;
  } catch {
    $("dbStatus").className = "db-status error";
    $("dbStatusText").textContent = "Offline";
    $("dbStatusSub").textContent = "start MongoDB and the server";
    toast("Can't reach the server. Start MongoDB and run npm start, then reload.", "error", 9000);
  }
  updateDuePreview();
  route();
  loadBadge();
})();
