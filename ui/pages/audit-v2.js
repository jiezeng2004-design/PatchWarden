(function () {
  "use strict";
  window.PatchWardenAuditV2 = true;

  var API_URL = "/api/audit";
  var audits = [];
  var stats = emptyStats();
  var groups = [];
  var selectedAuditId = null;
  var statsAvailable = false;

  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove("hidden"); }
  function hide(el) { if (el) el.classList.add("hidden"); }
  function isZh() {
    return window.PatchWardenI18n
      ? window.PatchWardenI18n.getLanguage() === "zh-CN"
      : /^zh(?:-|$)/i.test(document.documentElement.lang || navigator.language || "");
  }
  function tr(zh, en) { return isZh() ? zh : en; }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }
  function truncate(value, max) {
    var text = String(value || "");
    return text.length > max ? text.slice(0, max) + "…" : text;
  }
  function formatTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(isZh() ? "zh-CN" : "en", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(date);
  }
  function emptyStats() {
    return { total: 0, returned: 0, truncated: false, pass: 0, warn: 0, fail: 0, unknown: 0, needs_action: 0, manual_verification: 0 };
  }

  function verdictMeta(verdict) {
    var map = {
      pass: { zh: "通过", en: "Passed", color: "var(--pw-state-success)", bg: "var(--pw-state-success-bg)" },
      warn: { zh: "需复核", en: "Review", color: "var(--pw-state-warning)", bg: "var(--pw-state-warning-bg)" },
      fail: { zh: "未通过", en: "Failed", color: "var(--pw-state-error)", bg: "var(--pw-state-error-bg)" },
      unknown: { zh: "无结论", en: "No conclusion", color: "var(--pw-state-info)", bg: "var(--pw-state-info-bg)" }
    };
    return map[verdict] || map.unknown;
  }

  function verdictBadge(verdict) {
    var meta = verdictMeta(verdict);
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold whitespace-nowrap" style="color:' + meta.color + ";background:" + meta.bg + ';border-left:3px solid ' + meta.color + ';">' + escapeHtml(tr(meta.zh, meta.en)) + "</span>";
  }

  function showLoading() {
    show($("loadingState")); hide($("errorState")); hide($("emptyState")); hide($("tableWrapper")); hide($("evidencePanel"));
    show($("warningsLoadingState")); hide($("warningsErrorState")); hide($("warningsEmptyState")); hide($("warningsBody"));
  }
  function showError(message) {
    hide($("loadingState")); show($("errorState")); hide($("emptyState")); hide($("tableWrapper")); hide($("evidencePanel"));
    hide($("warningsLoadingState")); show($("warningsErrorState")); hide($("warningsEmptyState")); hide($("warningsBody"));
    if ($("errorMessage")) $("errorMessage").textContent = message;
    if ($("warningsErrorMessage")) $("warningsErrorMessage").textContent = message;
    statsAvailable = false;
    renderStats();
  }

  function renderStats() {
    if (!statsAvailable) {
      $("statTotal").textContent = "—";
      $("statPass").textContent = "—";
      $("statFail").textContent = "—";
      $("statUnknown").textContent = "—";
      $("overviewTitle").textContent = tr("审计数据不可用", "Audit data unavailable");
      $("overviewText").textContent = tr("无法核对审计统计。请重试；在数据恢复前不要将结果视为通过。", "Audit statistics could not be verified. Retry before treating any result as passed.");
      $("overviewIcon").style.color = "var(--pw-state-error)";
      $("auditOverview").style.borderLeft = "3px solid var(--pw-state-error)";
      return;
    }
    $("statTotal").textContent = String(stats.total || 0);
    $("statPass").textContent = String(stats.pass || 0);
    $("statFail").textContent = String(stats.needs_action || 0);
    $("statUnknown").textContent = String(stats.unknown || 0);

    var title;
    var text;
    var color;
    if (stats.fail > 0) {
      title = tr("存在 " + stats.fail + " 条未通过审计", stats.fail + " audit(s) failed");
      text = tr("先处理阻断问题；另有 " + stats.warn + " 条需要复核。", "Resolve blocking findings first; " + stats.warn + " audit(s) also need review.");
      color = "var(--pw-state-error)";
    } else if (stats.warn > 0) {
      title = tr("没有阻断问题，但有 " + stats.warn + " 条需要复核", "No blocking findings; " + stats.warn + " audit(s) need review");
      text = tr("查看风险证据并完成建议操作后再验收。", "Review the evidence and complete the suggested actions before acceptance.");
      color = "var(--pw-state-warning)";
    } else if (stats.needs_action > 0) {
      title = tr("有 " + stats.needs_action + " 条需要人工确认", stats.needs_action + " audit(s) require manual verification");
      text = tr("完成列出的人工检查并记录结果后再验收。", "Complete the listed manual checks and record the outcome before acceptance.");
      color = "var(--pw-state-warning)";
    } else if (stats.unknown > 0) {
      title = tr("有 " + stats.unknown + " 条旧记录尚未形成明确结论", stats.unknown + " legacy audit(s) have no clear conclusion");
      text = tr("重新运行这些任务的验收以生成结构化结论。", "Run acceptance again for these records to create a structured conclusion.");
      color = "var(--pw-state-info)";
    } else if (stats.total === 0) {
      title = tr("尚无审计记录", "No audit records yet");
      text = tr("运行验收后，这里会显示结论、发现、建议操作和证据。", "Run acceptance to show conclusions, findings, recommended actions, and evidence here.");
      color = "var(--pw-state-info)";
    } else {
      title = tr("当前审计均已通过", "All current audits passed");
      text = tr("没有待处理风险。", "No audit risks require action.");
      color = "var(--pw-state-success)";
    }
    if (stats.truncated) {
      text += " " + tr("共 " + stats.total + " 条，当前显示最近 " + stats.returned + " 条。", stats.total + " total; showing the latest " + stats.returned + ".");
    }
    $("overviewTitle").textContent = title;
    $("overviewText").textContent = text;
    $("overviewIcon").style.color = color;
    $("auditOverview").style.borderLeft = "3px solid " + color;
  }

  function groupMeta(type) {
    var map = {
      failed: { zh: "阻断问题", en: "Blocking findings", color: "var(--pw-state-error)" },
      warning: { zh: "需要复核", en: "Needs review", color: "var(--pw-state-warning)" },
      manual_verification: { zh: "需要人工确认", en: "Manual verification", color: "var(--pw-state-info)" },
      unknown: { zh: "缺少明确结论", en: "Missing conclusion", color: "var(--pw-state-info)" }
    };
    return map[type] || map.unknown;
  }

  function localizedGroupAction(type, fallback) {
    if (!isZh()) return fallback || "Review the audit evidence.";
    var map = {
      failed: "打开未通过的审计，修复已确认问题后重新运行验收。",
      warning: "逐项查看警告证据，确认无误后再接受结果。",
      manual_verification: "完成列出的人工检查，并在验收前记录结果。",
      unknown: "重新运行审计，生成当前的结构化结论。"
    };
    return map[type] || "查看审计证据。";
  }

  function renderGroups() {
    $("warnings-count").textContent = String(groups.length);
    hide($("warningsLoadingState")); hide($("warningsErrorState"));
    if (groups.length === 0) {
      show($("warningsEmptyState")); hide($("warningsBody"));
      return;
    }
    hide($("warningsEmptyState")); show($("warningsBody"));
    $("warningsBody").innerHTML = groups.map(function (group) {
      var meta = groupMeta(group.type);
      var subjects = Array.isArray(group.subjects) ? group.subjects.slice(0, 6) : [];
      var links = subjects.map(function (subject) {
        return '<a href="' + escapeHtml(subject.detail_url || "#") + '" class="inline-block px-1.5 py-0.5 rounded text-xs hover:underline" style="font-family:var(--pw-font-mono);color:var(--pw-text-accent);background:var(--pw-accent-subtle);" title="' + escapeHtml(subject.id) + '">' + escapeHtml(truncate(subject.id, 20)) + "</a>";
      }).join("");
      var remaining = Math.max(0, Number(group.count || 0) - subjects.length);
      if (remaining > 0) links += '<span class="text-xs px-1.5 py-0.5" style="color:var(--pw-text-tertiary);">' + escapeHtml(tr("另有 " + remaining + " 条", "+" + remaining + " more")) + "</span>";
      return '<div class="rounded-md p-3" style="background:var(--pw-bg-hover);border-left:3px solid ' + meta.color + ';">'
        + '<div class="flex items-center gap-2 flex-wrap"><strong class="text-sm" style="color:var(--pw-text-primary);">' + escapeHtml(tr(meta.zh, meta.en)) + '</strong><span class="text-xs" style="color:var(--pw-text-tertiary);">' + escapeHtml(String(group.count || 0)) + tr(" 条", "") + "</span></div>"
        + '<p class="text-xs mt-1" style="color:var(--pw-text-secondary);">' + escapeHtml(localizedGroupAction(group.type, group.recommended_action)) + "</p>"
        + (links ? '<div class="flex flex-wrap gap-1.5 mt-2">' + links + "</div>" : "")
        + "</div>";
    }).join("");
  }

  function checkSummary(entry) {
    var counts = entry.check_counts || {};
    if (!counts.total) return tr("未提供检查计数", "Check counts unavailable");
    return tr(
      (counts.pass || 0) + " 通过 · " + (counts.warn || 0) + " 警告 · " + (counts.fail || 0) + " 失败",
      (counts.pass || 0) + " pass · " + (counts.warn || 0) + " warn · " + (counts.fail || 0) + " fail"
    );
  }

  function renderTable() {
    hide($("loadingState"));
    if (audits.length === 0) {
      show($("emptyState")); hide($("tableWrapper"));
      return;
    }
    hide($("emptyState")); show($("tableWrapper"));
    $("auditTableBody").innerHTML = audits.map(function (entry, index) {
      var finding = Array.isArray(entry.findings) && entry.findings.length > 0
        ? entry.findings[0]
        : entry.verdict === "pass"
          ? tr("无待处理发现", "No findings require action")
          : entry.summary;
      var action = Array.isArray(entry.recommended_actions) && entry.recommended_actions.length > 0 ? entry.recommended_actions[0] : "";
      var typeLabel = entry.subject_type === "direct_session" ? "Direct" : tr("任务", "Task");
      var selected = entry.audit_id === selectedAuditId ? " pw-row-selected" : "";
      var alt = index % 2 ? "background-color:var(--pw-bg-hover);" : "";
      return '<tr class="cursor-pointer' + selected + '" data-audit-id="' + escapeHtml(entry.audit_id) + '" style="border-bottom:1px solid var(--pw-border-subtle);' + alt + '">'
        + '<td class="px-4 py-3"><div class="flex items-center gap-2"><span class="text-xs px-1.5 py-0.5 rounded" style="color:var(--pw-text-tertiary);background:var(--pw-bg-active);">' + escapeHtml(typeLabel) + '</span><a href="' + escapeHtml(entry.detail_url) + '" class="hover:underline" style="font-family:var(--pw-font-mono);font-size:var(--pw-text-xs);color:var(--pw-text-accent);" title="' + escapeHtml(entry.subject_id) + '">' + escapeHtml(truncate(entry.subject_id, 22)) + "</a></div></td>"
        + '<td class="px-4 py-3">' + verdictBadge(entry.verdict) + '<div class="text-xs mt-1 whitespace-nowrap" style="color:var(--pw-text-tertiary);">' + escapeHtml(checkSummary(entry)) + "</div></td>"
        + '<td class="px-4 py-3 text-xs" style="color:var(--pw-text-secondary);max-width:300px;">' + escapeHtml(truncate(finding || tr("无待处理发现", "No findings require action"), 120)) + "</td>"
        + '<td class="px-4 py-3 text-xs" style="color:var(--pw-text-secondary);max-width:260px;">' + escapeHtml(truncate(action || tr("无需操作", "No action required"), 110)) + "</td>"
        + '<td class="px-4 py-3 text-right whitespace-nowrap text-xs" style="font-family:var(--pw-font-mono);color:var(--pw-text-tertiary);">' + escapeHtml(formatTime(entry.checked_at)) + "</td>"
        + "</tr>";
    }).join("");
    Array.prototype.forEach.call($("auditTableBody").querySelectorAll("tr[data-audit-id]"), function (row) {
      row.addEventListener("click", onRowClick);
    });
  }

  function listHtml(items, emptyText) {
    if (!Array.isArray(items) || items.length === 0) return '<p style="color:var(--pw-text-tertiary);">' + escapeHtml(emptyText) + "</p>";
    return items.map(function (item) { return '<div class="flex gap-2"><span style="color:var(--pw-accent);">•</span><span>' + escapeHtml(item) + "</span></div>"; }).join("");
  }

  function renderEvidence(entry) {
    if (!entry) { hide($("evidencePanel")); return; }
    $("evidenceTaskId").textContent = entry.subject_id;
    var meta = verdictMeta(entry.verdict);
    $("evidenceConclusion").innerHTML = '<div class="flex items-center gap-2 flex-wrap">' + verdictBadge(entry.verdict) + '<strong class="text-sm" style="color:var(--pw-text-primary);">' + escapeHtml(entry.summary || tr("无摘要", "No summary")) + "</strong></div>";
    var counts = entry.check_counts || {};
    $("evidencePass").textContent = String(counts.pass || 0);
    $("evidenceWarn").textContent = String(counts.warn || 0);
    $("evidenceFail").textContent = String(counts.fail || 0);
    $("evidenceManual").textContent = entry.manual_verification_required ? tr("是", "Yes") : tr("否", "No");
    $("evidenceFindings").innerHTML = listHtml(entry.findings, tr("没有待处理发现", "No findings require action"));
    $("evidenceActions").innerHTML = listHtml(entry.recommended_actions, tr("无需进一步操作", "No further action required"));
    $("evidenceJson").textContent = JSON.stringify(entry, null, 2);
    $("evidencePanel").style.borderLeftColor = meta.color;
    show($("evidencePanel"));
    $("evidencePanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function onRowClick(event) {
    if (event.target.closest("a")) return;
    var id = event.currentTarget.getAttribute("data-audit-id");
    selectedAuditId = selectedAuditId === id ? null : id;
    renderTable();
    renderEvidence(audits.find(function (entry) { return entry.audit_id === selectedAuditId; }) || null);
  }

  function setRefreshing(active) {
    if ($("refreshIcon")) $("refreshIcon").classList.toggle("pw-spin", active);
  }

  function refresh() {
    showLoading();
    setRefreshing(true);
    fetch(API_URL, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!isValidAuditResponse(data)) throw new Error("AUDIT_RESPONSE_INVALID");
        audits = data.audits;
        stats = data.stats;
        groups = data.attention_groups;
        statsAvailable = true;
        selectedAuditId = null;
        renderStats(); renderGroups(); renderTable(); renderEvidence(null);
      })
      .catch(function (error) {
        var message = error && error.message === "AUDIT_RESPONSE_INVALID"
          ? tr("审计响应不完整或统计不一致", "Audit response is incomplete or inconsistent")
          : tr("无法加载审计数据", "Unable to load audit data");
        showError(message);
      })
      .finally(function () { setRefreshing(false); });
  }

  function isValidAuditResponse(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.audits) || !Array.isArray(data.attention_groups)) return false;
    var candidate = data.stats;
    if (!candidate || typeof candidate !== "object") return false;
    if (typeof candidate.truncated !== "boolean") return false;
    var keys = ["total", "returned", "pass", "warn", "fail", "unknown", "needs_action", "manual_verification"];
    for (var index = 0; index < keys.length; index += 1) {
      var value = candidate[keys[index]];
      if (typeof value !== "number" || !isFinite(value) || value < 0) return false;
    }
    if (candidate.pass + candidate.warn + candidate.fail + candidate.unknown !== candidate.total) return false;
    if (typeof data.total !== "number" || data.total !== candidate.total) return false;
    if (candidate.returned !== data.audits.length || candidate.returned > candidate.total) return false;
    if (candidate.manual_verification > candidate.needs_action || candidate.needs_action > candidate.total) return false;
    // Manual verification can overlap warning/failure verdicts. These bounds
    // prove the aggregate cannot under- or over-count the union of actions.
    var verdictActionCount = candidate.fail + candidate.warn;
    if (candidate.needs_action < Math.max(verdictActionCount, candidate.manual_verification)) return false;
    if (candidate.needs_action > Math.min(candidate.total, verdictActionCount + candidate.manual_verification)) return false;

    var expectedGroups = {
      failed: candidate.fail,
      warning: candidate.warn,
      manual_verification: candidate.manual_verification,
      unknown: candidate.unknown
    };
    var seenGroups = {};
    for (var groupIndex = 0; groupIndex < data.attention_groups.length; groupIndex += 1) {
      var group = data.attention_groups[groupIndex];
      if (!group || typeof group !== "object" || !Object.prototype.hasOwnProperty.call(expectedGroups, group.type)) return false;
      if (seenGroups[group.type]) return false;
      if (!Number.isInteger(group.count) || group.count !== expectedGroups[group.type] || !Array.isArray(group.subjects)) return false;
      seenGroups[group.type] = true;
    }
    for (var groupType in expectedGroups) {
      if (expectedGroups[groupType] > 0 && !seenGroups[groupType]) return false;
      if (expectedGroups[groupType] === 0 && seenGroups[groupType]) return false;
    }
    return true;
  }

  function rerender() {
    renderStats(); renderGroups(); renderTable();
    renderEvidence(audits.find(function (entry) { return entry.audit_id === selectedAuditId; }) || null);
  }

  function init() {
    $("refreshBtn").addEventListener("click", refresh);
    if ($("retryBtn")) $("retryBtn").addEventListener("click", refresh);
    window.addEventListener("patchwarden:languagechange", rerender);
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
