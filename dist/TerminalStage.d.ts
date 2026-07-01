import * as React from 'react';
interface StageProps {
    rootRef: React.RefObject<HTMLElement | null>;
    size: {
        width: number;
        height: number;
        dpr: number;
    };
    input: {
        x: number;
        y: number;
        active: boolean;
    };
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
export default function TerminalStage(props: StageProps): import("react/jsx-runtime").JSX.Element;
export {};
