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
