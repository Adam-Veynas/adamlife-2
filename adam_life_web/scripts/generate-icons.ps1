# Reproducible rasterization of the existing A monogram; no external dependencies.
Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'public\icons'
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
foreach ($iconSpec in @(@(180, 'apple-touch-icon.png'), @(192, 'icon-192.png'), @(512, 'icon-512.png'))) {
  $iconSize = [int]$iconSpec[0]
  $bitmap = [System.Drawing.Bitmap]::new($iconSize, $iconSize)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#191b1f'))
  $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#a6b5cc'), $iconSize * .055)
  $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new($iconSize * .29, $iconSize * .71), [System.Drawing.PointF]::new($iconSize * .5, $iconSize * .29), [System.Drawing.PointF]::new($iconSize * .71, $iconSize * .71))
  $graphics.DrawLines($pen, $points)
  $graphics.DrawLine($pen, [single]($iconSize * .39), [single]($iconSize * .52), [single]($iconSize * .61), [single]($iconSize * .52))
  $bitmap.Save((Join-Path $iconDirectory $iconSpec[1]), [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
