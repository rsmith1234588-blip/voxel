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

The world is **procedurally generated and infinite**. Chunks generate around you as you explore and unload once you're far away. Chunks you've damaged stay in memory, so your craters are still there when you come back. Press **R** to start a new world with a new random seed.

- **Biomes:** plains, forest, autumn woods, desert, tundra, snowy mountains and lakes
- **Structures:** the world is split into 48×48 regions, and each region may hold a structure that suits its biome:
  - castles with towers and a keep
  - city blocks of skyscrapers
  - villages, sometimes with a church
  - desert pyramids (with a surprise inside)
  - mountain watchtowers
  - ruins
  - TNT caches
- **TNT** (bright red blocks) explodes when it's hit, so it can set off chain reactions. Some is buried underground, too.
- **Structural collapse:** when blocks lose their connection to the ground, they fall as one solid piece and partly shatter into rubble on a hard landing.

You always spawn in front of a castle, with a TNT pyramid on the plaza behind you.

## Code layout

- `world.js`: chunk column storage, terrain and biome noise, structure placement, and chunk meshing with face culling and ambient occlusion
- `main.js`: chunk streaming, rendering, player physics, tools, explosions, collapse, effects, audio and HUD
