# 生成带真实 EXIF 的 JPEG（System.Drawing PropertyItem），供 exifr 验证
param([string]$OutDir = "$env:TEMP\sipp-exif-sample")
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$bmp = New-Object System.Drawing.Bitmap(120, 90)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::SteelBlue)
$g.FillEllipse([System.Drawing.Brushes]::Orange, 20, 20, 60, 40)
$g.Dispose()

function Add-Prop($bmp, $id, $type, [byte[]]$bytes) {
  # 借用现有 PropertyItem 作为模板
  $prop = $bmp.PropertyItems[0]
  $prop.Id = $id
  $prop.Type = $type
  $prop.Len = $bytes.Length
  $prop.Value = $bytes
  $bmp.SetPropertyItem($prop)
}

$enc = [System.Text.Encoding]::ASCII
Add-Prop $bmp 0x9003 2 $enc.GetBytes("2024:01:15 08:30:00`0")   # DateTimeOriginal
Add-Prop $bmp 0x9011 2 $enc.GetBytes("+02:00`0")                # OffsetTimeOriginal
Add-Prop $bmp 0x0132 2 $enc.GetBytes("2024:01:15 08:30:00`0")   # DateTime

$out = Join-Path $OutDir "exif-real.jpg"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Host "已生成 $out ($((Get-Item $out).Length) bytes)"
