import React, { useState } from 'react';
import { useBridgeStore } from '../stores/bridge-store';
import { useI18n } from '../i18n';
import StatusBadge from './StatusBadge';
import Modal from './Modal';

function formatUptime(seconds?: number): string {
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

export default function Sidebar() {
  const { bridges, selectedBridge, currentPage, navigate, loading, startBridge, stopBridge, deleteBridge } = useBridgeStore();
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const filtered = search
    ? bridges.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()))
    : bridges;

  return (
    <>
      <aside className="w-64 shrink-0 flex flex-col h-full
        bg-white/80 dark:bg-slate-800/80 backdrop-blur
        border-r border-slate-200 dark:border-slate-700/50">

        {/* Header with drag region for macOS title bar — pl-20 avoids traffic lights */}
        <div className="drag-region h-11 flex items-center pl-20 pr-4 shrink-0">
          <h1 className="text-sm font-semibold text-slate-700 dark:text-slate-300 truncate">
            MLB Manager
          </h1>
        </div>

        {/* Search + New button */}
        <div className="px-3 pb-2 flex gap-2 no-drag">
          <div className="flex-1 relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('bridge.list.search')}
              className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg
                bg-slate-100 dark:bg-slate-700/50
                text-slate-700 dark:text-slate-300
                placeholder-slate-400 dark:placeholder-slate-500
                border border-transparent
                focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30
                outline-none transition-all"
            />
          </div>
          <button
            onClick={() => navigate('new')}
            className="no-drag shrink-0 w-8 h-8 flex items-center justify-center rounded-lg
              bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            title={t('bridge.list.new')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {/* Bridge list */}
        <div className="flex-1 overflow-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-slate-400 dark:text-slate-600">{t('bridge.list.empty')}</p>
              {!search && (
                <button
                  onClick={() => navigate('new')}
                  className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {t('bridge.list.empty.cta')}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((bridge) => {
                const isSelected = selectedBridge === bridge.name && currentPage !== 'new';
                return (
                  <div
                    key={bridge.name}
                    onClick={() => navigate('list', bridge.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // Select on right-click too
                      navigate('list', bridge.name);
                    }}
                    className={`group relative rounded-xl p-2.5 cursor-pointer transition-all duration-150
                      ${isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/50 shadow-sm'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/30 border border-transparent'
                      }`}
                  >
                    {/* Name + Status */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-sm font-medium truncate
                        ${isSelected ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-800 dark:text-slate-200'}`}>
                        {bridge.name}
                      </span>
                      <StatusBadge state={bridge.state} compact />
                    </div>

                    {/* Meta line */}
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-500">
                      {bridge.state === 'running' && bridge.uptime !== undefined && (
                        <span>{formatUptime(bridge.uptime)}</span>
                      )}
                      {bridge.autoStart && (
                        <span className="text-slate-400">{t('bridge.autoStart')}</span>
                      )}
                    </div>

                    {/* Quick actions on hover */}
                    <div className="absolute right-1.5 top-1.5 hidden group-hover:flex gap-0.5">
                      {bridge.state === 'running' ? (
                        <MiniBtn
                          icon={stopIcon}
                          onClick={(e) => { e.stopPropagation(); stopBridge(bridge.name); }}
                          title={t('bridge.action.stop')}
                          danger
                        />
                      ) : (
                        <>
                          <MiniBtn
                            icon={playIcon}
                            onClick={(e) => { e.stopPropagation(); startBridge(bridge.name); }}
                            title={t('bridge.action.start')}
                          />
                          <MiniBtn
                            icon={trashIcon}
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(bridge.name); }}
                            title={t('bridge.action.delete')}
                            danger
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteBridge(deleteTarget); }}
        title={t('bridge.action.delete.title')}
        message={t('bridge.action.delete.confirm', { name: deleteTarget ?? '' })}
        confirmLabel={t('bridge.action.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
      />
    </>
  );
}

function MiniBtn({
  icon, onClick, title, danger = false,
}: {
  icon: React.ReactNode; onClick: (e: React.MouseEvent) => void; title: string; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors
        ${danger
          ? 'text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30'
          : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-600'
        }`}
    >
      {icon}
    </button>
  );
}

const playIcon = (
  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
    <path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" />
  </svg>
);
const stopIcon = (
  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
    <path fillRule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm5-2.25A.75.75 0 0 1 7.75 7h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5Z" clipRule="evenodd" />
  </svg>
);
const trashIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
  </svg>
);
