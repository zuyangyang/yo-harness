/**
 * ToolSteps: collapsible group of tool call steps.
 * Each step pairs a tool_call with its tool_result.
 */
import { useState } from 'react';
import type { ToolStep } from '../../utils/turn-grouping.js';
import { ApprovalCard } from '../Approval/ApprovalCard.js';
import { useApprovalStore } from '../../stores/approval.js';
import {
  ChevronRightIcon,
  WrenchScrewdriverIcon,
  ClockIcon,
  CheckIcon,
  XMarkIcon,
} from '../Icons/index.js';

interface ToolStepsProps {
  steps: ToolStep[];
}

export function ToolSteps({ steps }: ToolStepsProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0) return null;

  const successCount = steps.filter((s) => s.result?.ok).length;
  const failedCount = steps.filter((s) => s.result && !s.result.ok).length;
  const pendingCount = steps.filter((s) => !s.result && !s.waitingApproval).length;
  const waitingCount = steps.filter((s) => s.waitingApproval && !s.result).length;

  return (
    <div className="turn-tools">
      <div className="turn-tools__summary" onClick={() => setExpanded(!expanded)}>
        <span className={`turn-thinking__arrow ${expanded ? 'turn-thinking__arrow--expanded' : ''}`}>
          <ChevronRightIcon className="icon-arrow" />
        </span>
        <WrenchScrewdriverIcon className="icon-tool-group" />
        <span className="turn-tools__label">
          {steps.length} tool call{steps.length > 1 ? 's' : ''}
        </span>
        <span className="turn-tools__stats">
          {successCount > 0 && <span className="turn-tools__stat--success">{successCount} ok</span>}
          {failedCount > 0 && <span className="turn-tools__stat--error">{failedCount} failed</span>}
          {pendingCount > 0 && <span className="turn-tools__stat--pending">{pendingCount} running</span>}
          {waitingCount > 0 && <span className="turn-tools__stat--warning">{waitingCount} waiting</span>}
        </span>
      </div>
      {expanded && (
        <div className="turn-tools__list">
          {steps.map((step) => (
            <ToolStepItem key={step.callId} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolStepItem({ step }: { step: ToolStep }): JSX.Element {
  const statusIcon = getStatusIcon(step);
  const argsPreview = formatArgs(step.args);
  // 等待审批时按 callId 关联到实时待审批项，渲染可操作的审批卡
  const pendingApproval = useApprovalStore((s) =>
    s.pendingApprovals.find((a) => a.callId === step.callId),
  );

  return (
    <div className="tool-step">
      <div className="tool-step__header">
        <span className={`tool-step__status ${getStatusClass(step)}`}>{statusIcon}</span>
        <span className="tool-step__name">{step.toolName}</span>
        {step.result?.durationMs !== undefined && (
          <span className="tool-step__duration">{formatDuration(step.result.durationMs)}</span>
        )}
      </div>
      {argsPreview && (
        <div className="tool-step__args">{argsPreview}</div>
      )}
      {step.waitingApproval &&
        (pendingApproval ? (
          <ApprovalCard request={pendingApproval} />
        ) : (
          <div className="tool-step__waiting">
            Waiting approval: {step.waitingApproval.summary}
          </div>
        ))}
      {step.result && (
        <div className={`tool-step__result ${step.result.ok ? '' : 'tool-step__result--error'}`}>
          {step.result.content || (step.result.ok ? 'OK' : 'Failed')}
        </div>
      )}
    </div>
  );
}

function getStatusIcon(step: ToolStep): JSX.Element {
  if (step.waitingApproval) return <ClockIcon className="icon-status icon-status--pending" />;
  if (!step.result) return <ClockIcon className="icon-status icon-status--pending icon-spin" />;
  return step.result.ok
    ? <CheckIcon className="icon-status icon-status--success" />
    : <XMarkIcon className="icon-status icon-status--error" />;
}

function getStatusClass(step: ToolStep): string {
  if (step.waitingApproval) return 'tool-step__status--warning';
  if (!step.result) return 'tool-step__status--pending';
  return step.result.ok ? 'tool-step__status--success' : 'tool-step__status--error';
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      const truncated = val.length > 80 ? `${val.slice(0, 80)}...` : val;
      return `${key}: ${truncated}`;
    })
    .join(', ');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
