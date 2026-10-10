// Session storage supports reloads; memory keeps owner access when storage is blocked.
export function createOwnerTokenStore(getStorage = () => globalThis.sessionStorage) {
  const memory = new Map()
  const storedTokens = () => {
    try {
      const parsed = JSON.parse(getStorage().getItem('wastelens-owner-tokens') || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter(([, token]) => typeof token === 'string' && token.length > 0))
    } catch { return {} }
  }
  const ownerToken = (reportId) => {
    if (memory.has(reportId)) return memory.get(reportId)
    const token = storedTokens()[reportId]
    if (typeof token !== 'string' || !token) return ''
    memory.set(reportId, token)
    return token
  }
  const rememberOwnerToken = (reportId, token) => {
    if (typeof reportId !== 'string' || !reportId || typeof token !== 'string' || !token) return
    memory.set(reportId, token)
    try {
      getStorage().setItem('wastelens-owner-tokens', JSON.stringify({ ...storedTokens(), ...Object.fromEntries(memory) }))
    } catch { /* Owner access remains available in memory for this page. */ }
  }
  const ownerHeaders = (reportId, headers = {}) => {
    const token = ownerToken(reportId)
    return token ? { ...headers, 'X-Report-Token': token } : headers
  }
  return { ownerToken, rememberOwnerToken, ownerHeaders }
}

export const { ownerToken, rememberOwnerToken, ownerHeaders } = createOwnerTokenStore()
