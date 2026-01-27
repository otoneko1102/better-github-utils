import * as dom from "./dom.js";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiRequest(path, method = "GET", token, body = null) {
  if (!token) throw new Error("no_token");
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `token ${token}`,
  };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const txt = await res.text();
  let json = null;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch (e) {}
  return { ok: res.ok, status: res.status, json, text: txt };
}

export async function apiDeleteRepo(repoFullName, token) {
  return await apiRequest(`/repos/${repoFullName}`, "DELETE", token);
}

export async function apiArchiveRepo(repoFullName, token) {
  return await apiRequest(`/repos/${repoFullName}`, "PATCH", token, {
    archived: true,
  });
}

export async function apiSetArchived(repoFullName, archived, token) {
  return await apiRequest(`/repos/${repoFullName}`, "PATCH", token, {
    archived: !!archived,
  });
}

export async function apiGetRepo(repoFullName, token) {
  return await apiRequest(`/repos/${repoFullName}`, "GET", token);
}

export async function prepareDelete(
  options = { autoEnable: false, autoClick: false, countdown: 3 },
  signal = { canceled: false },
) {
  const repo = dom.getRepoFullName();
  if (!repo) return { ok: false, reason: "not_repo" };
  const input = dom.findDeleteInput();
  const confirmBtn = dom.findDeleteConfirmButton();
  if (!input || !confirmBtn) return { ok: false, reason: "not_found" };
  input.value = repo;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (options.autoEnable) {
    try {
      confirmBtn.removeAttribute("disabled");
      confirmBtn.disabled = false;
    } catch (e) {}
  }
  dom.highlight(confirmBtn);

  if (options.autoClick) {
    const cd = options.countdown || 3;
    for (let i = cd; i > 0; i--) {
      if (signal.canceled) return { ok: true, info: "canceled" };
      await wait(1000);
    }
    if (signal.canceled) return { ok: true, info: "canceled" };
    try {
      confirmBtn.click();
      return { ok: true, info: "clicked", target: confirmBtn };
    } catch (e) {
      return { ok: false, reason: "click_failed" };
    }
  }

  return { ok: true, info: "prepared", target: confirmBtn };
}

export async function prepareArchive(
  options = { autoEnable: false, autoClick: false, countdown: 3 },
  signal = { canceled: false },
) {
  const btn = dom.findArchiveButton();
  if (!btn) return { ok: false, reason: "no_archive_button" };
  let confirm = dom.findArchiveConfirmButton();
  if (!confirm) {
    if (options.openDialog) {
      try {
        btn.click();
      } catch (e) {}
      await wait(300);
      confirm = dom.findArchiveConfirmButton();
    }
  }
  if (!confirm) return { ok: false, reason: "no_confirm" };
  if (options.autoEnable) {
    try {
      confirm.removeAttribute("disabled");
      confirm.disabled = false;
    } catch (e) {}
  }
  dom.highlight(confirm);

  if (options.autoClick) {
    const cd = options.countdown || 3;
    for (let i = cd; i > 0; i--) {
      if (signal.canceled) return { ok: true, info: "canceled" };
      await wait(1000);
    }
    if (signal.canceled) return { ok: true, info: "canceled" };
    try {
      confirm.click();
      return { ok: true, info: "clicked", target: confirm };
    } catch (e) {
      return { ok: false, reason: "click_failed" };
    }
  }

  return { ok: true, info: "prepared", target: confirm };
}
