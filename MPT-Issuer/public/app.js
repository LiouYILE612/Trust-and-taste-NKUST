export async function api(path, method = "GET", body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(body)
  }

  const r = await fetch(path, opts)
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }

  if (!r.ok) {
    const err = new Error(data?.error || `HTTP ${r.status}`)
    err.data = data
    throw err
  }
  return data
}

export function setStatus(el, kind, text) {
  el.className = `badge ${kind}`
  el.textContent = text
}

export function $(id) {
  return document.getElementById(id)
}

export function pretty(x) {
  return JSON.stringify(x, null, 2)
}

export async function pollPayload(uuid, onUpdate, { interval = 1200, max = 200 } = {}) {
  for (let i = 0; i < max; i++) {
    const p = await api(`/api/payload/${uuid}`)
    onUpdate?.(p)
    if (p?.resolved || p?.validatedTx?.validated || p?.auto?.ok || p?.cancelled || p?.expired) return p
    await new Promise(r => setTimeout(r, interval))
  }
  return null
}
