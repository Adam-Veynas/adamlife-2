import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { palettes } from '../theme/palettes'

describe('подготовка PWA', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'))
  it('имеет единое имя, scope и утверждённый цвет Graphite', () => {
    expect(manifest).toMatchObject({ name: 'AdamLife', display: 'standalone', scope: '/', start_url: '/', theme_color: palettes[0].colors.bg, background_color: palettes[0].colors.bg })
  })
  it('содержит настоящие PNG нужных размеров, включая Apple touch icon', () => {
    for (const size of [180, 192, 512]) {
      const path = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`
      const png = readFileSync(new URL(`../../public/icons/${path}`, import.meta.url))
      expect(png.toString('ascii', 1, 4)).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(size); expect(png.readUInt32BE(20)).toBe(size)
    }
  })
  it('имеет iOS meta, safe viewport и не отключает масштабирование', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    expect(html).toContain('viewport-fit=cover'); expect(html).toContain('apple-mobile-web-app-capable'); expect(html).toContain('rel="apple-touch-icon"'); expect(html).not.toContain('user-scalable=no')
  })
})
