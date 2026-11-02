# Voxel Destruction

A small 3D voxel sandbox where you can destroy everything. It's built with three.js and needs no build step.

## Run

Serve the folder with any static server, then open the page:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000.

## Tools

| Key | Tool | What it does |
| --- | ---- | ------------ |
| 1 | 🔨 Hammer | Smashes the block you click, plus a few around it |
| 2 | 💣 Bomb | Thrown in an arc and explodes when it hits something |
| 3 | ☢️ NUKE | Drops a missile from the sky that leaves a huge crater, a shockwave and a mushroom cloud |
| R | Reset | Rebuilds the map |

Controls: drag to orbit, right-drag to pan, scroll to zoom.

Blocks that lose their connection to the bedrock fall as debris. The bottom bedrock layer can't be destroyed.
