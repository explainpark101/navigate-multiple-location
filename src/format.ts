import { Temporal } from '@js-temporal/polyfill'

type DurationFields = {
  hours?: number
  minutes?: number
}

type DurationFormatter = {
  format: (duration: DurationFields) => string
}

function formatWithIntl(fields: DurationFields): string | null {
  const intl = Intl as typeof Intl & {
    DurationFormat?: new (
      locales: string,
      options: { style: 'long' },
    ) => DurationFormatter
  }
  if (!intl.DurationFormat) return null
  return new intl.DurationFormat('ko', { style: 'long' }).format(fields)
}

export function formatDuration(seconds: number): string {
  const balanced = Temporal.Duration.from({
    seconds: Math.max(0, Math.round(seconds)),
  }).round({
    largestUnit: 'hours',
    smallestUnit: 'minutes',
    roundingMode: 'halfExpand',
  })

  const fields: DurationFields = {}
  if (balanced.hours > 0) fields.hours = balanced.hours
  if (balanced.minutes > 0 || balanced.hours === 0) fields.minutes = balanced.minutes

  const localized = formatWithIntl(fields)
  if (localized) return `약 ${localized}`

  const hours = fields.hours ?? 0
  const minutes = fields.minutes ?? 0
  if (hours <= 0) return `약 ${minutes}분`
  if (minutes === 0) return `약 ${hours}시간`
  return `약 ${hours}시간 ${minutes}분`
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}km`
  }
  return `${Math.round(meters).toLocaleString('ko-KR')}m`
}
