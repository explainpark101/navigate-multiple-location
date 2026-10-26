import dataHtml from '../data.html?raw'

export type SiteLookup = 'idle' | 'searching' | 'missing' | 'ready'

export type ExamSite = {
  key: number
  id: number
  region: string
  name: string
  address: string
  seats: number
  lat: number | null
  lon: number | null
  duration: number | null
  distance: number | null
  lookup: SiteLookup
}

export function loadExamSites(): ExamSite[] {
  const parsed = new DOMParser().parseFromString(dataHtml, 'text/html')
  const sites: ExamSite[] = []

  for (const row of parsed.querySelectorAll('tbody tr')) {
    const cells = row.querySelectorAll('td')
    const name = cells[2]?.textContent?.trim() ?? ''
    const address = cells[3]?.textContent?.trim() ?? ''
    if (!name || !address) continue

    const sourceNo = Number.parseInt(cells[0]?.textContent?.trim() ?? '', 10)
    const key = sites.length + 1
    sites.push({
      key,
      id: Number.isFinite(sourceNo) ? sourceNo : key,
      region: cells[1]?.textContent?.trim() ?? '',
      name,
      address,
      seats: Number.parseInt(cells[5]?.textContent?.trim() ?? '', 10) || 0,
      lat: null,
      lon: null,
      duration: null,
      distance: null,
      lookup: 'idle',
    })
  }

  return sites
}
