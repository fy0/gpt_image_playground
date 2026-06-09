import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const UPSTREAM_BASE_URL = normalizeBaseUrl(process.env.API_PROXY_URL || process.env.API_URL || 'https://api.openai.com/v1')
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || fileURLToPath(new URL('../dist', import.meta.url)))
const TASK_RETENTION_MS = Number(process.env.BACKEND_TASK_RETENTION_MS || 6 * 60 * 60 * 1000)
const MAX_REQUEST_BYTES = Number(process.env.BACKEND_MAX_REQUEST_BYTES || 600 * 1024 * 1024)
const CLEANUP_INTERVAL_MS = Math.min(TASK_RETENTION_MS, 10 * 60 * 1000)
const tasks = new Map()

if (!UPSTREAM_BASE_URL) {
  console.error('API_PROXY_URL is required for backend tasks.')
  process.exit(1)
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(input)
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return trimmed
  }
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function textResponse(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function logServerError(scope, error, details = '') {
  const suffix = details ? ` ${details}` : ''
  console.error(`[${scope}]${suffix} ${getErrorMessage(error)}`)
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text ? JSON.parse(text) : {})
      } catch {
        rejectBody(new Error('JSON 格式无效'))
      }
    })
    req.on('error', rejectBody)
  })
}

function createRequestHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${label}`)
  return value.trim()
}

function getProfile(request) {
  const settings = request?.settings
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : []
  const profile = profiles.find((item) => item?.id === settings?.activeProfileId) || profiles[0] || settings
  if (!profile || typeof profile !== 'object') throw new Error('缺少 API 配置')
  if (profile.provider && profile.provider !== 'openai') throw new Error('后端保持连接目前仅支持 OpenAI 兼容接口')
  return profile
}

function getEndpointPath(profile, isEdit) {
  const apiMode = profile.apiMode === 'responses' ? 'responses' : 'images'
  if (apiMode === 'responses') return 'responses'
  return isEdit ? 'images/edits' : 'images/generations'
}

function getOutputMime(params) {
  if (params?.output_format === 'jpeg') return 'image/jpeg'
  if (params?.output_format === 'webp') return 'image/webp'
  return 'image/png'
}

function normalizeBase64Image(value, fallbackMime) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:')
}

function bufferToDataUrl(buffer, mime) {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`
}

async function fetchImageUrlAsDataUrl(url, fallbackMime) {
  if (isDataUrl(url)) return url

  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMime
  return bufferToDataUrl(await response.arrayBuffer(), contentType)
}

function pickActualParams(source) {
  if (!source || typeof source !== 'object') return {}
  const actualParams = {}
  if (typeof source.size === 'string') actualParams.size = source.size
  if (['auto', 'low', 'medium', 'high'].includes(source.quality)) actualParams.quality = source.quality
  if (['png', 'jpeg', 'webp'].includes(source.output_format)) actualParams.output_format = source.output_format
  if (typeof source.output_compression === 'number') actualParams.output_compression = source.output_compression
  if (source.moderation === 'auto' || source.moderation === 'low') actualParams.moderation = source.moderation
  if (typeof source.n === 'number') actualParams.n = source.n
  return actualParams
}

function mergeActualParams(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function dataUrlToBlob(dataUrl, fallbackType = 'image/png') {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl)
  if (!match) throw new Error('输入图片格式无效')
  const mime = match[1] || fallbackType
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  const buffer = isBase64 ? Buffer.from(payload.replace(/\s/g, ''), 'base64') : Buffer.from(decodeURIComponent(payload))
  return new Blob([buffer], { type: mime })
}

function createResponsesImageTool(params, profile, isEdit, maskDataUrl) {
  const tool = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profile.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl }
  return tool
}

function createResponsesInput(prompt, inputImageDataUrls) {
  const text = `Use the following text as the complete prompt. Do not rewrite it:\n${prompt}`
  if (!inputImageDataUrls.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }]
}

function getResponsesImageResultBase64(result) {
  if (typeof result === 'string') return result.trim()
  if (!result || typeof result !== 'object') return ''
  return String(result.b64_json || result.base64 || result.image || result.data || '').trim()
}

function parseResponsesImageResults(payload, fallbackMime) {
  const output = Array.isArray(payload?.output) ? payload.output : []
  const results = []
  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue
    const b64 = getResponsesImageResultBase64(item.result)
    if (!b64) continue
    results.push({
      image: normalizeBase64Image(b64, fallbackMime),
      actualParams: mergeActualParams(pickActualParams(item)),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    })
  }
  if (!results.length) throw new Error('接口没有返回可识别的图片数据')
  return {
    images: results.map((item) => item.image),
    actualParams: mergeActualParams(results[0]?.actualParams),
    actualParamsList: results.map((item) => mergeActualParams(item.actualParams)),
    revisedPrompts: results.map((item) => item.revisedPrompt),
  }
}

async function parseImagesApiResponse(payload, fallbackMime) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  if (!data.length) throw new Error('接口没有返回图片数据')
  const images = []
  const rawImageUrls = []
  const revisedPrompts = []
  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
      images.push(normalizeBase64Image(item.b64_json, fallbackMime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      continue
    }
    if (isHttpUrl(item?.url) || isDataUrl(item?.url)) {
      if (isHttpUrl(item.url)) rawImageUrls.push(item.url)
      images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  const actualParams = mergeActualParams(pickActualParams(payload), { n: images.length })
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

async function callOpenAICompatible(request) {
  const profile = getProfile(request)
  const apiKey = requireString(profile.apiKey, 'API Key')
  const model = requireString(profile.model, '模型 ID')
  const params = request.params || {}
  const inputImageDataUrls = Array.isArray(request.inputImageDataUrls) ? request.inputImageDataUrls : []
  const isEdit = inputImageDataUrls.length > 0
  const endpointPath = getEndpointPath(profile, isEdit)
  const url = `${UPSTREAM_BASE_URL}/${endpointPath}`
  const fallbackMime = getOutputMime(params)
  const headers = createRequestHeaders(apiKey)
  let response

  if (profile.apiMode === 'responses' && Number(params.n) > 1) {
    const n = Math.max(1, Math.trunc(Number(params.n)))
    const results = await Promise.allSettled(
      Array.from({ length: n }).map(() =>
        callOpenAICompatible({ ...request, params: { ...params, n: 1 } }),
      ),
    )
    const successfulResults = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
    if (!successfulResults.length) {
      const firstError = results.find((result) => result.status === 'rejected')
      throw firstError?.reason || new Error('所有并发请求均失败')
    }
    const images = successfulResults.flatMap((result) => result.images)
    return {
      images,
      actualParams: mergeActualParams(successfulResults[0]?.actualParams, { n: images.length }),
      actualParamsList: successfulResults.flatMap((result) =>
        result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
      ),
      revisedPrompts: successfulResults.flatMap((result) =>
        result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
      ),
    }
  }

  if (profile.apiMode === 'responses') {
    const body = {
      model,
      input: createResponsesInput(requireString(request.prompt, '提示词'), inputImageDataUrls),
      tools: [createResponsesImageTool(params, profile, isEdit, request.maskDataUrl)],
      tool_choice: 'required',
    }
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } else if (isEdit) {
    const formData = new FormData()
    formData.append('model', model)
    formData.append('prompt', requireString(request.prompt, '提示词'))
    formData.append('size', params.size)
    formData.append('output_format', params.output_format)
    if (!profile.codexCli) formData.append('quality', params.quality)
    if (params.output_compression != null && params.output_format !== 'png') {
      formData.append('output_compression', String(params.output_compression))
    }
    if (params.n > 1) formData.append('n', String(params.n))
    if (profile.responseFormatB64Json) formData.append('response_format', 'b64_json')
    inputImageDataUrls.forEach((dataUrl, index) => {
      const blob = dataUrlToBlob(dataUrl)
      const ext = blob.type.split('/')[1] || 'png'
      formData.append('image[]', blob, `input-${index + 1}.${ext}`)
    })
    if (request.maskDataUrl) formData.append('mask', dataUrlToBlob(request.maskDataUrl), 'mask.png')
    response = await fetch(url, { method: 'POST', headers, body: formData })
  } else {
    const body = {
      model,
      prompt: requireString(request.prompt, '提示词'),
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation,
    }
    if (!profile.codexCli) body.quality = params.quality
    if (params.output_compression != null && params.output_format !== 'png') body.output_compression = params.output_compression
    if (params.n > 1) body.n = params.n
    if (profile.responseFormatB64Json) body.response_format = 'b64_json'
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(readApiErrorMessage(text) || `HTTP ${response.status}`)
  }

  const payload = await response.json()
  return profile.apiMode === 'responses'
    ? parseResponsesImageResults(payload, fallbackMime)
    : await parseImagesApiResponse(payload, fallbackMime)
}

function readApiErrorMessage(text) {
  if (!text) return ''
  try {
    const payload = JSON.parse(text)
    if (payload?.error?.message) return payload.error.message
    if (typeof payload?.detail === 'string') return payload.detail
    if (typeof payload?.error === 'string') return payload.error
    if (payload?.message) return payload.message
  } catch {
    return text
  }
  return text
}

function startTask(request) {
  const taskId = randomUUID()
  const task = {
    id: taskId,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  }
  tasks.set(taskId, task)
  void runTask(task, request)
  return task
}

async function runTask(task, request) {
  task.status = 'running'
  task.updatedAt = Date.now()
  try {
    task.result = await callOpenAICompatible(request)
    task.status = 'done'
  } catch (error) {
    task.error = getErrorMessage(error)
    logServerError('image-task', error, `${task.id} failed:`)
    task.status = 'error'
  } finally {
    task.updatedAt = Date.now()
  }
}

function serializeTask(task) {
  return {
    taskId: task.id,
    status: task.status,
    ...(task.result ? { result: task.result } : {}),
    ...(task.error ? { error: task.error } : {}),
  }
}

function cleanupTasks() {
  const now = Date.now()
  for (const [taskId, task] of tasks) {
    if (task.status === 'queued' || task.status === 'running') continue
    if (now - task.updatedAt > TASK_RETENTION_MS) tasks.delete(taskId)
  }
}

setInterval(cleanupTasks, CLEANUP_INTERVAL_MS).unref()

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api-proxy/')) {
    await handleApiProxy(req, res, url)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/backend-api/image-tasks') {
    try {
      const request = await readJsonBody(req)
      const task = startTask(request)
      jsonResponse(res, 202, serializeTask(task))
    } catch (error) {
      logServerError('backend-api', error, `${req.method} ${url.pathname} failed:`)
      jsonResponse(res, 400, { error: getErrorMessage(error) })
    }
    return true
  }

  const match = /^\/backend-api\/image-tasks\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'GET' && match) {
    const taskId = decodeURIComponent(match[1])
    const task = tasks.get(taskId)
    if (!task) {
      jsonResponse(res, 404, { error: '后端任务不存在或已过期' })
      return true
    }
    jsonResponse(res, 200, serializeTask(task))
    return true
  }

  if (url.pathname.startsWith('/backend-api/')) {
    jsonResponse(res, 404, { error: 'Not found' })
    return true
  }

  return false
}

async function handleApiProxy(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    textResponse(res, 405, 'Method Not Allowed')
    return
  }

  const relativePath = url.pathname.slice('/api-proxy/'.length)
  if (!relativePath) {
    textResponse(res, 403, 'Forbidden: API Proxy path required')
    return
  }

  const targetUrl = `${UPSTREAM_BASE_URL}/${relativePath}${url.search}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    const lowerKey = key.toLowerCase()
    if (lowerKey === 'host' || lowerKey === 'connection' || lowerKey === 'content-length') continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req,
      duplex: 'half',
    })
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    responseHeaders.delete('transfer-encoding')
    res.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()))
    if (!upstream.body) {
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  } catch (error) {
    logServerError('api-proxy', error, `${req.method} ${url.pathname} failed:`)
    jsonResponse(res, 502, { error: getErrorMessage(error) })
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

async function serveStatic(req, res, url) {
  const decodedPath = decodeURIComponent(url.pathname)
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '')
  let filePath = resolve(join(PUBLIC_DIR, normalizedPath))
  const relativePath = relative(PUBLIC_DIR, filePath)
  if (relativePath.startsWith('..') || relativePath === '..' || relativePath.includes(`..${sep}`) || resolve(relativePath) === relativePath) {
    textResponse(res, 403, 'Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': filePath.includes(`${PUBLIC_DIR}${process.platform === 'win32' ? '\\' : '/'}assets`) ? 'public, immutable, max-age=31536000' : 'no-cache',
      'Content-Length': body.length,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    const indexPath = join(PUBLIC_DIR, 'index.html')
    const body = await readFile(indexPath)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (await handleApi(req, res, url)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      textResponse(res, 405, 'Method Not Allowed')
      return
    }
    await serveStatic(req, res, url)
  } catch (error) {
    logServerError('server', error, `${req.method || 'GET'} ${req.url || '/'} failed:`)
    jsonResponse(res, 500, { error: getErrorMessage(error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Backend task server listening on http://${HOST}:${PORT}`)
})
