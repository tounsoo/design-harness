import { CircleAlert, CircleCheck, Minus } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import type { FrameKey, Session } from "../runtime/session";
import type { LensDrawing, PlacedLens } from "./lens";

/**
 * A lens drawn over one artboard, by the app and outside the frame, so its
 * lines and labels keep their size at any zoom and nothing about the page
 * that is measured changes. What belongs to the page moves with it when the
 * frame scrolls (the frame says where it is, `protocol.ts`); the view's
 * edge, the strip beside it and the ghost under the artboard stay put. The
 * layer is hidden from assistive technology: the line of words under the
 * artboard says the same thing.
 */
export function LensLayer({ session, frame, placed, scale, scheme }: { readonly session: Session; readonly frame: FrameKey; readonly placed: PlacedLens; readonly scale: number; readonly scheme: "light" | "dark" }) {
  const id = useId();
  const scroll = useSyncExternalStore(session.subscribeScroll, () => session.scrollOf(frame));
  const { shapes, labels, width, height, below, beside, gutter } = placed;
  const moved = `translate(${-scroll.x * scale} ${-scroll.y * scale})`;
  const label = (item: PlacedLens["labels"][number], index: number) => (
    <g key={index} className="lens-label" data-tone={item.tone} data-testid="lens-label">
      <rect x={item.x} y={item.y} width={item.width} height={item.height} rx="3" />
      <text x={item.x + item.width / 2} y={item.y + item.height - 4.5} textAnchor="middle">
        {item.tone === "fail" ? "✕ " : ""}
        {item.text}
      </text>
    </g>
  );
  return (
    <svg className="lens-layer" data-scheme={scheme} width={width + beside + 2} height={height + below + 2} aria-hidden="true" data-testid="lens-layer">
      <defs>
        <pattern id={`${id}hatch`} className="vis-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" />
        </pattern>
        <clipPath id={`${id}board`}>
          <rect x="0" y="0" width={width} height={height + 1.5} />
        </clipPath>
        {/* A label that belongs to the page may sit just under the artboard, with the first view's end. */}
        <clipPath id={`${id}labels`}>
          <rect x="0" y="0" width={width + beside} height={height + below + 2} />
        </clipPath>
      </defs>
      {below > gutter && gutter > 0 && <rect className="lens-ghost-area" x="0.75" y={height + gutter} width={width - 1.5} height={below - gutter} data-testid="lens-ghost-area" />}
      {shapes.map((shape, index) => (shape.kind === "ghost" ? <rect key={index} className="lens-ghost" data-tone={shape.tone} x={shape.rect.x} y={shape.rect.y} width={shape.rect.width} height={shape.rect.height} rx="2" {...(shape.tone === "fail" ? { fill: `url(#${id}hatch)` } : {})} data-testid="lens-ghost" /> : null))}
      <g clipPath={`url(#${id}board)`}>
        <g transform={moved}>
          {shapes.map((shape, index) => {
            switch (shape.kind) {
              case "circle":
                return (
                  <g key={index}>
                    <circle className="lens-halo" cx={shape.cx} cy={shape.cy} r={shape.r} />
                    <circle className="lens-circle" cx={shape.cx} cy={shape.cy} r={shape.r} fill={`url(#${id}hatch)`} data-testid="lens-circle" />
                  </g>
                );
              case "box":
                // A halo under each stroke keeps it readable on any colour the page paints there.
                return (
                  <g key={index}>
                    <rect className="lens-halo" x={shape.rect.x} y={shape.rect.y} width={shape.rect.width} height={shape.rect.height} rx="2" />
                    <rect className="lens-box" data-tone={shape.tone} x={shape.rect.x} y={shape.rect.y} width={shape.rect.width} height={shape.rect.height} rx="2" data-testid="lens-box" />
                  </g>
                );
              case "line":
                return shape.axis === "y" ? (
                  <g key={index}>
                    <line className="lens-halo" x1="0" y1={shape.at} x2={width} y2={shape.at} />
                    <line className="lens-line" data-tone={shape.tone} x1="0" y1={shape.at} x2={width} y2={shape.at} data-testid="lens-fold" />
                  </g>
                ) : null;
              default:
                return null;
            }
          })}
        </g>
      </g>
      <g clipPath={`url(#${id}labels)`}>
        <g transform={moved}>{labels.filter((item) => item.layer === "page").map(label)}</g>
      </g>
      {shapes.map((shape, index) => {
        if (shape.kind === "line" && shape.axis === "x") return <line key={index} className="lens-line" data-tone={shape.tone} x1={shape.at} y1="0" x2={shape.at} y2={height} data-testid="lens-edge" />;
        if (shape.kind === "strip") return <rect key={index} className="lens-strip" x={shape.rect.x} y="0" width={shape.rect.width} height={height} fill={`url(#${id}hatch)`} data-testid="lens-strip" />;
        return null;
      })}
      {labels.filter((item) => item.layer !== "page").map(label)}
    </svg>
  );
}

/** The lens in words, under its artboard: the same facts the layer draws, with a mark that does not rest on colour. */
export function LensWords({ drawing }: { readonly drawing: LensDrawing }) {
  return (
    <p className="lens-words" data-tone={drawing.tone} data-testid="lens-words">
      <span className="lens-words-icon" aria-hidden="true">
        {drawing.tone === "ok" ? <CircleCheck /> : drawing.tone === "fail" ? <CircleAlert /> : <Minus />}
      </span>
      <span>{drawing.words}</span>
    </p>
  );
}
