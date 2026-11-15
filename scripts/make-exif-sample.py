# 用 Pillow 生成带真实 EXIF 的 JPEG/HEIC 样张（exifr 验证基准）
# 用法：python scripts/make-exif-sample.py [输出目录]
import io, os, sys
from PIL import Image
import piexif  # pip install piexif

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TEMP', '/tmp'), 'sybot-exif-sample')
os.makedirs(OUT, exist_ok=True)

img = Image.new('RGB', (120, 90), (70, 130, 180))
# 画个圆当“拍摄内容”
from PIL import ImageDraw
d = ImageDraw.Draw(img)
d.ellipse([30, 20, 90, 70], fill=(255, 165, 0))

EXIF = {
    '0th': {piexif.ImageIFD.Make: b'Apple', piexif.ImageIFD.Model: b'iPhone 15 Pro'},
    'Exif': {
        piexif.ExifIFD.DateTimeOriginal: b'2024:01:15 08:30:00',
        piexif.ExifIFD.OffsetTimeOriginal: b'+02:00',
        piexif.ExifIFD.DateTimeDigitized: b'2024:01:15 08:30:00',
    },
}
exif_bytes = piexif.dump(EXIF)
jpg = os.path.join(OUT, 'exif-real.jpg')
img.save(jpg, 'JPEG', exif=exif_bytes, quality=90)
print('已生成', jpg, os.path.getsize(jpg), 'bytes')

# 无 OffsetTime 的样张（老设备场景）
EXIF2 = {
    '0th': {piexif.ImageIFD.Make: b'Apple', piexif.ImageIFD.Model: b'iPhone 6'},
    'Exif': {
        piexif.ExifIFD.DateTimeOriginal: b'2023:06:01 12:00:00',
        piexif.ExifIFD.DateTimeDigitized: b'2023:06:01 12:00:00',
    },
}
jpg2 = os.path.join(OUT, 'exif-nooffset.jpg')
img.save(jpg2, 'JPEG', exif=piexif.dump(EXIF2), quality=90)
print('已生成', jpg2, os.path.getsize(jpg2), 'bytes')
