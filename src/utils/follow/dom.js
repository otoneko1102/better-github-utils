export function createBadge(statusKey, cls = "github-utils-follow-badge") {
  const LABELS = {
    followed: "Followed you",
    not_followed: "Not followed you",
    unknown: "Status unavailable",
  };
  const el = document.createElement("span");
  el.className = cls;
  el.dataset.status = statusKey;
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", LABELS[statusKey] || statusKey);
  el.textContent = LABELS[statusKey] || statusKey;
  return el;
}

export function getOrCreateCheckerContainer(btn) {
  try {
    const row =
      btn.closest(".d-table") || btn.closest("li") || btn.closest("div");
    if (!row) return null;

    let cell = row.querySelector(".user-following-container");
    if (!cell) {
      const cells = row.querySelectorAll(".d-table-cell");
      cell = cells && cells.length ? cells[cells.length - 1] : row;
    }
    if (!cell) return null;
    let root = cell.querySelector(".github-utils-checker");
    if (!root) {
      root = document.createElement("div");
      root.className = "github-utils-checker";
      root.style.display = "inline-block";
      root.style.marginLeft = "8px";

      cell.appendChild(root);
    }
    return root;
  } catch (e) {
    return null;
  }
}

export function insertPlaceholderInChecker(
  btn,
  className = "github-utils-list-badge",
) {
  const root = getOrCreateCheckerContainer(btn);
  const p = document.createElement("span");
  p.className = className;
  p.textContent = "...";
  if (root) root.appendChild(p);
  return p;
}

export function appendBadgeToChecker(btn, badge) {
  const root = getOrCreateCheckerContainer(btn);
  if (root) root.appendChild(badge);
  return badge;
}

export function replaceWithBadge(el, statusKey, cls) {
  const b = createBadge(statusKey, cls);
  if (!el) return b;
  el.replaceWith(b);
  return b;
}

export function extractUsernameFromButton(btn) {
  const title = (
    btn.getAttribute("title") ||
    btn.getAttribute("aria-label") ||
    btn.value ||
    btn.textContent ||
    btn.innerText ||
    ""
  ).trim();
  let m = title.match(/Follow\s+(.*)|Unfollow\s+(.*)/i);
  if (m) return (m[1] || m[2]).trim();
  const form = btn.closest("form");
  if (form)
    try {
      const action = form.getAttribute("action") || form.action || "";
      const q = action.split("?")[1] || "";
      const p = new URLSearchParams(q);
      if (p.get("target")) return p.get("target");
    } catch (e) {}
  const anchor = btn.closest("div")?.querySelector('a[href^="/"]');
  if (anchor)
    return anchor.getAttribute("href").replace(/^\//, "").replace(/\/$/, "");
  return null;
}
