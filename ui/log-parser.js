(function (root) {
  "use strict";

  function parseLine(rawLine, stream) {
    var line = String(rawLine || "");
    var source = String(stream || "log");
    var entry = null;
    try {
      var parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entry = parsed;
    } catch (_) {}

    var level = entry ? String(entry.level || entry.severity || "").toLowerCase() : "";
    if (level === "warning") level = "warn";
    var time = entry ? String(entry.time || entry.timestamp || "") : "";
    var component = entry ? String(entry.component || entry.scope || entry.source || source) : source;
    var summary = entry ? String(entry.summary || entry.msg || entry.message || line) : line;
    return {
      raw: line,
      time: time,
      level: level,
      component: component,
      summary: summary,
      detail: entry ? JSON.stringify(entry, null, 2) : line,
      structured: entry !== null,
    };
  }

  root.PatchWardenLogParser = { parseLine: parseLine };
})(typeof window !== "undefined" ? window : globalThis);
