const ALLOWED_EXTERNAL_HOSTS = new Set([
  "platform.openai.com",
  "developers.openai.com",
  "chatgpt.com",
  "github.com",
]);

export function isAllowedExternalNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443")
      && ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
