import React, { useState, useEffect, useCallback } from 'react';
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedTime: string;
}

interface FileManagerProps {
  name: string;
}

export default function FileManager({ name }: FileManagerProps) {
  const { navigate } = useBridgeStore();
  const { t } = useI18n();

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [workDir, setWorkDir] = useState('');
  const [currentPath, setCurrentPath] = useState('.');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Preview state
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
    truncated: boolean;
    size: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadFiles = useCallback(async (subpath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.mlb.bridge.files(name, subpath);
      setEntries(result.entries);
      setWorkDir(result.workDir);
      setCurrentPath(result.currentPath);
    } catch (err) {
      setError((err as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  function navigateToDir(subpath: string) {
    setPreview(null);
    loadFiles(subpath === '.' ? undefined : subpath);
  }

  function navigateUp() {
    if (currentPath === '.') return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || '.';
    navigateToDir(parent);
  }

  async function previewFile(entry: FileEntry) {
    if (entry.isDirectory) {
      navigateToDir(entry.path);
      return;
    }

    // Check if text-previewable
    if (!isTextFile(entry.name) && !isImageFile(entry.name)) {
      setPreview({ name: entry.name, content: '', truncated: false, size: entry.size });
      return;
    }

    if (isImageFile(entry.name)) {
      // For images, we don't load content — just set preview metadata
      setPreview({ name: entry.name, content: '__IMAGE__', truncated: false, size: entry.size });
      return;
    }

    setPreviewLoading(true);
    try {
      const result = await window.mlb.bridge.fileContent(name, entry.path);
      setPreview({ name: entry.name, ...result });
    } catch (err) {
      setPreview({ name: entry.name, content: `Error: ${(err as Error).message}`, truncated: false, size: 0 });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function revealInFinder(filePath?: string) {
    await window.mlb.bridge.revealFile(name, filePath);
  }

  // Breadcrumb segments
  const breadcrumbs = currentPath === '.'
    ? [{ label: workDir.replace(/^\/Users\/[^/]+/, '~'), path: '.' }]
    : [
        { label: workDir.replace(/^\/Users\/[^/]+/, '~'), path: '.' },
        ...currentPath.split('/').map((seg, i, arr) => ({
          label: seg,
          path: arr.slice(0, i + 1).join('/'),
        })),
      ];

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 shrink-0">
        <button onClick={() => navigate('list', name)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          {t('files.back')}
        </button>
        <h1 className="text-lg font-semibold">{t('files.title', { name })}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => loadFiles(currentPath === '.' ? undefined : currentPath)}
            className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            {t('files.refresh')}
          </button>
          <button
            onClick={() => revealInFinder(currentPath === '.' ? undefined : currentPath)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-700
              text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            {t('files.reveal')}
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="px-6 pb-3 shrink-0">
        <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 overflow-x-auto">
          <FolderIcon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-slate-300 dark:text-slate-600">/</span>}
              <button
                onClick={() => navigateToDir(crumb.path)}
                className="hover:text-indigo-600 dark:hover:text-indigo-400 truncate max-w-48"
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex flex-col px-6 pb-4 min-h-0">
        {error && (
          <div className="mb-3 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-9 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 gap-3">
            {/* File list */}
            <div className={`overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ${preview ? 'max-h-[45%]' : 'flex-1'}`}>
              {currentPath !== '.' && (
                <FileRow
                  entry={{ name: '..', path: '', isDirectory: true, size: 0, modifiedTime: '' }}
                  onClick={navigateUp}
                  isParent
                />
              )}
              {entries.length === 0 && !error ? (
                <div className="text-center py-8 text-sm text-slate-400 dark:text-slate-600">
                  {t('files.empty')}
                </div>
              ) : (
                entries.map((entry) => (
                  <FileRow
                    key={entry.path}
                    entry={entry}
                    onClick={() => previewFile(entry)}
                    active={preview?.name === entry.name && !entry.isDirectory}
                  />
                ))
              )}
            </div>

            {/* Preview panel */}
            {preview && (
              <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('files.preview')}: {preview.name}</span>
                  <span className="text-[10px] text-slate-400">{formatSize(preview.size)}</span>
                  {preview.truncated && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">
                      {t('files.preview.truncated', { size: '512 KB' })}
                    </span>
                  )}
                  <button
                    onClick={() => setPreview(null)}
                    className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-4">
                  {previewLoading ? (
                    <div className="skeleton h-40 rounded-lg" />
                  ) : preview.content === '__IMAGE__' ? (
                    <div className="text-center text-sm text-slate-400">
                      Image preview not available in sandbox mode
                    </div>
                  ) : preview.content === '' && preview.size > 0 ? (
                    <div className="text-center text-sm text-slate-400 py-4">
                      {t('files.preview.binary')}
                    </div>
                  ) : (
                    <pre className="text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words leading-relaxed">
                      {preview.content}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Helpers ---

function FileRow({ entry, onClick, isParent = false, active = false }: {
  entry: FileEntry;
  onClick: () => void;
  isParent?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors
        hover:bg-slate-50 dark:hover:bg-slate-700/30
        ${active ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}
        ${!isParent ? 'border-b border-slate-100 dark:border-slate-700/50 last:border-0' : 'border-b border-slate-100 dark:border-slate-700/50'}`}
    >
      {/* Icon */}
      {entry.isDirectory ? (
        <FolderIcon className="w-4 h-4 shrink-0 text-indigo-500 dark:text-indigo-400" />
      ) : (
        <FileIcon className="w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500" />
      )}

      {/* Name */}
      <span className={`flex-1 truncate ${entry.isDirectory ? 'font-medium text-slate-800 dark:text-slate-200' : 'text-slate-700 dark:text-slate-300'}`}>
        {entry.name}{entry.isDirectory && !isParent ? '/' : ''}
      </span>

      {/* Size */}
      {!entry.isDirectory && (
        <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums shrink-0 w-16 text-right">
          {formatSize(entry.size)}
        </span>
      )}

      {/* Time */}
      {!isParent && entry.modifiedTime && (
        <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0 w-16 text-right">
          {formatRelativeTime(entry.modifiedTime)}
        </span>
      )}
    </button>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  );
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.swift',
  '.log', '.csv', '.sql', '.graphql', '.prisma', '.dockerfile',
  '.gitignore', '.editorconfig', '.eslintrc', '.prettierrc',
]);

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.has(lower)) return true; // exact match for dotfiles
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return TEXT_EXTENSIONS.has(lower.slice(dotIdx));
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

function isImageFile(name: string): boolean {
  const dotIdx = name.toLowerCase().lastIndexOf('.');
  if (dotIdx === -1) return false;
  return IMAGE_EXTENSIONS.has(name.toLowerCase().slice(dotIdx));
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  try {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  } catch {
    return '';
  }
}
