# Preset pictures

Drop a file here named after the preset id and it appears on that preset's card
instead of the coloured tile:

```
fortnite.png
valorant.png
retrac.png
gta5.png
```

`.png`, `.jpg` and `.webp` are tried in that order. Square images look best —
they are drawn at 52×52 and cropped to fill, so anything wide loses its sides.
If no file is there, the coloured tile with the short code is used, which is why
a missing picture never shows a broken-image icon.

## Why none are included

The Fortnite, Valorant and GTA logos belong to Epic, Riot and Rockstar. Putting
one file on your own PC is your decision; shipping them inside an executable
handed to strangers is a different thing, and not one this project makes for
you.

If you are distributing the app, either leave the tiles as they are or use
artwork you have the right to pass on.

The preset ids come from `src/data/presets.json`.
