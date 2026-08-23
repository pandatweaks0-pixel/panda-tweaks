"use strict";

// Generates the app icon from scratch: PNGs are rendered via System.Drawing,
// then packed into a multi-size ICO. Keeps the branding original and avoids
// pulling in an image dependency just to produce two files.
//
// Usage: node tools/make-icon.js
//
// The mark is a panda face, because that is the app's name — a taskbar icon
// people recognise beats an abstract one they have to learn. The eye patches
// double as slider pills with a bright knob for a pupil: at 256 px you read the
// tweaking motif, at 16 px you still read "panda", which is the size that
// decides whether an icon works.
//
// Every frame is drawn at its own resolution rather than scaled down from one
// big bitmap. A 16 px icon downsampled from 256 px is mud; a 16 px icon drawn
// at 16 px keeps its edges. Detail that cannot survive a size is dropped there
// instead of being smeared across three pixels.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUT_DIR = path.join(__dirname, "..", "src", "renderer", "assets");
const PNG = path.join(OUT_DIR, "logo.png");
const ICO = path.join(OUT_DIR, "logo.ico");
const TMP = path.join(require("os").tmpdir(), `panda-icon-${process.pid}`);

const SIZES = [16, 24, 32, 48, 64, 128, 256];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const psPath = (p) => p.replace(/'/g, "''");

// All geometry is written against a 256 grid and scaled per frame, so one set
// of numbers describes every size.
const drawScript = `
Add-Type -AssemblyName System.Drawing

$sizes = @(${SIZES.join(",")})
$dir   = '${psPath(TMP)}'

# --- palette ---------------------------------------------------------------
$fur    = [System.Drawing.Color]::FromArgb(255, 244, 247, 250)  # off-white face
$ink    = [System.Drawing.Color]::FromArgb(255, 14, 19, 27)     # ears, patches
$accent = [System.Drawing.Color]::FromArgb(255, 74, 222, 128)   # the app accent
$tileA  = [System.Drawing.Color]::FromArgb(255, 30, 39, 52)
$tileB  = [System.Drawing.Color]::FromArgb(255, 8, 11, 16)

function New-RoundRect($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

foreach ($S in $sizes) {
    $f = $S / 256.0
    $bmp = New-Object System.Drawing.Bitmap($S, $S)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    # --- tile ---------------------------------------------------------------
    # Windows rounds its own tiles less at small sizes; matching that keeps the
    # silhouette from turning into a circle at 16 px.
    $radius = [Math]::Max(2, [int](56 * $f))
    $tile = New-RoundRect 0 0 ($S - 1) ($S - 1) $radius
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($S, $S)), $tileA, $tileB)
    $g.FillPath($bg, $tile)

    if ($S -ge 32) {
        $rim = New-Object System.Drawing.Pen(
            [System.Drawing.Color]::FromArgb(80, 74, 222, 128), [Math]::Max(1, 3 * $f))
        $g.DrawPath($rim, $tile)
        $rim.Dispose()
    }

    $furBrush = New-Object System.Drawing.SolidBrush($fur)
    $inkBrush = New-Object System.Drawing.SolidBrush($ink)
    $accBrush = New-Object System.Drawing.SolidBrush($accent)

    # --- ears ---------------------------------------------------------------
    # Drawn before the head so the head overlaps them: that is what gives the
    # silhouette its notch instead of two circles stuck on a ball.
    #
    # Black ears on a near-black tile are a shape nobody can see, so each gets a
    # rim in the tile's own border grey. That reads as a lit edge rather than an
    # outline, and it is the only thing separating the ears from the background.
    $earR = 33 * $f
    $earRim = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(255, 52, 66, 86), [Math]::Max(1, 4 * $f))
    foreach ($ex in @(72, 184)) {
        $ed = $earR * 2
        $g.FillEllipse($inkBrush, ($ex * $f - $earR), (56 * $f - $earR), $ed, $ed)
        if ($S -ge 24) {
            $g.DrawEllipse($earRim, ($ex * $f - $earR), (56 * $f - $earR), $ed, $ed)
        }
    }
    $earRim.Dispose()

    # --- head ---------------------------------------------------------------
    # Smaller at tiny sizes: at 16 px a head this wide runs into the tile edge
    # and the icon loses the rounded-square silhouette that says "app".
    if ($S -lt 32) { $hw = 78 * $f; $hh = 72 * $f } else { $hw = 86 * $f; $hh = 78 * $f }
    $g.FillEllipse($furBrush, (128 * $f - $hw), (148 * $f - $hh), ($hw * 2), ($hh * 2))

    # --- eye patches --------------------------------------------------------
    # Tilted pills. At 256 they read as two slider tracks with a knob.
    #
    # Below 32 px that shape has nowhere to go: two 44 px-tall pills scaled to
    # 16 px land on the same three pixels and merge into one dark band, which
    # reads as a blob rather than a face. So small frames get their own
    # geometry — two round eyes, further apart, with a clear gap of fur between
    # them. Same idea, drawn for the space available.
    if ($S -lt 32) {
        $eyeR = 15 * $f
        foreach ($side in @(-1, 1)) {
            $cx = (128 + $side * 40) * $f
            $g.FillEllipse($inkBrush, ($cx - $eyeR), (140 * $f - $eyeR), ($eyeR * 2), ($eyeR * 2))
        }
    } else {
        $patchW = 62 * $f
        $patchH = 44 * $f
        foreach ($side in @(-1, 1)) {
            $cx = (128 + $side * 33) * $f
            $cy = 140 * $f
            $state = $g.Save()
            $g.TranslateTransform($cx, $cy)
            $g.RotateTransform($side * 22)
            $patch = New-RoundRect (-$patchW / 2) (-$patchH / 2) $patchW $patchH ($patchH / 2)
            $g.FillPath($inkBrush, $patch)
            $patch.Dispose()
            # The knob sits at the outer end of the pill, like a slider pushed out.
            $knobR = 13 * $f
            $g.FillEllipse($accBrush, ($side * $patchW / 2 - $side * $knobR - $knobR), (-$knobR), ($knobR * 2), ($knobR * 2))
            $g.Restore($state)
        }
    }

    # --- muzzle -------------------------------------------------------------
    # Below 48 px there is no room: a nose and mouth here would be two grey
    # pixels that only dirty the face.
    if ($S -ge 48) {
        $noseW = 20 * $f
        $noseH = 15 * $f
        $g.FillEllipse($inkBrush, (128 * $f - $noseW / 2), (186 * $f - $noseH / 2), $noseW, $noseH)
        $mouth = New-Object System.Drawing.Pen($ink, [Math]::Max(1, 6 * $f))
        $mouth.StartCap = 'Round'
        $mouth.EndCap = 'Round'
        $g.DrawArc($mouth, (108 * $f), (190 * $f), (20 * $f), (18 * $f), 20, 140)
        $g.DrawArc($mouth, (128 * $f), (190 * $f), (20 * $f), (18 * $f), 20, 140)
        $mouth.Dispose()
    }

    $furBrush.Dispose()
    $inkBrush.Dispose()
    $accBrush.Dispose()
    $bg.Dispose()
    $tile.Dispose()
    $g.Dispose()
    $bmp.Save((Join-Path $dir ("icon-$S.png")), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
`;

execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", drawScript], {
    windowsHide: true,
});

// The 256 px frame doubles as the in-app logo (splash and first-run wizard).
fs.copyFileSync(path.join(TMP, "icon-256.png"), PNG);

// ICO container. Windows Vista and later read PNG frames directly, so no BMP
// conversion is needed — but the directory has to list every frame, or Windows
// falls back to scaling the largest one.
const frames = SIZES.map((size) => ({ size, data: fs.readFileSync(path.join(TMP, `icon-${size}.png`)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(frames.length, 4);

let offset = header.length + frames.length * 16;
const entries = [];
for (const frame of frames) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 in a single byte.
    entry[0] = frame.size === 256 ? 0 : frame.size;
    entry[1] = frame.size === 256 ? 0 : frame.size;
    entry[2] = 0; // palette colours
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += frame.data.length;
    entries.push(entry);
}

fs.writeFileSync(ICO, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`wrote ${PNG} (${fs.statSync(PNG).size} bytes)`);
console.log(`wrote ${ICO} (${fs.statSync(ICO).size} bytes, ${frames.length} frames: ${SIZES.join(", ")})`);
