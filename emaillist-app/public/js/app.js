function renderNav(active) {
  const links = [
    { href: "/index.html", label: "Dashboard" },
    { href: "/contacts.html", label: "Contacts" },
    { href: "/segments.html", label: "Segments" },
    { href: "/compose.html", label: "Create Email" },
    { href: "/campaigns.html", label: "Campaigns" },
    { href: "/settings.html", label: "Settings" },
  ];
  const nav = document.createElement("div");
  nav.className = "topnav";
  nav.innerHTML = `
    <div class="topnav-inner">
      <div class="brand">Email List</div>
      <div class="navlinks">
        ${links.map(l => `<a href="${l.href}" class="${l.href === active ? "active" : ""}">${l.label}</a>`).join("")}
        <button class="logout-btn" id="logoutBtn">Log out</button>
      </div>
    </div>
  `;
  document.body.prepend(nav);
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
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
  }
  return { overlay, close };
}
