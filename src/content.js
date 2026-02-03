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
  // Reserved paths that are not user accounts
  const IGNORED_PATHS = [
    // Navigation & features
    "notifications",
    "settings",
    "explore",
    "marketplace",
    "features",
    "pricing",
    "pulls",
    "issues",
    "codespaces",
    "copilot",
    // Account & auth
    "account",
    "login",
    "logout",
    "signup",
    "join",
    "sessions",
    "password_reset",
    // Sponsorship & billing
    "sponsors",
    "sponsorships",
    "billing",
    // Resources & docs
    "about",
    "security",
    "enterprise",
    "team",
    "customer-stories",
    "readme",
    "resources",
    "events",
    "collections",
    "topics",
    "trending",
    "search",
    // Orgs & special pages
    "orgs",
    "organizations",
    "new",
    "apps",
    "integrations",
    "site",
    "contact",
    "support",
    "status",
    "education",
  ];

  function getProfileFromPath() {
    const m = location.pathname.match(/^\/([^\/]+)(?:\/.*)?$/);
    if (!m) return null;
    const u = m[1];
    return IGNORED_PATHS.includes(u.toLowerCase()) ? null : u;
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
        // scope the duplicate check to the button's own row/container so multiple users in the same broader item can each get badges
        const row =
          b.closest(".d-table") || b.closest("li") || b.closest("div");
        if (
          row &&
          row.querySelector(
            ".github-utils-list-badge, .github-utils-follow-badge",
          )
        )
          return;
        handleButton(b);
      } catch (e) {}
    });
  }

  function scanFeed(root = document) {
    try {
      const viewer = getCurrentUser();
      if (!viewer) return;

      // process per feed item/article to avoid cross-binding badges
      const items = Array.from(
        root.querySelectorAll(
          "article, .js-feed-item-component, .news, .TimelineItem, .js-timeline-item, .news-item",
        ),
      );

      items.forEach((item) => {
        try {
          // track usernames we've already added badges for in this article
          const namesSeen = new Set();

          // detect event type early (used to special-case STARRED_REPOSITORY)
          const hv = item.getAttribute && item.getAttribute("data-hydro-view");
          const isFollowEvent = hv && hv.indexOf('"card_type":"FOLLOW"') !== -1;
          const isStarredEvent =
            hv && hv.indexOf('"card_type":"STARRED_REPOSITORY"') !== -1;
          const isTrendingEvent =
            hv && hv.indexOf('"card_type":"TRENDING_REPOSITORY"') !== -1;
          const isRecommendationEvent =
            hv && hv.indexOf('"card_type":"REPOSITORY_RECOMMENDATION"') !== -1;
          const isAddedToListEvent =
            hv && hv.indexOf('"card_type":"ADDED_TO_LIST"') !== -1;
          // Sponsor-related cards (e.g. NEAR_SPONSORS_GOAL) should not show badges
          const isSponsorEvent = hv && hv.indexOf("SPONSOR") !== -1;
          if (isSponsorEvent) return;

          // collect all anchors and identify repo links (owner/repo)
          const allAnchors = Array.from(
            (item.querySelectorAll && item.querySelectorAll('a[href^="/"]')) ||
              [],
          );
          if (!allAnchors.length) return;
          const repoAnchors = allAnchors.filter((a) => {
            try {
              const n = (a.getAttribute("href") || "")
                .replace(/^\//, "")
                .replace(/\/$/, "");
              return n.indexOf("/") !== -1;
            } catch (e) {
              return false;
            }
          });

          // consolidate existing badges in this article: keep one badge per username and remove duplicates
          try {
            // helper: attempt to find the closest username anchor for a badge element
            const findClosestAnchorName = (el) => {
              try {
                const isValidAnchor = (a) => {
                  const href = (a.getAttribute("href") || "")
                    .replace(/^\//, "")
                    .replace(/\/$/, "");
                  return href && href.indexOf("/") === -1;
                };

                // scan previous siblings for anchors
                let prev = el.previousElementSibling;
                for (
                  let i = 0;
                  prev && i < 8;
                  i++, prev = prev.previousElementSibling
                ) {
                  try {
                    if (
                      prev.matches &&
                      prev.matches('a[href^="/"]') &&
                      isValidAnchor(prev)
                    )
                      return (prev.getAttribute("href") || "")
                        .replace(/^\//, "")
                        .replace(/\/$/, "");
                    const inner =
                      prev.querySelector && prev.querySelector('a[href^="/"]');
                    if (inner && isValidAnchor(inner))
                      return (inner.getAttribute("href") || "")
                        .replace(/^\//, "")
                        .replace(/\/$/, "");
                  } catch (e) {}
                }

                // search up the ancestor chain for anchors in local containers
                let anc = el;
                for (let i = 0; anc && i < 8; i++) {
                  anc = anc.parentElement;
                  if (!anc) break;
                  try {
                    const a =
                      anc.querySelector && anc.querySelector('a[href^="/"]');
                    if (a && isValidAnchor(a))
                      return (a.getAttribute("href") || "")
                        .replace(/^\//, "")
                        .replace(/\/$/, "");
                  } catch (e) {}
                }

                // fallback: choose the nearest anchor in the article by bounding rect distance
                const anchors = Array.from(
                  item.querySelectorAll('a[href^="/"]'),
                ).filter((a) => {
                  try {
                    return isValidAnchor(a);
                  } catch (e) {
                    return false;
                  }
                });
                if (!anchors.length) return null;
                const elRect = el.getBoundingClientRect
                  ? el.getBoundingClientRect()
                  : { top: 0, left: 0 };
                let best = null;
                let bestDist = Number.MAX_VALUE;
                anchors.forEach((a) => {
                  try {
                    const r = a.getBoundingClientRect();
                    const dist =
                      Math.abs(r.top - elRect.top) +
                      Math.abs(r.left - elRect.left);
                    if (dist < bestDist) {
                      bestDist = dist;
                      best = a;
                    }
                  } catch (e) {}
                });
                if (best)
                  return (best.getAttribute("href") || "")
                    .replace(/^\//, "")
                    .replace(/\/$/, "");
              } catch (e) {}
              return null;
            };

            // helper: if badge sits inside a form or user-following container, derive username from the form or button
            const getNameFromFormOrButton = (el) => {
              try {
                const f =
                  el.closest("form") ||
                  el.closest(".user-following-container") ||
                  el.closest("div");
                if (!f) return null;
                // try action target
                try {
                  const action =
                    (f.getAttribute &&
                      (f.getAttribute("action") || f.action || "")) ||
                    "";
                  const q = action.split("?")[1] || "";
                  const p = new URLSearchParams(q);
                  if (p.get("target")) return p.get("target");
                } catch (e) {}
                // look for follow button in the same form/container
                try {
                  const btns = Array.from(
                    (f.querySelectorAll &&
                      f.querySelectorAll('input[type="submit"],button')) ||
                      [],
                  );
                  for (const b of btns) {
                    try {
                      const s = (
                        b.getAttribute("aria-label") ||
                        b.title ||
                        b.value ||
                        b.textContent ||
                        b.innerText ||
                        ""
                      ).trim();
                      let m = s.match(/Follow\s+(.*)|Unfollow\s+(.*)/i);
                      if (m) return (m[1] || m[2]).trim();
                    } catch (e) {}
                  }
                } catch (e) {}
                // fallback: anchor inside the form/container
                try {
                  const a = f.querySelector && f.querySelector('a[href^="/"]');
                  if (a)
                    return (a.getAttribute("href") || "")
                      .replace(/^\//, "")
                      .replace(/\/$/, "");
                } catch (e) {}
              } catch (e) {}
              return null;
            };

            const existingBadges = Array.from(
              item.querySelectorAll(
                ".github-utils-list-badge, .github-utils-follow-badge",
              ),
            );
            const kept = new Set();

            // Move any badges that live inside forms or follow button containers into the persistent checker container
            try {
              ensure("src/utils/follow/dom.js")
                .then((dom) => {
                  try {
                    existingBadges.forEach((b) => {
                      try {
                        const form =
                          b.closest("form") ||
                          b.closest(".user-following-container");
                        if (!form) return;
                        // find the follow/unfollow button in this form
                        const followBtn = Array.from(
                          (form.querySelectorAll &&
                            form.querySelectorAll(
                              'input[type="submit"],button',
                            )) ||
                            [],
                        ).find((bn) => {
                          try {
                            const s = (
                              bn.getAttribute("aria-label") ||
                              bn.title ||
                              bn.textContent ||
                              bn.innerText ||
                              ""
                            ).toLowerCase();
                            return /(^|\s)(follow|unfollow)($|\s)/i.test(s);
                          } catch (e) {
                            return false;
                          }
                        });
                        if (followBtn) {
                          try {
                            dom.appendBadgeToChecker(followBtn, b);
                          } catch (e) {}
                        }
                      } catch (e) {}
                    });
                  } catch (e) {}
                })
                .catch(() => {});
            } catch (e) {}

            existingBadges.forEach((b) => {
              try {
                let name = b.dataset.ghName || null;
                const prev = b.previousElementSibling;
                if (!name) {
                  if (prev && prev.matches && prev.matches('a[href^="/"]')) {
                    name = (prev.getAttribute("href") || "")
                      .replace(/^\//, "")
                      .replace(/\/$/, "");
                  } else if (b.parentElement) {
                    const anchors =
                      Array.from(
                        b.parentElement.querySelectorAll('a[href^="/"]'),
                      ) || [];
                    if (anchors.length)
                      name = (anchors[0].getAttribute("href") || "")
                        .replace(/^\//, "")
                        .replace(/\/$/, "");
                  }
                }

                // try deriving name from nearby form/button if still missing
                if (!name) name = getNameFromFormOrButton(b);

                // attempt to find a nearby anchor if we still don't have a name
                if (!name) name = findClosestAnchorName(b);
                if (!name) return;

                // If this is a repository-type card that shows a repo (starred/trending/recommended/added-to-list) and this badge appears
                // to be attached to the repository's owner area, remove it (we don't want badges for the owner in these cards).
                if (
                  (isStarredEvent ||
                    isTrendingEvent ||
                    isRecommendationEvent ||
                    isAddedToListEvent) &&
                  repoAnchors.length
                ) {
                  const ownerAnchor =
                    prev && prev.matches && prev.matches('a[href^="/"]')
                      ? prev
                      : (b.parentElement &&
                          b.parentElement.querySelector('a[href^="/"]')) ||
                        null;
                  if (ownerAnchor) {
                    const isOwnerNearRepo = repoAnchors.some((ra) => {
                      try {
                        return (
                          ra.closest("section") ===
                            ownerAnchor.closest("section") ||
                          ra.closest("div") === ownerAnchor.closest("div") ||
                          ra.parentElement === ownerAnchor.parentElement ||
                          ra.closest(".color-bg-subtle") ===
                            ownerAnchor.closest(".color-bg-subtle")
                        );
                      } catch (e) {
                        return false;
                      }
                    });
                    if (isOwnerNearRepo) {
                      try {
                        b.remove();
                      } catch (e) {}
                      return;
                    }
                  }
                }

                if (kept.has(name)) {
                  try {
                    b.remove();
                  } catch (e) {}
                } else {
                  kept.add(name);
                  namesSeen.add(name);
                  try {
                    b.dataset.ghName = name;
                  } catch (e) {}
                }
              } catch (e) {}
            });
          } catch (e) {}

          // determine if this feed item is a FOLLOW card (already detected above)

          // header anchor (top actor) - for follow and ADDED_TO_LIST events, show a badge for the actor
          let headerAnchor = null;
          if (isFollowEvent || isAddedToListEvent) {
            try {
              headerAnchor = item.querySelector('header a[href^="/"]');
            } catch (e) {}
            if (headerAnchor) {
              const headerName = (headerAnchor.getAttribute("href") || "")
                .replace(/^\//, "")
                .replace(/\/$/, "");
              // skip invalid names / viewer / already-handled usernames
              if (
                !headerName ||
                headerName === viewer ||
                namesSeen.has(headerName)
              ) {
                // nothing to do here
              } else {
                // if a badge for this name already exists elsewhere in the article, mark handled and skip
                try {
                  if (
                    item.querySelector(
                      '.github-utils-list-badge[data-gh-name="' +
                        headerName +
                        '"] , .github-utils-follow-badge[data-gh-name="' +
                        headerName +
                        '"]',
                    )
                  ) {
                    namesSeen.add(headerName);
                  } else {
                    // ensure not already present immediately adjacent
                    const next = headerAnchor.nextElementSibling;
                    if (
                      !(
                        next &&
                        next.classList &&
                        (next.classList.contains("github-utils-list-badge") ||
                          next.classList.contains("github-utils-follow-badge"))
                      )
                    ) {
                      const placeholder = document.createElement("span");
                      placeholder.className = "github-utils-list-badge";
                      placeholder.textContent = "...";
                      placeholder.dataset.ghName = headerName;
                      // Prefer placing the badge to the left of the action button/menu if present; otherwise fall back to name-side inline
                      try {
                        const header =
                          headerAnchor.closest("header") ||
                          headerAnchor.parentElement;
                        const actionBtn =
                          header &&
                          header.querySelector(
                            ".feed-item-heading-menu-button, button[aria-haspopup], .user-following-container, .github-utils-checker",
                          );
                        if (actionBtn) {
                          try {
                            placeholder.style.display = "inline-block";
                            placeholder.style.marginRight = "6px";
                            placeholder.style.marginTop = "0";
                            actionBtn.insertAdjacentElement(
                              "beforebegin",
                              placeholder,
                            );
                          } catch (e) {
                            try {
                              actionBtn.parentElement &&
                                actionBtn.parentElement.insertBefore(
                                  placeholder,
                                  actionBtn,
                                );
                            } catch (e2) {}
                          }
                        } else {
                          try {
                            placeholder.style.display = "inline-flex";
                            placeholder.style.marginLeft = "6px";
                            placeholder.style.marginTop = "0";
                            placeholder.style.verticalAlign = "middle";
                          } catch (e) {}
                          try {
                            headerAnchor.insertAdjacentElement(
                              "afterend",
                              placeholder,
                            );
                          } catch (e) {
                            try {
                              headerAnchor.parentElement &&
                                headerAnchor.parentElement.appendChild(
                                  placeholder,
                                );
                            } catch (e2) {}
                          }
                        }
                      } catch (e) {}
                      // mark as handled for this article so other occurrences won't get duplicates
                      namesSeen.add(headerName);

                      // resolve status for header anchor (uses headerName)
                      (async () => {
                        try {
                          const dom = await ensure("src/utils/follow/dom.js");
                          const client = await ensure(
                            "src/utils/follow/client.js",
                          );
                          if (!dom || !client) {
                            dom &&
                              dom.replaceWithBadge(
                                placeholder,
                                "unknown",
                                "github-utils-list-badge name-side",
                              );
                            return;
                          }
                          const name = headerName;
                          const useBulk = shouldUseBulkChecks();
                          let resp = null;
                          if (useBulk)
                            resp = await client
                              .getFollowStatusOnce(viewer, name)
                              .catch(() => null);
                          else
                            resp = await new Promise((resolve) =>
                              chrome.runtime.sendMessage(
                                { type: "checkFollow", viewer, target: name },
                                (r) => {
                                  if (chrome.runtime.lastError) {
                                    console.warn(
                                      "[gh-utils] checkFollow msg failed (feed header)",
                                      chrome.runtime.lastError,
                                    );
                                    resolve(null);
                                    return;
                                  }
                                  resolve(r || null);
                                },
                              ),
                            );
                          if (!resp)
                            dom.replaceWithBadge(
                              placeholder,
                              "unknown",
                              "github-utils-list-badge name-side",
                            );
                          else
                            dom.replaceWithBadge(
                              placeholder,
                              resp.targetFollowsViewer
                                ? "followed"
                                : "not_followed",
                              "github-utils-list-badge name-side",
                            );
                        } catch (e) {
                          try {
                            placeholder &&
                              placeholder.replaceWith &&
                              placeholder.replaceWith(
                                document.createElement("span"),
                              );
                          } catch (e2) {}
                        }
                      })();
                    }
                  }
                } catch (e) {}
              }
            }
          }

          // For other anchors in the item, prefer per-row follow buttons
          allAnchors.forEach((a) => {
            try {
              if (isFollowEvent && headerAnchor && a === headerAnchor) return; // skip header anchor already handled
              // For ADDED_TO_LIST events, only show badge for the actor (header anchor); skip other anchors
              if (isAddedToListEvent && headerAnchor && a !== headerAnchor)
                return;
              const href = a.getAttribute("href") || "";
              const name = href.replace(/^\//, "").replace(/\/$/, "");
              if (!name || name.indexOf("/") !== -1) return;
              if (name === viewer) return;
              // In repo-showing cards (STARRED/TRENDING/RECOMMENDATION/ADDED_TO_LIST), skip anchors that are part of the repo owner/repo area (we don't badge those users)
              if (
                (isStarredEvent ||
                  isTrendingEvent ||
                  isRecommendationEvent ||
                  isAddedToListEvent) &&
                repoAnchors.length
              ) {
                try {
                  const ownerAnchor = a;
                  const ownerNearRepo = repoAnchors.some((ra) => {
                    try {
                      return (
                        ra.closest("section") ===
                          ownerAnchor.closest("section") ||
                        ra.closest("div") === ownerAnchor.closest("div") ||
                        ra.parentElement === ownerAnchor.parentElement ||
                        ra.closest(".color-bg-subtle") ===
                          ownerAnchor.closest(".color-bg-subtle")
                      );
                    } catch (e) {
                      return false;
                    }
                  });
                  if (ownerNearRepo) return;
                } catch (e) {}
              }
              if (namesSeen.has(name)) return;

              // find the nearest row/container for this user
              const userRow =
                a.closest("section") ||
                a.closest(".d-flex") ||
                a.closest(".feed-item-content") ||
                a.closest(".js-feed-item-view") ||
                item;
              if (!userRow) return;

              // skip if this userRow already has a badge
              if (
                userRow.querySelector &&
                userRow.querySelector(
                  ".github-utils-list-badge, .github-utils-follow-badge",
                )
              )
                return;

              // find follow button in the same row
              const followBtn = Array.from(
                (userRow.querySelectorAll &&
                  userRow.querySelectorAll('input[type="submit"],button')) ||
                  [],
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

              // avoid duplicating adjacent badges
              if (followBtn) {
                const after = followBtn.nextElementSibling;
                if (
                  after &&
                  after.classList &&
                  (after.classList.contains("github-utils-list-badge") ||
                    after.classList.contains("github-utils-follow-badge"))
                )
                  return;
              } else {
                const next = a.nextElementSibling;
                if (
                  next &&
                  next.classList &&
                  (next.classList.contains("github-utils-list-badge") ||
                    next.classList.contains("github-utils-follow-badge"))
                )
                  return;
              }

              const placeholder = document.createElement("span");
              placeholder.className = "github-utils-list-badge";
              placeholder.textContent = "...";

              try {
                if (followBtn) {
                  try {
                    // insert immediately for visual responsiveness, then migrate into checker container when possible
                    placeholder.style.display = "block";
                    placeholder.style.marginTop = "6px";
                    placeholder.style.marginLeft = "0";
                    placeholder.style.fontSize = "12px";
                  } catch (e) {}
                  try {
                    followBtn.insertAdjacentElement("afterend", placeholder);
                  } catch (e) {
                    try {
                      followBtn.parentElement &&
                        followBtn.parentElement.insertBefore(
                          placeholder,
                          followBtn.nextSibling,
                        );
                    } catch (e2) {}
                  }

                  // attempt to move placeholder into the persistent checker container (separate from the form)
                  try {
                    ensure("src/utils/follow/dom.js")
                      .then((dom) => {
                        try {
                          const moved = dom.insertPlaceholderInChecker(
                            followBtn,
                            "github-utils-list-badge",
                          );
                          if (moved && moved !== placeholder) {
                            try {
                              moved.dataset.ghFb = "1";
                              moved.dataset.ghName = name;
                              placeholder.replaceWith(moved);
                            } catch (e) {
                              try {
                                placeholder.remove();
                              } catch (e2) {}
                            }
                          } else if (moved) {
                            moved.dataset.ghName = name;
                          }
                        } catch (e) {}
                      })
                      .catch(() => {});
                  } catch (e) {}
                } else {
                  // Prefer placing the badge to the left of the action button/menu in the user's row when possible
                  let placed = false;
                  try {
                    const actionBtn = userRow.querySelector(
                      ".user-following-container, .feed-item-heading-menu-button, button[aria-haspopup], .github-utils-checker",
                    );
                    if (actionBtn) {
                      try {
                        placeholder.style.display = "inline-block";
                        placeholder.style.marginRight = "6px";
                        placeholder.style.marginTop = "0";
                        actionBtn.insertAdjacentElement(
                          "beforebegin",
                          placeholder,
                        );
                        placed = true;
                      } catch (e) {
                        try {
                          actionBtn.parentElement &&
                            actionBtn.parentElement.insertBefore(
                              placeholder,
                              actionBtn,
                            );
                          placed = true;
                        } catch (e2) {}
                      }
                    }
                  } catch (e) {}
                  if (!placed) {
                    try {
                      placeholder.style.display = "inline-flex";
                      placeholder.style.marginLeft = "6px";
                      placeholder.style.marginTop = "0";
                      placeholder.style.verticalAlign = "middle";
                    } catch (e) {}
                    a.insertAdjacentElement("afterend", placeholder);
                  }
                }
              } catch (e) {
                try {
                  ((followBtn && followBtn.parentElement) || a.parentElement) &&
                    (
                      (followBtn && followBtn.parentElement) ||
                      a.parentElement
                    ).appendChild(placeholder);
                } catch (e2) {}
              }

              placeholder.dataset.ghFb = "1";
              placeholder.dataset.ghName = name;
              namesSeen.add(name);

              (async () => {
                try {
                  const dom = await ensure("src/utils/follow/dom.js");
                  const client = await ensure("src/utils/follow/client.js");
                  if (!dom || !client) {
                    dom &&
                      dom.replaceWithBadge(
                        placeholder,
                        "unknown",
                        "github-utils-list-badge",
                      );
                    return;
                  }
                  const useBulk = shouldUseBulkChecks();
                  let resp = null;
                  if (useBulk)
                    resp = await client
                      .getFollowStatusOnce(viewer, name)
                      .catch(() => null);
                  else
                    resp = await new Promise((resolve) =>
                      chrome.runtime.sendMessage(
                        { type: "checkFollow", viewer, target: name },
                        (r) => {
                          if (chrome.runtime.lastError) {
                            console.warn(
                              "[gh-utils] checkFollow msg failed (feed)",
                              chrome.runtime.lastError,
                            );
                            resolve(null);
                            return;
                          }
                          resolve(r || null);
                        },
                      ),
                    );
                  if (!resp)
                    dom.replaceWithBadge(
                      placeholder,
                      "unknown",
                      followBtn
                        ? "github-utils-list-badge"
                        : "github-utils-list-badge name-side",
                    );
                  else
                    dom.replaceWithBadge(
                      placeholder,
                      resp.targetFollowsViewer ? "followed" : "not_followed",
                      followBtn
                        ? "github-utils-list-badge"
                        : "github-utils-list-badge name-side",
                    );
                } catch (e) {
                  try {
                    placeholder &&
                      placeholder.replaceWith &&
                      placeholder.replaceWith(document.createElement("span"));
                  } catch (e2) {}
                }
              })();
            } catch (e) {}
          });
        } catch (e) {}
      });
    } catch (e) {}
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
        scanFeed(document);
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

  // Ensure badges inside follow forms are moved to checker container when a follow/unfollow action occurs
  (function attachFollowProtectionHandlers() {
    function isFollowButton(el) {
      try {
        const s = (
          el.getAttribute("aria-label") ||
          el.title ||
          el.textContent ||
          el.innerText ||
          ""
        )
          .toString()
          .toLowerCase();
        return /(^|\s)(follow|unfollow)($|\s)/i.test(s);
      } catch (e) {
        return false;
      }
    }

    function moveBadgesForButton(btn) {
      try {
        ensure("src/utils/follow/dom.js")
          .then((dom) => {
            try {
              // Move badges inside the same form/container
              const form =
                btn.closest("form") || btn.closest(".user-following-container");
              if (form) {
                const badges = Array.from(
                  (form.querySelectorAll &&
                    form.querySelectorAll(
                      ".github-utils-list-badge, .github-utils-follow-badge",
                    )) ||
                    [],
                );
                badges.forEach((b) => {
                  try {
                    dom.appendBadgeToChecker(btn, b);
                  } catch (e) {}
                });
              }
              // Also move any immediate adjacent badge
              const after = btn.nextElementSibling;
              if (
                after &&
                after.classList &&
                (after.classList.contains("github-utils-list-badge") ||
                  after.classList.contains("github-utils-follow-badge"))
              ) {
                try {
                  dom.appendBadgeToChecker(btn, after);
                } catch (e) {}
              }
            } catch (e) {}
          })
          .catch(() => {});
      } catch (e) {}
    }

    document.addEventListener(
      "click",
      (ev) => {
        try {
          const btn =
            ev.target &&
            ev.target.closest &&
            ev.target.closest('input[type="submit"],button');
          if (!btn) return;
          if (!isFollowButton(btn)) return;
          // move badges immediately (before DOM mutations) and again shortly after
          moveBadgesForButton(btn);
          setTimeout(() => moveBadgesForButton(btn), 120);
        } catch (e) {}
      },
      true,
    );

    document.addEventListener(
      "submit",
      (ev) => {
        try {
          const btn =
            ev.target &&
            ev.target.querySelector &&
            (ev.target.querySelector('input[type="submit"],button') || null);
          if (!btn) return;
          if (!isFollowButton(btn)) return;
          moveBadgesForButton(btn);
        } catch (e) {}
      },
      true,
    );
  })();

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

        // If the added node contains feed items (e.g., after "Load more"), scan them immediately.
        try {
          if (
            (n.matches &&
              n.matches(
                "article, .js-feed-item-component, .news, .TimelineItem, .js-timeline-item, .news-item",
              )) ||
            (n.querySelector &&
              n.querySelector(
                "article, .js-feed-item-component, .news, .TimelineItem, .js-timeline-item, .news-item",
              ))
          ) {
            try {
              scanFeed(n);
            } catch (e) {}
          }
        } catch (e) {}

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
      const row =
        btn.closest(".d-table") || btn.closest("li") || btn.closest("div");
      if (
        row &&
        row.querySelector &&
        row.querySelector(
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
  try {
    // initial feed scan
    scanFeed(document);
  } catch (e) {}
})();
