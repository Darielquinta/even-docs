import './style.css'
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

type EvenBridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>
type RawResult = boolean | number | string | null | undefined

interface DocRecord {
  id: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
  cursor: number
  g2Page: number
  followCursor: boolean
  lastSnapshotHash?: string
  lastAutoSnapshotAt?: number
}

interface VersionRecord {
  id: string
  docId: string
  title: string
  body: string
  createdAt: number
  message: string
  chars: number
  hash: string
}

interface SettingsRecord {
  autoSnapshotMinutes: number
  g2PageSize: number
}

interface AppState {
  app: 'even-g2-docs-keyboard'
  schemaVersion: 4
  updatedAt: number
  activeDocId: string
  docs: DocRecord[]
  versions: VersionRecord[]
  settings: SettingsRecord
}

interface StorageMeta {
  schemaVersion: 4
  updatedAt: number
  chunkCount: number
  hash: string
  bytes: number
}

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const EVENT_CONTAINER_ID = 1
const EVENT_CONTAINER_NAME = 'evt'
const SCREEN_CONTAINER_ID = 2
const SCREEN_CONTAINER_NAME = 'screen'
const MENU_CONTAINER_ID = 3
const MENU_CONTAINER_NAME = 'menu'
const STARTUP_REBUILD_LIMIT = 1000
const UPGRADE_LIMIT = 1900
const BRIDGE_TIMEOUT_MS = 5000

// Faster G2 display updates, slower/heavier storage writes.
const SAVE_DEBOUNCE_MS = 900
const G2_DEBOUNCE_MS = 10
const G2_POLL_MS = 700

const STORAGE_PREFIX = 'com.dariel.g2docskeyboard.ehpk.local.v4'
const META_KEY = `${STORAGE_PREFIX}.meta`
const CHUNK_KEY_PREFIX = `${STORAGE_PREFIX}.chunk.`
const FALLBACK_KEY = `${STORAGE_PREFIX}.fallback`
const CHUNK_SIZE = 28000
const EMPTY_DOC_TEXT = 'G2 Docs Keyboard\n\nStart typing on the phone. EHPK local saves are active. Use Alt+←/→ to page.'
const TEST_TEXT = 'G2 Docs Keyboard test\n\nIf this appears without reopening the app, the G2 display path is awake. Miracles do happen, apparently.'

const bridgeStatusEl = document.querySelector<HTMLDivElement>('#bridgeStatus')!
const saveStatusEl = document.querySelector<HTMLDivElement>('#saveStatus')!
const storageStatusEl = document.querySelector<HTMLDivElement>('#storageStatus')!
const docSelectEl = document.querySelector<HTMLSelectElement>('#docSelect')!
const docTitleEl = document.querySelector<HTMLInputElement>('#docTitle')!
const editorEl = document.querySelector<HTMLTextAreaElement>('#editor')!
const charCountEl = document.querySelector<HTMLSpanElement>('#charCount')!
const g2MetaEl = document.querySelector<HTMLSpanElement>('#g2Meta')!
const versionListEl = document.querySelector<HTMLDivElement>('#versionList')!
const autoSnapshotMinutesEl = document.querySelector<HTMLInputElement>('#autoSnapshotMinutes')!
const g2PageSizeEl = document.querySelector<HTMLInputElement>('#g2PageSize')!
const importFileEl = document.querySelector<HTMLInputElement>('#importFile')!
const markdownPreviewEl = document.querySelector<HTMLDivElement>('#markdownPreview')!

const newDocButton = document.querySelector<HTMLButtonElement>('#newDocButton')!
const snapshotButton = document.querySelector<HTMLButtonElement>('#snapshotButton')!
const restoreButton = document.querySelector<HTMLButtonElement>('#restoreButton')!
const deleteDocButton = document.querySelector<HTMLButtonElement>('#deleteDocButton')!
const exportButton = document.querySelector<HTMLButtonElement>('#exportButton')!
const importButton = document.querySelector<HTMLButtonElement>('#importButton')!
const focusButton = document.querySelector<HTMLButtonElement>('#focusButton')!
const prevPageButton = document.querySelector<HTMLButtonElement>('#prevPageButton')!
const nextPageButton = document.querySelector<HTMLButtonElement>('#nextPageButton')!
const tailButton = document.querySelector<HTMLButtonElement>('#tailButton')!
const glassesMenuButton = document.querySelector<HTMLButtonElement>('#glassesMenuButton')!
const sendTestButton = document.querySelector<HTMLButtonElement>('#sendTestButton')!
const saveNowButton = document.querySelector<HTMLButtonElement>('#saveNowButton')!
const verifyStorageButton = document.querySelector<HTMLButtonElement>('#verifyStorageButton')!
const reloadLocalButton = document.querySelector<HTMLButtonElement>('#reloadLocalButton')!
const dangerWipeButton = document.querySelector<HTMLButtonElement>('#dangerWipeButton')!

let bridge: EvenBridge | null = null
let storageMode: 'bridge' | 'browser' | 'none' = 'none'
let state: AppState = makeDefaultState()
let selectedVersionId = ''
let startupPageCreated = false
let pushInFlight = false
let pendingG2 = false
let saveTimer: number | undefined
let g2Timer: number | undefined
let g2PollTimer: number | undefined
let mirrorTimer: number | undefined
let savingNow = false
let dirtyDuringSave = false
let lastSavedHash = ''
let lastSentToGlasses = ''
let composing = false
let g2Mode: 'document' | 'menu' = 'document'
let g2Layout: 'document' | 'menu' | '' = ''
let menuItems: G2MenuItem[] = []

interface G2MenuItem {
  label: string
  action: string
  docId?: string
  versionId?: string
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${hash >>> 0}`
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn('[G2DocsKeyboard] JSON parse failed:', error)
    return fallback
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function setPill(el: HTMLElement, text: string, stateName: 'waiting' | 'ready' | 'error' | 'plain' = 'plain') {
  el.textContent = text
  el.title = text
  el.className = `pill pill-${stateName}`
}

function showSave(text: string, stateName: 'waiting' | 'ready' | 'error' | 'plain' = 'plain') {
  setPill(saveStatusEl, text, stateName)
}

function showStorage(text: string, stateName: 'waiting' | 'ready' | 'error' | 'plain' = 'plain') {
  setPill(storageStatusEl, text, stateName)
}

function makeDefaultState(): AppState {
  const now = Date.now()
  const firstDoc: DocRecord = {
    id: makeId('doc'),
    title: 'Untitled G2 Doc',
    body: '',
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    g2Page: 0,
    followCursor: true,
  }
  return {
    app: 'even-g2-docs-keyboard',
    schemaVersion: 4,
    updatedAt: now,
    activeDocId: firstDoc.id,
    docs: [firstDoc],
    versions: [],
    settings: {
      autoSnapshotMinutes: 5,
      g2PageSize: 1200,
    },
  }
}

function cleanDoc(doc: Partial<DocRecord>, fallbackIndex = 1): DocRecord {
  const now = Date.now()
  const body = String(doc.body ?? '')
  return {
    id: String(doc.id || makeId('doc')),
    title: String(doc.title || `Untitled G2 Doc ${fallbackIndex}`).trim() || 'Untitled G2 Doc',
    body,
    createdAt: Number(doc.createdAt || now),
    updatedAt: Number(doc.updatedAt || now),
    cursor: Math.max(0, Math.min(Number(doc.cursor || 0), body.length)),
    g2Page: Math.max(0, Number(doc.g2Page || 0)),
    followCursor: doc.followCursor !== false,
    lastSnapshotHash: doc.lastSnapshotHash,
    lastAutoSnapshotAt: Number(doc.lastAutoSnapshotAt || 0) || undefined,
  }
}

function cleanState(input: unknown): AppState {
  const raw = input as Partial<AppState>
  const fallback = makeDefaultState()
  const docs = Array.isArray(raw.docs) ? raw.docs.map((doc, index) => cleanDoc(doc, index + 1)) : fallback.docs
  const usableDocs = docs.length ? docs : fallback.docs
  const versions = Array.isArray(raw.versions)
    ? raw.versions.map((version) => ({
        id: String(version.id || makeId('ver')),
        docId: String(version.docId || usableDocs[0].id),
        title: String(version.title || 'Snapshot'),
        body: String(version.body ?? ''),
        createdAt: Number(version.createdAt || Date.now()),
        message: String(version.message || 'Snapshot'),
        chars: Number(version.chars ?? String(version.body ?? '').length),
        hash: String(version.hash || simpleHash(`${version.title ?? ''}\n${version.body ?? ''}`)),
      }))
    : []
  const activeDocId = usableDocs.some((doc) => doc.id === raw.activeDocId) ? String(raw.activeDocId) : usableDocs[0].id
  const settings = {
    autoSnapshotMinutes: Math.max(1, Math.min(120, Number(raw.settings?.autoSnapshotMinutes || 5))),
    g2PageSize: Math.max(300, Math.min(1800, Number(raw.settings?.g2PageSize || 1200))),
  }
  return {
    app: 'even-g2-docs-keyboard',
    schemaVersion: 4,
    updatedAt: Number(raw.updatedAt || Date.now()),
    activeDocId,
    docs: usableDocs,
    versions,
    settings,
  }
}

function activeDoc(): DocRecord {
  const found = state.docs.find((doc) => doc.id === state.activeDocId)
  if (found) return found
  state.activeDocId = state.docs[0]?.id || makeDefaultState().activeDocId
  if (!state.docs.length) state = makeDefaultState()
  return state.docs[0]
}

function stateJson(): string {
  return JSON.stringify(state)
}

function stateHash(): string {
  return simpleHash(stateJson())
}

function contentHash(doc: DocRecord): string {
  return simpleHash(`${doc.title}\n${doc.body}`)
}

function chunkJson(json: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < json.length; i += CHUNK_SIZE) chunks.push(json.slice(i, i + CHUNK_SIZE))
  return chunks.length ? chunks : ['']
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error('Timed out waiting for Even bridge')), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  }
}

async function storageGet(key: string): Promise<string | null> {
  if (storageMode === 'bridge' && bridge?.getLocalStorage) {
    const value = await bridge.getLocalStorage(key)
    if (value === undefined || value === null) return null
    return String(value)
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function storageSet(key: string, value: string): Promise<void> {
  if (storageMode === 'bridge' && bridge?.setLocalStorage) {
    await bridge.setLocalStorage(key, value)
    return
  }
  window.localStorage.setItem(key, value)
}

async function saveStateToStorage(): Promise<void> {
  const json = stateJson()
  const hash = simpleHash(json)
  const chunks = chunkJson(json)
  const oldMeta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
  const oldChunkCount = Math.max(0, Number(oldMeta.chunkCount || 0))

  for (let i = 0; i < chunks.length; i += 1) {
    await storageSet(`${CHUNK_KEY_PREFIX}${i}`, chunks[i])
  }

  for (let i = chunks.length; i < oldChunkCount; i += 1) {
    await storageSet(`${CHUNK_KEY_PREFIX}${i}`, '')
  }

  const meta: StorageMeta = {
    schemaVersion: 4,
    updatedAt: Date.now(),
    chunkCount: chunks.length,
    hash,
    bytes: new Blob([json]).size,
  }
  await storageSet(META_KEY, JSON.stringify(meta))

  const loaded = await loadStateFromStorage(false)
  if (!loaded || simpleHash(JSON.stringify(loaded)) !== hash) {
    throw new Error('Storage verification failed after write')
  }

  lastSavedHash = hash
}

async function loadStateFromStorage(reportMissing = true): Promise<AppState | null> {
  const meta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
  const chunkCount = Math.max(0, Number(meta.chunkCount || 0))

  if (!chunkCount) {
    const fallback = await storageGet(FALLBACK_KEY)
    if (fallback) return cleanState(safeParse(fallback, makeDefaultState()))
    if (reportMissing) showStorage('No saved docs yet', 'waiting')
    return null
  }

  let json = ''
  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = await storageGet(`${CHUNK_KEY_PREFIX}${i}`)
    json += chunk ?? ''
  }

  const hash = simpleHash(json)
  if (meta.hash && hash !== meta.hash) {
    throw new Error('Saved data hash mismatch. Refusing to load corrupt local state.')
  }

  return cleanState(safeParse(json, makeDefaultState()))
}

async function wipeStorage(): Promise<void> {
  const meta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
  const chunkCount = Math.max(0, Number(meta.chunkCount || 0))
  for (let i = 0; i < Math.max(chunkCount, 32); i += 1) {
    await storageSet(`${CHUNK_KEY_PREFIX}${i}`, '')
  }
  await storageSet(META_KEY, '')
  await storageSet(FALLBACK_KEY, '')
}

function emergencyBrowserMirror() {
  try {
    window.localStorage.setItem(FALLBACK_KEY, stateJson())
  } catch {
    // Browser fallback is optional. The Even bridge store is the real one in EHPK.
  }
}

function scheduleEmergencyBrowserMirror() {
  if (mirrorTimer !== undefined) window.clearTimeout(mirrorTimer)

  mirrorTimer = window.setTimeout(() => {
    emergencyBrowserMirror()
    mirrorTimer = undefined
  }, SAVE_DEBOUNCE_MS)
}

function markDirtyAndSave(reason = 'edit') {
  syncActiveDocFromForm()
  state.updatedAt = Date.now()

  updateCharCount()
  updateMarkdownPreview()
  updateG2Meta()
  scheduleG2Update()

  scheduleEmergencyBrowserMirror()
  showSave(`Save queued: ${reason}`, 'waiting')

  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    emergencyBrowserMirror()
    void saveNow(reason)
  }, SAVE_DEBOUNCE_MS)
}

async function saveNow(reason = 'manual') {
  syncActiveDocFromForm()
  state.updatedAt = Date.now()
  emergencyBrowserMirror()

  if (savingNow) {
    dirtyDuringSave = true
    return
  }

  savingNow = true
  dirtyDuringSave = false
  showSave(`Saving ${reason}...`, 'waiting')

  try {
    await saveStateToStorage()
    maybeAutoSnapshot()
    showSave(`Saved ${nowTime()}`, 'ready')
    const meta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
    showStorage(`${storageMode === 'bridge' ? 'Even App' : 'Browser'} storage · ${state.docs.length} docs · ${state.versions.length} snapshots · ${(Number(meta.bytes || 0) / 1024).toFixed(1)} KB`, 'ready')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[G2DocsKeyboard] save failed:', error)
    showSave(`Save failed: ${message}`, 'error')
    showStorage(`Storage failed: ${message}`, 'error')
  } finally {
    savingNow = false
    if (dirtyDuringSave || stateHash() !== lastSavedHash) {
      dirtyDuringSave = false
      void saveNow('follow-up')
    }
  }
}

function syncActiveDocFromForm() {
  const doc = activeDoc()
  doc.title = docTitleEl.value.trim() || 'Untitled G2 Doc'
  doc.body = editorEl.value
  doc.cursor = editorEl.selectionStart ?? doc.body.length
  doc.updatedAt = Date.now()
  doc.g2Page = doc.followCursor ? pageForCursor(doc) : clampPage(doc)
}

function pageSize(): number {
  return Math.max(300, Math.min(1800, Number(state.settings.g2PageSize || 1200)))
}

function totalPagesFor(text: string): number {
  const rendered = markdownToG2Text(text)
  return Math.max(1, Math.ceil(Math.max(1, rendered.length) / pageSize()))
}

function clampPage(doc: DocRecord): number {
  const total = totalPagesFor(doc.body)
  return Math.max(0, Math.min(total - 1, doc.g2Page || 0))
}

function pageForCursor(doc: DocRecord): number {
  return Math.max(0, Math.floor(Math.max(0, doc.cursor) / pageSize()))
}

function getG2Chunk(doc: DocRecord): string {
  if (!doc.body.trim()) return EMPTY_DOC_TEXT
  const total = totalPagesFor(doc.body)
  const page = doc.followCursor ? pageForCursor(doc) : clampPage(doc)
  doc.g2Page = Math.max(0, Math.min(total - 1, page))
  const start = doc.g2Page * pageSize()
  const renderedBody = markdownToG2Text(doc.body)
  const raw = renderedBody.slice(start, start + pageSize())
  const header = `${doc.title || 'Untitled'} · ${doc.g2Page + 1}/${total} · ${g2Mode === 'menu' ? 'menu' : 'doc'}\n`
  return `${header}${raw}`.slice(0, UPGRADE_LIMIT)
}

function isStartupSuccess(result: RawResult): boolean {
  if (result === 0 || result === '0' || result === true) return true
  const text = String(result ?? '').toUpperCase()
  return text.includes('SUCCESS') || text.includes('CREATE_PAGE_SUCCESS')
}

function isUpdateSuccess(result: RawResult): boolean {
  if (result === false) return true
  if (result === true || result === 0 || result === '0') return true
  const text = String(result ?? '').toUpperCase()
  return text.includes('SUCCESS') || text.includes('UPGRADE_TEXT_DATA_SUCCESS') || text.includes('REBUILD_PAGE_SUCCESS')
}

function displayTextProperty(content: string): unknown {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: 8,
    containerID: SCREEN_CONTAINER_ID,
    containerName: SCREEN_CONTAINER_NAME,
    content: content.slice(0, STARTUP_REBUILD_LIMIT),
    isEventCapture: 0,
  })
}

function eventTextProperty(): unknown {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: 0,
    containerID: EVENT_CONTAINER_ID,
    containerName: EVENT_CONTAINER_NAME,
    content: ' ',
    isEventCapture: 1,
  })
}


function menuTextProperty(content: string): unknown {
  return new TextContainerProperty({
    xPosition: 236,
    yPosition: 0,
    width: 340,
    height: DISPLAY_HEIGHT,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: 8,
    containerID: SCREEN_CONTAINER_ID,
    containerName: SCREEN_CONTAINER_NAME,
    content: content.slice(0, STARTUP_REBUILD_LIMIT),
    isEventCapture: 0,
  })
}

function buildG2MenuItems(): G2MenuItem[] {
  const docs = [...state.docs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((doc, index) => ({
      label: `${doc.id === state.activeDocId ? '✓' : 'Doc'} ${index + 1}: ${doc.title || 'Untitled'}`.slice(0, 64),
      action: 'open-doc',
      docId: doc.id,
    }))
  const snapshots = state.versions
    .filter((version) => version.docId === state.activeDocId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((version, index) => ({
      label: `Restore snap ${index + 1}: ${new Date(version.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`.slice(0, 64),
      action: 'restore-snapshot',
      versionId: version.id,
    }))
  return [
    { label: '← Back to document', action: 'close-menu' },
    { label: 'Snapshot current doc', action: 'snapshot' },
    { label: 'Restore latest snapshot', action: 'restore-latest' },
    ...snapshots,
    { label: 'New blank doc', action: 'new-doc' },
    { label: 'Next page', action: 'next-page' },
    { label: 'Previous page', action: 'prev-page' },
    { label: 'Follow cursor', action: 'follow-cursor' },
    ...docs,
  ].slice(0, 20)
}

function g2MenuProperty(): unknown {
  menuItems = buildG2MenuItems()
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 236,
    height: DISPLAY_HEIGHT,
    borderWidth: 1,
    borderColor: 8,
    borderRadius: 0,
    paddingLength: 4,
    containerID: MENU_CONTAINER_ID,
    containerName: MENU_CONTAINER_NAME,
    itemContainer: {
      itemCount: menuItems.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: menuItems.map((item) => item.label),
    },
    isEventCapture: 1,
  })
}

function pageContainer(content: string): unknown {
  if (g2Mode === 'menu') {
    return new CreateStartUpPageContainer({
      containerTotalNum: 2,
      listObject: [g2MenuProperty()],
      textObject: [menuTextProperty(content)],
    })
  }
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [eventTextProperty(), displayTextProperty(content)],
  })
}

function rebuildContainer(content: string): unknown {
  if (g2Mode === 'menu') {
    return new RebuildPageContainer({
      containerTotalNum: 2,
      listObject: [g2MenuProperty()],
      textObject: [menuTextProperty(content)],
    })
  }
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [eventTextProperty(), displayTextProperty(content)],
  })
}

async function ensureStartupPage(content: string): Promise<boolean> {
  if (!bridge) return false
  if (startupPageCreated && g2Layout === g2Mode) return true
  const result = await bridge.createStartUpPageContainer(pageContainer(content))
  startupPageCreated = isStartupSuccess(result)
  if (startupPageCreated) g2Layout = g2Mode
  if (!startupPageCreated) console.warn('[G2DocsKeyboard] startup page failed:', result)
  return startupPageCreated
}

async function rebuildG2(content: string): Promise<boolean> {
  if (!bridge) return false
  const result = await bridge.rebuildPageContainer(rebuildContainer(content))
  const success = isUpdateSuccess(result)
  if (success) {
    startupPageCreated = true
    g2Layout = g2Mode
  }
  return success
}

async function pushToG2(content: string, force = false) {
  if (!bridge) return
  if (pushInFlight) {
    pendingG2 = true
    return
  }
  if (!force && content === lastSentToGlasses) return

  pushInFlight = true
  pendingG2 = false
  try {
    const ready = await ensureStartupPage(content)
    if (!ready) return

    if (g2Layout !== g2Mode) {
      await rebuildG2(content)
    }

    const update = new TextContainerUpgrade({
      containerID: SCREEN_CONTAINER_ID,
      containerName: SCREEN_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: Math.min(content.length, UPGRADE_LIMIT),
      content: content.slice(0, UPGRADE_LIMIT),
    })
    const result = await bridge.textContainerUpgrade(update)
    if (!isUpdateSuccess(result)) {
      console.warn('[G2DocsKeyboard] text upgrade failed, rebuilding:', result)
      await rebuildG2(content)
    }
    lastSentToGlasses = content
  } catch (error) {
    console.warn('[G2DocsKeyboard] G2 push failed, trying rebuild:', error)
    await rebuildG2(content).catch((rebuildError) => console.warn('[G2DocsKeyboard] rebuild failed:', rebuildError))
  } finally {
    pushInFlight = false
    if (pendingG2) {
      pendingG2 = false
      const doc = activeDoc()
      void pushToG2(getG2Chunk(doc), true)
    }
  }
}

function scheduleG2Update(force = false) {
  if (g2Timer !== undefined) window.clearTimeout(g2Timer)
  g2Timer = window.setTimeout(() => {
    syncActiveDocFromForm()
    updateG2Meta()
    void pushToG2(getG2Chunk(activeDoc()), force)
  }, G2_DEBOUNCE_MS)
}

function startG2Poll() {
  if (g2PollTimer !== undefined) window.clearInterval(g2PollTimer)
  g2PollTimer = window.setInterval(() => {
    if (!bridge || document.visibilityState === 'hidden') return
    const doc = activeDoc()
    const content = getG2Chunk(doc)
    if (content !== lastSentToGlasses) void pushToG2(content)
  }, G2_POLL_MS)
}

function updateG2Meta() {
  const doc = activeDoc()
  const total = totalPagesFor(doc.body)
  doc.g2Page = doc.followCursor ? pageForCursor(doc) : clampPage(doc)
  g2MetaEl.textContent = `Page ${doc.g2Page + 1}/${total} · ${doc.followCursor ? 'following cursor' : 'manual'} · ${g2Mode}`
  glassesMenuButton.textContent = g2Mode === 'menu' ? 'Close glasses menu' : 'Open glasses menu'
}

function updateCharCount() {
  const doc = activeDoc()
  const chars = doc.body.length.toLocaleString()
  const words = doc.body.trim() ? doc.body.trim().split(/\s+/).length.toLocaleString() : '0'
  charCountEl.textContent = `${chars} chars · ${words} words`
}

function renderDocs() {
  docSelectEl.innerHTML = ''
  const sorted = [...state.docs].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const doc of sorted) {
    const option = document.createElement('option')
    option.value = doc.id
    option.textContent = `${doc.title || 'Untitled'} · ${new Date(doc.updatedAt).toLocaleDateString()}`
    docSelectEl.appendChild(option)
  }
  docSelectEl.value = state.activeDocId
}

function renderVersions() {
  const doc = activeDoc()
  const versions = state.versions
    .filter((version) => version.docId === doc.id)
    .sort((a, b) => b.createdAt - a.createdAt)

  versionListEl.innerHTML = ''
  if (!versions.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No snapshots yet. Hit Snapshot or Ctrl+S, because time travel requires paperwork.'
    versionListEl.appendChild(empty)
    return
  }

  for (const version of versions) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `version-item ${selectedVersionId === version.id ? 'selected' : ''}`
    item.dataset.versionId = version.id
    item.innerHTML = `
      <strong>${escapeHtml(version.message)}</strong>
      <span>${new Date(version.createdAt).toLocaleString()} · ${version.chars.toLocaleString()} chars</span>
      <small>${escapeHtml(version.hash)}</small>
    `
    item.addEventListener('click', () => {
      selectedVersionId = version.id
      renderVersions()
    })
    versionListEl.appendChild(item)
  }
}

function escapeHtml(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#039;')
}


function inlineMarkdown(value: string): string {
  let html = escapeHtml(value)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')
  return html
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const html: string[] = []
  let inList = false
  let inCode = false
  let paragraph: string[] = []

  const closeParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const closeList = () => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      closeParagraph()
      closeList()
      inCode = !inCode
      html.push(inCode ? '<pre><code>' : '</code></pre>')
      continue
    }
    if (inCode) {
      html.push(escapeHtml(line))
      continue
    }
    if (!trimmed) {
      closeParagraph()
      closeList()
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (heading) {
      closeParagraph()
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed)
    if (bullet) {
      closeParagraph()
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`)
      continue
    }
    paragraph.push(trimmed)
  }

  closeParagraph()
  closeList()
  if (inCode) html.push('</code></pre>')
  return html.join('\n') || '<p class="empty">Nothing to preview yet.</p>'
}

function markdownToG2Text(markdown: string): string {
  return markdown
    .replace(/^###\s+/gm, '▸ ')
    .replace(/^##\s+/gm, '■ ')
    .replace(/^#\s+/gm, '◆ ')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^[-*+]\s+/gm, '• ')
}

function updateMarkdownPreview() {
  markdownPreviewEl.innerHTML = markdownToHtml(activeDoc().body)
}

function renderSettings() {
  autoSnapshotMinutesEl.value = String(state.settings.autoSnapshotMinutes)
  g2PageSizeEl.value = String(state.settings.g2PageSize)
}

function renderActiveDoc() {
  const doc = activeDoc()
  docTitleEl.value = doc.title
  editorEl.value = doc.body
  editorEl.setSelectionRange(Math.min(doc.cursor, doc.body.length), Math.min(doc.cursor, doc.body.length))
  renderDocs()
  renderVersions()
  updateCharCount()
  updateMarkdownPreview()
  updateG2Meta()
  scheduleG2Update(true)
  keepTryingFocus()
}

function renderAll() {
  renderSettings()
  renderActiveDoc()
}

function createSnapshot(message = 'Manual snapshot') {
  syncActiveDocFromForm()
  const doc = activeDoc()
  const hash = contentHash(doc)
  const version: VersionRecord = {
    id: makeId('ver'),
    docId: doc.id,
    title: doc.title,
    body: doc.body,
    createdAt: Date.now(),
    message,
    chars: doc.body.length,
    hash,
  }
  state.versions.push(version)
  doc.lastSnapshotHash = hash
  doc.lastAutoSnapshotAt = Date.now()
  selectedVersionId = version.id
  state.updatedAt = Date.now()
  renderVersions()
  void saveNow('snapshot')
}

function maybeAutoSnapshot() {
  const doc = activeDoc()
  const minutes = Math.max(1, state.settings.autoSnapshotMinutes)
  const due = Date.now() - Number(doc.lastAutoSnapshotAt || 0) > minutes * 60_000
  const hash = contentHash(doc)
  if (due && doc.body.trim() && hash !== doc.lastSnapshotHash) {
    createSnapshot('Auto snapshot')
  }
}

function createNewDoc() {
  syncActiveDocFromForm()
  const now = Date.now()
  const doc: DocRecord = {
    id: makeId('doc'),
    title: `New doc ${state.docs.length + 1}`,
    body: '',
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    g2Page: 0,
    followCursor: true,
  }
  state.docs.push(doc)
  state.activeDocId = doc.id
  selectedVersionId = ''
  state.updatedAt = now
  renderActiveDoc()
  void saveNow('new doc')
}

function deleteActiveDoc() {
  const doc = activeDoc()
  if (state.docs.length <= 1) {
    doc.title = 'Untitled G2 Doc'
    doc.body = ''
    doc.cursor = 0
    doc.g2Page = 0
    doc.followCursor = true
    state.versions = state.versions.filter((version) => version.docId !== doc.id)
  } else {
    state.docs = state.docs.filter((candidate) => candidate.id !== doc.id)
    state.versions = state.versions.filter((version) => version.docId !== doc.id)
    state.activeDocId = state.docs[0].id
  }
  selectedVersionId = ''
  state.updatedAt = Date.now()
  renderActiveDoc()
  void saveNow('delete doc')
}

function restoreSelectedVersion() {
  if (!selectedVersionId) {
    showSave('Select a snapshot first', 'error')
    return
  }
  const version = state.versions.find((candidate) => candidate.id === selectedVersionId)
  if (!version) {
    showSave('Snapshot not found', 'error')
    return
  }
  const doc = activeDoc()
  doc.title = version.title
  doc.body = version.body
  doc.cursor = version.body.length
  doc.g2Page = pageForCursor(doc)
  doc.followCursor = true
  doc.updatedAt = Date.now()
  state.updatedAt = Date.now()
  renderActiveDoc()
  void saveNow('restore snapshot')
}

function exportBackup() {
  syncActiveDocFromForm()
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `g2-docs-keyboard-backup-${new Date().toISOString().slice(0, 19).split(':').join('-')}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

async function importBackupFile(file: File) {
  try {
    const text = await file.text()
    const imported = cleanState(JSON.parse(text))
    state = imported
    selectedVersionId = ''
    renderAll()
    await saveNow('import backup')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showSave(`Import failed: ${message}`, 'error')
  } finally {
    importFileEl.value = ''
  }
}

function focusEditor() {
  editorEl.focus({ preventScroll: true })
  const doc = activeDoc()
  const cursor = Math.min(doc.cursor || editorEl.value.length, editorEl.value.length)
  editorEl.setSelectionRange(cursor, cursor)
}

function keepTryingFocus() {
  for (const delay of [40, 120, 300, 700, 1300, 2200]) {
    window.setTimeout(focusEditor, delay)
  }
}

async function connectBridge() {
  setPill(bridgeStatusEl, 'Bridge: connecting', 'waiting')
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    storageMode = bridge?.setLocalStorage && bridge?.getLocalStorage ? 'bridge' : 'browser'
    setPill(bridgeStatusEl, 'Bridge: connected', 'ready')
    showStorage(storageMode === 'bridge' ? 'Using Even App local storage' : 'Using browser fallback storage', storageMode === 'bridge' ? 'ready' : 'waiting')

    if (bridge.onEvenHubEvent) {
      bridge.onEvenHubEvent((event: any) => {
        if (event?.listEvent) handleListEvent(event.listEvent)
        if (event?.textEvent) handleTextEvent(event.textEvent)
        const eventType = event?.textEvent?.eventType ?? event?.sysEvent?.eventType
        if (eventType === OsEventTypeList?.FOREGROUND_ENTER_EVENT || eventType === 4) {
          startupPageCreated = false
          g2Layout = ''
          lastSentToGlasses = ''
          scheduleG2Update(true)
          keepTryingFocus()
          void saveNow('foreground')
        }
        if (eventType === OsEventTypeList?.FOREGROUND_EXIT_EVENT || eventType === OsEventTypeList?.SYSTEM_EXIT_EVENT || eventType === 5 || eventType === 7) {
          void saveNow('exit')
        }
      })
    }
  } catch (error) {
    console.warn('[G2DocsKeyboard] bridge unavailable:', error)
    bridge = null
    storageMode = 'browser'
    setPill(bridgeStatusEl, 'Bridge: browser preview', 'waiting')
    showStorage('Using browser fallback. EHPK should show Even App storage.', 'waiting')
  }
}

async function loadInitialState() {
  try {
    const loaded = await loadStateFromStorage(false)
    if (loaded) {
      state = loaded
      lastSavedHash = simpleHash(JSON.stringify(state))
      const meta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
      showStorage(`${storageMode === 'bridge' ? 'Even App' : 'Browser'} storage loaded · ${state.docs.length} docs · ${state.versions.length} snapshots · ${(Number(meta.bytes || 0) / 1024).toFixed(1)} KB`, 'ready')
    } else {
      showStorage(`${storageMode === 'bridge' ? 'Even App' : 'Browser'} storage ready · new vault`, 'ready')
      await saveNow('initial')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[G2DocsKeyboard] load failed:', error)
    showStorage(`Load failed: ${message}`, 'error')
    showSave('Using unsaved emergency doc', 'error')
  }
}

async function verifyStorage() {
  try {
    syncActiveDocFromForm()
    await saveStateToStorage()
    const loaded = await loadStateFromStorage(false)
    if (!loaded) throw new Error('Nothing loaded after saving')
    const before = simpleHash(JSON.stringify(state))
    const after = simpleHash(JSON.stringify(loaded))
    if (before !== after) throw new Error(`Hash mismatch ${before} !== ${after}`)
    const meta = safeParse<Partial<StorageMeta>>(await storageGet(META_KEY), {})
    showStorage(`Verified ${storageMode === 'bridge' ? 'Even App' : 'Browser'} storage · ${Number(meta.chunkCount || 0)} chunks · ${(Number(meta.bytes || 0) / 1024).toFixed(1)} KB`, 'ready')
    showSave(`Verified ${nowTime()}`, 'ready')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showStorage(`Verify failed: ${message}`, 'error')
    showSave(`Verify failed: ${message}`, 'error')
  }
}


function openGlassesMenu() {
  syncActiveDocFromForm()
  g2Mode = 'menu'
  startupPageCreated = false
  lastSentToGlasses = ''
  updateG2Meta()
  scheduleG2Update(true)
}

function closeGlassesMenu() {
  g2Mode = 'document'
  startupPageCreated = false
  lastSentToGlasses = ''
  updateG2Meta()
  scheduleG2Update(true)
}

function pagePreviousFromGlasses() {
  const doc = activeDoc()
  doc.followCursor = false
  doc.g2Page = Math.max(0, clampPage(doc) - 1)
  updateG2Meta()
  markDirtyAndSave('glasses previous page')
}

function pageNextFromGlasses() {
  const doc = activeDoc()
  doc.followCursor = false
  doc.g2Page = Math.min(totalPagesFor(doc.body) - 1, clampPage(doc) + 1)
  updateG2Meta()
  markDirtyAndSave('glasses next page')
}

function restoreLatestSnapshot() {
  const doc = activeDoc()
  const latest = state.versions
    .filter((version) => version.docId === doc.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!latest) {
    showSave('No snapshot to restore', 'error')
    return
  }
  selectedVersionId = latest.id
  restoreSelectedVersion()
}

function handleG2MenuAction(item: G2MenuItem) {
  if (item.action === 'open-doc' && item.docId) {
    syncActiveDocFromForm()
    state.activeDocId = item.docId
    selectedVersionId = ''
    renderActiveDoc()
    openGlassesMenu()
    void saveNow('glasses doc switch')
    return
  }
  if (item.action === 'snapshot') {
    createSnapshot('Glasses snapshot')
    openGlassesMenu()
    return
  }
  if (item.action === 'restore-latest') {
    restoreLatestSnapshot()
    openGlassesMenu()
    return
  }
  if (item.action === 'restore-snapshot' && item.versionId) {
    selectedVersionId = item.versionId
    restoreSelectedVersion()
    openGlassesMenu()
    return
  }
  if (item.action === 'new-doc') {
    createNewDoc()
    openGlassesMenu()
    return
  }
  if (item.action === 'next-page') {
    pageNextFromGlasses()
    return
  }
  if (item.action === 'prev-page') {
    pagePreviousFromGlasses()
    return
  }
  if (item.action === 'follow-cursor') {
    const doc = activeDoc()
    doc.followCursor = true
    doc.g2Page = pageForCursor(doc)
    updateG2Meta()
    markDirtyAndSave('glasses follow cursor')
    return
  }
  closeGlassesMenu()
}

function handleListEvent(listEvent: any) {
  const item = menuItems.find((candidate, index) => (
    candidate.label === listEvent?.currentSelectItemName || index === Number(listEvent?.currentSelectItemIndex)
  ))
  if (item) handleG2MenuAction(item)
}

function handleTextEvent(textEvent: any) {
  if (textEvent?.containerID !== EVENT_CONTAINER_ID && textEvent?.containerName !== EVENT_CONTAINER_NAME) return
  pageNextFromGlasses()
}

function wireEvents() {
  editorEl.addEventListener('compositionstart', () => { composing = true })
  editorEl.addEventListener('compositionend', () => {
    composing = false
    markDirtyAndSave('composition')
  })
  editorEl.addEventListener('input', () => {
    if (composing) return
    markDirtyAndSave('typing')
  })
  editorEl.addEventListener('keyup', () => {
    const doc = activeDoc()
    doc.cursor = editorEl.selectionStart ?? doc.cursor
    if (doc.followCursor) doc.g2Page = pageForCursor(doc)
    updateG2Meta()
    scheduleG2Update()
  })
  editorEl.addEventListener('click', () => {
    const doc = activeDoc()
    doc.cursor = editorEl.selectionStart ?? doc.cursor
    if (doc.followCursor) doc.g2Page = pageForCursor(doc)
    updateG2Meta()
    scheduleG2Update()
  })
  docTitleEl.addEventListener('input', () => markDirtyAndSave('title'))
  docSelectEl.addEventListener('change', () => {
    syncActiveDocFromForm()
    state.activeDocId = docSelectEl.value
    selectedVersionId = ''
    renderActiveDoc()
    void saveNow('switch doc')
  })
  newDocButton.addEventListener('click', createNewDoc)
  snapshotButton.addEventListener('click', () => createSnapshot('Manual snapshot'))
  restoreButton.addEventListener('click', restoreSelectedVersion)
  deleteDocButton.addEventListener('click', deleteActiveDoc)
  exportButton.addEventListener('click', exportBackup)
  importButton.addEventListener('click', () => importFileEl.click())
  importFileEl.addEventListener('change', () => {
    const file = importFileEl.files?.[0]
    if (file) void importBackupFile(file)
  })
  focusButton.addEventListener('click', focusEditor)
  prevPageButton.addEventListener('click', () => {
    const doc = activeDoc()
    doc.followCursor = false
    doc.g2Page = Math.max(0, clampPage(doc) - 1)
    updateG2Meta()
    markDirtyAndSave('page')
  })
  nextPageButton.addEventListener('click', () => {
    const doc = activeDoc()
    doc.followCursor = false
    doc.g2Page = Math.min(totalPagesFor(doc.body) - 1, clampPage(doc) + 1)
    updateG2Meta()
    markDirtyAndSave('page')
  })
  glassesMenuButton.addEventListener('click', () => {
    if (g2Mode === 'menu') closeGlassesMenu()
    else openGlassesMenu()
  })
  tailButton.addEventListener('click', () => {
    const doc = activeDoc()
    doc.followCursor = true
    doc.cursor = editorEl.selectionStart ?? doc.body.length
    doc.g2Page = pageForCursor(doc)
    updateG2Meta()
    markDirtyAndSave('follow cursor')
  })
  sendTestButton.addEventListener('click', () => void pushToG2(TEST_TEXT, true))
  saveNowButton.addEventListener('click', () => void saveNow('manual'))
  verifyStorageButton.addEventListener('click', () => void verifyStorage())
  reloadLocalButton.addEventListener('click', async () => {
    const loaded = await loadStateFromStorage(true)
    if (loaded) {
      state = loaded
      selectedVersionId = ''
      renderAll()
      showSave(`Reloaded ${nowTime()}`, 'ready')
    }
  })
  dangerWipeButton.addEventListener('click', async () => {
    await wipeStorage()
    state = makeDefaultState()
    selectedVersionId = ''
    renderAll()
    await saveNow('wipe reset')
  })
  autoSnapshotMinutesEl.addEventListener('change', () => {
    state.settings.autoSnapshotMinutes = Math.max(1, Math.min(120, Number(autoSnapshotMinutesEl.value || 5)))
    markDirtyAndSave('settings')
  })
  g2PageSizeEl.addEventListener('change', () => {
    state.settings.g2PageSize = Math.max(300, Math.min(1800, Number(g2PageSizeEl.value || 1200)))
    updateG2Meta()
    markDirtyAndSave('settings')
  })

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault()
      createSnapshot('Keyboard snapshot')
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'n') {
      event.preventDefault()
      createNewDoc()
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'e') {
      event.preventDefault()
      exportBackup()
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      prevPageButton.click()
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault()
      nextPageButton.click()
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void saveNow('hidden')
    } else {
      keepTryingFocus()
      startupPageCreated = false
      g2Layout = ''
      lastSentToGlasses = ''
      scheduleG2Update(true)
    }
  })
  window.addEventListener('pagehide', () => {
    emergencyBrowserMirror()
    void saveNow('pagehide')
  })
  window.addEventListener('beforeunload', () => {
    emergencyBrowserMirror()
  })
}

async function boot() {
  wireEvents()
  keepTryingFocus()
  await connectBridge()
  await loadInitialState()
  renderAll()
  startG2Poll()
  void verifyStorage()
}

void boot()