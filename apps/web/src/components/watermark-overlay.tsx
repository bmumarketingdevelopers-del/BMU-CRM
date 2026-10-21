// v37: the on-screen watermark over a one-time project's video before the final payment (videos can't be marked on
// the server). Sits above the player and lets clicks through to the controls.
const LINE = "BMU · PREVIEW · Not for use until paid";

export function WatermarkOverlay() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden select-none" data-testid="watermark-overlay">
      <div className="absolute -inset-1/2 flex rotate-[-24deg] flex-col justify-center gap-16">
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i} className="whitespace-nowrap text-center text-sm font-semibold tracking-wide text-white/45 [text-shadow:0_0_2px_rgba(0,0,0,0.7)] sm:text-base">
            {`${LINE}      ${LINE}      ${LINE}`}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Player props for a preview: no download button, no picture-in-picture, no right-click "Save video". */
export const previewVideoProps = {
  controlsList: "nodownload noremoteplayback",
  disablePictureInPicture: true,
  onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
} as const;
