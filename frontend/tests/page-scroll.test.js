import test from 'node:test'
import assert from 'node:assert/strict'
import { scrollToPageHash } from '../src/page-scroll.js'

function fixture(desktop) {
  const calls = []
  const content = { scrollTo: (options) => calls.push(['content', options]) }
  const windowRef = {
    matchMedia: (query) => {
      assert.equal(query, '(min-width: 901px)')
      return { matches: desktop }
    },
    scrollTo: (options) => calls.push(['window', options]),
  }
  const documentRef = {
    getElementById: (id) => ({ scrollIntoView: (options) => calls.push([id, options]) }),
  }
  return { content, calls, windowRef, documentRef }
}

test('desktop home, account and communities navigation reset only the content pane', () => {
  for (const hash of ['', '#top', '#login', '#groups']) {
    const state = fixture(true)
    scrollToPageHash(hash, state.content, state)
    assert.deepEqual(state.calls, [['content', { top: 0, behavior: 'instant' }]])
  }
})

test('mobile home and page changes preserve native document scrolling', () => {
  for (const hash of ['', '#top', '#login', '#groups']) {
    const state = fixture(false)
    scrollToPageHash(hash, state.content, state)
    assert.deepEqual(state.calls, [['window', { top: 0, behavior: 'instant' }]])
  }
})

test('feed, guide and how-it-works links reach their section on both layouts', () => {
  for (const desktop of [true, false]) {
    for (const hash of ['#community', '#everyday', '#how']) {
      const state = fixture(desktop)
      scrollToPageHash(hash, state.content, state)
      assert.deepEqual(state.calls, [[hash.slice(1), { block: 'start' }]])
    }
  }
})

test('report links do not reset the reading position or sidebar', () => {
  const state = fixture(true)
  scrollToPageHash('#report/12345678-1234-1234-1234-123456789abc', state.content, state)
  assert.deepEqual(state.calls, [])
})

test('navigation tolerates a section still mounting and a missing desktop pane', () => {
  const state = fixture(true)
  state.documentRef.getElementById = () => null
  scrollToPageHash('#everyday', state.content, state)
  assert.deepEqual(state.calls, [])
  scrollToPageHash('#top', null, state)
  assert.deepEqual(state.calls, [['window', { top: 0, behavior: 'instant' }]])
})
