# Adding Custom Engine SynthDefs

norns-web uses [SuperSonic](https://github.com/samaaron/supersonic) (scsynth compiled to WebAssembly) for synthesis. It can only load **pre-compiled binary SynthDef** files (`.scsyndef`), not raw SuperCollider source (`.sc`).

Place compiled `.scsyndef` files here as `{EngineName}.scsyndef`.
They are tried before any Sonic Pi approximation — so `PolySub.scsyndef` would override the built-in prophet approximation.

---

## Compiling an Engine's SynthDef

You need SuperCollider installed on your desktop.

### 1. Find the engine source

norns engines live in `lib/sc/` inside each script's folder, named `Engine_{Name}.sc`.
Community engines are also collected in [monome/dust](https://github.com/monome/dust/tree/master/lib/sc).

### 2. Open SuperCollider and compile

```supercollider
// Boot the server first
s.boot;

// Load the engine file
(
  PathName("/path/to/Engine_Boing.sc").fullPath.load;
)

// Wait for the SynthDef to compile, then write it to a binary file
SynthDef.writeDefFile("/path/to/norns-web/engines");
// or for a specific def:
SynthDescLib.global.at(\boing).def.writeDefFile("/path/to/norns-web/engines/Boing.scsyndef");
```

The output file should be named exactly `{EngineName}.scsyndef` — matching what the Lua script declares as `engine.name = "EngineName"`.

### 3. Reload norns-web

The engine bridge checks for `engines/{Name}.scsyndef` before falling back to a Sonic Pi approximation.
Open the browser console to confirm: `[engine] loaded custom SynthDef: Boing`

---

## Built-in Approximations (no .scsyndef needed)

| norns engine   | Sonic Pi synth used     | Notes                              |
|----------------|-------------------------|------------------------------------|
| PolySub        | sonic-pi-prophet        | Subtractive poly, very close match |
| PolyPerc       | sonic-pi-beep           | Percussive trigger, approximate    |
| MollyThePoly   | sonic-pi-prophet        | Paraphonic, approximate            |

Any other engine declared with `engine.name` will be silent unless you provide a `.scsyndef` file.
