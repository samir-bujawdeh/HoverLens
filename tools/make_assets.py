#!/usr/bin/env python3
"""Draws the extension icons and the test images with only the standard library."""
import math, os, struct, sys, zlib

def png(path, w, h, pixel):
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            rows.extend(pixel(x, y))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)

def icon(size, mono=False):
    """A magnifying glass with a picture inside the lens, supersampled."""
    S = 3
    def cov(x, y):
        hits = [0, 0, 0, 0]  # lens ring, lens fill (mountain), handle, sky
        for sy in range(S):
            for sx in range(S):
                u = (x + (sx + .5) / S) / size
                v = (y + (sy + .5) / S) / size
                cx, cy, r = .42, .42, .30
                d = math.hypot(u - cx, v - cy)
                if r - .065 <= d <= r:
                    hits[0] += 1
                elif d < r - .065:
                    # mountain silhouette inside the lens
                    if v > .52 - .14 * max(0, 1 - abs(u - .36) / .16) and v > .5:
                        hits[1] += 1
                    elif v > .58 - .1 * max(0, 1 - abs(u - .52) / .12):
                        hits[1] += 1
                    else:
                        hits[3] += 1
                else:
                    # handle along the diagonal
                    t = ((u - cx) + (v - cy)) / math.sqrt(2)
                    n = abs((u - cx) - (v - cy)) / math.sqrt(2)
                    if r - .01 < t < .58 and n < .07:
                        hits[2] += 1
        return [h / (S * S) for h in hits]
    def px(x, y):
        ring, fill, handle, sky = cov(x, y)
        if mono:
            a = min(1, ring + handle + fill)
            return (0, 0, 0, int(a * 255))
        # colored icon on a rounded-square background
        u, v = (x + .5) / size, (y + .5) / size
        rr = .22
        dx, dy = max(abs(u - .5) - (.5 - rr), 0), max(abs(v - .5) - (.5 - rr), 0)
        inside = 1.0 if math.hypot(dx, dy) <= rr else 0.0
        g = v
        bg = (int(30 + 20 * g), int(110 + 30 * g), int(255 - 40 * g))
        col = list(bg)
        def mix(c, a):
            for i in range(3):
                col[i] = int(col[i] * (1 - a) + c[i] * a)
        mix((205, 230, 255), sky)
        mix((40, 160, 110), fill)
        mix((255, 255, 255), ring + handle)
        return (*col, int(255 * inside))
    return px

def main(root):
    ext = os.path.join(root, 'Extension', 'images')
    for s in (48, 96, 128, 256, 512):
        png(os.path.join(ext, f'icon-{s}.png'), s, s, icon(s))
    for s in (16, 32):
        png(os.path.join(ext, f'toolbar-{s}.png'), s, s, icon(s, mono=True))
    # test images: a big gradient "photo" and a second album frame
    t = os.path.join(root, 'test')
    def photo(w, h, hue):
        def px(x, y):
            u, v = x / w, y / h
            ring = (math.sin(math.hypot(u - .5, v - .5) * 40) + 1) / 2
            r = int(255 * (u if hue == 0 else 1 - u))
            g = int(255 * v)
            b = int(255 * ring)
            return (r, g, b, 255)
        return px
    png(os.path.join(t, 'big.png'), 1600, 1000, photo(1600, 1000, 0))
    png(os.path.join(t, 'big2.png'), 900, 1200, photo(900, 1200, 1))
    png(os.path.join(t, 'small.png'), 160, 100, photo(160, 100, 0))

if __name__ == '__main__':
    main(sys.argv[1])
