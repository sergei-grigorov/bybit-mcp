// Ответ инструмента должен помещаться в контекст модели. Если JSON слишком длинный,
// самые большие массивы укорачиваются, а в ответ добавляется пометка, что и насколько
// обрезано.

const RESERVE = 600; // место под пометку об обрезке

function collectArrays(node, path, out, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectArrays(item, `${path}[${i}]`, out, depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value) && value.length > 1) {
      out.push({ parent: node, key, path: childPath, size: JSON.stringify(value).length });
    }
    collectArrays(value, childPath, out, depth + 1);
  }
}

// adjust(clone, truncated) может поправить укороченную копию и вернуть доп. пояснение.
export function fitJson(value, maxChars, adjust) {
  let text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  const budget = Math.max(1000, maxChars - RESERVE);
  const clone = structuredClone(value);
  const truncated = new Map();
  for (let guard = 0; guard < 40 && text.length > budget; guard++) {
    const arrays = [];
    collectArrays(clone, '', arrays);
    if (!arrays.length) break;
    arrays.sort((a, b) => b.size - a.size);
    const target = arrays[0];
    const arr = target.parent[target.key];
    const avg = target.size / arr.length;
    const excess = text.length - budget;
    let keep = Math.floor(arr.length - Math.ceil(excess / Math.max(avg, 1)));
    keep = Math.min(arr.length - 1, Math.max(1, keep));
    const info = truncated.get(target.path) ?? { path: target.path, total: arr.length };
    info.kept = keep;
    truncated.set(target.path, info);
    target.parent[target.key] = arr.slice(0, keep);
    text = JSON.stringify(clone);
  }
  if (truncated.size) {
    const list = [...truncated.values()];
    const extra = adjust?.(clone, list);
    const note = {
      truncated: list,
      hint: extra ?? 'Output was shortened to fit. Narrow the request (symbol, time range, limit) or page with cursor.',
    };
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
      text = JSON.stringify({ ...clone, _output: note });
    } else {
      text = JSON.stringify({ data: clone, _output: note });
    }
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}… [output cut at ${maxChars} characters; the JSON above is incomplete]`;
  }
  return text;
}
