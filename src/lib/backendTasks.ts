import type { AppSettings, TaskParams } from '../types'
import type { CallApiResult } from './imageApiShared'

export type BackendTaskStatus = 'queued' | 'running' | 'done' | 'error'

export interface BackendTaskSubmitRequest {
  settings: AppSettings
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface BackendTaskSubmitResponse {
  taskId: string
  status: BackendTaskStatus
}

export interface BackendTaskStatusResponse {
  taskId: string
  status: BackendTaskStatus
  result?: CallApiResult
  error?: string
}

export async function submitBackendImageTask(request: BackendTaskSubmitRequest): Promise<BackendTaskSubmitResponse> {
  const response = await fetch('/backend-api/image-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(request),
  })

  return parseBackendTaskResponse(response)
}

export async function getBackendImageTask(taskId: string): Promise<BackendTaskStatusResponse> {
  const response = await fetch(`/backend-api/image-tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    cache: 'no-store',
  })

  return parseBackendTaskResponse(response)
}

async function parseBackendTaskResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  if (!response.ok) {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error
      : `后端任务请求失败：HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}
