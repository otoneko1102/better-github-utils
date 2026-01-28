(async function () {
  "use strict";
  // If no token is set in storage, disable all content-script behavior.
  try {
    const token = await new Promise((resolve) =>
      chrome.storage.sync.get(["github_utils_token"], (items) =>
        resolve(items.github_utils_token || null),
      ),
    );
    if (!token) {
      try {
        console.debug(
          "[gh-utils] content: token missing — content script disabled",
        );
      } catch (e) {}
      return;
    }
  } catch (e) {}

  async function ensure(modPath) {
    try {
      return await import(chrome.runtime.getURL(modPath));
    } catch (e) {
      try {
        console.warn(
          "[gh-utils] ensure import failed",
          modPath,
          e && e.message ? e.message : e,
        );
      } catch (e2) {}
      return null;
    }
  }

  function getCurrentUser() {
    const m = document.querySelector('meta[name="user-login"]');
    return m ? m.content : null;
  }

  try {
    window.addEventListener("unhandledrejection", (ev) => {
      try {
        const r = ev.reason;
        const msg = (r && r.message) || (typeof r === "string" ? r : null);
        if (
          msg &&
          msg.indexOf &&
          msg.indexOf("Extension context invalidated") !== -1
        ) {
          console.warn("[gh-utils] suppressed unhandledrejection:", msg);
          ev.preventDefault && ev.preventDefault();
        }
      } catch (e) {}
    });
  } catch (e) {}
  function getProfileFromPath() {
    const m = location.pathname.match(/^\/([^\/]+)(?:\/.*)?$/);
    if (!m) return null;
    const u = m[1];
    const reserved = [
      "notifications",
      "settings",
      "explore",
      "marketplace",
      "features",
      "pricing",
      "pulls",
      "issues",
    ];
    return reserved.includes(u) ? null : u;
  }
  function isOwnFollowers() {
    try {
      const qs = new URLSearchParams(location.search);
      return (
        qs.get("tab") === "followers" &&
        getCurrentUser() === getProfileFromPath()
      );
    } catch (e) {
      return false;
    }
  }

  function shouldUseBulkChecks() {
    const profile = getProfileFromPath();
    const viewer = getCurrentUser();
    if (!profile || !viewer) return false;
    if (profile && profile !== viewer) return true;
    return false;
  }

  async function handleButton(btn) {
    const dom = await ensure("src/utils/follow/dom.js");
    if (!dom) {
      setTimeout(schedule, 250);
      return;
    }
    const client = await ensure("src/utils/follow/client.js");
    if (!client) {
      setTimeout(schedule, 250);
      return;
    }
    const viewer = getCurrentUser();
    if (!viewer) return;
    const name = dom.extractUsernameFromButton(btn);
    if (!name) return;
    const container =
      btn.closest(".d-table") || btn.closest("li") || btn.closest("div");
    if (isOwnFollowers()) {
      const badge = dom.createBadge("followed", "github-utils-list-badge");
      dom.appendBadgeToChecker(btn, badge);
      return;
    }
    const placeholder = dom.insertPlaceholderInChecker(
      btn,
      "github-utils-list-badge",
    );

    const useBulk = shouldUseBulkChecks();
    let resp = null;
    try {
      if (useBulk) {
        resp = await client.getFollowStatusOnce(viewer, name).catch(() => null);
      } else {
        resp = await new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: "checkFollow", viewer, target: name },
            (r) => {
              if (chrome.runtime.lastError) {
                console.warn(
                  "[gh-utils] checkFollow msg failed",
                  chrome.runtime.lastError,
                );
                resolve(null);
                return;
              }
              resolve(r || null);
            },
          ),
        );
      }
    } catch (e) {
      resp = null;
    }

    if (!resp) {
      dom.replaceWithBadge(placeholder, "unknown", "github-utils-list-badge");
      return;
    }
    const badge = dom.createBadge(
      resp.targetFollowsViewer ? "followed" : "not_followed",
      "github-utils-list-badge",
    );
    if (placeholder && placeholder.replaceWith) placeholder.replaceWith(badge);
    else dom.appendBadgeToChecker(btn, badge);
  }

  function scan(root = document) {
    const buttons = Array.from(
      root.querySelectorAll('input[type="submit"],button'),
    ).filter((b) =>
      /(^|\s)(follow|unfollow)($|\s)/i.test(
        (
          b.title ||
          b.getAttribute("aria-label") ||
          b.value ||
          b.textContent ||
          b.innerText ||
          ""
        ).toLowerCase(),
      ),
    );
    buttons.forEach((b) => {
      try {
        if (b.hidden || b.hasAttribute("hidden") || b.offsetParent === null)
          return;
        const item =
          b.closest(".d-table") || b.closest("li") || b.closest("div");
        if (
          item &&
          item.querySelector(
            ".github-utils-list-badge, .github-utils-follow-badge",
          )
        )
          return;
        handleButton(b);
      } catch (e) {}
    });
  }

  function scanHover(root) {
    const card =
      root.querySelector &&
      (root.querySelector("[data-hovercard-url]") ||
        root.querySelector(".Popover-message") ||
        root);
    if (!card) return;
    const domPath = "src/utils/follow/dom.js";
    ensure(domPath)
      .then(async (dom) => {
        if (!dom) return;
        const anchor = card.querySelector('a[href^="/"]');
        if (!anchor) return;
        const name = anchor
          .getAttribute("href")
          .replace(/^\//, "")
          .replace(/\/$/, "");
        const viewer = getCurrentUser();
        if (!name || name === viewer) return;
        if (
          card.querySelector(
            ".github-utils-hover-badge, .github-utils-list-badge",
          )
        )
          return;
        const followBtn = Array.from(
          card.querySelectorAll('input[type="submit"],button'),
        ).find((b) => {
          try {
            const s = (
              b.getAttribute("aria-label") ||
              b.title ||
              b.textContent ||
              b.innerText ||
              ""
            ).toLowerCase();
            return /(^|\s)(follow|unfollow)($|\s)/i.test(s);
          } catch (e) {
            return false;
          }
        });
        const placeholder = document.createElement("div");
        placeholder.className = "github-utils-hover-badge";
        placeholder.textContent = "...";
        const targetEl =
          followBtn || card.querySelector(".Popover-message") || card;
        if (!targetEl) return;
        if (followBtn) {
          followBtn.insertAdjacentElement("afterend", placeholder);
        } else targetEl.appendChild(placeholder);
        ensure("src/utils/follow/client.js")
          .then(async (client) => {
            if (!client) return;
            const viewer = getCurrentUser();
            const useBulk = (function () {
              const profile = getProfileFromPath();
              return profile && viewer && profile !== viewer;
            })();
            let resp = null;
            try {
              if (useBulk)
                resp = await client.getFollowStatusOnce(viewer, name);
              else
                resp = await new Promise((resolve) =>
                  chrome.runtime.sendMessage(
                    { type: "checkFollow", viewer, target: name },
                    (r) => {
                      if (chrome.runtime.lastError) {
                        console.warn(
                          "[gh-utils] checkFollow msg failed (hover)",
                          chrome.runtime.lastError,
                        );
                        resolve(null);
                        return;
                      }
                      resolve(r || null);
                    },
                  ),
                );
            } catch (e) {
              resp = null;
            }
            if (!resp)
              dom.replaceWithBadge(
                placeholder,
                "unknown",
                "github-utils-hover-badge",
              );
            else
              dom.replaceWithBadge(
                placeholder,
                resp.targetFollowsViewer ? "followed" : "not_followed",
                "github-utils-hover-badge",
              );
          })
          .catch(() => {});
      })
      .catch(() => {});
  }

  let retryTimer = null;
  function schedule() {
    if (retryTimer) clearTimeout(retryTimer);
    let attempt = 0;
    const max = 6;
    const tryRun = () => {
      attempt++;
      try {
        scan(document);
        const pop = document.querySelectorAll(
          "[data-hovercard-url], .Popover-message",
        );
        pop.forEach((p) => scanHover(p));
      } catch (e) {}
      if (
        document.querySelector(
          ".h-card, .vcard, .d-table, .user-following-container",
        ) ||
        attempt >= max
      )
        return;
      retryTimer = setTimeout(tryRun, 100 * Math.pow(2, attempt - 1));
    };
    retryTimer = setTimeout(tryRun, 80);
  }

  let __gh_last_inject_at = 0;
  const mo = new MutationObserver((mutations) => {
    if (location.href !== window.__gh_last_location) {
      try {
        ensure("src/utils/follow/client.js")
          .then((m) => {
            try {
              if (m && m.clearCache) m.clearCache();
            } catch (e) {}
          })
          .catch(() => {});
      } catch (e) {}
      window.__gh_last_location = location.href;
      schedule();
    }

    const now = Date.now();
    if (now - __gh_last_inject_at < 200) return;
    __gh_last_inject_at = now;

    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches && n.matches(".h-card, .vcard, #js-pjax-container")) {
          schedule();
        }
        if (
          n.querySelector &&
          n.querySelector("[data-hovercard-url], .Popover-message")
        ) {
          const popup =
            n.querySelector("[data-hovercard-url]") ||
            n.querySelector(".Popover-message") ||
            n;
          scanHover(popup);
        }
        try {
          const path = location.pathname;
          if (/^\/[^\/]+\/[^\/]+\/settings/.test(path)) {
            if (!document.querySelector(".gh-autocomplete-panel")) {
              (async () => {
                try {
                  console.debug(
                    "[gh-utils] attempting to inject autocomplete panel",
                  );
                  const dom = await import(
                    chrome.runtime.getURL("src/utils/autocomplete/dom.js")
                  );
                  const actions = await import(
                    chrome.runtime.getURL("src/utils/autocomplete/actions.js")
                  );
                  let target = dom.findDangerZone();
                  if (!target) {
                    console.debug(
                      "[gh-utils] findDangerZone returned null, trying fallbacks",
                    );
                    target = document.querySelector(
                      "#options_bucket, .repository-content, main, #repo-content-pjax-container",
                    );
                  }
                  if (target) {
                    console.debug("[gh-utils] injecting panel into", target);
                    const headingContainer =
                      document
                        .querySelector("#danger-zone")
                        ?.closest(".Subhead") ||
                      document.querySelector("#danger-zone")?.parentElement ||
                      target;
                    if (headingContainer) {
                      headingContainer
                        .querySelectorAll(".gh-autocomplete-panel")
                        .forEach((n) => n.remove());
                    }

                    const box = target;
                    if (!box.dataset.ghAutocInjected) {
                      dom.insertInlinePanels();
                      chrome.storage.sync.get(
                        ["github_utils_token"],
                        (items) => {
                          const token = items.github_utils_token;
                          document
                            .querySelectorAll(".gh-autoc-autoexec")
                            .forEach((cb) => {
                              cb.disabled = !token;
                              if (!token)
                                cb.title =
                                  "Auto execute requires a GitHub token (set in extension popup)";
                            });
                        },
                      );
                      box.dataset.ghAutocInjected = "1";
                    } else {
                      console.debug(
                        "[gh-utils] inline panels already injected",
                      );
                    }

                    async function performAutoAction(btn, inline, statusEl) {
                      try {
                        if (inline.dataset.ghAutocHandled) return;
                        inline.dataset.ghAutocHandled = "1";
                        const token = await new Promise((resolve) =>
                          chrome.storage.sync.get(
                            ["github_utils_token"],
                            (items) => resolve(items.github_utils_token),
                          ),
                        );
                        if (!token) {
                          statusEl &&
                            (statusEl.textContent =
                              "Token required for Auto (set it in extension popup)");
                          delete inline.dataset.ghAutocHandled;
                          return;
                        }
                        const repo = dom.getRepoFullName();
                        if (!repo) {
                          statusEl &&
                            (statusEl.textContent =
                              "Cannot determine repository");
                          delete inline.dataset.ghAutocHandled;
                          return;
                        }
                        statusEl &&
                          (statusEl.textContent = "Executing via API...");
                        const act = btn.dataset.action;
                        let apiRes = null;
                        if (act === "archive") {
                          const info = await actions.apiGetRepo(repo, token);
                          const currentlyArchived =
                            info && info.ok && info.json && info.json.archived;
                          const newArchived = !currentlyArchived;
                          apiRes = await actions.apiSetArchived(
                            repo,
                            newArchived,
                            token,
                          );
                          if (apiRes && apiRes.ok) {
                            statusEl &&
                              (statusEl.textContent = newArchived
                                ? "Repository archived via API"
                                : "Repository unarchived via API");
                            try {
                              const pageBtn = dom.findArchiveButton();
                              const newLabel = newArchived
                                ? "Unarchive this repository"
                                : "Archive this repository";
                              if (pageBtn) {
                                const lbl =
                                  pageBtn.querySelector(".Button-label") ||
                                  pageBtn.querySelector(".Button-content") ||
                                  pageBtn;
                                if (lbl) lbl.textContent = newLabel;
                              }
                              if (btn && btn.textContent)
                                btn.textContent = newLabel;
                            } catch (e) {}
                            setTimeout(() => location.reload(), 800);
                          } else
                            statusEl &&
                              (statusEl.textContent = `API failed: ${apiRes?.status || "unknown"}`);
                        } else if (act === "delete") {
                          let confirmInput = inline.querySelector(
                            ".gh-autoc-confirm-delete-input",
                          );
                          if (!confirmInput) {
                            const lbl = document.createElement("label");
                            lbl.className =
                              "gh-autoc-opt gh-autoc-confirm-delete";
                            lbl.innerHTML =
                              '<input type="checkbox" class="gh-autoc-confirm-delete-input"> Confirm auto-delete (required)';
                            inline.appendChild(lbl);
                            statusEl &&
                              (statusEl.textContent =
                                "Please check the Confirm auto-delete box to proceed");
                            delete inline.dataset.ghAutocHandled;
                            return;
                          }
                          if (!confirmInput.checked) {
                            statusEl &&
                              (statusEl.textContent =
                                "Please check the Confirm auto-delete box to proceed");
                            delete inline.dataset.ghAutocHandled;
                            return;
                          }
                          apiRes = await actions.apiDeleteRepo(repo, token);
                          if (apiRes && apiRes.ok) {
                            statusEl &&
                              (statusEl.textContent =
                                "Repository deleted via API");
                            setTimeout(() => location.reload(), 800);
                          } else
                            statusEl &&
                              (statusEl.textContent = `API failed: ${apiRes?.status || "unknown"}`);
                        }
                        setTimeout(
                          () => delete inline.dataset.ghAutocHandled,
                          1500,
                        );
                      } catch (e) {
                        statusEl &&
                          (statusEl.textContent = `API error: ${e.message || e}`);
                        delete inline.dataset.ghAutocHandled;
                      }
                    }

                    Array.from(
                      document.querySelectorAll(".gh-autoc-btn"),
                    ).forEach((btn) => {
                      if (btn.dataset.ghAutocBound) return;
                      btn.dataset.ghAutocBound = "1";

                      ["pointerdown", "mousedown", "touchstart"].forEach(
                        (evName) => {
                          btn.addEventListener(
                            evName,
                            (ev) => {
                              try {
                                ev.preventDefault();
                                ev.stopImmediatePropagation &&
                                  ev.stopImmediatePropagation();
                                ev.stopPropagation();
                              } catch (e) {}
                            },
                            { capture: true },
                          );
                        },
                      );

                      btn.addEventListener(
                        "click",
                        async function captureAutoHandler(ev) {
                          try {
                            const inline = btn.closest(".gh-autoc-inline");
                            ev.preventDefault();
                            ev.stopImmediatePropagation &&
                              ev.stopImmediatePropagation();
                            ev.stopPropagation();
                            const statusEl = inline?.querySelector(
                              ".gh-autoc-inline-status",
                            );
                            const autoOn =
                              inline?.querySelector(".gh-autoc-autoexec")
                                ?.checked || false;
                            if (autoOn) {
                              await performAutoAction(btn, inline, statusEl);
                              return;
                            }

                            statusEl && (statusEl.textContent = "Preparing...");
                            try {
                              let res;
                              const act = btn.dataset.action;
                              if (act === "delete")
                                res = await actions.prepareDelete(
                                  {},
                                  { canceled: false },
                                );
                              else if (act === "archive")
                                res = await actions.prepareArchive(
                                  {},
                                  { canceled: false },
                                );
                              else res = { ok: false, reason: "unknown" };

                              if (res && res.ok)
                                statusEl &&
                                  (statusEl.textContent =
                                    "Prepared — confirm manually.");
                              else
                                statusEl &&
                                  (statusEl.textContent = `Failed: ${res?.reason || "unknown"}`);
                            } catch (e) {
                              statusEl &&
                                (statusEl.textContent = `Error: ${e.message || e}`);
                            }
                          } catch (e) {}
                        },
                        { capture: true },
                      );

                      btn.addEventListener("click", async (ev) => {
                        try {
                          ev.preventDefault();
                          ev.stopPropagation();
                          ev.stopImmediatePropagation &&
                            ev.stopImmediatePropagation();
                        } catch (e) {}
                        const act = btn.dataset.action;
                        const inline = btn.closest(".gh-autoc-inline");

                        if (inline?.dataset.ghAutocHandled) {
                          return;
                        }

                        const autoexec =
                          inline?.querySelector(".gh-autoc-autoexec")
                            ?.checked || false;
                        const statusEl = inline?.querySelector(
                          ".gh-autoc-inline-status",
                        );
                        if (autoexec) {
                          const token = await new Promise((resolve) =>
                            chrome.storage.sync.get(
                              ["github_utils_token"],
                              (items) => resolve(items.github_utils_token),
                            ),
                          );
                          if (!token) {
                            statusEl &&
                              (statusEl.textContent =
                                "Token required for Auto (set it in extension popup)");
                            return;
                          }

                          const repo = dom.getRepoFullName();
                          if (!repo) {
                            statusEl &&
                              (statusEl.textContent =
                                "Cannot determine repository");
                            return;
                          }

                          try {
                            statusEl &&
                              (statusEl.textContent = "Executing via API...");
                            let apiRes = null;

                            if (act === "archive") {
                              apiRes = await actions.apiArchiveRepo(
                                repo,
                                token,
                              );
                              if (apiRes && apiRes.ok) {
                                statusEl &&
                                  (statusEl.textContent =
                                    "Repository archived via API");
                                setTimeout(() => location.reload(), 800);
                              } else
                                statusEl &&
                                  (statusEl.textContent = `API failed: ${apiRes?.status || "unknown"}`);
                            } else if (act === "delete") {
                              let confirmInput = inline.querySelector(
                                ".gh-autoc-confirm-delete-input",
                              );
                              if (!confirmInput) {
                                const lbl = document.createElement("label");
                                lbl.className =
                                  "gh-autoc-opt gh-autoc-confirm-delete";
                                lbl.innerHTML =
                                  '<input type="checkbox" class="gh-autoc-confirm-delete-input"> Confirm auto-delete (required)';
                                inline.appendChild(lbl);
                                statusEl &&
                                  (statusEl.textContent =
                                    "Please check the Confirm auto-delete box to proceed");
                                return;
                              }
                              if (!confirmInput.checked) {
                                statusEl &&
                                  (statusEl.textContent =
                                    "Please check the Confirm auto-delete box to proceed");
                                return;
                              }
                              apiRes = await actions.apiDeleteRepo(repo, token);
                              if (apiRes && apiRes.ok) {
                                statusEl &&
                                  (statusEl.textContent =
                                    "Repository deleted via API");
                                setTimeout(() => location.reload(), 800);
                              } else
                                statusEl &&
                                  (statusEl.textContent = `API failed: ${apiRes?.status || "unknown"}`);
                            } else {
                              statusEl &&
                                (statusEl.textContent = "Unknown action");
                            }
                          } catch (e) {
                            statusEl &&
                              (statusEl.textContent = `API error: ${e.message || e}`);
                          }

                          return;
                        }

                        const signal = { canceled: false };
                        const options = {
                          autoEnable: true,
                          autoClick: false,
                          countdown: 3,
                        };

                        statusEl && (statusEl.textContent = "Preparing...");
                        try {
                          let res;
                          if (act === "delete")
                            res = await actions.prepareDelete(options, signal);
                          else if (act === "archive")
                            res = await actions.prepareArchive(options, signal);
                          else res = { ok: false, reason: "unknown" };

                          if (res && res.ok) {
                            statusEl &&
                              (statusEl.textContent =
                                "Prepared — confirm manually.");
                          } else {
                            statusEl &&
                              (statusEl.textContent = `Failed: ${res?.reason || "unknown"}`);
                          }
                        } catch (e) {
                          statusEl &&
                            (statusEl.textContent = `Error: ${e.message || e}`);
                        }
                      });
                    });
                  } else {
                    console.debug(
                      "[gh-utils] failed to find a target to inject panel",
                    );
                  }
                } catch (e) {
                  console.warn(
                    "[gh-utils] error injecting autocomplete panel:",
                    e,
                  );
                }
              })();
            }
          }
        } catch (e) {}
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (!changes || !changes.github_utils_token) return;
      const token = changes.github_utils_token.newValue;
      document.querySelectorAll(".gh-autoc-autoexec").forEach((cb) => {
        cb.disabled = !token;
        if (!token)
          cb.title =
            "Auto execute requires a GitHub token (set in extension popup)";
        else cb.title = "";
      });
    });
  }

  function isFollowButtonElement(el) {
    try {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (!/input|button/i.test(el.tagName)) return false;
      const s =
        (el.getAttribute && (el.getAttribute("aria-label") || el.title)) ||
        el.value ||
        el.textContent ||
        el.innerText ||
        "";
      return /(^|\s)(follow|unfollow)($|\s)/i.test(s);
    } catch (e) {
      return false;
    }
  }

  function rescanContainer(container, maxAttempts = 4) {
    let attempt = 0;
    const tryRun = () => {
      attempt++;
      try {
        scan(container || document);
      } catch (e) {}
      if (attempt < maxAttempts) setTimeout(tryRun, 150 * attempt);
    };
    setTimeout(tryRun, 120);

    try {
      const el =
        container && container instanceof HTMLElement ? container : document;
      const obs = new MutationObserver((mutations) => {
        try {
          if (
            el.querySelector &&
            el.querySelector(
              ".github-utils-list-badge, .github-utils-follow-badge",
            )
          ) {
            obs.disconnect();
            return;
          }
          if (
            el.querySelector &&
            Array.from(el.querySelectorAll('input[type="submit"],button')).some(
              isFollowButtonElement,
            )
          ) {
            try {
              scan(el);
            } catch (e) {}
          }
        } catch (e) {}
      });
      obs.observe(el, { childList: true, subtree: true });
      setTimeout(
        () => {
          try {
            obs.disconnect();
          } catch (e) {}
        },
        Math.max(2000, maxAttempts * 150 * 2),
      );
    } catch (e) {}
  }

  async function attemptQuickBadgeUpdate(btn, container) {
    try {
      const dom = await ensure("src/utils/follow/dom.js");
      const client = await ensure("src/utils/follow/client.js");
      if (!dom || !client) return false;
      const viewer = getCurrentUser();
      if (!viewer) return false;
      const name = dom.extractUsernameFromButton(btn);
      if (!name) return false;
      const item =
        btn.closest(".d-table") || btn.closest("li") || btn.closest("div");
      if (
        item &&
        item.querySelector &&
        item.querySelector(
          ".github-utils-list-badge, .github-utils-follow-badge",
        )
      )
        return true;

      if (isOwnFollowers()) {
        const b = dom.createBadge("followed", "github-utils-list-badge");
        dom.appendBadgeToChecker(btn, b);
        return true;
      }

      try {
        const cached = client.getCachedFollowStatus
          ? client.getCachedFollowStatus(viewer, name)
          : undefined;
        if (typeof cached !== "undefined") {
          const status =
            cached === null
              ? "unknown"
              : cached.targetFollowsViewer
                ? "followed"
                : "not_followed";
          console.debug("[gh-utils] attemptQuickBadgeUpdate: using cache", {
            viewer,
            name,
            status,
          });
          const badge = dom.createBadge(status, "github-utils-list-badge");
          dom.appendBadgeToChecker(btn, badge);
          return true;
        }
      } catch (e) {}

      return false;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener(
    "click",
    (ev) => {
      try {
        const target = ev.target;
        const btn =
          target && target.closest
            ? target.closest('input[type="submit"],button')
            : null;
        if (!btn) return;
        if (!isFollowButtonElement(btn)) return;
        const container =
          btn.closest(".d-table") ||
          btn.closest("li") ||
          btn.closest("div") ||
          document;
        attemptQuickBadgeUpdate(btn, container).catch(() => {});
        setTimeout(() => rescanContainer(container), 200);
      } catch (e) {}
    },
    true,
  );

  document.addEventListener(
    "submit",
    (ev) => {
      try {
        const form = ev.target;
        if (!form) return;
        const submitBtn = form.querySelector('input[type="submit"],button');
        if (!submitBtn || !isFollowButtonElement(submitBtn)) return;
        const container =
          submitBtn.closest(".d-table") ||
          submitBtn.closest("li") ||
          submitBtn.closest("div") ||
          document;
        attemptQuickBadgeUpdate(submitBtn, container).catch(() => {});
        setTimeout(() => rescanContainer(container), 250);
      } catch (e) {}
    },
    true,
  );

  try {
    window.addEventListener("pjax:end", () => schedule());
    document.addEventListener("turbo:frame-load", () => schedule());
  } catch (e) {}

  schedule();
  document
    .querySelectorAll("[data-hovercard-url], .Popover-message")
    .forEach((p) => scanHover(p));
})();
