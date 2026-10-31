// ---------------------------------------------------------------------------
// Emailer — shared UI: app shell, toasts, icons, number animation, helpers.
// ---------------------------------------------------------------------------

// Sidebar structure. "soon" entries have no backend yet, so they are shown
// honestly as not-yet-available rather than linking to a fake page.
const NAV = [
  { href: "/index.html", label: "Overview", icon: "layout-dashboard", match: ["/index.html"] },
  { href: "/campaigns.html", label: "Campaigns", icon: "send", match: ["/campaigns.html", "/compose.html"] },
  { href: "/contacts.html", label: "Audience", icon: "users", match: ["/contacts.html", "/segments.html"] },
  { href: "/contacts.html", label: "Contacts", sub: true, match: ["/contacts.html"] },
  { href: "/segments.html", label: "Segments", sub: true, match: ["/segments.html"] },
  { label: "Templates", icon: "layout-template", soon: true },
  { href: "/analytics.html", label: "Analytics", icon: "bar-chart-3", match: ["/analytics.html"] },
  { label: "Automations", icon: "workflow", soon: true },
  { href: "/settings.html", label: "Settings", icon: "settings", match: ["/settings.html"] },
];

function icon(name, extra = "") {
  return `<i data-lucide="${name}" ${extra}></i>`;
}

// Lucide icons load once, then are applied to anything rendered later too.
let iconTimer = null;
function refreshIcons() {
  if (iconTimer) return;
  iconTimer = requestAnimationFrame(() => {
    iconTimer = null;
    if (window.lucide && document.querySelector("[data-lucide]")) window.lucide.createIcons();
  });
}
(function loadIcons() {
  const s = document.createElement("script");
  s.src = "https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js";
  s.async = true;
  s.onload = refreshIcons;
  document.head.appendChild(s);
  new MutationObserver(refreshIcons).observe(document.documentElement, { childList: true, subtree: true });
})();

function renderNav(active) {
  const container = document.querySelector(".container");
  const app = document.createElement("div");
  app.className = "app";

  const links = NAV.map((l) => {
    if (l.soon) {
      return `<span class="sb-link soon" aria-disabled="true" title="Not built yet">${icon(l.icon)}<span>${l.label}</span><span class="sb-tag">Soon</span></span>`;
    }
    // "Audience" is a group heading: its Contacts / Segments children carry the active state.
    const isActive = l.label !== "Audience" && l.match.includes(active);
    const inGroup = l.label === "Audience" && l.match.includes(active);
    const cls = ["sb-link", l.sub ? "sb-sub" : "", isActive ? "active" : "", inGroup ? "group-open" : ""].join(" ");
    return `<a class="${cls}" href="${l.href}" ${isActive ? 'aria-current="page"' : ""}>${l.icon ? icon(l.icon) : ""}<span>${l.label}</span></a>`;
  }).join("");

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.id = "sidebar";
  sidebar.setAttribute("aria-label", "Main navigation");
  sidebar.innerHTML = `
    <a class="sb-brand" href="/index.html"><span class="sb-mark">${icon("arrow-up-right")}</span>Emailer</a>
    <a class="btn sb-new" href="/compose.html">${icon("plus")}New campaign</a>
    <nav>${links}</nav>
    <div class="sb-foot">
      <p>Your audience. Your message. Your momentum.</p>
      <button class="sb-link" id="logoutBtn">${icon("log-out")}<span>Log out</span></button>
    </div>`;

  const topbar = document.createElement("header");
  topbar.className = "topbar";
  topbar.innerHTML = `
    <button class="icon-btn" id="menuBtn" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <a class="sb-brand" href="/index.html"><span class="sb-mark">${icon("arrow-up-right")}</span>Emailer</a>`;

  const scrim = document.createElement("div");
  scrim.className = "scrim";

  const main = document.createElement("main");
  main.className = "main";
  main.id = "main";

  const skip = document.createElement("a");
  skip.className = "skip-link";
  skip.href = "#main";
  skip.textContent = "Skip to content";

  document.body.prepend(app);
  document.body.prepend(skip);
  const wrap = document.createElement("div");
  wrap.append(topbar, main);
  app.append(sidebar, wrap);
  document.body.append(scrim);
  if (container) main.append(container);

  const menuBtn = document.getElementById("menuBtn");
  const setOpen = (open) => {
    sidebar.classList.toggle("open", open);
    scrim.classList.toggle("on", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  sidebar.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
  refreshIcons();
}

// ---- Toasts: the "something good happened" moment ------------------------
function toast({ title, body, type = "success", href, hrefLabel, duration }) {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${icon(type === "error" ? "x" : "check")}</span>
    <div><b>${escapeHtml(title)}</b>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ""}${href ? `<a href="${href}">${escapeHtml(hrefLabel || "View")}</a>` : ""}</div>`;
  stack.appendChild(el);
  refreshIcons();
  const ms = duration || (body || href ? 7000 : 4200);
  const timer = setTimeout(dismiss, ms);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 220);
  }
  el.addEventListener("click", (e) => { if (!e.target.closest("a")) dismiss(); });
}

// ---- Animated counters ----------------------------------------------------
// Counts from 0 up to `to`. `format` turns the in-flight value into text.
function animateNumber(el, to, { format = (v) => Math.round(v).toLocaleString(), duration = 900 } = {}) {
  if (to === null || to === undefined || Number.isNaN(to)) { el.textContent = "—"; return; }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || to === 0) { el.textContent = format(to); return; }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(to * eased);
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = format(to);
  }
  requestAnimationFrame(frame);
}

// ---- Empty states: never leave a page looking abandoned -------------------
const EMPTY_ART = `<svg class="empty-art" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
  <circle cx="48" cy="48" r="40" opacity=".5"/><circle cx="48" cy="48" r="27"/><circle cx="48" cy="48" r="14" opacity=".7"/>
  <circle cx="48" cy="8" r="4" fill="#D6B46A" stroke="none"/></svg>`;

function emptyState({ title, body, href, label, secondaryHref, secondaryLabel }) {
  return `<div class="empty">${EMPTY_ART}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>
    ${href || secondaryHref ? `<div class="action-row">${href ? `<a class="btn" href="${href}">${escapeHtml(label)}</a>` : ""}${secondaryHref ? `<a class="btn btn-secondary" href="${secondaryHref}">${escapeHtml(secondaryLabel)}</a>` : ""}</div>` : ""}</div>`;
}

function skeletonRows(n = 4) {
  return Array.from({ length: n }, () => `<div class="skeleton sk-line"></div>`).join("");
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options,
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  let data = null;
  if (isJson) {
    try { data = await res.json(); } catch (e) { /* fall through to the checks below */ }
  }

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }

  // A 2xx response that isn't actually JSON almost always means this
  // request never reached our API at all - e.g. a misconfigured deployment
  // serving a static index.html fallback for unknown routes instead of
  // running the backend. Without this check, that looks like "success" to
  // the caller even though nothing happened server-side. Never let that
  // read as success.
  if (!isJson) {
    throw new Error(`Got an unexpected non-JSON response from ${url} - this usually means the request isn't reaching the backend. Check your deployment's routing.`);
  }

  return data;
}

function showMsg(el, text, type = "error") {
  if (type === "success") {
    // Successful actions get a refined toast rather than a banner.
    el.style.display = "none";
    toast({ title: text });
    return;
  }
  el.textContent = text;
  el.className = `msg ${type}`;
  el.style.display = "block";
}

function hideMsg(el) {
  el.style.display = "none";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  // innerHTML escapes & < > but not quotes - escape those too so this is
  // also safe to drop inside a quoted HTML attribute, not just text content.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Formats a 0..1 rate (or null/undefined when there's no denominator yet)
// as a percentage string for display - e.g. 0.417 -> "41.7%", null -> "—".
function formatRate(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  return `${(Number(rate) * 100).toFixed(1)}%`;
}

function formatNumber(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

// Renders a modal with the given inner HTML and returns { overlay, close() }.
// The caller is responsible for wiring up any buttons inside contentHtml.
function openModal(contentHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">${contentHtml}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  const first = overlay.querySelector("input, button, select, textarea");
  if (first) first.focus();
  return { overlay, close };
}
