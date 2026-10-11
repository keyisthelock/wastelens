// Desktop navigation scrolls the feed pane; small screens retain normal page scrolling.
export function scrollToPageHash(hash, content, {
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (['', '#top', '#login', '#groups'].includes(hash)) {
    const desktop = windowRef.matchMedia('(min-width: 901px)').matches
    const target = desktop && content ? content : windowRef
    target.scrollTo({ top: 0, behavior: 'instant' })
    return
  }
  if (['#community', '#everyday', '#how'].includes(hash)) {
    documentRef.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }
}
