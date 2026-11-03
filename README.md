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
| Click | Use the current tool (hold it for auto-fire and beams) |
| Right-click | Detonate all placed C4, or light the TNT you're looking at while holding the TNT Placer |
| 1–9 / mouse wheel | Switch hotbar slot |
| E | Open the inventory |
| Space | Jump, or swim up in water |
| F | Toggle fly mode (Space goes up, C goes down) |
| R | Generate a new world |
| Esc | Release the mouse |

## Block size

On the start screen, **Block size** switches between **Normal (1 m)** and **Tiny (10 cm)**. The setting is saved in your browser, and switching reloads the page with a fresh world.

In tiny mode every block is 10x smaller (1,000 times as many blocks), so craters, rubble and collapses are far more detailed. The same castles, cities and pyramids are built out of tiny blocks, and hills are smooth slopes instead of 1 m steps. To keep it playable:

- Only the 19 m around you is live (the normal view is about 140 m), and you start right in front of the castle gate.
- Chunks you've already explored stay visible out to about 80 m as frozen snapshots (at 40 cm detail). Nothing happens in them: they show each chunk as it was when it left the live area, damage included, and update the next time you walk back.
- Blasts are capped at a 6 m radius, so the nuke makes a 6 m crater.
- Only part of the destroyed material flies off as debris.
- Natural ground never collapses. Structures still do.
- Big explosions can still cause a short stutter while the crater is rebuilt.

## Inventory

Press **E** to see all 21 tools. There are three ways to put a tool in your 9-slot hotbar:

- Click a tool to put it in the highlighted slot.
- Drag a tool onto any slot.
- Hover over a tool and press 1–9.

If the tool is already in another slot, the two slots swap. Your hotbar is saved in your browser.

## Tools

| Category | Tool | What it does |
| -------- | ---- | ------------ |
| Hand tools | 🔨 Hammer | Smashes the blocks in front of you |
| | 🧨 TNT Placer | Places TNT blocks. Right-click a TNT block to light it |
| | ✋ Force Push | Blasts everything in a cone in front of you away |
| Guns & beams | 🔫 Minigun | Hold the button for rapid fire that chews through blocks |
| | 💥 Shotgun | Fires a wide spray of 12 pellets |
| | ⚡ Laser | A continuous beam that burns through anything |
| | ❄️ Freeze Ray | Turns blocks (and lakes) into ice, which shatters easily when hit |
| | 🔥 Flamethrower | Sets things on fire. Wood, leaves and grass burn, and the fire spreads |
| Explosives | 🚀 Rocket | Fires straight at the crosshair and explodes on impact |
| | 🍍 Grenade | Bounces around, then explodes after 2 seconds |
| | 💣 Bomb | Thrown in an arc and explodes on impact |
| | 🎆 Cluster Bomb | Bursts into a ring of bomblets |
| | 📦 C4 | Sticks to surfaces. Place as many as you like, then right-click to set them all off |
| | ⛏️ Drill Missile | Bores a long tunnel, then explodes |
| Strikes | ☢️ NUKE | Calls a missile down on the crosshair: a huge crater, shockwave and mushroom cloud |
| | ✈️ Airstrike | A bomber carpet-bombs along the direction you're looking |
| | ☄️ Meteor Shower | Rains flaming meteors around the crosshair |
| | 🌩️ Lightning | Strikes the crosshair and starts fires |
| Disasters | 🕳️ Black Hole | Pulls in and swallows blocks, debris and you, then collapses |
| | 🌪️ Tornado | A wandering twister that rips up trees and buildings and flings the debris |
| | 🏚️ Earthquake | Splits the ground open and crumbles nearby buildings |

Explosions can set nearby trees on fire. Any TNT caught in a blast, a fire or a disaster goes off too.

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

- `world.js`: block size setting (`VS` cells per metre), chunk column storage, terrain and biome noise, structure placement, and chunk meshing with face culling and ambient occlusion
- `main.js`: chunk streaming, rendering, player physics, tools, explosions, collapse, effects, audio and HUD
