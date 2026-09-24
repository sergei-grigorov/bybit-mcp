// Страницы коннектора на сервере: общая вёрстка и страница настроек. Без внешних
// ресурсов и без скриптов; стили — с nonce из Content-Security-Policy. Всё, что
// приходит из настроек и манифеста, экранируется.

import { randomBytes } from 'node:crypto';

export const STYLE = `
:root { --bg:#f5f6f8; --card:#fff; --text:#1c1d21; --muted:#6b7280; --line:#e3e5e8; --accent:#2a8bd8; --accent-2:#1f6fb0; --ok:#1f9d55; --err:#c83232; --warn-bg:#fff6e0; --warn-line:#f0c46b; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171a; --card:#1e2125; --text:#eceef1; --muted:#9aa1ab; --line:#30343a; --accent:#4aa3ea; --accent-2:#7cbcf0; --ok:#4cc27d; --err:#ef6b6b; --warn-bg:#3a3120; --warn-line:#8a6d2c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:640px; margin:32px auto; padding:0 16px 48px; }
h1 { font-size:24px; margin:0 0 4px; }
h2 { font-size:16px; margin:0 0 12px; }
a { color:var(--accent); }
.sub, .muted { color:var(--muted); }
.sub { margin:0 0 20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; margin:0 0 16px; }
.field { padding:12px 0; border-top:1px solid var(--line); }
.field:first-child { border-top:0; padding-top:0; }
.field p { margin:4px 0 0; font-size:13px; }
label { display:block; font-weight:500; }
label.check { display:flex; gap:10px; align-items:flex-start; }
label.check input { margin-top:4px; }
label.inline { display:inline-flex; gap:6px; align-items:center; font-weight:400; font-size:13px; color:var(--muted); margin-top:6px; }
input[type=text], input[type=password], input[type=number], textarea { display:block; width:100%; margin-top:6px; padding:10px 12px; font:inherit; color:var(--text); background:transparent; border:1px solid var(--line); border-radius:10px; }
textarea { min-height:70px; resize:vertical; }
input:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; }
button { font:inherit; cursor:pointer; border:0; border-radius:10px; padding:10px 16px; background:var(--accent); color:#fff; font-weight:600; }
button:hover { background:var(--accent-2); }
.badge { display:inline-block; font-size:12px; font-weight:500; color:var(--ok); border:1px solid var(--line); border-radius:8px; padding:0 6px; margin-left:6px; }
.warn { background:var(--warn-bg); border:1px solid var(--warn-line); border-radius:12px; padding:12px 14px; margin:0 0 16px; }
.warn ul, .errbox ul { margin:6px 0 0; padding-left:20px; }
.errbox { border:1px solid var(--err); color:var(--err); border-radius:12px; padding:12px 14px; margin:0 0 16px; }
.ok { color:var(--ok); font-weight:600; }
.okbox { border:1px solid var(--ok); border-radius:12px; padding:12px 14px; margin:0 0 16px; }
.actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
ul.links { margin:0; padding-left:20px; }
footer { color:var(--muted); font-size:13px; }
`;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function newNonce() {
  return randomBytes(16).toString('base64');
}

// Заголовки HTML-страницы: строгий CSP (стили — только с nonce, скриптов нет),
// без кеширования и встраивания в чужие страницы.
export function pageHeaders(nonce, { formAction = "'self'" } = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // same-origin, а не no-referrer: с no-referrer браузер отправляет форму с Origin: null.
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

export function layout({ title, nonce, body }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>`;
}

function list(items) {
  return `<ul>${items.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
}

// Поле формы по описанию из manifest.json → user_config.
function renderField(field, value, options = {}) {
  const id = `f_${field.key}`;
  const name = escapeHtml(field.key);
  const title = escapeHtml(field.title ?? field.key);
  const hint = field.description ? `<p class="muted">${escapeHtml(field.description)}</p>` : '';
  const required = field.required ? ' <span class="muted">(обязательно)</span>' : '';
  if (field.type === 'boolean') {
    return `<div class="field"><label class="check" for="${id}"><input type="checkbox" id="${id}" name="${name}"${value ? ' checked' : ''}><span>${title}</span></label>${hint}</div>`;
  }
  if (field.sensitive) {
    const isSet = value !== undefined && value !== '';
    return `<div class="field"><label for="${id}">${title}${required}${isSet ? '<span class="badge">задано</span>' : ''}</label>
<input type="password" id="${id}" name="${name}" autocomplete="new-password" spellcheck="false" placeholder="${isSet ? 'Оставьте пустым, чтобы не менять' : 'Не задано'}">
${isSet && !field.required ? `<label class="inline"><input type="checkbox" name="clear:${name}"> стереть сохранённое значение</label>` : ''}${hint}</div>`;
  }
  if (field.type === 'number') {
    const attrs = [
      field.min !== undefined ? ` min="${escapeHtml(field.min)}"` : '',
      field.max !== undefined ? ` max="${escapeHtml(field.max)}"` : '',
      field.default !== undefined ? ` placeholder="${escapeHtml(field.default)}"` : '',
    ].join('');
    return `<div class="field"><label for="${id}">${title}${required}</label><input type="number" step="any" id="${id}" name="${name}" value="${escapeHtml(value ?? '')}"${attrs}>${hint}</div>`;
  }
  const placeholder = field.default !== undefined ? ` placeholder="${escapeHtml(field.default)}"` : '';
  if (options.multiline) {
    return `<div class="field"><label for="${id}">${title}${required}</label><textarea id="${id}" name="${name}" spellcheck="false"${placeholder}>${escapeHtml(value ?? '')}</textarea>${hint}</div>`;
  }
  return `<div class="field"><label for="${id}">${title}${required}</label><input type="text" id="${id}" name="${name}" value="${escapeHtml(value ?? '')}" spellcheck="false" autocomplete="off"${placeholder}>${hint}</div>`;
}

// Страница настроек. values — сохранённые значения (секреты в разметку не попадают:
// для них показывается только отметка «задано»).
export function renderSettingsPage({
  nonce,
  title,
  fields,
  values,
  fieldOptions = {},
  notice = null,
  errors = [],
  problems = [],
  links = [],
  intro = '',
  footer = '',
}) {
  const body = `
<h1>${escapeHtml(title)}: настройки</h1>
<p class="sub">${intro}</p>
${notice ? `<div class="okbox"><span class="ok">${escapeHtml(notice)}</span></div>` : ''}
${errors.length ? `<div class="errbox"><b>Настройки не сохранены:</b>${list(errors)}</div>` : ''}
${problems.length ? `<div class="warn"><b>Коннектор предупреждает:</b>${list(problems)}</div>` : ''}
<form method="post" autocomplete="off">
<section>
${fields.map((f) => renderField(f, f.sensitive ? (values[f.key] ? 'set' : undefined) : values[f.key], fieldOptions[f.key])).join('\n')}
</section>
<div class="actions"><button type="submit">Сохранить</button><span class="muted">Коннектор перезапустится с новыми настройками.</span></div>
</form>
${links.length ? `<section><h2>Ещё</h2><ul class="links">${links.map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a>${l.note ? ` <span class="muted">— ${escapeHtml(l.note)}</span>` : ''}</li>`).join('')}</ul></section>` : ''}
${footer ? `<footer>${footer}</footer>` : ''}`;
  return layout({ title: `${title}: настройки`, nonce, body });
}

export function renderMessagePage({ nonce, title, text, links = [] }) {
  const body = `<h1>${escapeHtml(title)}</h1><section><p>${escapeHtml(text)}</p>${links.length ? `<ul class="links">${links.map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a></li>`).join('')}</ul>` : ''}</section>`;
  return layout({ title, nonce, body });
}
