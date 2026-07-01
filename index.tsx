import * as React from 'react';
import CrazyGLWrapper, {
	useContent,
	useHeroReady,
	type HeroComponentProps,
} from '@crazygl/core';
import metadata from './metadata.json';
import './style.css';

/* ─────────────────────────────────────────────────────────────────────────
   Cyber Terminal Hero.

   A terminal/code-editor screenshot floats at the centre, tilted slightly
   forward. Around it: drifting "command fragments" (short shell strings
   rendered as CanvasTexture quads), a 3D additive particle cloud in the
   syntax-color palette that drifts toward the screen, a soft halo behind
   the screenshot, and — if the pointer is over the canvas — a fading
   matrix-green cursor trail (Line with per-vertex alpha decay).

   Physics statement
     - Screenshot: self-illuminated PlaneGeometry with MeshStandardMaterial
       (emissive + emissiveMap) so it reads as a real backlit display.
     - Command fragments: each fragment is a CanvasTexture (text painted
       once, varied per-fragment) on a 2D quad. Drift = analytic random
       walk (no force integration, just per-fragment velocity + a slow
       sin wobble). Allocation-free pool, count driven by .visible flag.
     - Syntax particles: Three.js Points with per-particle additive RGB.
       Each frame: pos += vel*dt, plus a gentle pull toward the screen
       origin scaled by `particlePull`. Wrap on far drift.
     - Cursor trail: ring buffer of last N pointer samples (clientX/Y
       captured via pointermove on rootRef). Each frame we rebuild a
       Line BufferGeometry where the head is bright matrix-green and the
       tail fades to zero alpha. Geometry size is fixed (N positions);
       only positions + colors are rewritten in-place.
     - Halo: a single screen-facing additive plane behind the screenshot
       with a radial-gradient texture — soft glow, no real light.

   References
     - hero-stage-screen — emissive screen plane reference.
     - hero-data-flow / FlowStage — Three.js particle pool + lines pattern.
     - hero-digital-rain — moving glyph reference (we render fragments
       differently, but the "deterministic-random text + drift" idea is
       the same).
   ───────────────────────────────────────────────────────────────────────── */

const TerminalStage = React.lazy(() => import('./TerminalStage'));

function CyberTerminalHero(props: HeroComponentProps) {
	const {
		size,
		input,
		rootRef,
		reducedMotion,
		// Screenshot
		screenshot = 'https://crazygl.com/samples/screenshot-dashboard-dark-2.avif',
		screenshotX = 0,
		screenshotY = 0,
		screenshotScale = 1.0,
		screenshotTilt = -8,
		screenEmissive = 0.6,
		// Fragments
		fragmentCount = 22,
		commands,
		fragmentColor1 = '#56ffa0',
		fragmentColor2 = '#56e3ff',
		fragmentColor3 = '#ffb45a',
		fragmentSpeed = 0.3,
		// Particles
		particleCount = 300,
		particleColor1 = '#56ffa0',
		particleColor2 = '#56e3ff',
		particleColor3 = '#ffb45a',
		particlePull = 0.4,
		// Cursor trail
		cursorTrailEnabled = true,
		cursorTrailColor = '#56ffa0',
		cursorTrailLength = 24,
		// Atmosphere
		haloColor = '#56ffa0',
		haloStrength = 0.4,
		bgColor = '#020410',
		gridStrength = 0.04,
		transparentBackground = false,
		// Motion
		parallaxStrength = 0.4,
	} = props as any;

	const content = useContent(props);
	useHeroReady(props);
	const [mounted, setMounted] = React.useState(false);
	React.useEffect(() => setMounted(true), []);

	// Build the stage backdrop CSS. We layer a radial brightener on top
	// of the user's bgColor and (optionally) a faint cross-hatch grid.
	// transparentBackground = true → no backdrop, the host page shows.
	const stageBg = React.useMemo(() => {
		if (transparentBackground) return 'transparent';
		const [r, g, b] = parseHex(bgColor);
		const lighter = `rgb(${clamp255(r * 1.4 + 6)}, ${clamp255(g * 1.4 + 8)}, ${clamp255(b * 1.4 + 14)})`;
		const dark = `rgb(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)})`;
		return `radial-gradient(ellipse at 50% 45%, ${lighter} 0%, ${bgColor} 55%, ${dark} 100%)`;
	}, [bgColor, transparentBackground]);

	// Subtle dot-grid overlay. We bake an inline data-URI SVG into a CSS
	// background so it tiles cheaply and matches gridStrength exactly.
	// The wrapper renders this as a sibling layer below the canvas so the
	// canvas can stay transparent for additive blending.
	const gridLayer = React.useMemo(() => {
		if (gridStrength <= 0 || transparentBackground) return null;
		const alpha = Math.max(0, Math.min(1, gridStrength * 4)); // gridStrength 0.04 → alpha 0.16
		// 28px cross-hatch dot pattern. URL-encoded so it works as data: URI.
		// We use white dots and let the page-level bgColor do the tinting.
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><circle cx='1' cy='1' r='1' fill='rgba(168,232,200,${alpha.toFixed(3)})'/></svg>`;
		const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
		return (
			<div
				aria-hidden="true"
				className="crazygl-cyber-terminal-grid"
				style={{
					position: 'absolute',
					inset: 0,
					backgroundImage: url,
					backgroundSize: '28px 28px',
					backgroundRepeat: 'repeat',
					pointerEvents: 'none',
					zIndex: 0,
					mixBlendMode: 'screen',
				} as React.CSSProperties}
			/>
		);
	}, [gridStrength, transparentBackground]);

	return (
		<>
			<crazygl-stage
				style={{
					position: 'absolute',
					inset: 0,
					zIndex: 0,
					overflow: 'hidden',
					background: stageBg,
				} as React.CSSProperties}
			>
				{gridLayer}
				{mounted ? (
					<React.Suspense fallback={null}>
						<TerminalStage
							rootRef={rootRef}
							size={size}
							input={input}
							reducedMotion={!!reducedMotion}
							screenshot={screenshot}
							screenshotX={screenshotX}
							screenshotY={screenshotY}
							screenshotScale={screenshotScale}
							screenshotTilt={screenshotTilt}
							screenEmissive={screenEmissive}
							fragmentCount={fragmentCount}
							commands={commands}
							fragmentColor1={fragmentColor1}
							fragmentColor2={fragmentColor2}
							fragmentColor3={fragmentColor3}
							fragmentSpeed={fragmentSpeed}
							particleCount={particleCount}
							particleColor1={particleColor1}
							particleColor2={particleColor2}
							particleColor3={particleColor3}
							particlePull={particlePull}
							cursorTrailEnabled={!!cursorTrailEnabled}
							cursorTrailColor={cursorTrailColor}
							cursorTrailLength={cursorTrailLength}
							haloColor={haloColor}
							haloStrength={haloStrength}
							parallaxStrength={parallaxStrength}
						/>
					</React.Suspense>
				) : null}
			</crazygl-stage>
			<crazygl-content
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'flex-start',
					zIndex: 1,
					pointerEvents: 'none',
					padding: '0 6vw',
				} as React.CSSProperties}
			>
				<div className="crazygl-cyber-terminal-content">{content.node}</div>
			</crazygl-content>
		</>
	);
}

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
	const n = parseInt(f, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function clamp255(v: number) {
	return Math.max(0, Math.min(255, Math.round(v)));
}

export default function CyberTerminal(props: any) {
	return <CrazyGLWrapper hero={CyberTerminalHero} metadata={metadata as any} {...props} />;
}
export { metadata };
