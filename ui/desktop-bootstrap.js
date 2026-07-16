(function () {
  if (!window.patchwardenDesktop) return;
  var html = document.documentElement;
  var theme = localStorage.getItem("patchwarden.desktop.theme") || "system";
  var dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  html.classList.add("pw-desktop", dark ? "dark" : "light");
  html.dataset.theme = dark ? "dark" : "light";
  html.style.backgroundColor = dark ? "#0f1413" : "#eef2f1";
  var language = localStorage.getItem("patchwarden.language");
  if (language === "zh-CN" || language === "en") html.lang = language;
})();
