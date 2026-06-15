/**
 * Intentionally tiny markdown→HTML used by every real email driver (SMTP,
 * Resend, …) so they all render + escape identically. We do double-newline →
 * paragraph and single-newline → <br>, plus auto-link bare URLs. This is enough
 * for the announcement / support-flow / password-reset templates we send today.
 */
export function markdownToBasicHtml(md: string): string {
  // Escape ALL five HTML-significant characters. Crucially this includes the
  // double quote: the auto-linker below drops the matched URL into an
  // href="..." attribute, so an unescaped quote in attacker-influenced text
  // (book title, member name, admin-authored template) would break out of the
  // attribute and inject markup (link/UI spoofing in a trusted email). Escaping
  // " → &quot; first means any quote inside a matched URL stays a literal.
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const paragraphs = linked
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:540px;margin:0 auto;padding:24px">${paragraphs}</body></html>`;
}
