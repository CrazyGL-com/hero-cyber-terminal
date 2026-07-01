<sub>*Hero made by [@ybouane](https://x.com/ybouane).*</sub>
<p align="center">
  <img src="https://crazygl.com/heroes/hero-cyber-terminal/banner-full.png" alt="Cyber Terminal" width="640">
</p>

# @crazygl/hero-cyber-terminal

A terminal/code-editor screenshot floats at the centre, surrounded by drifting command fragments, glowing syntax particles and a pointer-driven matrix-green cursor trail.

## Demo
[Cyber Terminal](https://crazygl.com/hero/cyber-terminal)

## Install

```bash
npm install @crazygl/hero-cyber-terminal
```

## Usage

```tsx
import CyberTerminal from '@crazygl/hero-cyber-terminal';

export default function Page() {
  return (
    <CyberTerminal
      screenshot="/screenshots/terminal-dark.avif"
      screenshotTilt={-8}
      fragmentCount={22}
      particleCount={300}
    />
  );
}
```

## Customise

- **Content** — `heading`/`subheading`, two-column, or custom node.
- **Screenshot** — `screenshot` URL, `screenshotX`/`screenshotY`, `screenshotScale`, `screenshotTilt`, `screenEmissive`.
- **Command fragments** — `fragmentCount`, `commands` (one per line), three palette colours, `fragmentSpeed`.
- **Particles** — `particleCount`, three palette colours, `particlePull` (attraction toward the screen).
- **Cursor trail** — `cursorTrailEnabled`, `cursorTrailColor`, `cursorTrailLength`.
- **Atmosphere / Motion** — `haloColor`/`haloStrength`, `bgColor`, `gridStrength`, `transparentBackground`, `parallaxStrength`.

## Inputs you can plug in

- **Screenshot** — any JPG / PNG / WebP / AVIF. Looks best with terminal or code-editor captures; native aspect is preserved.

## Best for

- Developer tools, APIs, hosting and deployment platforms
- CLI products and observability dashboards
- AI/automation SaaS wanting a hacker-but-polished vibe



This hero is part of [CrazyGL](https://crazygl.com), a collection of production-ready WebGL, canvas, 3D, and typography effects. Every CrazyGL hero ships with an agent-ready `SKILL.md` file that helps developers and coding agents adapt the effect into custom landing pages and interactive experiences.
