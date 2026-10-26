const SAVER_LONG_PROMPT = 1500
const SAVER_QUICK_PROMPT = 300

function saverMatches(text, words) {
  const list = String(words || '').split(',').map(w => w.trim()).filter(Boolean)
  return list.some(w => new RegExp(`(^|[^\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`, 'i').test(text))
}

function saverSkillWords(skills) {
  return [...new Set((skills || []).flatMap(s => String(s).toLowerCase().split(':')).filter(w => w.length >= 4))].join(',')
}

function routeModel(text, { settings, skills = [], attachments = false, mode = 'default' }) {
  const keep = reason => ({ model: settings.defaultModel, reason })
  if (attachments) return keep('attachment')
  if (mode === 'plan') return keep('plan mode')
  if (text.length > SAVER_LONG_PROMPT) return keep('long prompt')
  if (/^\/|\b[\w-]+:[\w-]+\b|skill|(^|\s)@\w/i.test(text) || saverMatches(text, saverSkillWords(skills))) return keep('skill or command')
  if (saverMatches(text, settings.saverHeavyWords)) return { model: settings.saverHeavyModel, reason: 'heavy task' }
  if (text.length <= SAVER_QUICK_PROMPT && saverMatches(text, settings.saverQuickWords)) {
    const model = settings.saverQuickModel === 'haiku' && skills.length ? 'sonnet' : settings.saverQuickModel
    return { model, reason: 'quick task' }
  }
  return { model: settings.saverOtherModel, reason: 'everything else' }
}

function limitedUntil(u) {
  if (!u) return null
  const r = u.rate_limits || {}
  const full = [r.five_hour, r.seven_day, r.seven_day_opus, r.seven_day_sonnet, ...(r.model_scoped || [])]
    .filter(w => w?.resets_at && w.utilization >= 100).map(w => Date.parse(w.resets_at))
  return full.length ? Math.max(...full) : 0
}

function pickAccount(current, usages, now = Date.now()) {
  const known = usages.map(({ id, u }) => ({ id, u, at: limitedUntil(u) })).filter(x => x.at !== null)
    .map(x => ({ ...x, at: x.at > now ? x.at : 0 }))
  const free = known.filter(x => x.at === 0 && x.id !== current)
    .sort((a, b) => (a.u.rate_limits?.five_hour?.utilization || 0) - (b.u.rate_limits?.five_hour?.utilization || 0))
  if (free.length) return { id: free[0].id, at: 0 }
  const mine = known.find(x => x.id === current)
  const best = known.filter(x => x.id !== current).sort((a, b) => a.at - b.at)[0]
  return best && (!mine || best.at < mine.at) ? { id: best.id, at: best.at } : null
}
