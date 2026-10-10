import test from 'node:test'
import assert from 'node:assert/strict'
import { accountRequest, validAccount } from '../src/account-api.js'

const user = { id: 'test-id', name: 'Neighbor', email: 'neighbor@example.test', email_verified: false }
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

test('account requests use cookie credentials without storing or returning client tokens', async () => {
  let request
  const actual = await accountRequest(async (url, options) => { request = { url, options }; return response({ user }) }, '/api', 'login', { email: user.email, password: 'synthetic-test-password' })
  assert.equal(actual, user)
  assert.equal(request.url, '/api/auth/login')
  assert.equal(request.options.credentials, 'include')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.Authorization, undefined)
})

test('only explicit anonymous session responses are treated as signed out', async () => {
  assert.equal(await accountRequest(async () => response({ user: null }), '/api', 'me'), null)
  await assert.rejects(accountRequest(async () => response({}), '/api', 'me'), /could not be confirmed/)
})

test('network errors, rejected passwords and malformed success never create a signed-in user', async () => {
  await assert.rejects(accountRequest(async () => { throw new Error('offline') }, '/api', 'login', {}))
  await assert.rejects(accountRequest(async () => response({ detail: 'Email or password is incorrect' }, 401), '/api', 'login', {}), /incorrect/)
  for (const value of [null, {}, { id: 'id' }, { id: '', name: 'Neighbor', email: 'a@b.test' }]) {
    assert.throws(() => validAccount(value))
  }
})

test('logout changes account state only after a confirmed server response', async () => {
  assert.equal(await accountRequest(async () => response({ signed_out: true }), '/api', 'logout', {}), null)
  await assert.rejects(accountRequest(async () => response({ signed_out: false }), '/api', 'logout', {}), /not confirmed/)
})
