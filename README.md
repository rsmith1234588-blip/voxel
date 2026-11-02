# Voxel Destruction

A first-person voxel sandbox where you can destroy everything. It's built with three.js and needs no build step.

## Run

Serve the folder with any static server, then open the page:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000. You need a desktop browser, because the game uses mouse pointer lock.

## Controls

| Input | Action |
| ----- | ------ |
| WASD | Move (hold Shift to sprint) |
| Mouse | Look around |
| Click | Use the current tool (hold it for auto-fire or the laser) |
| 1–7 / mouse wheel | Switch tool |
| Space | Jump, or swim up in water |
| F | Toggle fly mode (Space goes up, C goes down) |
| R | Generate a new world |
| Esc | Release the mouse |

## Tools

| Key | Tool | What it does |
| --- | ---- | ------------ |
| 1 | 🔨 Hammer | Smashes the blocks in front of you |
| 2 | ⚡ Laser | A continuous beam that burns through anything while you hold the button |
| 3 | 🚀 Rocket | Fires straight at the crosshair and explodes on impact |
| 4 | 💣 Bomb | Thrown in an arc and explodes on impact |
| 5 | 🎆 Cluster Bomb | Bursts into a ring of bomblets |
| 6 | 🕳️ Black Hole | Pulls in and swallows blocks, debris and you, then collapses |
| 7 | ☢️ NUKE | Calls a missile down on the crosshair: a huge crater, shockwave and mushroom cloud |

## World

The map is 128 × 128 × 64 blocks and contains:

- a castle with towers and a keep
- a city of skyscrapers
- a village with a church
- desert pyramids
- snowy mountains
- a lake with a dock
- forests

**TNT** (bright red blocks) explodes when it's hit, so it can set off chain reactions.

**Structural collapse:** when blocks lose their connection to the ground, they fall as one solid piece. If a piece lands hard enough, part of it shatters into rubble.

## Code layout

- `world.js`: voxel grid, chunk meshing with face culling and ambient occlusion, and world generation
- `main.js`: rendering, player physics, tools, explosions, collapse, effects, audio and HUD
