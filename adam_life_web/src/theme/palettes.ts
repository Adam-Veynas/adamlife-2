/** Central design tokens. Graphite is the approved, fixed application theme. */
const graphite = {
  bg: '#0d0e10',
  'surface-soft': '#121316',
  surface: '#191b1f',
  'surface-high': '#22252b',
  'surface-hover': '#292d34',
  'surface-input': '#111317',
  line: '#30343c',
  'line-strong': '#49515e',
  text: '#e8eaee',
  'text-secondary': '#b9bec8',
  muted: '#a1a9b6',
  quiet: '#919aa9',
  accent: '#a6b5cc',
  'accent-hover': '#becbe0',
  'accent-soft': '#28313f',
  'accent-border': '#52647e',
  'accent-text': '#c1cee2',
  'on-accent': '#151c27',
  positive: '#9bc1a8',
  'positive-soft': '#26362c',
  'positive-border': '#425b4a',
  negative: '#d3a0a6',
  'negative-soft': '#39292d',
  'negative-border': '#70505a',
  danger: '#c18a94',
  'danger-hover': '#d5a0a9',
  backdrop: '#07080bd1',
  shadow: '#00000066',
  'shadow-strong': '#00000088',
  'shadow-soft': '#00000033',
  'grid-subtle': '#30343c55',
  'focus-soft': '#a6b5cc22',
  'category-1': '#9aabc1',
  'category-2': '#ada3c0',
  'category-3': '#aaaeb6',
  'category-4': '#bfae9a',
  'category-5': '#8c9ebf',
  'category-6': '#bda3b3',
  'category-7': '#9994b4',
  'category-8': '#9299a5',
}

export type ThemeTokens = typeof graphite
export const palettes = [{ id: 'graphite', name: 'Obsidian Graphite', colors: graphite }]

export function applyTheme() {
  const palette = palettes[0]
  const root = document.documentElement
  root.dataset.palette = 'graphite'
  for (const [token, color] of Object.entries(palette.colors)) root.style.setProperty(`--${token}`, color)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.colors.bg)
}

const categoryTokens: Record<string, string> = {
  Продукты: 'category-1', Жильё: 'category-2', Транспорт: 'category-3',
  Развлечения: 'category-4', Кредиты: 'category-5', Покупки: 'category-6',
  Здоровье: 'category-7', Другое: 'category-8',
}

export function categoryColor(category: string): string {
  return `var(--${categoryTokens[category] ?? 'category-8'})`
}
