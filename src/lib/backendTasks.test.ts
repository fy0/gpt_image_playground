import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { getBackendImageTask, submitBackendImageTask } from './backendTasks'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backendTasks', () => {
  it('submits image tasks to the same-origin backend endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      taskId: 'task-1',
      status: 'queued',
    }), { status: 202 }))

    await expect(submitBackendImageTask({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).resolves.toEqual({ taskId: 'task-1', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend-api/image-tasks',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('reads image task status by task id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      taskId: 'task-1',
      status: 'running',
    }), { status: 200 }))

    await expect(getBackendImageTask('task-1')).resolves.toEqual({ taskId: 'task-1', status: 'running' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend-api/image-tasks/task-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
