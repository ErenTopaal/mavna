import { useEffect, useRef } from "react";
import type { GpuFailureReason, PresetConfig, ShaderInstance } from "shaders/js";

/*
 * The page's background: a slow red aurora from the top over the flat ground,
 * with a faint ember along the bottom edge. Everything about how it is drawn
 * stays in this file, so the drawing can be replaced without touching the app.
 */

// the page ground, oklch(0.145 0 0), which index.html paints before any of this loads
const GROUND = "#0a0a0a";

const LOOK: PresetConfig = {
  components: [
    { type: "SolidColor", props: { color: GROUND } },
    // a faint ember along the bottom edge only, so the foot of the page is not dead black
    {
      type: "RadialGradient",
      props: {
        colorA: "#5a1019",
        colorB: GROUND,
        center: { x: 0.5, y: 1.3 },
        radius: 0.62,
        aspect: 0.45,
        colorSpace: "linear",
        opacity: 0.55,
      },
    },
    {
      type: "Aurora",
      props: {
        colorA: "#3a0a0e",
        colorB: "#ff6367",
        colorC: "#ffb8b4",
        intensity: 55,
        curtainCount: 3,
        speed: 5,
        waviness: 90,
        rayDensity: 12,
        height: 90,
        center: { x: 0.5, y: 0 },
        seed: 4,
        opacity: 0.55,
      },
    },
    // the canvas is 8-bit, so the dark gradients step visibly; a per-pixel blue
    // noise under soft light breaks the steps up. It sits a little below linear
    // mid grey (#bcbcbc), which takes the whole page down a touch, and its two
    // colours are close so the noise never reads as grain
    {
      type: "BlueNoise",
      props: { colorA: "#b6b6b6", colorB: "#b2b2b2", grain: 1, blendMode: "softLight" },
    },
  ],
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

// the reasons createShader gives up for good with; it reports a device it is
// recovering from through the same callback, with the browser's own message
const TERMINAL: ReadonlySet<string> = new Set<
  GpuFailureReason | "unrecoverable" | "rebuild_failed"
>([
  "unsupported",
  "no-adapter",
  "no-device",
  "init-failed",
  "device-lost",
  "out-of-memory",
  "gpu-error",
  "render-failed",
  "limit-exceeded",
  "unrecoverable",
  "rebuild_failed",
]);

/**
 * Fixed behind the widget. The library loads only once this mounts, so the
 * widget never waits for it. Without WebGPU the canvas stays transparent and
 * the flat ground shows through.
 */
export function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let instance: ShaderInstance | null = null;
    let drawn = false;
    let gone = false;
    const motion = window.matchMedia(REDUCED_MOTION);
    // the library has no reduced-motion handling of its own: hold a still
    // frame, and follow the preference if it changes while the page is open.
    // Pausing before the first frame is drawn would hold an empty canvas.
    const follow = () => {
      if (instance === null || !drawn) return;
      if (motion.matches) instance.pause();
      else instance.resume();
    };
    void import("shaders/js").then(async ({ createShader }) => {
      if (gone) return;
      const created = await createShader(canvas, LOOK, {
        // the owner has not agreed to send visitor data to the library's maker
        disableTelemetry: true,
        colorSpace: "srgb",
        // fires once a frame has really been rendered, which can be after
        // createShader resolves while its pipelines are still compiling
        onReady: () => {
          drawn = true;
          follow();
        },
        onError: (reason) => {
          // no WebGPU at all is the expected case the flat ground is there for
          if (reason === "unsupported") return;
          if (TERMINAL.has(reason)) console.error(`the background shader stopped: ${reason}`);
          // anything else is a lost device the library is already rebuilding from
          else console.warn(`the background shader lost its device and is rebuilding: ${reason}`);
        },
      });
      if (gone) {
        created.destroy();
        return;
      }
      instance = created;
      follow();
      motion.addEventListener("change", follow);
    });
    return () => {
      gone = true;
      motion.removeEventListener("change", follow);
      instance?.destroy();
    };
  }, []);
  return (
    <div
      aria-hidden="true"
      style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}
