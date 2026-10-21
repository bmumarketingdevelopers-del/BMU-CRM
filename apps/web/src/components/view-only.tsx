"use client";
// v39: a one-time project's work before the final payment is view only: the clean file in an in-app viewer with no
// download button, no right-click "Save", no picture-in-picture. (Downloads unlock after the final payment.)

/** Player props for view-only video: no download button, no picture-in-picture, no right-click "Save video". */
export const previewVideoProps = {
  controlsList: "nodownload noremoteplayback",
  disablePictureInPicture: true,
  onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
} as const;

/** Files the viewer can show; anything else waits for the final payment. */
export const canViewOnly = (mime: string | null | undefined, kind?: string) => /^(image|video)\//.test(mime ?? "") || mime === "application/pdf" || ["image", "video", "pdf"].includes(kind ?? "");

export function ViewOnlyViewer({ file, onClose }: { file: { url: string; name: string; mimeType?: string | null; kind?: string }; onClose: () => void }) {
  const mime = file.mimeType ?? "";
  const kind = mime.startsWith("video/") || file.kind === "video" ? "video" : mime === "application/pdf" || file.kind === "pdf" ? "pdf" : "image";
  const stop = (e: React.SyntheticEvent) => e.preventDefault();
  return (
    <div role="dialog" aria-modal aria-label={`View ${file.name}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="relative flex max-h-full w-full max-w-5xl flex-col" onClick={(e) => e.stopPropagation()} onContextMenu={stop}>
        <div className="flex min-h-0 justify-center bg-black">
          {kind === "video" ? (
            <video src={file.url} controls autoPlay playsInline className="block max-h-[80vh] max-w-full" {...previewVideoProps} />
          ) : kind === "pdf" ? (
            // The browser's PDF toolbar (with its download button) is hidden.
            <iframe title={file.name} src={`${file.url}#toolbar=0&navpanes=0`} className="h-[80vh] w-full bg-white" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={file.url} alt={file.name} draggable={false} onDragStart={stop} className="block max-h-[80vh] max-w-full select-none" />
          )}
        </div>
        <p className="mt-2 flex justify-between gap-4 text-xs text-white/80">
          <span>View only. The download unlocks after sign-off and the final payment.</span>
          <button type="button" className="underline" onClick={onClose}>
            Close
          </button>
        </p>
      </div>
    </div>
  );
}
