import React, { useEffect, useRef } from 'react';
import { useClaudeSetupStore, type StepProgress, type ConfigItem } from '../stores/claude-setup-store';
import { useI18n } from '../i18n';

interface ClaudeSetupProps {
  onComplete: () => void;
}

export default function ClaudeSetup({ onComplete }: ClaudeSetupProps) {
  const { installed, version, installing, steps, installError, installClaude, updateStep } = useClaudeSetupStore();
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = window.mlb.onClaudeSetupProgress((progress) => {
      updateStep(progress as StepProgress);
    });
    return cleanup;
  }, [updateStep]);

  // Auto-scroll to latest step
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [steps]);

  const allDone = steps.length > 0 && steps.every((s) => s.status === 'done');
  const hasError = steps.some((s) => s.status === 'error') || !!installError;
  const started = steps.length > 0;

  return (
    <div className="flex-1 flex flex-col items-center h-full overflow-hidden">
      {/* Header */}
      <div className="text-center pt-12 pb-6 px-6 shrink-0">
        {/* Animated icon */}
        <div className={`w-16 h-16 mx-auto mb-5 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500
          ${allDone
            ? 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/20 scale-110'
            : hasError
              ? 'bg-gradient-to-br from-red-500 to-rose-600 shadow-red-500/20'
              : 'bg-gradient-to-br from-indigo-500 to-violet-600 shadow-indigo-500/20'
          }`}>
          {allDone ? (
            <CheckIcon className="w-8 h-8 text-white" />
          ) : hasError ? (
            <XIcon className="w-8 h-8 text-white" />
          ) : (
            <TerminalIcon className="w-8 h-8 text-white" />
          )}
        </div>

        <h1 className="text-xl font-bold mb-1.5 text-slate-800 dark:text-slate-100">
          {allDone ? t('claude.setup.success') : t('claude.setup.title')}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {allDone && version
            ? t('claude.setup.version', { version })
            : t('claude.setup.desc')
          }
        </p>
      </div>

      {/* Steps timeline */}
      {started && (
        <div ref={scrollRef} className="flex-1 w-full max-w-xl mx-auto overflow-y-auto px-6 pb-4">
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[15px] top-3 bottom-3 w-px bg-slate-200 dark:bg-slate-700" />

            {steps.map((step, i) => (
              <StepRow key={step.step} step={step} isLast={i === steps.length - 1} t={t} />
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="shrink-0 pb-8 pt-4 flex flex-col items-center gap-3">
        {allDone ? (
          <button
            onClick={onComplete}
            className="px-10 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-xl
              hover:bg-emerald-700 transition-all shadow-sm hover:shadow-md"
          >
            {t('claude.setup.continue')}
          </button>
        ) : (
          <>
            <button
              onClick={installClaude}
              disabled={installing}
              className="px-10 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl
                hover:bg-indigo-700 transition-all shadow-sm hover:shadow-md
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? (
                <span className="flex items-center gap-2">
                  <Spinner className="w-4 h-4" />
                  Installing...
                </span>
              ) : hasError ? t('claude.setup.retry') : t('claude.setup.install')}
            </button>
            {!installing && !started && (
              <a
                href="https://docs.anthropic.com/en/docs/claude-code/overview"
                target="_blank" rel="noopener noreferrer"
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                {t('claude.setup.manual')} →
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, isLast, t }: { step: StepProgress; isLast: boolean; t: (k: string) => string }) {
  const isDone = step.status === 'done';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';
  const skipped = step.detail === 'skipped';

  return (
    <div className="relative pl-10 pb-5 animate-fade-in" style={{ animationDelay: `${step.step * 50}ms` }}>
      {/* Node */}
      <div className={`absolute left-0 top-0.5 w-[31px] h-[31px] rounded-full flex items-center justify-center
        border-2 transition-all duration-300 bg-white dark:bg-slate-900 z-10
        ${isDone ? 'border-emerald-500' : isError ? 'border-red-500' : isRunning ? 'border-indigo-500' : 'border-slate-300 dark:border-slate-600'}
      `}>
        {isDone ? (
          <div className="w-full h-full rounded-full bg-emerald-500 flex items-center justify-center">
            <CheckIcon className="w-3.5 h-3.5 text-white" />
          </div>
        ) : isError ? (
          <div className="w-full h-full rounded-full bg-red-500 flex items-center justify-center">
            <XIcon className="w-3.5 h-3.5 text-white" />
          </div>
        ) : isRunning ? (
          <Spinner className="w-4 h-4 text-indigo-500" />
        ) : (
          <span className="text-xs text-slate-400">{step.step}</span>
        )}
      </div>

      {/* Content */}
      <div>
        <div className={`text-sm font-medium mb-1 transition-colors ${
          isRunning ? 'text-indigo-600 dark:text-indigo-400' :
          isDone ? 'text-slate-700 dark:text-slate-300' :
          isError ? 'text-red-600 dark:text-red-400' :
          'text-slate-400'
        }`}>
          {t(step.label) !== step.label ? t(step.label) : step.label}
          {skipped && <span className="text-slate-400 dark:text-slate-600 font-normal ml-2">— skipped</span>}
        </div>

        {step.detail && !skipped && (
          <div className="text-xs text-slate-400 dark:text-slate-500 font-mono mb-1.5">
            {step.detail}
          </div>
        )}

        {/* Config key-value cards */}
        {step.config && step.config.length > 0 && !skipped && (
          <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden
            bg-slate-50 dark:bg-slate-800/50">
            {step.config.map((item, i) => (
              <ConfigRow key={i} item={item} isLast={i === step.config!.length - 1} />
            ))}
          </div>
        )}

        {step.error && (
          <div className="mt-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-xs text-red-600 dark:text-red-400 font-mono break-all">{step.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ item, isLast }: { item: ConfigItem; isLast: boolean }) {
  return (
    <div className={`flex items-center px-3 py-1.5 text-xs gap-3 animate-fade-in
      ${isLast ? '' : 'border-b border-slate-200 dark:border-slate-700'}`}>
      <span className="text-slate-500 dark:text-slate-400 shrink-0 w-32 text-right font-medium">
        {item.key}
      </span>
      <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
        {item.masked ? '••••••••' : item.value}
      </span>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="3" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="3" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
