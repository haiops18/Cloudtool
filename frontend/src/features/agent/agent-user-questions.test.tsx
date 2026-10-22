import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AgentQuestionForm } from './agent-user-questions'

const request = {
  id: 'request',
  questions: [{ id: 'zone', header: 'Zone', question: 'Chọn zone nào?', isOther: true,
    options: [{ label: 'Zone A (id-a)', description: 'Region A' }, { label: 'Zone B (id-b)', description: 'Region B' }] }],
}

it('requires an explicit choice and sends the selected label', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const screen = await render(<AgentQuestionForm request={request} onAnswer={onAnswer} />)
  await expect.element(screen.getByRole('button', { name: 'Gửi câu trả lời' })).toBeDisabled()
  await screen.getByRole('radio').nth(1).click()
  await screen.getByRole('button', { name: 'Gửi câu trả lời' }).click()
  expect(onAnswer).toHaveBeenCalledWith({ zone: ['Zone B (id-b)'] }, false)
})

it('allows free text and cancellation without a guessed answer', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const screen = await render(<AgentQuestionForm request={request} onAnswer={onAnswer} />)
  await screen.getByRole('radio').nth(2).click()
  await screen.getByRole('textbox', { name: 'Trả lời: Zone' }).fill('Cần zone khác')
  await screen.getByRole('button', { name: 'Gửi câu trả lời' }).click()
  expect(onAnswer).toHaveBeenCalledWith({ zone: ['Cần zone khác'] }, false)
  await screen.getByRole('button', { name: 'Hủy câu hỏi' }).click()
  expect(onAnswer).toHaveBeenLastCalledWith({}, true)
})
