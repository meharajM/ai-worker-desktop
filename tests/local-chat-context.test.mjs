import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLocalChatPrompt, MAX_LOCAL_CHAT_PROMPT_LENGTH } from '../src/renderer/src/lib/local-chat-context.ts'

test('local chat includes recent turns in order before the current prompt', () => {
  const prompt = buildLocalChatPrompt([
    { role: 'user', content: 'Remember my preferred city: Pune.' },
    { role: 'assistant', content: 'I will keep that in mind.' },
  ], 'What city did I mention?')

  assert.match(prompt, /User: Remember my preferred city: Pune\.\nAssistant: I will keep that in mind\./)
  assert.ok(prompt.endsWith('Current user message:\nWhat city did I mention?'))
})

test('local chat context stays within the native UTF-16 prompt limit and preserves the current message', () => {
  const current = 'Latest question 🧪'
  const prompt = buildLocalChatPrompt([
    { role: 'user', content: 'earlier '.repeat(4_000) },
    { role: 'assistant', content: 'newest 🧪 '.repeat(4_000) },
  ], current)

  assert.ok(prompt.length <= MAX_LOCAL_CHAT_PROMPT_LENGTH)
  assert.ok(prompt.endsWith(`Current user message:\n${current}`))
  assert.match(prompt, /\[Earlier text omitted\]/)
  for (let index = 0; index < prompt.length; index += 1) {
    const code = prompt.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(prompt.charCodeAt(index + 1) >= 0xdc00 && prompt.charCodeAt(index + 1) <= 0xdfff)
      index += 1
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff)
    }
  }
})

test('a full-size current message is sent intact without older context', () => {
  const current = '🧪'.repeat(4_000)
  const prompt = buildLocalChatPrompt([{ role: 'assistant', content: 'Older context' }], current)

  assert.equal(prompt, current)
})
