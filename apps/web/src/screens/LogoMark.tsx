import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CUES, Easing, LOOP_SECONDS, REVERSE_AT, animate, authoredTime } from '../lib/logoFold.js';

/**
 * The brand mark, folding into itself while the agent works.
 *
 * Whole and still when there is nothing to say, and folding when there is:
 * one mark that comes alive rather than a separate spinner appearing beside
 * it. Only the copy in the conversation folds; the one in the rail stays
 * whole, so the corner of the screen is not moving while a student reads.
 *
 * The geometry below is measured, not derived -- each fold axis is the
 * perpendicular bisector between a piece and the spot it lands on, taken off
 * the artwork itself. That is why the texture has to keep its original
 * framing (see scripts/make-web-marks.py): the numbers are in a 900-unit
 * space laid over the whole square, and re-cropping the image moves every
 * landing spot without moving the axis that aims at it.
 */

const IMG = '/mark.png';

/** The space the fold was measured in. Everything below is in these units. */
const S = 900;
const C1 = 474.5; // cut line: C | bars (mid white gap)
const C2 = 617.2; // cut line: bars | small blocks (mid white gap)
const SPLIT = 0.47 * S; // horizontal split between the two block rows

/**
 * Where the coloured artwork sits inside that square.
 *
 * The mark does not fill its own texture -- there is transparent margin on
 * every side. Sizing to the square would leave the caller guessing how much
 * of what they asked for is actually mark, so `size` means the height of the
 * visible mark and this is what converts it back.
 */
const MARK = { left: 171.45, top: 87.19, width: 558.11, height: 726.64 };

const ROWS = [
  {
    yA: 0,
    yB: SPLIT,
    ax: { ox: 609.2, oy: 221.9, tilt: 26.32, sx: -128.3, sy: -63.4 }, // blocks -> bars
    c: { x: 545.0, y: 190.4, rot: -19.3 }, // bar centroid + slant
    bx: { ox: 472.2, oy: 216.3, tilt: -19.53, sx: -145.7, sy: 51.7 },
    l: { x: 399.3, y: 242.1 },
  },
  {
    yA: SPLIT,
    yB: S,
    ax: { ox: 609.3, oy: 679.0, tilt: -27.39, sx: -128.4, sy: 66.5 },
    c: { x: 545.0, y: 712.4, rot: 20.3 },
    bx: { ox: 472.2, oy: 684.1, tilt: 21.28, sx: -145.7, sy: -56.7 },
    l: { x: 399.3, y: 655.7 },
  },
];

// Fold 3: only the purple slab + deep blue wedge fold (not the outer blue C).
// Fold lines: bottom = measured purple/deep-blue boundary y=-0.5375x+823.75,
// top = its mirror y=0.5375x+77.05. Piece outer edges follow the purple
// silhouette: top edge y=-0.3565x+334.7, wedge bottom y=0.3731x+557.8.
const L3TOP = {
  tilt: -61.74,
  ox: 381,
  oy: 281.84,
  clip: `polygon(282.6px 228.9px, ${C1}px 160.5px, ${C1}px 332.09px)`,
};
const L3BOT = {
  tilt: 61.74,
  ox: 381,
  oy: 618.91,
  clip: `polygon(286.6px 669.7px, ${C1}px 568.71px, ${C1}px 739.85px)`,
};
// Base = the outer blue C only: left slice with the whole purple+wedge silhouette notched out.
const CBASE = `polygon(0px 0px, ${C1}px 0px, ${C1}px 160.5px, 276px 231.3px, 276px 665.8px, ${C1}px 739.85px, ${C1}px ${S}px, 0px ${S}px)`;
// The purple middle band (between the two fold-3 lines, bounded by the purple silhouette).
const BAND = `polygon(276px 231.3px, 282.6px 228.9px, ${C1}px 332.09px, ${C1}px 568.71px, 286.6px 669.7px, 276px 665.8px)`;
// The purple's left edge (mid white gap). There was once a fourth fold about
// this axis, swinging the landed band and its flaps left onto the blue bar;
// the animation drops it, and what is left is the band's origin. Kept as the
// export writes it, so the next re-port stays a clean diff.
const BAND_AXIS_X = 275;

/** How hard the folded faces darken as they turn. */
const SHADING = 0.9;

const MOTION = {
  fold: (start: number, end: number) =>
    animate({ from: 0, to: -179.92, start, end, ease: Easing.easeInOutCubic }),
  fade: (from: number, to: number, start: number, end: number) =>
    animate({ from, to, start, end, ease: Easing.easeInOutQuad }),
};

const cue = (name: string): number => CUES[name] ?? 0;

const sliceStyle = (
  xL: number,
  xR: number,
  yA: number,
  yB: number,
  filter?: string,
  clip?: string,
): CSSProperties => ({
  position: 'absolute',
  left: 0,
  top: 0,
  width: S,
  height: S,
  backgroundImage: `url("${IMG}")`,
  backgroundSize: `${S}px ${S}px`,
  backgroundRepeat: 'no-repeat',
  clipPath: clip ?? `inset(${yA}px ${S - xR}px ${S - yB}px ${xL}px)`,
  ...(filter ? { filter } : {}),
});

interface PanelProps {
  ox: number;
  oy: number;
  tilt: number;
  sx: number;
  sy: number;
  xL?: number;
  xR?: number;
  yA?: number;
  yB?: number;
  clip?: string;
  angle: number;
  mirrorBack?: boolean;
}

/**
 * A strip folding about a diagonal in-plane axis through (ox, oy), tilted
 * `tilt` degrees from vertical.
 *
 * Face visibility is gated on the angle rather than left to backface culling,
 * so a rest state renders correctly even where the browser has not composited
 * the 3D layer yet.
 */
function Panel({
  ox,
  oy,
  tilt,
  sx,
  sy,
  xL = 0,
  xR = S,
  yA = 0,
  yB = S,
  clip,
  angle,
  mirrorBack,
}: PanelProps) {
  const shade = Math.sin((Math.min(Math.abs(angle), 179.9) / 180) * Math.PI) * SHADING;
  const showBack = Math.abs(angle) >= 90;
  const origin = `${ox}px ${oy}px`;
  const face: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: S,
    height: S,
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
  };
  const backFace: CSSProperties = mirrorBack
    ? { ...face, backfaceVisibility: 'visible', WebkitBackfaceVisibility: 'visible' }
    : face;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: S,
        height: S,
        transformStyle: 'preserve-3d',
        transformOrigin: origin,
        transform: `rotate(${tilt}deg) rotateY(${angle}deg) rotate(${-tilt}deg)`,
      }}
    >
      <div
        style={{ ...face, transformOrigin: origin, visibility: showBack ? 'hidden' : 'visible' }}
      >
        <div style={sliceStyle(xL, xR, yA, yB, `brightness(${1 - shade * 0.2})`, clip)} />
      </div>
      <div
        style={{
          ...backFace,
          transformOrigin: origin,
          visibility: showBack ? 'visible' : 'hidden',
          transform: mirrorBack ? 'none' : `rotate(${tilt}deg) rotateY(180deg) rotate(${-tilt}deg)`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: S,
            height: S,
            transformOrigin: origin,
            transform: `translate(${sx}px, ${sy}px)`,
          }}
        >
          <div style={sliceStyle(xL, xR, yA, yB, `brightness(${1 - shade * 0.1})`, clip)} />
        </div>
      </div>
    </div>
  );
}

/** The whole mark at one authored moment. */
function Piece({ T }: { T: number }) {
  // Fold 1: the small blocks onto the bars, then a grow-sideways merge.
  const a2 = MOTION.fold(cue('The fold') + 0.02, cue('Merge') - 0.04)(T);
  const mp = MOTION.fade(0, 1, cue('Merge'), cue('Merge') + 0.16)(T);
  const blocksOp = MOTION.fade(1, 0, cue('Merge') + 0.06, cue('Merge') + 0.18)(T);
  // Fold 2: the bars onto the inner C, pressed in rather than spread.
  const a1 = MOTION.fold(cue('Second fold') + 0.02, cue('Merge 2') - 0.04)(T);
  const mp2 = MOTION.fade(0, 1, cue('Merge 2'), cue('Merge 2') + 0.16)(T);
  const barsOp = MOTION.fade(1, 0, cue('Merge 2') + 0.06, cue('Merge 2') + 0.18)(T);
  // Fold 3: top and bottom fold inward onto the purple band, and stay put.
  // Toward the viewer, so the pieces visibly overlap it rather than vanishing
  // behind. The last fold, and it has the rest of the run to make.
  const a3 = -MOTION.fold(cue('Third fold') + 0.02, REVERSE_AT - 0.06)(T);

  const mSx = 1 + 0.24 * mp;
  const mSy = 1 - 0.08 * mp;
  const mS2y = 1 - 0.08 * mp2;
  const landed1 = T >= cue('Merge') - 0.001;
  const landed2 = T >= cue('Merge 2') - 0.001;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: S,
        height: S,
        perspective: '1900px',
        perspectiveOrigin: `${(C1 + C2) / 2}px 50%`,
      }}
    >
      <div style={sliceStyle(0, C1, 0, S, undefined, CBASE)} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformStyle: 'preserve-3d',
          transformOrigin: `${BAND_AXIS_X}px 450px`,
        }}
      >
        <div style={sliceStyle(0, C1, 0, S, undefined, BAND)} />
        {[L3TOP, L3BOT].map((f, i) => (
          <Panel
            key={i}
            ox={f.ox}
            oy={f.oy}
            tilt={f.tilt}
            sx={0}
            sy={0}
            clip={f.clip}
            mirrorBack
            angle={a3}
          />
        ))}
      </div>
      <div
        style={{ position: 'absolute', inset: 0, opacity: barsOp, transformStyle: 'preserve-3d' }}
      >
        {ROWS.map((r, i) =>
          landed2 ? (
            <div
              key={i}
              style={{
                position: 'absolute',
                inset: 0,
                transformOrigin: '0 0',
                transform: `translate(${r.l.x}px, ${r.l.y}px) rotate(${r.c.rot}deg) scale(1, ${mS2y}) rotate(${-r.c.rot}deg) translate(${-r.l.x}px, ${-r.l.y}px) translate(${r.bx.sx}px, ${r.bx.sy}px)`,
              }}
            >
              <div style={sliceStyle(C1, C2, r.yA, r.yB)} />
            </div>
          ) : (
            <Panel
              key={i}
              ox={r.bx.ox}
              oy={r.bx.oy}
              tilt={r.bx.tilt}
              sx={r.bx.sx}
              sy={r.bx.sy}
              xL={C1}
              xR={C2}
              yA={r.yA}
              yB={r.yB}
              angle={a1}
            />
          ),
        )}
      </div>
      <div
        style={{ position: 'absolute', inset: 0, opacity: blocksOp, transformStyle: 'preserve-3d' }}
      >
        {ROWS.map((r, i) =>
          landed1 ? (
            <div
              key={i}
              style={{
                position: 'absolute',
                inset: 0,
                transformOrigin: '0 0',
                transform: `translate(${r.c.x}px, ${r.c.y}px) rotate(${r.c.rot}deg) scale(${mSx}, ${mSy}) rotate(${-r.c.rot}deg) translate(${-r.c.x}px, ${-r.c.y}px) translate(${r.ax.sx}px, ${r.ax.sy}px)`,
              }}
            >
              <div style={sliceStyle(C2, S, r.yA, r.yB)} />
            </div>
          ) : (
            <Panel
              key={i}
              ox={r.ax.ox}
              oy={r.ax.oy}
              tilt={r.ax.tilt}
              sx={r.ax.sx}
              sy={r.ax.sy}
              xL={C2}
              xR={S}
              yA={r.yA}
              yB={r.yB}
              angle={a2}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** Whether this student has asked their machine to stop animating things. */
function prefersStill(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface Props {
  /** Height of the visible mark in px. The transparent margin is trimmed. */
  size: number;
  /** Folding while true, whole and still while false. */
  working: boolean;
}

export function LogoMark({ size, working }: Props) {
  const [elapsed, setElapsed] = useState(0);
  /*
   * Started by work and stopped by the loop, not by work. Cutting the frames
   * the moment an answer arrives leaves the mark folded in half on screen;
   * carrying on to the end of the loop lands it whole, which is the only
   * shape it should ever come to rest in.
   */
  const [running, setRunning] = useState(false);
  const stillWorking = useRef(working);

  useEffect(() => {
    stillWorking.current = working;
    if (working && !prefersStill()) setRunning(true);
  }, [working]);

  useEffect(() => {
    if (!running) return;

    let frame = 0;
    let previous = 0;
    const startedAt = performance.now();

    const step = (now: number) => {
      const seconds = (now - startedAt) / 1000;
      const wrapped = Math.floor(seconds / LOOP_SECONDS) > Math.floor(previous / LOOP_SECONDS);
      previous = seconds;

      if (!stillWorking.current && wrapped) {
        setElapsed(0);
        setRunning(false);
        return;
      }
      setElapsed(seconds);
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  const scale = size / MARK.height;

  return (
    <span
      className="logo-mark"
      aria-hidden="true"
      style={{ width: MARK.width * scale, height: MARK.height * scale }}
    >
      <span
        style={{
          position: 'absolute',
          left: -MARK.left * scale,
          top: -MARK.top * scale,
          width: S,
          height: S,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
        }}
      >
        <Piece T={authoredTime(elapsed)} />
      </span>
    </span>
  );
}
