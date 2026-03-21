import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useDeepForgeStore, type DeepForgeProject } from '../stores/deepforge-store';

const PHASE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  planning: { bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
  executing: { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  paused: { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  completing: { bg: 'bg-purple-50 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400', dot: 'bg-purple-500' },
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
  completing: '打包中',
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

const ROLE_LABELS: Record<string, string> = {
  planner: '规划师',
  coder: '编码者',
  reviewer: '审查者',
  tester: '测试者',
  architect: '架构师',
  designer: '设计师',
  writer: '文档编写',
  debugger: '调试者',
  researcher: '调研者',
  executor: '执行者',
  validator: '验证者',
  fixer: '修复者',
  refactorer: '重构者',
  analyst: '分析师',
  orchestrator: '编排者',
  manager: '管理者',
};

function getRoleLabel(role: string): string {
  const lower = role.toLowerCase();
  return ROLE_LABELS[lower] || role;
}

function formatElapsed(startedAt?: string | number): string {
  if (!startedAt) return '';
  const start = typeof startedAt === 'string' ? new Date(startedAt).getTime() : startedAt;
  if (isNaN(start)) return '';
  const elapsed = Math.floor((Date.now() - start) / 1000);
  if (elapsed < 0) return '';
  if (elapsed < 60) return `${elapsed}秒`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  return `${h}时${m}分`;
}

// --- Log parsing utilities ---

interface LogEntry {
  type: 'tool' | 'text' | 'unknown';
  toolName?: string;
  paramsSummary?: string;
  content: string;
}

function parseLogEntries(output: string): LogEntry[] {
  if (!output) return [];
  const lines = output.split('\n');
  const entries: LogEntry[] = [];
  let currentEntry: LogEntry | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[tool]')) {
      if (currentEntry) entries.push(currentEntry);
      const rest = trimmed.slice(6).trim();
      const match = rest.match(/^(\S+)\s*(.*)/);
      currentEntry = {
        type: 'tool',
        toolName: match ? match[1] : rest,
        paramsSummary: match && match[2] ? match[2].slice(0, 120) : undefined,
        content: rest,
      };
    } else if (trimmed.startsWith('[text]')) {
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        type: 'text',
        content: trimmed.slice(6).trim(),
      };
    } else {
      // continuation of previous entry or standalone
      if (currentEntry) {
        currentEntry.content += '\n' + trimmed;
      } else {
        currentEntry = { type: 'unknown', content: trimmed };
      }
    }
  }
  if (currentEntry) entries.push(currentEntry);
  return entries;
}

// --- Task statistics ---

interface TaskStats {
  total: number;
  completed: number;
  running: number;
  failed: number;
  pending: number;
}

function computeTaskStats(tasks: DeepForgeProject['tasks']): TaskStats {
  const stats: TaskStats = { total: tasks.length, completed: 0, running: 0, failed: 0, pending: 0 };
  for (const t of tasks) {
    if (t.status === 'completed') stats.completed++;
    else if (t.status === 'running') stats.running++;
    else if (t.status === 'failed') stats.failed++;
    else stats.pending++;
  }
  return stats;
}

// --- Status badge component ---

function StatusBadgeIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      );
    case 'running':
      return (
        <span className="relative flex h-3.5 w-3.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-blue-500" />
        </span>
      );
    case 'failed':
      return (
        <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      );
    default: // pending
      return (
        <span className="w-3 h-3 rounded-full bg-slate-300 dark:bg-slate-600" />
      );
  }
}

// --- Stats bar component ---

function TaskStatsBar({ stats }: { stats: TaskStats }) {
  if (stats.total === 0) return null;

  const items = [
    { label: '总数', count: stats.total, color: 'bg-slate-400 dark:bg-slate-500', textColor: 'text-slate-600 dark:text-slate-400' },
    { label: '完成', count: stats.completed, color: 'bg-emerald-500', textColor: 'text-emerald-600 dark:text-emerald-400' },
    { label: '运行中', count: stats.running, color: 'bg-blue-500', textColor: 'text-blue-600 dark:text-blue-400' },
    { label: '失败', count: stats.failed, color: 'bg-red-500', textColor: 'text-red-600 dark:text-red-400' },
    { label: '待执行', count: stats.pending, color: 'bg-slate-300 dark:bg-slate-600', textColor: 'text-slate-500 dark:text-slate-400' },
  ];

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${item.color}`} />
          <span className={`text-xs ${item.textColor}`}>
            {item.label}
          </span>
          <span className={`text-xs font-semibold ${item.textColor}`}>
            {item.count}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- Timeline entry component ---

function TimelineEntry({ entry, index, total }: { entry: LogEntry; index: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const isLast = index === total - 1;

  if (entry.type === 'tool') {
    return (
      <div className="flex gap-3">
        {/* Vertical timeline line + dot */}
        <div className="flex flex-col items-center w-5 shrink-0">
          <div className="w-2 h-2 rounded-full bg-indigo-400 dark:bg-indigo-500 mt-2 shrink-0 ring-2 ring-indigo-100 dark:ring-indigo-900/50" />
          {!isLast && <div className="w-px flex-1 bg-slate-200 dark:bg-slate-700 mt-1" />}
        </div>
        {/* Card */}
        <div className="flex-1 mb-3 min-w-0">
          <div className="bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-200/50 dark:border-indigo-800/30 rounded-lg p-2.5">
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.049.58.025 1.193-.14 1.743" />
              </svg>
              <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 font-mono">
                {entry.toolName}
              </span>
            </div>
            {entry.paramsSummary && (
              <p className="text-[11px] text-indigo-600/70 dark:text-indigo-400/60 mt-1 truncate font-mono">
                {entry.paramsSummary}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (entry.type === 'text') {
    const preview = entry.content.slice(0, 100);
    const hasMore = entry.content.length > 100;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center w-5 shrink-0">
          <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600 mt-2 shrink-0" />
          {!isLast && <div className="w-px flex-1 bg-slate-200 dark:bg-slate-700 mt-1" />}
        </div>
        <div className="flex-1 mb-3 min-w-0">
          <div
            className={`rounded-lg p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50
              ${hasMore ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700/50' : ''}`}
            onClick={() => hasMore && setExpanded(!expanded)}
          >
            <p className="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-all">
              {expanded ? entry.content : preview}{hasMore && !expanded ? '...' : ''}
            </p>
            {hasMore && (
              <button className="text-[10px] text-indigo-500 dark:text-indigo-400 mt-1 hover:underline">
                {expanded ? '收起' : '展开全部'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // unknown
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center w-5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 mt-2 shrink-0" />
        {!isLast && <div className="w-px flex-1 bg-slate-200 dark:bg-slate-700 mt-1" />}
      </div>
      <div className="flex-1 mb-2 min-w-0">
        <p className="text-[11px] text-slate-500 dark:text-slate-500 truncate">{entry.content.slice(0, 120)}</p>
      </div>
    </div>
  );
}

const FINISHED_PHASES = new Set(['completed', 'paused']);

export default function DeepForgeDashboard() {
  const { projects, loading, error, fetchProjects, selectedProject, selectProject, detailState, detailLogs, detailLoading, fetchLogs } = useDeepForgeStore();
  const [tab, setTab] = useState<'active' | 'finished'>('active');

  // Poll projects every 5 seconds
  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  const activeProjects = useMemo(() => projects.filter(p => !FINISHED_PHASES.has(p.phase) || p.isRunning), [projects]);
  const finishedProjects = useMemo(() => projects.filter(p => FINISHED_PHASES.has(p.phase) && !p.isRunning), [projects]);

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
          <h1 className="text-sm font-semibold">DeepForge 控制台</h1>
          {!selectedProject && (
            <div className="flex items-center bg-slate-100 dark:bg-slate-700 rounded-lg p-0.5">
              <button
                onClick={() => setTab('active')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  tab === 'active'
                    ? 'bg-white dark:bg-slate-600 text-slate-800 dark:text-slate-200 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                进行中 {activeProjects.length > 0 && <span className="ml-1 text-[10px] opacity-60">{activeProjects.length}</span>}
              </button>
              <button
                onClick={() => setTab('finished')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  tab === 'finished'
                    ? 'bg-white dark:bg-slate-600 text-slate-800 dark:text-slate-200 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                已结束 {finishedProjects.length > 0 && <span className="ml-1 text-[10px] opacity-60">{finishedProjects.length}</span>}
              </button>
            </div>
          )}
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
              <p className="text-sm">加载 DeepForge 项目失败</p>
              <p className="text-xs mt-1">{error}</p>
            </div>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-slate-400 dark:text-slate-600">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z" />
              </svg>
              <p className="text-sm">暂无 DeepForge 项目</p>
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
            onProjectDeleted={() => selectProject(null)}
          />
        ) : (
          (() => {
            const displayed = tab === 'active' ? activeProjects : finishedProjects;
            return displayed.length === 0 ? (
              <div className="flex items-center justify-center h-64">
                <p className="text-sm text-slate-400 dark:text-slate-500">
                  {tab === 'active' ? '没有进行中的项目' : '没有已结束的项目'}
                </p>
              </div>
            ) : (
              <div className="p-6 grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
                {displayed.map((project) => (
                  <ProjectCard key={project.id} project={project} onClick={() => selectProject(project.id)} />
                ))}
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}

function ProjectCard({ project, onClick }: { project: DeepForgeProject; onClick: () => void }) {
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
          {project.createdAt ? formatElapsed(project.createdAt) : '—'}
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
                className={`flex-1 ${TASK_STATUS_COLORS[task.status] || 'bg-slate-300 dark:bg-slate-600'}
                  ${task.status === 'running' ? 'animate-pulse' : ''}`}
                title={`${getRoleLabel(task.role)}: ${STATUS_LABELS[task.status] || task.status}`}
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
                {getRoleLabel(task.role)}
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
  project, detailState, detailLogs, detailLoading, onBack, onRefreshLogs, onProjectDeleted,
}: {
  project: DeepForgeProject | null;
  detailState: any;
  detailLogs: string[];
  detailLoading: boolean;
  onBack: () => void;
  onRefreshLogs: () => void;
  onProjectDeleted: () => void;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [expandedTask, setExpandedTask] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [packageLogs, setPackageLogs] = useState<string[]>([]);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeMsg, setResumeMsg] = useState('');
  const packageLogsEndRef = useRef<HTMLDivElement>(null);
  // Force re-render for elapsed time on running tasks
  const [, setTick] = useState(0);

  const { fetchProjects, pollDetail } = useDeepForgeStore();

  // Poll detail state every 5 seconds to keep iterations/tasks in sync
  useEffect(() => {
    const interval = setInterval(pollDetail, 5000);
    return () => clearInterval(interval);
  }, [pollDetail]);

  const handleStop = async () => {
    if (!project) return;
    if (!confirm('确定要终止该任务吗？正在执行的进程将被强制停止。')) return;
    try {
      setActionLoading('stop');
      await window.mlb.deepforge.stop(project.id);
      await fetchProjects();
    } catch (err) {
      alert(`终止失败: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async () => {
    if (!project) return;
    try {
      setActionLoading('resume');
      await window.mlb.deepforge.resume(project.id);
      await fetchProjects();
    } catch (err) {
      alert(`继续失败: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  // Subscribe to package progress
  useEffect(() => {
    if (!showPackageModal) return;
    const unsub = window.mlb.deepforge.onPackageProgress(({ projectId: pid, step }) => {
      if (project && pid === project.id) {
        setPackageLogs(prev => [...prev, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${step}`]);
      }
    });
    return unsub;
  }, [showPackageModal, project?.id]);

  // Auto-scroll package logs
  useEffect(() => {
    packageLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [packageLogs]);

  const [showPackageConfirm, setShowPackageConfirm] = useState(false);
  const packageAbortRef = useRef<AbortController | null>(null);

  const handlePackage = () => {
    if (!project) return;
    setShowPackageConfirm(true);
  };

  const handlePackageConfirm = async () => {
    if (!project) return;
    setShowPackageConfirm(false);
    setPackageLogs([]);
    setShowPackageModal(true);
    setActionLoading('package');
    packageAbortRef.current = new AbortController();
    try {
      const result = await window.mlb.deepforge.package(project.id);
      setPackageLogs(prev => [...prev, `✅ 完成！产出路径: ${result.path}`]);
    } catch (err) {
      if (packageAbortRef.current?.signal.aborted) {
        setPackageLogs(prev => [...prev, `⏹ 已停止`]);
      } else {
        setPackageLogs(prev => [...prev, `❌ 失败: ${(err as Error).message}`]);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = () => {
    if (!project) return;
    setResumeMsg('');
    setShowResumeModal(true);
  };

  const handleResumeConfirm = async () => {
    if (!project) return;
    try {
      setActionLoading('resume');
      setShowResumeModal(false);
      // Inject message to Leader before resuming (if provided)
      if (resumeMsg.trim()) {
        await window.mlb.deepforge.inject(project.id, `# 用户新指令（立即执行）\n\n${resumeMsg.trim()}\n\n**重要：请立即按照此指令调整方向，不要等下一轮。**`);
      }
      await window.mlb.deepforge.resume(project.id);
      await fetchProjects();
    } catch (err) {
      alert(`重启失败: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    try {
      setActionLoading('delete');
      await window.mlb.deepforge.delete(project.id);
      await fetchProjects();
      onProjectDeleted();
    } catch (err) {
      alert(`删除失败: ${(err as Error).message}`);
    } finally {
      setActionLoading(null);
      setShowDeleteConfirm(false);
    }
  };

  useEffect(() => {
    if (!project?.tasks.some(t => t.status === 'running')) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [project?.tasks]);

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
  const taskStats = computeTaskStats(project.tasks);

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
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => window.mlb.deepforge.reveal(project.id)}
            className="text-xs px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            title="在访达中打开工作目录"
          >
            打开目录
          </button>
          {/* Package deliverables — available when not running */}
          {!project.isRunning && (
            <button
              onClick={handlePackage}
              disabled={actionLoading === 'package'}
              className="text-xs px-2.5 py-1 rounded-lg bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors disabled:opacity-50"
              title="整理产出并打包"
            >
              {actionLoading === 'package' ? '打包中...' : '整理产出'}
            </button>
          )}
          {/* Restart with new code — available when paused/completed */}
          {!project.isRunning && (
            <button
              onClick={handleRestart}
              disabled={actionLoading === 'resume'}
              className="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors disabled:opacity-50"
              title="用最新代码重新启动，保留已有进度"
            >
              {actionLoading === 'resume' ? '启动中...' : '重新执行'}
            </button>
          )}
          {project.isRunning && (
            <button
              onClick={handleStop}
              disabled={actionLoading === 'stop'}
              className="text-xs px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
              title="终止正在运行的任务"
            >
              {actionLoading === 'stop' ? '终止中...' : '终止'}
            </button>
          )}
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="阶段" value={PHASE_LABELS[project.phase] || project.phase} />
        <StatCard label="迭代" value={`${project.currentIteration}/${project.totalIterations || '?'}`} />
        <StatCard label="运行时长" value={project.createdAt ? formatElapsed(project.createdAt) : '—'} />
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">最大并发</div>
          <select
            value={project.maxConcurrent || 5}
            onChange={async (e) => {
              const val = parseInt(e.target.value, 10);
              try {
                await window.mlb.deepforge.setConfig(project.id, 'maxConcurrent', val);
                await fetchProjects();
              } catch (err) {
                alert(`设置失败: ${(err as Error).message}`);
              }
            }}
            className="w-full text-lg font-semibold bg-transparent text-slate-800 dark:text-slate-200 border-none outline-none cursor-pointer"
          >
            {[1, 2, 3, 5, 8, 10, 15].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tasks section */}
      {project.tasks.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">当前任务</h2>
          </div>

          {/* Task statistics bar */}
          <div className="mb-4 p-3 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
            <TaskStatsBar stats={taskStats} />
            {/* Progress bar */}
            <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700 mt-2.5">
              {taskStats.completed > 0 && (
                <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${(taskStats.completed / taskStats.total) * 100}%` }} />
              )}
              {taskStats.running > 0 && (
                <div className="bg-blue-500 animate-pulse transition-all duration-500" style={{ width: `${(taskStats.running / taskStats.total) * 100}%` }} />
              )}
              {taskStats.failed > 0 && (
                <div className="bg-red-500 transition-all duration-500" style={{ width: `${(taskStats.failed / taskStats.total) * 100}%` }} />
              )}
              {taskStats.pending > 0 && (
                <div className="bg-slate-300 dark:bg-slate-600 transition-all duration-500" style={{ width: `${(taskStats.pending / taskStats.total) * 100}%` }} />
              )}
            </div>
          </div>

          {/* Task cards */}
          <div className="space-y-2">
            {project.tasks.map((task, i) => (
              <TaskCard
                key={i}
                task={task}
                index={i}
                projectId={project.id}
                isExpanded={expandedTask === i}
                onToggle={() => setExpandedTask(expandedTask === i ? null : i)}
              />
            ))}
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
                  {iter.tasks && (
                    <span className="text-xs text-slate-400">{iter.tasks.length} 个任务</span>
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
                        title={`${getRoleLabel(t.role)}: ${STATUS_LABELS[t.status] || t.status}`}
                      >
                        {getRoleLabel(t.role)}
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

      {/* Message to Leader */}
      <MessageToLeader projectId={project.id} />

      {/* Delete project */}
      <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-700">
        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
          >
            删除项目
          </button>
        ) : (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-xl p-4">
            <p className="text-sm text-red-700 dark:text-red-400 mb-3">
              确定删除该项目吗？所有产出将被永久删除，此操作不可恢复。
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={actionLoading === 'delete'}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {actionLoading === 'delete' ? '删除中...' : '确认删除'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resume modal */}
      {showResumeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-[480px] border border-slate-200 dark:border-slate-700">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <span className="text-base font-semibold text-slate-800 dark:text-slate-200">重新执行</span>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">可选：给 Leader 一条指令，立即按新方向迭代。留空则直接继续。</p>
              <textarea
                value={resumeMsg}
                onChange={(e) => setResumeMsg(e.target.value)}
                placeholder="例如：改用方案 B、重点对比钉钉、把报告改成英文..."
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleResumeConfirm(); }}
              />
              <p className="text-[11px] text-slate-400">⌘+Enter 快速启动</p>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
              <button
                onClick={() => setShowResumeModal(false)}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleResumeConfirm}
                className="text-xs px-4 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
              >
                {resumeMsg.trim() ? '注入指令并启动' : '直接启动'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Package confirm modal */}
      {showPackageConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-[400px] border border-slate-200 dark:border-slate-700">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <span className="text-base font-semibold text-slate-800 dark:text-slate-200">整理产出</span>
            </div>
            <div className="p-5">
              <p className="text-sm text-slate-600 dark:text-slate-400">将启动 Agent 整理产出并生成报告，打包为 zip。</p>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
              <button
                onClick={() => setShowPackageConfirm(false)}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handlePackageConfirm}
                className="text-xs px-4 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 transition-colors"
              >
                开始整理
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Package progress modal */}
      {showPackageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-[560px] max-h-[70vh] flex flex-col border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-slate-800 dark:text-slate-200">整理产出</span>
                {actionLoading === 'package' && (
                  <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                )}
              </div>
              {actionLoading !== 'package' && (
                <button
                  onClick={() => setShowPackageModal(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/50">
              {packageLogs.length === 0 ? (
                <p className="text-slate-400 dark:text-slate-500">等待 Agent 启动...</p>
              ) : (
                packageLogs.map((line, i) => (
                  <div key={i} className={`py-0.5 ${
                    line.includes('✅') ? 'text-emerald-600 dark:text-emerald-400 font-medium' :
                    line.includes('❌') ? 'text-red-500 dark:text-red-400 font-medium' :
                    line.includes('⚠️') ? 'text-amber-500 dark:text-amber-400' : ''
                  }`}>
                    {line}
                  </div>
                ))
              )}
              <div ref={packageLogsEndRef} />
            </div>
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
              {actionLoading === 'package' && project && (
                <button
                  onClick={async () => {
                    packageAbortRef.current?.abort();
                    await window.mlb.deepforge.packageStop(project.id);
                    setActionLoading(null);
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                >
                  停止
                </button>
              )}
              {actionLoading !== 'package' && (
                <button
                  onClick={() => setShowPackageModal(false)}
                  className="text-xs px-4 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  关闭
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Improved Task Card ---

function TaskCard({
  task,
  index,
  projectId,
  isExpanded,
  onToggle,
}: {
  task: DeepForgeProject['tasks'][number];
  index: number;
  projectId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [showRawLog, setShowRawLog] = useState(false);
  const hasExpandable = task.output || task.error || task.description;
  const logEntries = useMemo(() => parseLogEntries(task.output || ''), [task.output]);
  const roleLabel = getRoleLabel(task.role);

  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl border overflow-hidden transition-colors
      ${task.status === 'running'
        ? 'border-blue-200 dark:border-blue-800/50'
        : task.status === 'failed'
        ? 'border-red-200 dark:border-red-800/50'
        : 'border-slate-200 dark:border-slate-700'
      }`}>
      {/* Main card row */}
      <div
        className={`flex items-center gap-3 p-3 ${hasExpandable ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-750' : ''}`}
        onClick={() => hasExpandable && onToggle()}
      >
        {/* Status icon */}
        <div className="shrink-0">
          <StatusBadgeIcon status={task.status} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {roleLabel}
            </span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
              {task.role !== roleLabel ? task.role : ''}
            </span>
            {task.description && (
              <span className="text-xs text-slate-400 dark:text-slate-500 truncate flex-1 min-w-0">
                {task.description}
              </span>
            )}
          </div>

          {/* Running: progress animation + elapsed */}
          {task.status === 'running' && (
            <div className="mt-1.5">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-blue-500 dark:text-blue-400">执行中</span>
                {task.startedAt && (
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    {formatElapsed(task.startedAt)}
                  </span>
                )}
              </div>
              {/* Indeterminate progress bar */}
              <div className="h-1 w-full bg-blue-100 dark:bg-blue-900/30 rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-blue-500 rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" />
              </div>
            </div>
          )}

          {/* Failed: error summary directly on card */}
          {task.status === 'failed' && task.error && (
            <div className="mt-1.5 flex items-start gap-1.5">
              <svg className="w-3 h-3 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <p className="text-[11px] text-red-500 dark:text-red-400 line-clamp-2">
                {task.error.length > 150 ? task.error.slice(0, 150) + '...' : task.error}
              </p>
            </div>
          )}
        </div>

        {/* Status badge */}
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

        {/* Terminal attach button — visible for running/completed/failed tasks with an id */}
        {task.id && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.mlb.deepforge.attach(projectId, task.id!);
            }}
            className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            title="在终端中查看日志"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          </button>
        )}

        {/* Expand arrow */}
        {hasExpandable && (
          <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-slate-100 dark:border-slate-700">
          {/* Description */}
          {task.description && (
            <div className="px-4 pt-3">
              <div className="flex items-center gap-1.5 mb-1">
                <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">描述</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 ml-[18px]">{task.description}</p>
            </div>
          )}

          {/* Error detail */}
          {task.error && (
            <div className="px-4 pt-3">
              <div className="flex items-center gap-1.5 mb-1">
                <svg className="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <span className="text-[10px] text-red-400 font-medium uppercase tracking-wider">错误信息</span>
              </div>
              <p className="text-xs text-red-500 dark:text-red-400 ml-[18px] whitespace-pre-wrap">{task.error}</p>
            </div>
          )}

          {/* Timeline visualization of output */}
          {task.output && logEntries.length > 0 && (
            <div className="px-4 pt-3 pb-1">
              <div className="flex items-center gap-1.5 mb-3">
                <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
                </svg>
                <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">执行步骤</span>
                <span className="text-[10px] text-slate-400">({logEntries.length})</span>
              </div>
              <div className="ml-1">
                {logEntries.map((entry, idx) => (
                  <TimelineEntry key={idx} entry={entry} index={idx} total={logEntries.length} />
                ))}
              </div>
            </div>
          )}

          {/* Raw log toggle */}
          {task.output && (
            <div className="px-4 pb-3 pt-1">
              <button
                onClick={(e) => { e.stopPropagation(); setShowRawLog(!showRawLog); }}
                className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors flex items-center gap-1"
              >
                <svg className={`w-3 h-3 transition-transform ${showRawLog ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
                查看原始日志
              </button>
              {showRawLog && (
                <pre className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 whitespace-pre-wrap break-all
                  bg-slate-950 rounded-lg p-3 max-h-48 overflow-auto font-mono">
                  {task.output}
                </pre>
              )}
            </div>
          )}

          {/* Spacer if nothing else was rendered */}
          {!task.description && !task.error && !task.output && (
            <div className="p-3">
              <p className="text-xs text-slate-400 italic">暂无详情</p>
            </div>
          )}
        </div>
      )}
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

function MessageToLeader({ projectId }: { projectId: string }) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await window.mlb.deepforge.inject(projectId, msg.trim());
      setSent(true);
      setMsg('');
      setTimeout(() => setSent(false), 3000);
    } catch (err) {
      alert(`发送失败: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-6 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">给 Leader 发消息</h3>
      <p className="text-[11px] text-slate-400 mb-3">消息会写入 feedback.md，Leader 下一轮迭代时会读到并执行。</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="例如：论文改成中文、重点对比钉钉..."
          className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600
            bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300
            placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        />
        <button
          onClick={handleSend}
          disabled={sending || !msg.trim()}
          className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {sending ? '发送中...' : sent ? '已发送' : '发送'}
        </button>
      </div>
    </div>
  );
}
