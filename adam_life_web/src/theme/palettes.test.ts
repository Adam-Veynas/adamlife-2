import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { categoryColor, palettes } from './palettes'

function luminance(hex: string): number {
  const values = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + .05) / (values[1] + .05)
}

describe.each(palettes)('$name: читаемость и семантика', palette => {
  it('основной, второстепенный и приглушённый текст читается на всех основных поверхностях', () => {
    for (const foreground of ['text', 'text-secondary', 'muted', 'quiet'] as const) {
      for (const background of ['bg', 'surface', 'surface-high', 'surface-input', 'accent-soft'] as const) {
        expect(contrast(palette.colors[foreground], palette.colors[background]), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('контраст текста основной и опасной кнопок достаточен', () => {
    for (const background of ['accent', 'accent-hover', 'danger', 'danger-hover'] as const) {
      expect(contrast(palette.colors['on-accent'], palette.colors[background]), background).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('доходы и расходы сохраняют контраст и разные цвета', () => {
    for (const semantic of ['positive', 'negative'] as const) {
      expect(contrast(palette.colors[semantic], palette.colors.surface)).toBeGreaterThanOrEqual(4.5)
    }
    expect(palette.colors.positive).not.toBe(palette.colors.negative)
  })
  it('категории не используют зелёный цвет дохода', () => {
    for (let index = 1; index <= 8; index++) {
      const value = palette.colors[`category-${index}` as keyof typeof palette.colors]
      const [r, g, b] = [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16))
      expect(g > r && g > b, `category-${index} must not be semantic green`).toBe(false)
    }
  })
})

describe('централизованная система палитр', () => {
  it('закрепляет утверждённый Graphite', () => {
    expect(palettes.map(palette => palette.name)).toEqual(['Obsidian Graphite'])
  })
  it('не оставляет прямых цветов и старых зелёных заливок в стилях', () => {
    for (const path of ['../styles.css', './theme.css', '../ux.css']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toMatch(/#[\da-f]{3,8}\b/i)
    }
    expect(readFileSync(new URL('../components/Charts.tsx', import.meta.url), 'utf8')).not.toMatch(/#[\da-f]{6}\b/i)
  })
  it('использует токены для всех категорий', () => {
    expect(categoryColor('Продукты')).toBe('var(--category-1)')
    expect(categoryColor('Здоровье')).toBe('var(--category-7)')
    expect(categoryColor('Неизвестная категория')).toBe('var(--category-8)')
  })
  it('не меняет тему по URL и не содержит временного переключателя', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const definitions = readFileSync(new URL('./palettes.ts', import.meta.url), 'utf8')
    expect(app).not.toContain('PaletteSwitcher')
    expect(definitions).not.toMatch(/localStorage|sessionStorage|URLSearchParams|\.setItem\(/)
  })
})
