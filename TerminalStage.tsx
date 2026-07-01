import * as React from 'react';
import * as THREE from 'three';
import { useHeroAnimationFrame, useHeroAssetGate } from '@crazygl/core';

/* ─────────────────────────────────────────────────────────────────────────
   TerminalStage — the Three.js scene for the Cyber Terminal hero.

   Layered structure (back → front):
     1. Soft additive halo plane behind the screenshot (radial gradient).
     2. Far command fragments (small, dim, z < -3).
     3. Mid-depth syntax particles (z ≈ -2 .. -1).
     4. Terminal screenshot plane (z = 0, tilted).
     5. Foreground particles (z ≈ +0.5 .. +1.5).
     6. Cursor trail Line in screen-space NDC overlay (closest to camera).

   Everything is allocated once at mount and mutated in place each frame.

   Coordinate spaces in this module:
     world   — Three.js world. Camera at (0, 0, 5.6), looking at (0, 0, 0).
     ndc     — normalised device coords for the cursor trail overlay.
               Trail Line lives in a separate THREE.Scene rendered with an
               OrthographicCamera so its positions are literally NDC.
     trailClient — raw pointer (clientX/Y) captured via pointermove on
                   rootRef; we convert to NDC every frame using the canvas
                   bounding-rect cached on the state ref.
   ───────────────────────────────────────────────────────────────────────── */

const MAX_FRAGMENTS = 40;
const MAX_PARTICLES = 600;
const MAX_TRAIL = 50; // upper bound for cursorTrailLength slider

// The default set of strings we cycle through for command fragments.
// Curated to be short, visually distinct, and recognisably "developer."
// This is the canonical fallback when the `commands` prop is empty.
const DEFAULT_FRAGMENT_STRINGS = [
	'$ deploy --prod',
	'git push origin main',
	'npm install',
	'> Compiled successfully in 2.3s',
	'> 200 OK · 142ms',
	'kubectl apply -f infra.yaml',
	'docker build -t app:v1.2 .',
	'[INFO] Deployed to us-east-2',
	'ssh deploy@prod.example',
	'curl -X POST /api/run',
	'function compile() {',
	'const result = await run();',
	'> All tests passed (482)',
	'> Healthy ✓',
];

/* Normalise the `commands` prop to a clean string[]. Accepts:
   - Array<string>: used as-is (filtered to non-empty trimmed strings)
   - string: split on \n, trim, drop empties
   - undefined / null / empty result: fall back to DEFAULT_FRAGMENT_STRINGS */
function parseCommandStrings(input: unknown): string[] {
	let arr: string[] | null = null;
	if (Array.isArray(input)) {
		arr = (input as unknown[])
			.map((v) => (typeof v === 'string' ? v.trim() : ''))
			.filter((s) => s.length > 0);
	} else if (typeof input === 'string') {
		arr = input
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
	}
	if (!arr || arr.length === 0) return DEFAULT_FRAGMENT_STRINGS;
	return arr;
}

interface StageProps {
	rootRef: React.RefObject<HTMLElement | null>;
	size: { width: number; height: number; dpr: number };
	input: { x: number; y: number; active: boolean };
	reducedMotion: boolean;
	screenshot: string;
	screenshotX: number;
	screenshotY: number;
	screenshotScale: number;
	screenshotTilt: number;
	screenEmissive: number;
	fragmentCount: number;
	commands?: string | string[];
	fragmentColor1: string;
	fragmentColor2: string;
	fragmentColor3: string;
	fragmentSpeed: number;
	particleCount: number;
	particleColor1: string;
	particleColor2: string;
	particleColor3: string;
	particlePull: number;
	cursorTrailEnabled: boolean;
	cursorTrailColor: string;
	cursorTrailLength: number;
	haloColor: string;
	haloStrength: number;
	parallaxStrength: number;
}

type FragmentEntry = {
	mesh: THREE.Mesh;
	mat: THREE.MeshBasicMaterial;
	tex: THREE.CanvasTexture;
	canvas: HTMLCanvasElement;
	width: number;      // canvas px width (for plane aspect)
	height: number;     // canvas px height
	worldW: number;     // current mesh world width (so we can rebuild on color change)
	worldH: number;
	stringIdx: number;
	colorIdx: number;
	// Drift state — deterministic seed per fragment.
	bx: number; by: number; bz: number;   // base orbit centre
	rx: number; ry: number; rz: number;   // orbit radii
	phaseX: number; phaseY: number; phaseZ: number;
	speedScale: number;
};

/* Build a single CanvasTexture for one fragment. Drawn once per
   (string, color) combo; the canvas size is sized to the rendered text
   bbox so the mesh aspect is correct. We cap at a sane DPR so very large
   texts don't balloon GPU memory. */
function buildFragmentTexture(
	str: string,
	colorHex: string,
): { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; width: number; height: number } {
	const dpr = (typeof window !== 'undefined') ? Math.min(window.devicePixelRatio || 1, 2) : 1;
	const fontPx = 22;
	const padX = 14;
	const padY = 8;
	const canvas = (typeof document !== 'undefined')
		? document.createElement('canvas')
		: ({ width: 1, height: 1 } as any as HTMLCanvasElement);
	const ctx = canvas.getContext ? canvas.getContext('2d') : null;
	let textW = str.length * fontPx * 0.6; // fallback estimate
	let textH = fontPx * 1.3;
	if (ctx) {
		ctx.font = `${fontPx}px ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
		const metrics = ctx.measureText(str);
		textW = Math.max(40, Math.ceil(metrics.width));
		textH = Math.ceil(fontPx * 1.35);
	}
	const cssW = textW + padX * 2;
	const cssH = textH + padY * 2;
	canvas.width = Math.max(2, Math.floor(cssW * dpr));
	canvas.height = Math.max(2, Math.floor(cssH * dpr));
	if (ctx) {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// Faint dark backing so the fragment reads against bright bg too.
		ctx.fillStyle = 'rgba(2, 6, 16, 0.55)';
		ctx.fillRect(0, 0, cssW, cssH);
		// Inject a 1-pixel border of the fragment color at low alpha so
		// the fragment reads as a "tag" not raw floating text. Sells the
		// terminal/window feel.
		ctx.strokeStyle = withAlpha(colorHex, 0.45);
		ctx.lineWidth = 1;
		ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);

		// Subtle scanline pattern.
		ctx.fillStyle = withAlpha(colorHex, 0.05);
		for (let y = 0; y < cssH; y += 3) {
			ctx.fillRect(0, y, cssW, 1);
		}

		// Now the text itself. Hot-core white + colored shadow for glow.
		ctx.font = `${fontPx}px ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
		ctx.textBaseline = 'middle';
		ctx.shadowColor = withAlpha(colorHex, 0.85);
		ctx.shadowBlur = 8;
		ctx.fillStyle = colorHex;
		ctx.fillText(str, padX, cssH / 2);
		ctx.shadowBlur = 0;
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return { canvas, tex, width: cssW, height: cssH };
}

function withAlpha(hex: string, a: number): string {
	const [r, g, b] = parseHex(hex);
	return `rgba(${r},${g},${b},${a})`;
}
function parseHex(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
	const n = parseInt(f, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Build a radial-gradient texture for the halo plane behind the screenshot. */
function buildHaloTexture(): THREE.CanvasTexture | null {
	if (typeof document === 'undefined') return null;
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	grad.addColorStop(0.00, 'rgba(255,255,255,1.0)');
	grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
	grad.addColorStop(0.70, 'rgba(255,255,255,0.10)');
	grad.addColorStop(1.00, 'rgba(255,255,255,0.0)');
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/* Build a soft round texture for syntax particles. */
function buildParticleTexture(): THREE.CanvasTexture | null {
	if (typeof document === 'undefined') return null;
	const size = 64;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
	grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
	grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/* Deterministic per-index pseudo-random — keeps fragment / particle layouts
   stable across re-mounts and renders. */
function frac(n: number): number {
	return n - Math.floor(n);
}
function hash1(i: number, salt: number): number {
	return frac(Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453);
}

export default function TerminalStage(props: StageProps) {
	const {
		rootRef, size, input, reducedMotion,
		screenshot, screenshotX, screenshotY, screenshotScale, screenshotTilt, screenEmissive,
		fragmentCount, commands, fragmentColor1, fragmentColor2, fragmentColor3, fragmentSpeed,
		particleCount, particleColor1, particleColor2, particleColor3, particlePull,
		cursorTrailEnabled, cursorTrailColor, cursorTrailLength,
		haloColor, haloStrength,
		parallaxStrength,
	} = props;

	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

	// Parse the `commands` prop into a clean string[]. Memoised on the raw
	// prop reference; downstream the useEffect uses a stringified key so
	// per-line edits inside a textarea trigger a texture rebuild.
	const commandStrings = React.useMemo(() => parseCommandStrings(commands), [commands]);
	const commandStringsRef = React.useRef<string[]>(commandStrings);
	commandStringsRef.current = commandStrings;

	// Kick the screenshot download off as early as possible — during render,
	// before any effect runs — so the network fetch overlaps the synchronous
	// WebGL context creation + scene construction in the setup effect below.
	// The texture-load effect consumes this preloaded image when the URL matches.
	const screenPreloadRef = React.useRef<{ url: string; img: HTMLImageElement } | null>(null);
	if (
		typeof Image !== 'undefined' &&
		screenshot &&
		screenPreloadRef.current?.url !== screenshot
	) {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.src = screenshot;
		screenPreloadRef.current = { url: screenshot, img };
	}

	// Hold the hero "not ready" until the off-DOM screenshot texture settles.
	const [assetReady, setAssetReady] = React.useState(false);
	useHeroAssetGate(assetReady);

	// One big ref bag so we can build the entire scene up-front and mutate
	// in place per frame without re-allocating anything.
	const stateRef = React.useRef<{
		renderer: THREE.WebGLRenderer | null;
		scene: THREE.Scene | null;
		camera: THREE.PerspectiveCamera | null;
		sceneRoot: THREE.Group | null;
		// Screenshot
		screenMesh: THREE.Mesh | null;
		screenMat: THREE.MeshStandardMaterial | null;
		screenTex: THREE.Texture | null;
		screenAspect: number;
		// Halo
		haloMesh: THREE.Mesh | null;
		haloMat: THREE.MeshBasicMaterial | null;
		// Fragments
		fragments: FragmentEntry[];
		// Particles
		points: THREE.Points | null;
		pGeom: THREE.BufferGeometry | null;
		pMat: THREE.PointsMaterial | null;
		pPos: Float32Array | null;
		pVel: Float32Array | null;
		pCol: Float32Array | null;
		// Cursor trail
		trailScene: THREE.Scene | null;
		trailCam: THREE.OrthographicCamera | null;
		trailLine: THREE.Line | null;
		trailGeom: THREE.BufferGeometry | null;
		trailMat: THREE.LineBasicMaterial | null;
		trailPos: Float32Array | null;
		trailCol: Float32Array | null;
		// Trail ring buffer of pointer samples in CLIENT coords (px) +
		// timestamps; we convert to NDC every frame using a cached rect.
		trailBufX: Float32Array;
		trailBufY: Float32Array;
		trailBufT: Float32Array;
		trailHead: number;     // index of newest sample
		trailFilled: number;   // number of populated samples (≤ MAX_TRAIL)
		canvasRect: DOMRect | null;
		// Pointer smoothing for parallax
		px: number; py: number;
		// Color cache (THREE.Color so per-frame doesn't reparse hex strings)
		colFrag: THREE.Color[];
		colPart: THREE.Color[];
		colTrail: THREE.Color;
		colHalo: THREE.Color;
	}>({
		renderer: null,
		scene: null,
		camera: null,
		sceneRoot: null,
		screenMesh: null,
		screenMat: null,
		screenTex: null,
		screenAspect: 16 / 9,
		haloMesh: null,
		haloMat: null,
		fragments: [],
		points: null,
		pGeom: null,
		pMat: null,
		pPos: null,
		pVel: null,
		pCol: null,
		trailScene: null,
		trailCam: null,
		trailLine: null,
		trailGeom: null,
		trailMat: null,
		trailPos: null,
		trailCol: null,
		trailBufX: new Float32Array(MAX_TRAIL),
		trailBufY: new Float32Array(MAX_TRAIL),
		trailBufT: new Float32Array(MAX_TRAIL),
		trailHead: -1,
		trailFilled: 0,
		canvasRect: null,
		px: 0.5, py: 0.5,
		colFrag: [new THREE.Color(), new THREE.Color(), new THREE.Color()],
		colPart: [new THREE.Color(), new THREE.Color(), new THREE.Color()],
		colTrail: new THREE.Color(),
		colHalo: new THREE.Color(),
	});

	// ────────────────────────────────────────────────────────────────────
	// One-time scene setup.
	// ────────────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const state = stateRef.current;

		const renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			premultipliedAlpha: false,
			powerPreference: 'high-performance',
		});
		renderer.setPixelRatio(Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 1.75));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.NoToneMapping;
		renderer.setClearColor(0x000000, 0);
		// `autoClear=true` for the main scene; we'll manually clear=false on the
		// trail overlay pass so it composites on top without wiping.
		renderer.autoClear = true;
		state.renderer = renderer;

		const scene = new THREE.Scene();
		scene.background = null;
		state.scene = scene;

		const sceneRoot = new THREE.Group();
		scene.add(sceneRoot);
		state.sceneRoot = sceneRoot;

		const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 60);
		camera.position.set(0, 0, 5.6);
		camera.lookAt(0, 0, 0);
		state.camera = camera;

		// Minimal lighting — the screen is emissive, fragments use
		// MeshBasicMaterial (unlit), particles use PointsMaterial (also
		// unlit). We add a soft hemisphere fill so the screen's roughness
		// isn't completely matte.
		const hemi = new THREE.HemisphereLight(0xb0d6ff, 0x05060a, 0.18);
		sceneRoot.add(hemi);
		const key = new THREE.DirectionalLight(0xffffff, 0.4);
		key.position.set(-1.5, 1.2, 3.2);
		sceneRoot.add(key);

		// ── Halo plane (behind the screenshot) ──────────────────────────
		const haloTex = buildHaloTexture();
		const haloMat = new THREE.MeshBasicMaterial({
			map: haloTex,
			color: new THREE.Color(haloColor),
			transparent: true,
			opacity: haloStrength,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const haloGeom = new THREE.PlaneGeometry(1, 1);
		const haloMesh = new THREE.Mesh(haloGeom, haloMat);
		haloMesh.position.set(0, 0, -0.25);
		haloMesh.scale.set(5.5, 4.0, 1);
		sceneRoot.add(haloMesh);
		state.haloMesh = haloMesh;
		state.haloMat = haloMat;

		// ── Screenshot plane ────────────────────────────────────────────
		const screenGeom = new THREE.PlaneGeometry(1, 1);
		const screenMat = new THREE.MeshStandardMaterial({
			color: new THREE.Color(0x101216),
			emissive: new THREE.Color(0xffffff),
			emissiveIntensity: screenEmissive,
			metalness: 0.0,
			roughness: 0.55,
		});
		const screenMesh = new THREE.Mesh(screenGeom, screenMat);
		screenMesh.position.set(0, 0, 0);
		sceneRoot.add(screenMesh);
		state.screenMesh = screenMesh;
		state.screenMat = screenMat;

		// ── Command fragments pool ──────────────────────────────────────
		// Allocate MAX_FRAGMENTS upfront, hide unused via .visible.
		const colorKeys = [fragmentColor1, fragmentColor2, fragmentColor3];
		const initialStrings = commandStringsRef.current;
		for (let i = 0; i < MAX_FRAGMENTS; i++) {
			const stringIdx = i % initialStrings.length;
			const colorIdx = i % 3;
			const str = initialStrings[stringIdx]!;
			const colorHex = colorKeys[colorIdx]!;
			const { canvas: c, tex, width: w, height: h } = buildFragmentTexture(str, colorHex);
			const mat = new THREE.MeshBasicMaterial({
				map: tex,
				transparent: true,
				depthWrite: false,
				opacity: 1,
				blending: THREE.NormalBlending,
			});
			// Plane sized to canvas aspect at a base world scale of ~0.0042 / px.
			const scaleK = 0.0042;
			const worldW = w * scaleK;
			const worldH = h * scaleK;
			const geom = new THREE.PlaneGeometry(worldW, worldH);
			const mesh = new THREE.Mesh(geom, mat);
			mesh.position.set(0, 0, 0);
			sceneRoot.add(mesh);

			// Deterministic per-fragment drift parameters.
			const r0 = hash1(i, 11);
			const r1 = hash1(i, 22);
			const r2 = hash1(i, 33);
			const r3 = hash1(i, 44);
			const r4 = hash1(i, 55);
			const r5 = hash1(i, 66);
			const r6 = hash1(i, 77);
			// Depth split: half behind the screen (z=-4..-2.2), half in front (z=+0.6..+2.2).
			// This achieves the layered look (far fragments dim, front fragments crisp).
			const isFront = r6 < 0.55;
			const bz = isFront ? (0.6 + r3 * 1.6) : -(2.2 + r3 * 1.8);
			// X/Y orbit centre — spread around the screen but bias outward
			// so fragments avoid sitting directly ON the screenshot.
			let bx = (r0 - 0.5) * 6.5;
			let by = (r1 - 0.5) * 3.6;
			// Push fragments away from the centre by adding outward bias.
			if (Math.abs(bx) < 1.6) bx += Math.sign(bx || 1) * (1.0 + r4 * 0.8);
			if (Math.abs(by) < 1.0) by += Math.sign(by || 1) * (0.6 + r5 * 0.5);

			state.fragments.push({
				mesh, mat, tex, canvas: c, width: w, height: h,
				worldW, worldH,
				stringIdx, colorIdx,
				bx, by, bz,
				rx: 0.2 + r2 * 0.5,
				ry: 0.15 + r3 * 0.4,
				rz: 0.15 + r4 * 0.3,
				phaseX: r0 * Math.PI * 2,
				phaseY: r1 * Math.PI * 2,
				phaseZ: r2 * Math.PI * 2,
				speedScale: 0.5 + r5 * 1.2,
			});
		}

		// ── Syntax particles ────────────────────────────────────────────
		const particleTex = buildParticleTexture();
		const pPos = new Float32Array(MAX_PARTICLES * 3);
		const pVel = new Float32Array(MAX_PARTICLES * 3);
		const pCol = new Float32Array(MAX_PARTICLES * 3);
		const colA = new THREE.Color(particleColor1);
		const colB = new THREE.Color(particleColor2);
		const colC = new THREE.Color(particleColor3);
		for (let i = 0; i < MAX_PARTICLES; i++) {
			const r0 = hash1(i, 101);
			const r1 = hash1(i, 202);
			const r2 = hash1(i, 303);
			const r3 = hash1(i, 404);
			const r4 = hash1(i, 505);
			const r5 = hash1(i, 606);
			// Spread in a thick disc around the screen, with depth split.
			pPos[i * 3 + 0] = (r0 - 0.5) * 7.5;
			pPos[i * 3 + 1] = (r1 - 0.5) * 4.5;
			pPos[i * 3 + 2] = (r2 - 0.5) * 3.4;
			// Slow drift in a random direction.
			pVel[i * 3 + 0] = (r3 - 0.5) * 0.08;
			pVel[i * 3 + 1] = (r4 - 0.5) * 0.08;
			pVel[i * 3 + 2] = (r5 - 0.5) * 0.06;
			// Color pick.
			const pick = r0 < 0.45 ? colA : (r0 < 0.78 ? colB : colC);
			pCol[i * 3 + 0] = pick.r;
			pCol[i * 3 + 1] = pick.g;
			pCol[i * 3 + 2] = pick.b;
		}
		const pGeom = new THREE.BufferGeometry();
		pGeom.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
		pGeom.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
		pGeom.setDrawRange(0, particleCount);
		const pMat = new THREE.PointsMaterial({
			size: 0.12,
			map: particleTex,
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			sizeAttenuation: true,
			blending: THREE.AdditiveBlending,
			alphaTest: 0.01,
		});
		const points = new THREE.Points(pGeom, pMat);
		points.frustumCulled = false;
		sceneRoot.add(points);
		state.points = points;
		state.pGeom = pGeom;
		state.pMat = pMat;
		state.pPos = pPos;
		state.pVel = pVel;
		state.pCol = pCol;

		// ── Cursor trail overlay ────────────────────────────────────────
		// Separate Scene + OrthographicCamera so the line is in NDC and
		// always reads as a 2D overlay (no perspective foreshortening).
		const trailScene = new THREE.Scene();
		const trailCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
		const trailGeom = new THREE.BufferGeometry();
		const trailPos = new Float32Array(MAX_TRAIL * 3);
		const trailCol = new Float32Array(MAX_TRAIL * 3);
		trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
		trailGeom.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
		trailGeom.setDrawRange(0, 0);
		const trailMat = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			linewidth: 1,
		});
		const trailLine = new THREE.Line(trailGeom, trailMat);
		trailLine.frustumCulled = false;
		trailScene.add(trailLine);
		state.trailScene = trailScene;
		state.trailCam = trailCam;
		state.trailLine = trailLine;
		state.trailGeom = trailGeom;
		state.trailMat = trailMat;
		state.trailPos = trailPos;
		state.trailCol = trailCol;

		return () => {
			renderer.dispose();
			scene.traverse((obj: any) => {
				if (obj.geometry) obj.geometry.dispose?.();
				if (obj.material) {
					const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
					for (const m of mats) {
						if ((m as any).map && (m as any).map !== state.screenTex) (m as any).map.dispose?.();
						m.dispose?.();
					}
				}
			});
			trailGeom.dispose();
			trailMat.dispose();
			state.screenTex?.dispose?.();
			state.renderer = null;
			state.scene = null;
			state.camera = null;
			state.fragments = [];
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ────────────────────────────────────────────────────────────────────
	// Capture pointer samples directly on rootRef. The wrapper exposes
	// runtime.input (normalised 0..1) but for the cursor trail we want raw
	// clientX/Y → NDC every frame, which means listening directly.
	// ────────────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const el = rootRef?.current;
		if (!el) return;
		const state = stateRef.current;

		const updateRect = () => {
			const canvas = canvasRef.current;
			state.canvasRect = canvas ? canvas.getBoundingClientRect() : null;
		};
		updateRect();

		const onPointerMove = (e: PointerEvent) => {
			const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
			// Refresh rect cheaply — only when needed. We just update if it's null.
			if (!state.canvasRect) updateRect();
			const head = (state.trailHead + 1) % MAX_TRAIL;
			state.trailBufX[head] = e.clientX;
			state.trailBufY[head] = e.clientY;
			state.trailBufT[head] = now;
			state.trailHead = head;
			state.trailFilled = Math.min(MAX_TRAIL, state.trailFilled + 1);
		};
		const onPointerLeave = () => {
			// Don't clear immediately — let the trail fade naturally.
		};
		const onScroll = () => updateRect();

		el.addEventListener('pointermove', onPointerMove, { passive: true });
		el.addEventListener('pointerleave', onPointerLeave, { passive: true });
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', updateRect, { passive: true });
		return () => {
			el.removeEventListener('pointermove', onPointerMove);
			el.removeEventListener('pointerleave', onPointerLeave);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', updateRect);
		};
	}, [rootRef]);

	// ────────────────────────────────────────────────────────────────────
	// Resize.
	// ────────────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const state = stateRef.current;
		const renderer = state.renderer;
		const camera = state.camera;
		if (!renderer || !camera) return;
		const w = Math.max(2, size.width || 1);
		const h = Math.max(2, size.height || 1);
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		// Invalidate cached canvas rect so next pointer event re-fetches it.
		state.canvasRect = canvasRef.current?.getBoundingClientRect() ?? null;
	}, [size.width, size.height]);

	// ────────────────────────────────────────────────────────────────────
	// Load the screenshot texture and apply scale/tilt.
	// ────────────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const state = stateRef.current;
		const THREEmod = THREE;
		if (!state.scene || !state.screenMat) return;
		if (!screenshot) {
			if (state.screenMat) {
				state.screenMat.map = null;
				state.screenMat.emissiveMap = null;
				state.screenMat.needsUpdate = true;
			}
			setAssetReady(true);
			return;
		}
		let cancelled = false;

		const applyTexture = (tex: THREE.Texture, img: HTMLImageElement | HTMLCanvasElement | undefined) => {
			if (cancelled) { tex.dispose(); return; }
			tex.colorSpace = THREEmod.SRGBColorSpace;
			tex.minFilter = THREEmod.LinearFilter;
			tex.magFilter = THREEmod.LinearFilter;
			tex.generateMipmaps = false;
			tex.anisotropy = state.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
			tex.needsUpdate = true;
			state.screenTex?.dispose?.();
			state.screenTex = tex;
			if (img && (img as any).width && (img as any).height) {
				state.screenAspect = (img as any).width / (img as any).height;
			}
			if (state.screenMat) {
				state.screenMat.map = tex;
				state.screenMat.emissiveMap = tex;
				state.screenMat.color.setRGB(1, 1, 1);
				state.screenMat.needsUpdate = true;
			}
			applyScreenTransform();
			setAssetReady(true);
		};

		// Reuse the image whose download was kicked off during render so the
		// fetch has already overlapped scene construction. Fall back to
		// THREE.TextureLoader if no preload exists (e.g. no Image global).
		const preload = screenPreloadRef.current;
		const preImg = preload && preload.url === screenshot ? preload.img : null;
		if (preImg) {
			const onReady = () => applyTexture(new THREEmod.Texture(preImg), preImg);
			const onError = (err: any) => { console.error('[cyber-terminal] screenshot load failed:', err); setAssetReady(true); };
			if (preImg.complete && preImg.naturalWidth > 0) {
				onReady();
			} else {
				preImg.addEventListener('load', onReady, { once: true });
				preImg.addEventListener('error', onError, { once: true });
			}
		} else {
			const loader = new THREEmod.TextureLoader();
			loader.setCrossOrigin?.('anonymous');
			loader.load(
				screenshot,
				(tex: THREE.Texture) => applyTexture(tex, tex.image as HTMLImageElement | HTMLCanvasElement | undefined),
				undefined,
				(err: any) => {
					console.error('[cyber-terminal] screenshot load failed:', err);
					setAssetReady(true);
				},
			);
		}
		function applyScreenTransform() {
			const s = stateRef.current;
			if (!s.screenMesh) return;
			const baseW = 3.4 * Math.max(0.3, screenshotScale);
			const baseH = baseW / Math.max(0.4, s.screenAspect);
			s.screenMesh.scale.set(baseW, baseH, 1);
			s.screenMesh.position.set(screenshotX, screenshotY, 0);
			s.screenMesh.rotation.set(screenshotTilt * Math.PI / 180, 0, 0);
			// Halo scales with screen but extends well past it for soft glow.
			if (s.haloMesh) {
				s.haloMesh.scale.set(baseW * 1.9, baseH * 2.2, 1);
				s.haloMesh.position.set(screenshotX, screenshotY, -0.25);
			}
		}
		applyScreenTransform();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [screenshot]);

	// ────────────────────────────────────────────────────────────────────
	// Rebuild fragment CanvasTextures + plane geometry when the parsed
	// command list changes. Each fragment plane gets a new texture sized
	// to its newly-assigned string; the old texture/canvas/geometry are
	// disposed to avoid GPU leaks. Mesh transform state (position, drift
	// params) is preserved — only what depends on the text is rebuilt.
	// We key the effect on a stringified join so that editing any single
	// line in the textarea triggers a rebuild (the array identity from
	// React.useMemo already covers prop swaps).
	// ────────────────────────────────────────────────────────────────────
	const commandsKey = React.useMemo(() => commandStrings.join('\n'), [commandStrings]);
	React.useEffect(() => {
		const state = stateRef.current;
		const list = commandStrings;
		if (!list.length || !state.fragments.length) return;
		const colorKeys = [fragmentColor1, fragmentColor2, fragmentColor3];
		const scaleK = 0.0042;
		for (let i = 0; i < state.fragments.length; i++) {
			const f = state.fragments[i]!;
			const newIdx = i % list.length;
			const str = list[newIdx]!;
			const colorHex = colorKeys[f.colorIdx]!;
			// Dispose the previous texture (CanvasTexture holds a GPU upload).
			f.tex?.dispose?.();
			const built = buildFragmentTexture(str, colorHex);
			f.tex = built.tex;
			f.canvas = built.canvas;
			f.width = built.width;
			f.height = built.height;
			f.stringIdx = newIdx;
			// New world size for the plane — the canvas aspect changed.
			const worldW = built.width * scaleK;
			const worldH = built.height * scaleK;
			// Replace the plane geometry. Three.js Mesh.geometry is settable;
			// dispose the old one to free the buffer.
			const oldGeom = f.mesh.geometry;
			f.mesh.geometry = new THREE.PlaneGeometry(worldW, worldH);
			oldGeom?.dispose?.();
			f.worldW = worldW;
			f.worldH = worldH;
			// Point the material at the new texture.
			f.mat.map = built.tex;
			f.mat.needsUpdate = true;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [commandsKey]);

	// ────────────────────────────────────────────────────────────────────
	// Live slider sync — no geometry rebuilds. All cheap mutations.
	// ────────────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const state = stateRef.current;
		// Screen size + tilt + position.
		if (state.screenMesh) {
			const baseW = 3.4 * Math.max(0.3, screenshotScale);
			const baseH = baseW / Math.max(0.4, state.screenAspect);
			state.screenMesh.scale.set(baseW, baseH, 1);
			state.screenMesh.position.set(screenshotX, screenshotY, 0);
			state.screenMesh.rotation.set(screenshotTilt * Math.PI / 180, 0, 0);
			if (state.haloMesh) {
				state.haloMesh.scale.set(baseW * 1.9, baseH * 2.2, 1);
				state.haloMesh.position.set(screenshotX, screenshotY, -0.25);
			}
		}
		// Screen emissive.
		if (state.screenMat) {
			state.screenMat.emissiveIntensity = screenEmissive;
		}
		// Halo color + strength.
		if (state.haloMat) {
			state.haloMat.color.set(haloColor);
			state.haloMat.opacity = haloStrength;
		}
		// Fragment visibility.
		const fragN = Math.max(0, Math.min(MAX_FRAGMENTS, fragmentCount | 0));
		for (let i = 0; i < state.fragments.length; i++) {
			state.fragments[i]!.mesh.visible = i < fragN;
		}
		// Particle draw range.
		const partN = Math.max(0, Math.min(MAX_PARTICLES, particleCount | 0));
		if (state.pGeom) state.pGeom.setDrawRange(0, partN);
		// Trail color.
		state.colTrail.set(cursorTrailColor);
		state.colHalo.set(haloColor);
		// Particle color cache (for in-place recolor on slider drag).
		state.colPart[0].set(particleColor1);
		state.colPart[1].set(particleColor2);
		state.colPart[2].set(particleColor3);
		// Recolor existing particle attribute buffer based on the new tints.
		if (state.pCol && state.pGeom) {
			for (let i = 0; i < MAX_PARTICLES; i++) {
				const r = hash1(i, 101);
				const pick = r < 0.45 ? state.colPart[0]! : (r < 0.78 ? state.colPart[1]! : state.colPart[2]!);
				state.pCol[i * 3 + 0] = pick.r;
				state.pCol[i * 3 + 1] = pick.g;
				state.pCol[i * 3 + 2] = pick.b;
			}
			(state.pGeom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
		}
		// Fragment color cache (used by per-frame brightness modulation).
		state.colFrag[0].set(fragmentColor1);
		state.colFrag[1].set(fragmentColor2);
		state.colFrag[2].set(fragmentColor3);
		// Apply colors to fragment materials (multiplicative tint on the
		// already-baked texture). The baked text is mostly white-tinted by
		// the fragment color; here we just tint slightly to match the
		// active palette without rebuilding canvases.
		for (let i = 0; i < state.fragments.length; i++) {
			const f = state.fragments[i]!;
			const col = state.colFrag[f.colorIdx]!;
			// Mix toward the chosen color but keep it bright (the texture
			// already encodes the right tint).
			f.mat.color.setRGB(
				0.85 + 0.15 * col.r,
				0.85 + 0.15 * col.g,
				0.85 + 0.15 * col.b,
			);
		}
		// Trail line visibility (we still rebuild trail every frame so the
		// `visible` flag is the only sync to do here).
		if (state.trailLine) state.trailLine.visible = !!cursorTrailEnabled;
	}, [
		screenshotScale, screenshotX, screenshotY, screenshotTilt, screenEmissive,
		haloColor, haloStrength,
		fragmentCount, fragmentColor1, fragmentColor2, fragmentColor3,
		particleCount, particleColor1, particleColor2, particleColor3,
		cursorTrailEnabled, cursorTrailColor,
	]);

	// ────────────────────────────────────────────────────────────────────
	// rAF — all per-frame work happens here. Allocation-free.
	// ────────────────────────────────────────────────────────────────────
	useHeroAnimationFrame(rootRef, ({ elapsed, delta }) => {
		const state = stateRef.current;
		const renderer = state.renderer;
		const scene = state.scene;
		const camera = state.camera;
		if (!renderer || !scene || !camera) return;
		const dt = reducedMotion ? 0 : Math.min(0.05, Math.max(0.001, delta));

		// ── Smoothed pointer parallax (sceneRoot yaw/pitch + halo float) ──
		const ix = input?.x ?? 0.5;
		const iy = input?.y ?? 0.5;
		const ease = 1 - Math.exp(-Math.max(0.001, delta) * 3.0);
		state.px += (ix - state.px) * ease;
		state.py += (iy - state.py) * ease;
		if (state.sceneRoot) {
			const pStrength = Math.max(0, Math.min(1, parallaxStrength));
			state.sceneRoot.rotation.y = (state.px - 0.5) * 0.28 * pStrength;
			state.sceneRoot.rotation.x = -(state.py - 0.5) * 0.16 * pStrength;
		}

		// ── Drift command fragments. Each fragment orbits its base point
		//   with deterministic sin/cos motion + a slow time-driven drift.
		const fragGlobalSpeed = fragmentSpeed * 0.8;
		const t = reducedMotion ? 0 : elapsed * fragGlobalSpeed;
		for (let i = 0; i < state.fragments.length; i++) {
			const f = state.fragments[i]!;
			if (!f.mesh.visible) continue;
			const tt = t * f.speedScale;
			const px = f.bx + Math.sin(tt + f.phaseX) * f.rx;
			const py = f.by + Math.cos(tt * 0.7 + f.phaseY) * f.ry;
			const pz = f.bz + Math.sin(tt * 0.5 + f.phaseZ) * f.rz;
			f.mesh.position.set(px, py, pz);
			// Always face the camera, but apply a small yaw matching the
			// scene root so they read as drifting through the same space.
			f.mesh.rotation.set(0, 0, 0);
			// Opacity fades with distance: front fragments are brighter,
			// far-behind fragments fade.
			const depth = pz; // -4 .. +2 range typically
			const op = Math.max(0.18, Math.min(1, 1.0 - (-depth + 0.5) * 0.18));
			f.mat.opacity = op;
		}

		// ── Particle drift + pull toward screen origin ─────────────────
		const pPos = state.pPos;
		const pVel = state.pVel;
		const pGeom = state.pGeom;
		if (pPos && pVel && pGeom) {
			const pull = Math.max(0, Math.min(1, particlePull)) * 0.15; // small force
			const sx = state.screenMesh?.position.x ?? 0;
			const sy = state.screenMesh?.position.y ?? 0;
			const partN = Math.max(0, Math.min(MAX_PARTICLES, particleCount | 0));
			for (let i = 0; i < partN; i++) {
				let x = pPos[i * 3 + 0]!;
				let y = pPos[i * 3 + 1]!;
				let z = pPos[i * 3 + 2]!;
				let vx = pVel[i * 3 + 0]!;
				let vy = pVel[i * 3 + 1]!;
				let vz = pVel[i * 3 + 2]!;
				// Gentle pull toward (sx, sy, 0).
				const dx = sx - x;
				const dy = sy - y;
				const dz = 0 - z;
				const d2 = dx * dx + dy * dy + dz * dz + 1e-4;
				const inv = 1 / Math.sqrt(d2);
				const f = pull * dt * Math.min(1.5, 1.0 / Math.max(0.4, d2 * 0.25));
				vx += dx * inv * f;
				vy += dy * inv * f;
				vz += dz * inv * f * 0.4; // weaker pull on Z so they stay layered
				// Damp slightly so the field doesn't blow up.
				const damp = Math.pow(0.985, dt * 60);
				vx *= damp; vy *= damp; vz *= damp;
				// Integrate.
				x += vx * dt;
				y += vy * dt;
				z += vz * dt;
				// If a particle reaches the screen, reseed it on the
				// outskirts (wrap). Use a deterministic respawn hash so
				// successive lives are varied but reproducible.
				const dr2 = (sx - x) * (sx - x) + (sy - y) * (sy - y) + z * z;
				if (dr2 < 0.10 * 0.10) {
					const r0 = hash1(i, 991 + Math.floor(elapsed * 7));
					const r1 = hash1(i, 992 + Math.floor(elapsed * 11));
					const r2 = hash1(i, 993 + Math.floor(elapsed * 13));
					const ang = r0 * Math.PI * 2;
					const rad = 3.4 + r1 * 1.4;
					x = sx + Math.cos(ang) * rad;
					y = sy + Math.sin(ang) * rad * 0.55;
					z = (r2 - 0.5) * 3.0;
					vx = -Math.cos(ang) * 0.06;
					vy = -Math.sin(ang) * 0.06;
					vz = (hash1(i, 994) - 0.5) * 0.04;
				}
				pPos[i * 3 + 0] = x;
				pPos[i * 3 + 1] = y;
				pPos[i * 3 + 2] = z;
				pVel[i * 3 + 0] = vx;
				pVel[i * 3 + 1] = vy;
				pVel[i * 3 + 2] = vz;
			}
			(pGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
		}

		// ── Cursor trail. Convert the ring buffer (client coords) into
		//   the trail line's NDC positions. Trail length is clamped to
		//   cursorTrailLength. Per-vertex alpha (encoded in RGB via additive
		//   blending) decays from head (newest) to tail (oldest). ──────
		const trailGeom = state.trailGeom;
		const trailPos = state.trailPos;
		const trailCol = state.trailCol;
		const rect = state.canvasRect;
		if (trailGeom && trailPos && trailCol && state.trailLine && cursorTrailEnabled && rect && rect.width > 1 && rect.height > 1 && state.trailFilled > 1) {
			const wantN = Math.max(2, Math.min(MAX_TRAIL, cursorTrailLength | 0));
			const have = Math.min(state.trailFilled, wantN);
			// Walk from newest → oldest in the ring buffer.
			let count = 0;
			const head = state.trailHead;
			const tNow = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
			const maxAge = 1.2; // seconds — older samples drop out
			const baseR = state.colTrail.r;
			const baseG = state.colTrail.g;
			const baseB = state.colTrail.b;
			for (let i = 0; i < have; i++) {
				const idx = (head - i + MAX_TRAIL) % MAX_TRAIL;
				const cx = state.trailBufX[idx]!;
				const cy = state.trailBufY[idx]!;
				const age = tNow - state.trailBufT[idx]!;
				if (age > maxAge) break;
				// Convert client px → canvas NDC (-1..+1).
				const nx = ((cx - rect.left) / rect.width) * 2 - 1;
				// Three's NDC has +Y up; clientY is top-down, so flip.
				const ny = -(((cy - rect.top) / rect.height) * 2 - 1);
				trailPos[count * 3 + 0] = nx;
				trailPos[count * 3 + 1] = ny;
				trailPos[count * 3 + 2] = 0;
				// Alpha curve: 1 at head, ~0 at the trail's far end.
				// Combine "index decay" (i/wantN) with "age decay" (age/maxAge).
				const idxA = 1 - i / wantN;
				const ageA = 1 - age / maxAge;
				const a = Math.max(0, idxA * idxA * ageA);
				// Encode alpha via RGB scale — additive blend makes black = invisible.
				trailCol[count * 3 + 0] = baseR * a;
				trailCol[count * 3 + 1] = baseG * a;
				trailCol[count * 3 + 2] = baseB * a;
				count++;
			}
			(trailGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
			(trailGeom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
			trailGeom.setDrawRange(0, count);
			state.trailLine.visible = count > 1;
		} else if (state.trailLine) {
			state.trailLine.visible = false;
		}

		// ── Render. Main scene first, then trail overlay on top. ───────
		renderer.autoClear = true;
		renderer.render(scene, camera);
		if (state.trailLine?.visible && state.trailScene && state.trailCam) {
			renderer.autoClear = false;
			renderer.render(state.trailScene, state.trailCam);
			renderer.autoClear = true;
		}
	});

	return (
		<canvas
			ref={canvasRef}
			className="crazygl-cyber-terminal-canvas"
			aria-hidden="true"
		/>
	);
}
