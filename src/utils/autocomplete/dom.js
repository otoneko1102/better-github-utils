export function getRepoFullName() {
  const m = location.pathname.match(/^\/([^\/]+)\/([^\/]+)(?:\/.*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function findDangerZone() {
  const heading = document.querySelector(
    "#danger-zone, h2#danger-zone, h3#danger-zone",
  );
  if (heading) {
    const next = heading.nextElementSibling;
    if (
      next &&
      next.classList &&
      (next.classList.contains("Box") ||
        /color-border-danger/.test(next.className))
    )
      return next;
    return heading;
  }

  let el = document.querySelector(
    ".Box.color-border-danger, .Box--danger, .Box[color-border-danger], .Box--danger",
  );
  if (el) return el;

  el = document.querySelector(
    'form[action*="/settings/delete"], form[action*="/settings/archive"]',
  );
  if (el) return el.closest(".Box") || el.parentElement || el;

  const headings = Array.from(document.querySelectorAll("h1,h2,h3,summary"));
  for (const h of headings)
    if (/danger/i.test(h.textContent || ""))
      return h.closest(".Box") || h.parentElement || h;

  return (
    document.querySelector(
      ".repository-content, #repo-content-pjax-container",
    ) || null
  );
}

export function createPanel() {
  const panel = document.createElement("div");
  panel.className = "gh-autocomplete-panel";
  panel.innerHTML = `
    <div class="gh-autocomplete-header">Automation (experimental)</div>
    <div class="gh-autocomplete-body">
      <button class="gh-autoc-btn" data-action="archive">Auto complete</button>
      <button class="gh-autoc-btn" data-action="delete">Auto complete</button>
      <div class="gh-autoc-note">These actions will pre-fill confirmation inputs and highlight the final confirm button. They will not submit automatically.</div>
    </div>
  `;
  return panel;
}

export function findDangerItems() {
  const items = { visibility: null, archive: null, delete: null };

  const lis = Array.from(
    document.querySelectorAll(
      ".Box.color-border-danger ul > li, .Box.color-border-danger li",
    ),
  ).filter((li) => {
    if (li.closest("template")) return false;
    try {
      if (li.offsetParent === null) return false;
    } catch (e) {}
    return true;
  });
  for (const li of lis) {
    const strong = li.querySelector("strong")?.textContent || "";
    const text = (strong || li.textContent || "").trim();
    if (!items.visibility && /Change repository visibility/i.test(text))
      items.visibility = li;
    if (!items.archive && /Archive this repository/i.test(text))
      items.archive = li;
    if (!items.delete && /Delete this repository/i.test(text))
      items.delete = li;
  }
  return items;
}

export function createInlinePanel(action) {
  const wrap = document.createElement("div");
  wrap.className = "gh-autoc-inline gh-autocomplete-inline-panel";

  const label = "Auto complete";
  wrap.innerHTML = `
    <div class="gh-autoc-inline-row">
      <button class="gh-autoc-btn" data-action="${action}">${label}</button>
      <label class="gh-autoc-opt"><input type="checkbox" class="gh-autoc-autoexec" data-action="${action}"> Auto (API)</label>
    </div>
    <div class="gh-autoc-inline-status" aria-live="polite"></div>
  `;
  return wrap;
}

export function insertInlinePanels() {
  const items = findDangerItems();
  const inserted = [];
  for (const [action, li] of Object.entries(items)) {
    if (!li) continue;
    if (action === "visibility") continue;
    if (li.querySelector(".gh-autoc-inline")) continue;
    const anchor =
      li.querySelector(".flex-auto, .flex-1") || li.querySelector("div") || li;
    const panel = createInlinePanel(action);
    try {
      anchor.parentElement.insertBefore(
        panel,
        anchor.nextElementSibling || anchor.nextSibling,
      );
      inserted.push(panel);
    } catch (e) {
      try {
        li.appendChild(panel);
        inserted.push(panel);
      } catch (e2) {}
    }
  }
  return inserted;
}

export function insertPanel(target, panel) {
  if (!target || !panel) return false;
  try {
    if (
      (target.tagName && /^H[1-6]$/.test(target.tagName)) ||
      target.id === "danger-zone" ||
      (target.classList && target.classList.contains("Subhead-heading"))
    ) {
      console.debug("[gh-utils] inserting panel after heading target");
      target.parentElement.insertBefore(
        panel,
        target.nextElementSibling || target.nextSibling,
      );
      return true;
    }

    if (
      target.classList &&
      (target.classList.contains("Box") ||
        /color-border-danger/.test(target.className) ||
        /Box/.test(target.className))
    ) {
      console.debug("[gh-utils] inserting panel at top of Box target");
      target.insertBefore(panel, target.firstChild);
      return true;
    }

    const hd = document.querySelector("#danger-zone");
    if (hd && hd.parentElement) {
      console.debug("[gh-utils] fallback: inserting after #danger-zone");
      hd.parentElement.insertBefore(
        panel,
        hd.nextElementSibling || hd.nextSibling,
      );
      return true;
    }

    console.debug("[gh-utils] fallback: prepending to target");
    target.prepend(panel);
    return true;
  } catch (e) {
    console.warn("[gh-utils] insertPanel error", e);
    try {
      target.prepend(panel);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

export function highlight(el) {
  if (!el) return;
  el.style.boxShadow = "0 0 0 3px rgba(255,165,0,0.15)";
  el.style.transition = "box-shadow 0.2s ease-in-out";
}

export function findDeleteInput() {
  return (
    document.querySelector(
      'input[aria-label="Type the name of the repository to confirm"], input[name="verify"], input[placeholder*="owner/repo"]',
    ) ||
    document
      .querySelector('input[type="text"]')
      .closest("form")
      ?.querySelector('input[type="text"]')
  );
}

export function findDeleteConfirmButton() {
  return (
    Array.from(document.querySelectorAll('button, input[type="submit"]')).find(
      (b) => /delete this repository/i.test(b.textContent || b.value || ""),
    ) || null
  );
}

export function findArchiveButton() {
  return (
    Array.from(document.querySelectorAll("button")).find((b) =>
      /archive this repository/i.test(b.textContent || ""),
    ) || null
  );
}

export function findArchiveConfirmButton() {
  return (
    Array.from(document.querySelectorAll("button")).find(
      (b) =>
        /archive repository/i.test(b.textContent || "") ||
        /I understand the consequences.*archive/i.test(b.textContent || ""),
    ) || null
  );
}

export function findVisibilityForm() {
  let form = document.querySelector(
    'form[action*="/settings/access"], form[action*="/settings/collaboration"], form:has(input[type="radio"])',
  );
  if (form) return form;

  const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
  for (const r of radios) {
    try {
      const label =
        (r.labels &&
          Array.from(r.labels)
            .map((l) => l.textContent)
            .join(" ")) ||
        r.closest("label")?.textContent ||
        r.nextSibling?.textContent ||
        r.getAttribute("aria-label") ||
        "";
      if (/private|public/i.test(label))
        return (
          r.closest("form") ||
          r.closest('[role="dialog"]') ||
          r.closest(".Overlay") ||
          r.closest(".Box") ||
          r.parentElement
        );
    } catch (e) {}
  }

  const visBtns = document.querySelectorAll(
    '[data-new-visibility], button[id^="repo-visibility-proceed-button"]',
  );
  if (visBtns && visBtns.length) {
    const b = visBtns[0];
    return (
      b.closest("form") ||
      b.closest('[role="dialog"]') ||
      b.closest(".Overlay") ||
      b.parentElement ||
      null
    );
  }

  return null;
}

export function findVisibilityRadios(form) {
  if (!form) return null;
  const radios = Array.from(form.querySelectorAll('input[type="radio"]')) || [];
  let makePrivate = null;
  let makePublic = null;

  for (const r of radios) {
    let label = "";
    try {
      if (r.labels && r.labels.length)
        label = Array.from(r.labels)
          .map((l) => l.textContent)
          .join(" ");
      else
        label =
          r.closest("label")?.textContent ||
          r.nextSibling?.textContent ||
          r.getAttribute("aria-label") ||
          "";
    } catch (e) {
      label = r.getAttribute("aria-label") || "";
    }
    if (/private/i.test(label) && !makePrivate) makePrivate = r;
    if (/public/i.test(label) && !makePublic) makePublic = r;
  }

  if (makePrivate || makePublic) {
    const mpChecked = makePrivate ? !!makePrivate.checked : false;
    const mpubChecked = makePublic ? !!makePublic.checked : false;
    return {
      makePrivate: makePrivate ? makePrivate : { checked: mpChecked },
      makePublic: makePublic ? makePublic : { checked: mpubChecked },
    };
  }

  const hidden = form.querySelector(
    'input[name="visibility"][type="hidden"], input[type="hidden"][name="visibility"]',
  );
  if (hidden) {
    const val = (hidden.value || "").toLowerCase();
    return {
      makePrivate: { checked: val === "private" },
      makePublic: { checked: val === "public" },
    };
  }

  const btnPrivate = form.querySelector(
    '[data-new-visibility="private"], button[data-new-visibility="private"]',
  );
  const btnPublic = form.querySelector(
    '[data-new-visibility="public"], button[data-new-visibility="public"]',
  );
  if (btnPrivate || btnPublic) {
    const pChecked = btnPrivate
      ? btnPrivate.getAttribute("aria-pressed") === "true" ||
        btnPrivate.getAttribute("aria-checked") === "true" ||
        btnPrivate.classList.contains("selected") ||
        btnPrivate.classList.contains("is-selected") ||
        btnPrivate.dataset.selected === "true"
      : false;
    const pubChecked = btnPublic
      ? btnPublic.getAttribute("aria-pressed") === "true" ||
        btnPublic.getAttribute("aria-checked") === "true" ||
        btnPublic.classList.contains("selected") ||
        btnPublic.classList.contains("is-selected") ||
        btnPublic.dataset.selected === "true"
      : false;
    return {
      makePrivate: { checked: !!pChecked },
      makePublic: { checked: !!pubChecked },
    };
  }

  const txt = (form.textContent || "").toLowerCase();
  if (
    txt.includes("currently private") ||
    txt.includes("this repository is currently private")
  )
    return { makePrivate: { checked: true }, makePublic: { checked: false } };
  if (
    txt.includes("currently public") ||
    txt.includes("this repository is currently public")
  )
    return { makePrivate: { checked: false }, makePublic: { checked: true } };

  const docHidden = document.querySelector(
    'input[name="visibility"][type="hidden"]',
  );
  if (docHidden) {
    const v = (docHidden.value || "").toLowerCase();
    return {
      makePrivate: { checked: v === "private" },
      makePublic: { checked: v === "public" },
    };
  }

  return {
    makePrivate: makePrivate ? makePrivate : { checked: false },
    makePublic: makePublic ? makePublic : { checked: false },
  };

  const allRadios = Array.from(
    document.querySelectorAll('input[type="radio"]'),
  );
  for (const r of allRadios) {
    try {
      const lab =
        (r.labels &&
          Array.from(r.labels)
            .map((l) => l.textContent)
            .join(" ")) ||
        r.closest("label")?.textContent ||
        r.nextSibling?.textContent ||
        r.getAttribute("aria-label") ||
        "";
      if (/private/i.test(lab) && r.checked)
        return {
          makePrivate: { checked: true },
          makePublic: { checked: false },
        };
      if (/public/i.test(lab) && r.checked)
        return {
          makePrivate: { checked: false },
          makePublic: { checked: true },
        };
    } catch (e) {}
  }

  console.debug("[gh-utils] findVisibilityRadios: no radios found");
  return { makePrivate: { checked: false }, makePublic: { checked: false } };
}
