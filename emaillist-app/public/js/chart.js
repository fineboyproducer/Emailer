// Campaign performance chart + data-backed insights.
// Everything here is computed from /api/campaigns — nothing is invented.
// Requires app.js (escapeHtml, emptyState, formatRate).

const MIN_DELIVERED = 10; // below this, a rate is too noisy to compare

function chartPoints(campaigns, limit = 12) {
  return campaigns
    .filter((c) => c.delivered > 0 && c.open_rate !== null && c.open_rate !== undefined)
    .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
    .slice(-limit);
}

function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t, c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t, c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

let lastChart = null;

function renderPerformanceChart(el, campaigns) {
  lastChart = { el, campaigns };
  const data = chartPoints(campaigns);

  if (data.length < 2) {
    el.innerHTML = emptyState({
      title: data.length === 1 ? "One more campaign and your trend appears" : "Your performance trend starts here",
      body: data.length === 1
        ? "Your chart compares campaigns over time. Send another campaign and it will draw itself."
        : "Once your campaigns have delivery results, you'll see open and click rates side by side over time.",
      href: "/compose.html",
      label: "Create a campaign",
    });
    return;
  }

  const W = Math.max(300, el.clientWidth || 640);
  const H = W < 520 ? 210 : 270;
  const m = { l: 40, r: 14, t: 14, b: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const maxRate = Math.max(...data.map((d) => Math.max(d.open_rate || 0, d.click_rate || 0)));
  const yMax = Math.max(10, Math.ceil((maxRate * 100) / 10) * 10) / 100;
  const x = (i) => m.l + (data.length === 1 ? iw / 2 : (iw * i) / (data.length - 1));
  const y = (v) => m.t + ih - (v / yMax) * ih;

  const open = data.map((d, i) => ({ x: x(i), y: y(d.open_rate || 0) }));
  const click = data.map((d, i) => ({ x: x(i), y: y(d.click_rate || 0) }));
  const openPath = smoothPath(open), clickPath = smoothPath(click);
  const area = `${openPath} L${open[open.length - 1].x},${m.t + ih} L${open[0].x},${m.t + ih} Z`;

  const ticks = [0, 1, 2, 3, 4].map((i) => (yMax * i) / 4);
  const labelEvery = Math.ceil(data.length / (W < 520 ? 4 : 7));
  const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  el.innerHTML = `
    <div class="chart-wrap chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Open rate and click rate for your last ${data.length} campaigns">
        <defs>
          <linearGradient id="openFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#D6B46A" stop-opacity=".22"/><stop offset="100%" stop-color="#D6B46A" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 10}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`).join("")}
        ${data.map((d, i) => (i % labelEvery === 0 || i === data.length - 1) ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${fmtDate(d.sent_at)}</text>` : "").join("")}
        <path d="${area}" fill="url(#openFill)"/>
        <path class="line-click" d="${clickPath}" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="1" pathLength="1" opacity=".85"/>
        <path class="line-open" d="${openPath}" fill="none" stroke-width="2.5" stroke-linecap="round" pathLength="1"/>
        <g class="dots">${data.map((d, i) => `<circle cx="${open[i].x}" cy="${open[i].y}" r="3.5" fill="#101114" stroke="#D6B46A" stroke-width="2"/>`).join("")}</g>
        <line id="cursor" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="rgba(245,243,237,.25)" stroke-dasharray="3 4" opacity="0"/>
        <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/>
      </svg>
      <div class="chart-tip" role="tooltip"></div>
    </div>
    <div class="chart-legend" style="margin-top:12px;">
      <span><i style="background:#D6B46A"></i>Open rate</span>
      <span><i style="background:#D4D2CB"></i>Click rate</span>
    </div>`;

  // Draw-in animation for the headline line
  const line = el.querySelector(".line-open");
  const clickLine = el.querySelector(".line-click");
  clickLine.removeAttribute("stroke-dasharray");
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    line.style.strokeDasharray = "1";
    line.style.strokeDashoffset = "1";
    line.getBoundingClientRect();
    line.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1)";
    line.style.strokeDashoffset = "0";
  }

  // Hover / touch tooltip
  const svg = el.querySelector("svg"), tip = el.querySelector(".chart-tip"), cursor = el.querySelector("#cursor");
  function show(evt) {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    let idx = 0, best = Infinity;
    open.forEach((p, i) => { const dd = Math.abs(p.x - px); if (dd < best) { best = dd; idx = i; } });
    const d = data[idx];
    cursor.setAttribute("x1", open[idx].x); cursor.setAttribute("x2", open[idx].x); cursor.setAttribute("opacity", "1");
    tip.innerHTML = `<b>${escapeHtml(d.subject)}</b><span style="color:var(--muted)">${fmtDate(d.sent_at)} · ${formatNumber(d.delivered)} delivered</span>
      <div class="tip-row"><span>Open rate</span><span>${formatRate(d.open_rate)}</span></div>
      <div class="tip-row"><span>Click rate</span><span>${formatRate(d.click_rate)}</span></div>`;
    const scale = r.width / W;
    let left = open[idx].x * scale + 14;
    if (left + 240 > r.width) left = open[idx].x * scale - 14 - tip.offsetWidth;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = Math.max(0, open[idx].y * scale - 30) + "px";
    tip.classList.add("on");
  }
  function hide() { tip.classList.remove("on"); cursor.setAttribute("opacity", "0"); }
  const hit = el.querySelector(".hit");
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastChart && document.body.contains(lastChart.el)) renderPerformanceChart(lastChart.el, lastChart.campaigns); }, 180);
});

// ---------------------------------------------------------------------------
// Insights. Each rule only fires when the numbers genuinely support it.
// ---------------------------------------------------------------------------
function pct(v) { return `${(v * 100).toFixed(1)}%`; }
function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

function buildInsights(campaigns) {
  const out = [];

  if (!campaigns.length) {
    out.push({
      icon: "send",
      title: "Send your first campaign to start building insights",
      body: "Once emails are delivered, Emailer compares your campaigns and points out what's working.",
      href: "/compose.html", hrefLabel: "Create a campaign",
    });
    return out;
  }

  const newestFirst = [...campaigns].sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  // Sent, but no delivery events at all: the webhook is probably not connected.
  const sentSome = campaigns.some((c) => c.sent > 0);
  const anyEvents = campaigns.some((c) => c.delivered > 0 || c.opened_unique > 0 || c.clicked_unique > 0);
  if (sentSome && !anyEvents) {
    out.push({
      icon: "plug-zap",
      title: "No delivery results have arrived yet",
      body: "Your campaigns were sent, but Resend hasn't reported any delivery, open or click events. If that persists, check that the Resend webhook is connected.",
      href: "/settings.html", hrefLabel: "Check connection",
    });
  }

  const pts = newestFirst.filter((c) => c.delivered >= MIN_DELIVERED && c.open_rate !== null && c.open_rate !== undefined);

  if (pts.length >= 4) {
    const last = pts[0];
    const avg = mean(pts.slice(1, 4).map((c) => c.open_rate));
    const diff = last.open_rate - avg;
    if (diff >= 0.01) {
      out.push({
        icon: "trending-up",
        title: `"${last.subject}" opened better than your previous three`,
        body: `Its open rate was ${pct(last.open_rate)}, ${(diff * 100).toFixed(1)} points above the ${pct(avg)} average of the three before it. Consider reusing its subject-line approach.`,
        href: `/campaign.html?id=${last.id}`, hrefLabel: "Open report",
      });
    } else if (diff <= -0.01) {
      out.push({
        icon: "trending-down",
        title: `"${last.subject}" opened below your recent average`,
        body: `Its open rate was ${pct(last.open_rate)}, ${(Math.abs(diff) * 100).toFixed(1)} points under the ${pct(avg)} average of the three before it. Compare its subject line with your stronger campaigns.`,
        href: `/campaign.html?id=${last.id}`, hrefLabel: "Open report",
      });
    }
  }

  const lastWithData = pts[0];
  if (lastWithData && lastWithData.unsubscribed / lastWithData.delivered > 0.01) {
    out.push({
      icon: "user-minus",
      title: "Your last campaign saw a higher-than-usual unsubscribe rate",
      body: `${lastWithData.unsubscribed} of ${formatNumber(lastWithData.delivered)} delivered recipients unsubscribed (${pct(lastWithData.unsubscribed / lastWithData.delivered)}). Sending to a narrower segment can help.`,
      href: "/segments.html", hrefLabel: "Your segments",
    });
  }

  if (pts.length >= 2) {
    const best = pts.reduce((a, b) => ((b.click_rate || 0) > (a.click_rate || 0) ? b : a));
    if ((best.click_rate || 0) > 0) {
      out.push({
        icon: "mouse-pointer-click",
        title: `"${best.subject}" is your strongest campaign for clicks`,
        body: `${pct(best.click_rate)} of delivered recipients clicked. It's a good reference when planning your next call to action.`,
        href: `/campaign.html?id=${best.id}`, hrefLabel: "Open report",
      });
    }
  }

  if (pts.length > 0 && pts.length < 4) {
    out.push({
      icon: "sparkles",
      title: "Comparisons unlock as you send more",
      body: `Emailer compares your latest campaign with the three before it. You have ${pts.length} with delivery results so far; ${4 - pts.length} more will unlock that insight.`,
    });
  }

  return out;
}

function renderInsights(el, campaigns) {
  const items = buildInsights(campaigns);
  if (!items.length) {
    el.innerHTML = `<div class="insight-chip">${icon("lightbulb")}Your Next Insight</div>
      <p class="insight-title">Nothing stands out yet</p><p>Your recent campaigns are performing consistently. We'll flag anything worth acting on.</p>`;
    return;
  }
  const [top, ...rest] = items;
  el.innerHTML = `
    <div class="insight-chip">${icon("lightbulb")}Your Next Insight</div>
    <div class="insight-title">${escapeHtml(top.title)}</div>
    <p>${escapeHtml(top.body)}</p>
    ${top.href ? `<a class="link-btn" href="${top.href}" style="color:var(--gold)">${escapeHtml(top.hrefLabel || "View")} ${icon("arrow-right")}</a>` : ""}
    ${rest.length ? `<div class="insight-more">${rest.slice(0, 3).map((r) => `<div>${icon(r.icon)}<span>${r.href ? `<a href="${r.href}">${escapeHtml(r.title)}</a>` : escapeHtml(r.title)}</span></div>`).join("")}</div>` : ""}`;
}
