import React, { useEffect, useState } from 'react';
import { useForgeStore, type ForgeProject } from '../stores/forge-store';

const PHASE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  planning: { bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
  executing: { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  paused: { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  completed: { bg: 'bg-slate-50 dark:bg-slate-700/30', text: 'text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' },
  failed: { bg: 'bg-red-50 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  error: { bg: 'bg-red-50 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
};

const DEFAULT_PHASE_COLOR = { bg: 'bg-slate-50 dark:bg-slate-700/30', text: 'text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' };

const TASK_STATUS_COLORS: Record<string, string> = {
  completed: 'bg-emerald-500',
  running: 'bg-blue-500',
  pending: 'bg-slate-300 dark:bg-slate-600',
  failed: 'bg-red-500',
  skipped: 'bg-slate-200 dark:bg-slate-700',
};

const PHASE_LABELS: Record<string, string> = {
  running: '运行中',
  planning: '规划中',
  executing: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  error: '错误',
};

const STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  running: '运行中',
  pending: '待执行',
  failed: '失败',
  skipped: '已跳过',
  paused: '已暂停',
};

function formatElapsed(startedAt?: number): string {
  if (!startedAt) return '';
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed}秒`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  return `${h}时${m}分`;
}

export default function ForgeDashboard() {
  const { projects, loading, error, fetchProjects, selectedProject, selectProject, detailState, detailLogs, detailLoading, fetchLogs } = useForgeStore();

  // Poll projects every 5 seconds
  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 shrink-0
        bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 0 0 .495-7.468 5.99 5.99 0 0 0-1.925 3.547 5.975 5.975 0 0 1-2.133-1.001A3.75 3.75 0 0 0 12 18Z" />
          </svg>
          <h1 className="text-sm font-semibold">Forge 控制台</h1>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {projects.length} 个项目
          </span>
        </div>
        <button
          onClick={() => fetchProjects()}
          className="px-3 py-1 text-xs font-medium rounded-lg transition-colors
            bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
            hover:bg-slate-200 dark:hover:bg-slate-600"
        >
          刷新
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && projects.length === 0 ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-slate-400 dark:text-slate-600">
              <p className="text-sm">加载 Forge 项目失败</p>
              <p className="text-xs mt-1">{error}</p>
            </div>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-slate-400 dark:text-slate-600">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
              </svg>
              <p className="text-sm">暂无 Forge 项目</p>
              <p className="text-xs mt-1">~/.forge/projects/ 和 ~/.deepforge/projects/ 中的项目会显示在这里</p>
            </div>
          </div>
        ) : selectedProject ? (
          <ProjectDetail
            project={projects.find((p) => p.id === selectedProject) ?? null}
            detailState={detailState}
            detailLogs={detailLogs}
            detailLoading={detailLoading}
            onBack={() => selectProject(null)}
            onRefreshLogs={() => { if (selectedProject) fetchLogs(selectedProject); }}
          />
        ) : (
          <div className="p-6 grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onClick={() => selectProject(project.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectCard({ project, onClick }: { project: ForgeProject; onClick: () => void }) {
  const phaseColor = PHASE_COLORS[project.phase] || DEFAULT_PHASE_COLOR;

  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700
        p-4 cursor-pointer transition-all duration-150
        hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-sm"
    >
      {/* Title + Status */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
            {project.title}
          </h3>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-mono">
            {project.id}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {project.isRunning && (
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot" />
          )}
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${phaseColor.bg} ${phaseColor.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${phaseColor.dot}`} />
            {PHASE_LABELS[project.phase] || project.phase}
          </span>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400 mb-3">
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
          </svg>
          迭代 {project.currentIteration}/{project.totalIterations || '?'}
        </span>
        <span className="flex items-center gap-1">
          {(project.totalTokens || 0).toLocaleString()} tokens
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-400">
          {project.source}
        </span>
      </div>

      {/* Tasks bar */}
      {project.tasks.length > 0 && (
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium tracking-wider">
              任务
            </span>
            <span className="text-[10px] text-slate-400">
              ({project.tasks.filter((t) => t.status === 'completed').length}/{project.tasks.length})
            </span>
          </div>
          <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700">
            {project.tasks.map((task, i) => (
              <div
                key={i}
                className={`flex-1 ${TASK_STATUS_COLORS[task.status] || 'bg-slate-300 dark:bg-slate-600'}`}
                title={`${task.role}: ${STATUS_LABELS[task.status] || task.status}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1 mt-2">
            {project.tasks.map((task, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md
                  ${task.status === 'completed'
                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                    : task.status === 'running'
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : task.status === 'failed'
                    ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                    : 'bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400'
                  }`}
              >
                <span className={`w-1 h-1 rounded-full ${TASK_STATUS_COLORS[task.status] || 'bg-slate-300'}`} />
                {task.role}
                {task.status === 'failed' && task.error && (
                  <span className="text-red-500 dark:text-red-400 ml-0.5" title={task.error}>!</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectDetail({
  project, detailState, detailLogs, detailLoading, onBack, onRefreshLogs,
}: {
  project: ForgeProject | null;
  detailState: any;
  detailLogs: string[];
  detailLoading: boolean;
  onBack: () => void;
  onRefreshLogs: () => void;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [expandedTask, setExpandedTask] = useState<number | null>(null);

  if (!project) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          &larr; 返回项目列表
        </button>
        <p className="text-sm text-slate-400 mt-4">项目未找到</p>
      </div>
    );
  }

  const phaseColor = PHASE_COLORS[project.phase] || DEFAULT_PHASE_COLOR;

  // Extract iterations from detail state
  const iterations: any[] = detailState?.iterations || [];

  return (
    <div className="max-w-3xl mx-auto p-6 animate-fade-in">
      {/* Back button */}
      <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-4">
        &larr; 返回项目列表
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-200">{project.title}</h1>
        {project.isRunning && (
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse-dot" />
        )}
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${phaseColor.bg} ${phaseColor.text}`}>
          {PHASE_LABELS[project.phase] || project.phase}
        </span>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="阶段" value={PHASE_LABELS[project.phase] || project.phase} />
        <StatCard label="迭代" value={`${project.currentIteration}/${project.totalIterations || '?'}`} />
        <StatCard label="费用" value={`${(p.totalInputTokens||0)+(p.totalOutputTokens||0)} tokens`} />
        <StatCard label="来源" value={project.source} />
      </div>

      {/* Tasks section */}
      {project.tasks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-3 text-slate-700 dark:text-slate-300">当前任务</h2>
          <div className="space-y-2">
            {project.tasks.map((task, i) => {
              const isExpanded = expandedTask === i;
              const hasExpandable = task.output || task.error || task.description;
              return (
                <div key={i} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <div
                    className={`flex items-center gap-3 p-3 ${hasExpandable ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-750' : ''}`}
                    onClick={() => hasExpandable && setExpandedTask(isExpanded ? null : i)}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_STATUS_COLORS[task.status] || 'bg-slate-300'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{task.role}</span>
                        {task.description && (
                          <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{task.description}</span>
                        )}
                      </div>
                      {task.status === 'running' && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] text-blue-500 dark:text-blue-400">执行中...</span>
                          {task.startedAt && (
                            <span className="text-[11px] text-slate-400 dark:text-slate-500">
                              已用时 {formatElapsed(task.startedAt)}
                            </span>
                          )}
                        </div>
                      )}
                      {task.status === 'failed' && task.error && (
                        <p className="text-[11px] text-red-500 dark:text-red-400 mt-0.5 truncate" title={task.error}>
                          {task.error}
                        </p>
                      )}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0
                      ${task.status === 'completed'
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                        : task.status === 'running'
                        ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                        : task.status === 'failed'
                        ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {STATUS_LABELS[task.status] || task.status}
                    </span>
                    {hasExpandable && (
                      <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                      </svg>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="border-t border-slate-100 dark:border-slate-700 px-3 py-2 space-y-2">
                      {task.description && (
                        <div>
                          <span className="text-[10px] text-slate-400 font-medium">描述</span>
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{task.description}</p>
                        </div>
                      )}
                      {task.error && (
                        <div>
                          <span className="text-[10px] text-red-400 font-medium">错误信息</span>
                          <p className="text-xs text-red-500 dark:text-red-400 mt-0.5 whitespace-pre-wrap">{task.error}</p>
                        </div>
                      )}
                      {task.output && (
                        <div>
                          <span className="text-[10px] text-slate-400 font-medium">输出</span>
                          <pre className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 whitespace-pre-wrap break-all
                            bg-slate-50 dark:bg-slate-900/50 rounded-lg p-2 max-h-40 overflow-auto font-mono">
                            {task.output.length > 500 ? task.output.slice(0, 500) + '...' : task.output}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Iterations timeline */}
      {iterations.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-3 text-slate-700 dark:text-slate-300">迭代记录</h2>
          <div className="space-y-2">
            {iterations.map((iter: any, i: number) => (
              <div
                key={i}
                className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    第 {i + 1} 次迭代
                  </span>
                  {iter.costUsd !== undefined && (
                    <span className="text-xs text-slate-400">{Math.round(Number(iter.costUsd) * 5000).toLocaleString()} tokens</span>
                  )}
                </div>
                {Array.isArray(iter.tasks) && iter.tasks.length > 0 && (
                  <div className="flex gap-1 mt-2">
                    {iter.tasks.map((t: any, j: number) => (
                      <span
                        key={j}
                        className={`text-[10px] px-1.5 py-0.5 rounded
                          ${t.status === 'completed'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                            : t.status === 'failed'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                            : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
                          }`}
                        title={`${t.role}: ${STATUS_LABELS[t.status] || t.status}`}
                      >
                        {t.role}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Logs section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">日志</h2>
          <div className="flex gap-2">
            <button
              onClick={onRefreshLogs}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors
                bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
                hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              刷新
            </button>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors
                bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300
                hover:bg-slate-200 dark:hover:bg-slate-600"
            >
              {showLogs ? '收起' : '展开'}
            </button>
          </div>
        </div>
        {showLogs && (
          <div className="bg-slate-950 rounded-xl p-4 font-mono text-xs leading-5 max-h-80 overflow-auto">
            {detailLogs.length === 0 ? (
              <span className="text-slate-600">暂无日志</span>
            ) : (
              detailLogs.map((line, i) => (
                <div key={i} className="text-slate-400 whitespace-pre-wrap break-all hover:bg-slate-900/50 px-1 -mx-1 rounded">
                  {line}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
      <div className="text-[11px] text-slate-500 dark:text-slate-500 mb-1">{label}</div>
      <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{value}</div>
    </div>
  );
}
