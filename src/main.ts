import './style.css'
import 'leaflet/dist/leaflet.css'
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
import {
  divIcon,
  icon,
  latLngBounds,
  layerGroup,
  map as createMap,
  marker,
  tileLayer,
  type LayerGroup,
  type Map as LeafletMap,
  type Marker,
} from 'leaflet'
import { loadExamSites, type ExamSite } from './exam-sites.ts'
import { formatDistance, formatDuration } from './format.ts'

type Origin = {
  lat: number
  lon: number
  label: string
}

type RouteSummary = {
  duration: number
  distance: number
}

const NOMINATIM_PAUSE_MS = 1100
const GIL_LEVEL_QUERY = /.*길 \d*-?\d*/
const RO_LEVEL_QUERY = /.*로 \d*-?\d*/
const SEOUL_CENTER: [number, number] = [37.5665, 126.978]

const examSites = loadExamSites()
const siteIcon = icon({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIconRetinaUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

let map: LeafletMap
let markersGroup: LayerGroup
let startMarker: Marker | null = null
let pinnedOrigin: Origin | null = null
let deviceOrigin: Origin | null = null
let lastOrigin: Origin | null = null
let userEditedOrigin = false
let locationRequestId = 0
let selectedSite: ExamSite | null = null
let geocodeTail: Promise<unknown> = Promise.resolve()

const siteTokens = new Map<number, number>()
const siteMarkers = new Map<number, Marker>()
const rowByKey = new Map<number, HTMLTableRowElement>()

const originForm = requireElement<HTMLFormElement>('originForm')
const startAddress = requireElement<HTMLInputElement>('startAddress')
const locateBtn = requireElement<HTMLButtonElement>('locateBtn')
const calcBtn = requireElement<HTMLButtonElement>('calcBtn')
const statusText = requireElement<HTMLElement>('statusText')
const selectedMarkerInfo = requireElement<HTMLElement>('selectedMarkerInfo')

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}

function start(): void {
  map = createMap('map').setView(SEOUL_CENTER, 12)
  tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)
  markersGroup = layerGroup().addTo(map)
  requestAnimationFrame(() => {
    map.invalidateSize()
  })

  renderTable()
  statusText.textContent = `고사장 ${examSites.length}곳을 불러왔습니다. 현재 위치를 확인하는 중...`
  void useCurrentLocation(false)
}

originForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void calculateAll()
})

locateBtn.addEventListener('click', () => {
  void useCurrentLocation(true)
})

startAddress.addEventListener('input', () => {
  if (pinnedOrigin && startAddress.value.trim() === pinnedOrigin.label) {
    deviceOrigin = pinnedOrigin
    userEditedOrigin = false
    return
  }
  deviceOrigin = null
  userEditedOrigin = true
})

async function useCurrentLocation(force: boolean): Promise<void> {
  if (!('geolocation' in navigator)) {
    statusText.textContent = '이 브라우저는 현재 위치를 지원하지 않습니다. 출발지 주소를 입력하세요.'
    startAddress.placeholder = '출발지 주소 입력 (예: 서울시청)'
    return
  }

  const requestId = ++locationRequestId
  locateBtn.disabled = true
  statusText.textContent = '현재 위치를 확인하는 중...'

  try {
    const position = await requestCurrentPosition()
    if (requestId !== locationRequestId) return
    const lat = position.coords.latitude
    const lon = position.coords.longitude
    const placeName = await reverseGeocode(lat, lon)
    if (requestId !== locationRequestId) return
    const label = placeName ?? `현재 위치 (${lat.toFixed(5)}, ${lon.toFixed(5)})`
    pinnedOrigin = { lat, lon, label }

    if (!force && userEditedOrigin) {
      statusText.textContent = '현재 위치를 찾았지만, 입력한 출발지를 유지합니다.'
      return
    }

    deviceOrigin = pinnedOrigin
    userEditedOrigin = false
    startAddress.value = label
    placeStartMarker(pinnedOrigin)
    map.setView([lat, lon], 13)
    statusText.textContent = '출발지를 현재 위치로 설정했습니다. 계산 버튼을 누르세요.'
  } catch (error) {
    if (requestId !== locationRequestId) return
    startAddress.placeholder = '출발지 주소 입력 (예: 서울시청)'
    statusText.textContent = geolocationErrorMessage(error)
  } finally {
    if (requestId === locationRequestId) locateBtn.disabled = false
  }
}

function requestCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 60_000,
    })
  })
}

function geolocationErrorMessage(error: unknown): string {
  if (error instanceof GeolocationPositionError) {
    if (error.code === error.PERMISSION_DENIED) {
      return '위치 권한이 거부되었습니다. 출발지 주소를 직접 입력하세요.'
    }
    if (error.code === error.TIMEOUT) {
      return '현재 위치를 가져오는 시간이 초과되었습니다. 내 위치를 다시 누르거나 주소를 입력하세요.'
    }
  }
  return '현재 위치를 가져오지 못했습니다. 출발지 주소를 직접 입력하세요.'
}

async function calculateAll(): Promise<void> {
  const typed = startAddress.value.trim()
  if (!typed && !deviceOrigin) {
    window.alert('출발지를 확인하지 못했습니다. 내 위치를 누르거나 주소를 입력하세요.')
    return
  }

  calcBtn.disabled = true
  calcBtn.textContent = '계산 중...'
  statusText.textContent = '출발지 좌표를 확인하는 중...'

  try {
    const origin = await resolveStart(typed)
    if (!origin) {
      window.alert('출발지 주소를 찾을 수 없습니다. 더 자세한 주소를 입력하세요.')
      statusText.textContent = '출발지 지오코딩 실패'
      return
    }

    lastOrigin = origin
    placeStartMarker(origin)
    markersGroup.clearLayers()
    siteMarkers.clear()

    for (const site of examSites) {
      site.duration = null
      site.distance = null
      site.lookup = 'idle'
    }
    renderTable()

    const queue = [...examSites]
    for (let index = 0; index < queue.length; index += 1) {
      const site = queue[index]
      if (!site) continue
      statusText.textContent = `산출 중 (${index + 1}/${queue.length}): ${site.name}`
      await refreshSite(site, origin, false)
    }

    const bounds = latLngBounds([[origin.lat, origin.lon]])
    for (const site of examSites) {
      if (site.lat !== null && site.lon !== null) bounds.extend([site.lat, site.lon])
    }
    map.fitBounds(bounds, { padding: [50, 50] })
    statusText.textContent = '계산 완료. 가까운 순서대로 정렬했습니다. 좌표 없음은 주소를 수정하세요.'
  } catch (error) {
    console.error(error)
    statusText.textContent = '계산 중 오류가 발생했습니다. 다시 시도하세요.'
  } finally {
    calcBtn.disabled = false
    calcBtn.textContent = '거리/시간 계산'
  }
}

async function resolveStart(typed: string): Promise<Origin | null> {
  if (deviceOrigin && typed === deviceOrigin.label) return deviceOrigin
  if (!typed) return deviceOrigin
  const coords = await geocode(typed)
  if (!coords) return null
  return { lat: coords.lat, lon: coords.lon, label: typed }
}

function placeStartMarker(origin: Origin): void {
  if (startMarker) map.removeLayer(startMarker)
  startMarker = marker([origin.lat, origin.lon], {
    alt: '출발지',
    zIndexOffset: 1000,
    icon: divIcon({
      className: 'origin-marker',
      html: '<div style="background:#4f46e5;color:white;padding:4px 8px;border-radius:4px;font-weight:700;font-size:11px;box-shadow:0 2px 4px rgba(0,0,0,0.2);white-space:nowrap;">출발지</div>',
      iconSize: [52, 24],
      iconAnchor: [26, 24],
    }),
  })
    .addTo(map)
    .bindPopup(`<b>출발지</b><br>${escapeHtml(origin.label)}`)
}

async function refreshSite(site: ExamSite, origin: Origin, focus: boolean): Promise<void> {
  const token = (siteTokens.get(site.key) ?? 0) + 1
  siteTokens.set(site.key, token)
  site.duration = null
  site.distance = null
  site.lookup = 'searching'
  updateSiteRow(site)

  const coords = site.lat !== null && site.lon !== null
    ? { lat: site.lat, lon: site.lon }
    : await geocodeQueued(site.address)
  if (siteTokens.get(site.key) !== token) return

  if (!coords) {
    site.lat = null
    site.lon = null
    site.lookup = 'missing'
    syncSiteMarker(site)
    publishSite(site)
    return
  }

  site.lat = coords.lat
  site.lon = coords.lon
  const route = await fetchOsrm(origin.lon, origin.lat, site.lon, site.lat)
  if (siteTokens.get(site.key) !== token) return

  if (route) {
    site.duration = route.duration
    site.distance = route.distance
  }
  site.lookup = 'ready'
  syncSiteMarker(site)
  publishSite(site)
  if (focus && site.lat !== null && site.lon !== null) focusOnSite(site)
}

function roadLevelQueries(address: string): string[] {
  const trimmed = address.trim()
  const queries: string[] = []
  for (const pattern of [GIL_LEVEL_QUERY, RO_LEVEL_QUERY]) {
    const matched = address.match(pattern)?.[0]?.trim()
    if (!matched || !/\d/.test(matched) || matched === trimmed) continue
    if (!queries.includes(matched)) queries.push(matched)
  }
  return queries
}

function geocodeQueued(address: string): Promise<{ lat: number; lon: number } | null> {
  const job = geocodeTail.then(() => geocodeWithRoadFallback(address))
  geocodeTail = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}

async function geocodeWithRoadFallback(address: string): Promise<{ lat: number; lon: number } | null> {
  const direct = await geocode(address)
  await pause(NOMINATIM_PAUSE_MS)
  if (direct) return direct

  for (const shortened of roadLevelQueries(address)) {
    const fallback = await geocode(shortened)
    await pause(NOMINATIM_PAUSE_MS)
    if (fallback) return fallback
  }
  return null
}

function publishSite(site: ExamSite): void {
  sortSites()
  reorderRows()
  updateSiteRow(site)
}

function sortSites(): void {
  examSites.sort((left, right) => {
    if (left.duration === null && right.duration === null) return left.key - right.key
    if (left.duration === null) return 1
    if (right.duration === null) return -1
    return left.duration - right.duration
  })
  examSites.forEach((site, index) => {
    site.id = index + 1
  })
}

function reorderRows(): void {
  const tbody = requireElement<HTMLTableSectionElement>('examTableBody')
  for (const site of examSites) {
    const row = rowByKey.get(site.key)
    if (!row) continue
    tbody.append(row)
    const indexCell = row.querySelector('[data-field="index"]')
    if (indexCell) indexCell.textContent = String(site.id)
  }
}

function syncSiteMarker(site: ExamSite): void {
  const existing = siteMarkers.get(site.key)
  if (site.lat === null || site.lon === null) {
    if (existing) {
      markersGroup.removeLayer(existing)
      siteMarkers.delete(site.key)
    }
    return
  }

  if (existing) {
    existing.setLatLng([site.lat, site.lon])
    existing.setPopupContent(popupHtml(site))
    return
  }

  const created = marker([site.lat, site.lon], { icon: siteIcon, alt: site.name })
    .addTo(markersGroup)
    .bindPopup(popupHtml(site))
  siteMarkers.set(site.key, created)
}

function popupHtml(site: ExamSite): string {
  const travel = site.duration === null
    ? '계산불가'
    : `${formatDuration(site.duration)} · ${formatDistance(site.distance ?? 0)}`
  return `<b>${escapeHtml(site.name)}</b><br>${escapeHtml(site.address)}<br>이동: ${escapeHtml(travel)}`
}

function focusOnSite(site: ExamSite): void {
  const previous = selectedSite
  selectedSite = site
  if (previous) updateSiteRow(previous)
  updateSiteRow(site)

  if (site.lat === null || site.lon === null) {
    selectedMarkerInfo.textContent = `${site.name}: 좌표 없음`
    return
  }
  map.setView([site.lat, site.lon], 15)
  const travel = site.duration === null ? '시간 미산출' : formatDuration(site.duration)
  selectedMarkerInfo.textContent = `선택: ${site.name} (${travel})`
}

function renderTable(): void {
  const tbody = requireElement<HTMLTableSectionElement>('examTableBody')
  tbody.replaceChildren()
  rowByKey.clear()

  for (const site of examSites) {
    const row = document.createElement('tr')
    row.addEventListener('click', () => {
      focusOnSite(site)
    })
    row.append(
      fieldCell('index', String(site.id), 'num'),
      cell(site.region, 'region'),
      cell(site.name, 'place-name'),
      addressCell(site),
      cell(`${site.seats}석`, 'num'),
      durationCell(site),
    )
    paintRow(row, site)
    rowByKey.set(site.key, row)
    tbody.append(row)
  }
}

function updateSiteRow(site: ExamSite): void {
  const row = rowByKey.get(site.key)
  if (!row) return
  const indexCell = row.querySelector('[data-field="index"]')
  if (indexCell) indexCell.textContent = String(site.id)
  const duration = row.querySelector<HTMLTableCellElement>('[data-field="duration"]')
  if (duration) fillDurationCell(duration, site)
  const address = row.querySelector<HTMLTableCellElement>('[data-field="address"]')
  if (address) syncAddressCell(address, site)
  paintRow(row, site)
}

function paintRow(row: HTMLTableRowElement, site: ExamSite): void {
  row.className = 'exam-row'
  row.dataset.state = site === selectedSite ? 'selected' : site.lookup
}

function cell(text: string, className: string): HTMLTableCellElement {
  const td = document.createElement('td')
  td.className = className
  td.textContent = text
  return td
}

function fieldCell(field: string, text: string, className: string): HTMLTableCellElement {
  const td = cell(text, className)
  td.dataset.field = field
  return td
}

function addressCell(site: ExamSite): HTMLTableCellElement {
  const td = document.createElement('td')
  td.dataset.field = 'address'
  td.className = ''
  syncAddressCell(td, site)
  return td
}

function syncAddressCell(td: HTMLTableCellElement, site: ExamSite): void {
  const input = td.querySelector('input')
  if (site.lookup === 'missing') {
    if (input instanceof HTMLInputElement) {
      if (document.activeElement !== input && input.value !== site.address) input.value = site.address
      return
    }
    td.replaceChildren(buildAddressEditor(site))
    return
  }

  if (site.lookup === 'searching' && input instanceof HTMLInputElement && document.activeElement === input) return
  td.replaceChildren(document.createTextNode(site.address))
  td.title = site.address
}

function buildAddressEditor(site: ExamSite): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col gap-1'
  const input = document.createElement('input')
  input.type = 'text'
  input.value = site.address
  input.ariaLabel = `${site.name} 주소`
  input.title = '주소를 수정한 뒤 Enter'
  input.setAttribute('aria-invalid', 'true')
  input.enterKeyHint = 'search'
  input.className = 'w-full min-w-64 px-2 py-1 rounded border border-rose-300 bg-white text-slate-800 font-sans focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300'
  input.addEventListener('click', (event) => {
    event.stopPropagation()
  })
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key !== 'Enter') return
    event.preventDefault()
    input.blur()
  })
  input.addEventListener('change', () => {
    commitAddress(site, input)
  })

  const hint = document.createElement('span')
  hint.className = 'text-[11px] text-rose-600'
  hint.textContent = '좌표를 찾지 못했습니다. 주소를 수정하세요.'
  wrap.append(input, hint)
  return wrap
}

function commitAddress(site: ExamSite, input: HTMLInputElement): void {
  const next = input.value.trim()
  if (!next || next === site.address) {
    input.value = site.address
    return
  }
  site.address = next
  site.lat = null
  site.lon = null
  site.duration = null
  site.distance = null
  const origin = lastOrigin
  if (!origin) {
    statusText.textContent = '출발지를 먼저 설정한 뒤 계산하세요.'
    return
  }
  void refreshSite(site, origin, true)
}

function durationCell(site: ExamSite): HTMLTableCellElement {
  const td = document.createElement('td')
  td.dataset.field = 'duration'
  fillDurationCell(td, site)
  return td
}

function fillDurationCell(td: HTMLTableCellElement, site: ExamSite): void {
  td.className = 'num'
  td.replaceChildren()

  if (site.lookup === 'searching') {
    td.append(mutedSpan('검색 중'))
    return
  }
  if (site.lookup === 'missing') {
    const missing = document.createElement('span')
    missing.className = 'text-rose-600 font-normal'
    missing.textContent = '좌표 없음'
    td.append(missing)
    return
  }
  if (site.lookup !== 'ready' || site.duration === null) {
    td.append(mutedSpan(site.lookup === 'ready' ? '계산불가' : '미산출'))
    return
  }

  td.append(document.createTextNode(formatDuration(site.duration)))
  if (site.distance !== null) {
    const distance = document.createElement('span')
    distance.className = 'block text-slate-400 font-normal'
    distance.textContent = formatDistance(site.distance)
    td.append(distance)
  }
}

function mutedSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'text-slate-400 font-normal'
  span.textContent = text
  return span
}

async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`
    const response = await fetch(url, { headers: { 'Accept-Language': 'ko' } })
    if (!response.ok) return null
    const data = (await response.json()) as { lat?: string; lon?: string }[]
    const first = data[0]
    if (!first?.lat || !first.lon) return null
    const lat = Number.parseFloat(first.lat)
    const lon = Number.parseFloat(first.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  } catch (error) {
    console.error('Geocoding error:', error)
    return null
  }
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`
    const response = await fetch(url, { headers: { 'Accept-Language': 'ko' } })
    if (!response.ok) return null
    const data = (await response.json()) as { display_name?: string }
    const name = data.display_name?.trim()
    return name || null
  } catch (error) {
    console.error('Reverse geocoding error:', error)
    return null
  }
}

async function fetchOsrm(startLon: number, startLat: number, endLon: number, endLat: number): Promise<RouteSummary | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=false`
    const response = await fetch(url)
    if (!response.ok) return null
    const data = (await response.json()) as {
      code?: string
      routes?: { duration: number; distance: number }[]
    }
    const route = data.code === 'Ok' ? data.routes?.[0] : undefined
    if (!route) return null
    return { duration: route.duration, distance: route.distance }
  } catch (error) {
    console.error('OSRM routing error:', error)
    return null
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}
