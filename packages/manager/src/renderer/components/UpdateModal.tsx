import React, { useState, useEffect, useRef } from 'react';

interface UpdateInfo {
  hasUpdate: boolean;
  forceUpdate?: boolean;
  version?: string;
  notes?: string;
  downloadUrl?: string;
  publishDate?: string;
}

export default function UpdateModal() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.mlb.system.checkUpdate().then((info) => {
        if (info?.hasUpdate) setUpdate(info);
      }).catch(() => {});
    }, 3000); // delay 3s after mount
    return () => clearTimeout(timer);
  }, []);

  // Show/hide dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const shouldShow = update?.hasUpdate && !dismissed;
    if (shouldShow && !dialog.open) {
      dialog.showModal();
    } else if (!shouldShow && dialog.open) {
      dialog.close();
    }
  }, [update, dismissed]);

  if (!update?.hasUpdate || dismissed) return null;

  const handleDownload = () => {
    if (update.downloadUrl) {
      window.mlb.system.openUrl(update.downloadUrl);
    }
  };

  const handleDismiss = () => {
    if (!update.forceUpdate) setDismissed(true);
  };

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-[200] bg-transparent backdrop:bg-black/40 backdrop:backdrop-blur-sm
        p-0 m-auto rounded-2xl shadow-2xl border-0 outline-none max-w-md w-full
        animate-modal-in"
      onClick={(e) => {
        if (e.target === dialogRef.current && !update.forceUpdate) handleDismiss();
      }}
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-2xl">🎉</span>
          <h3 className="text-base font-semibold">发现新版本 v{update.version}</h3>
        </div>

        {/* Release date */}
        {update.publishDate && (
          <p className="text-xs text-slate-500 dark:text-slate-500 mb-3">
            发布于 {update.publishDate}
          </p>
        )}

        {/* Release notes */}
        {update.notes && (
          <div className="mb-6 max-h-48 overflow-auto rounded-xl bg-slate-50 dark:bg-slate-900/50 p-4
            text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
            {update.notes.split('\n').map((line, i) => (
              <div key={i} className={line.startsWith('-') ? 'ml-1' : ''}>
                {line || <br />}
              </div>
            ))}
          </div>
        )}

        {/* Force update notice */}
        {update.forceUpdate && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
            ⚠️ 当前版本已不兼容，请更新后继续使用
          </p>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-3">
          {!update.forceUpdate && (
            <button
              onClick={handleDismiss}
              className="px-4 py-2 text-sm font-medium rounded-lg
                bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
                hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              稍后提醒
            </button>
          )}
          <button
            onClick={handleDownload}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors
              bg-indigo-600 text-white hover:bg-indigo-700"
          >
            下载更新
          </button>
        </div>
      </div>
    </dialog>
  );
}
