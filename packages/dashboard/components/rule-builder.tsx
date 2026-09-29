'use client';

import { Plus, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { Badge, Card } from '@/components/ui/misc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TargetingRule } from '@/lib/flags';

/**
 * Editor for a flag's targeting rules.
 *
 * Rules beat the percentage rollout, so this is how you let specific people in
 * before anyone else — the "turn it on for me and QA first" move.
 *
 * The rules are serialised into a hidden input so the surrounding Server Action
 * form submits them without this component needing its own request.
 */

const OPERATORS = [
  { value: 'in', label: 'is any of', hint: 'Matches when the attribute equals one of the values.' },
  { value: 'eq', label: 'equals', hint: 'Matches one exact value.' },
] as const;

export function RuleBuilder({ name, initial }: { name: string; initial: TargetingRule[] }) {
  const [rules, setRules] = useState<TargetingRule[]>(initial);

  const update = (index: number, patch: Partial<TargetingRule>) =>
    setRules((current) =>
      current.map((rule, i) => {
        if (i !== index) return rule;
        const next = { ...rule, ...patch };
        // The API rejects `eq` with more than one value, so keep the UI honest
        // rather than letting the user discover it on save.
        if (next.operator === 'eq' && next.values.length > 1) next.values = next.values.slice(0, 1);
        return next;
      }),
    );

  const addRule = (rule: TargetingRule) => setRules((current) => [...current, rule]);
  const removeRule = (index: number) =>
    setRules((current) => current.filter((_, i) => i !== index));

  return (
    <div className="space-y-3">
      <input type="hidden" name={name} value={JSON.stringify(rules)} />

      {rules.length === 0 && (
        <p className="rounded-lg border border-dashed border-border-subtle px-4 py-6 text-center text-sm text-ink-muted">
          No targeting rules. Everyone is decided by the rollout percentage.
        </p>
      )}

      {rules.map((rule, index) => (
        <RuleRow
          key={index}
          rule={rule}
          index={index}
          onChange={(patch) => update(index, patch)}
          onRemove={() => removeRule(index)}
        />
      ))}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => addRule({ attribute: 'userId', operator: 'in', values: [] })}
        >
          <UserPlus className="h-4 w-4" />
          Allowlist users
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => addRule({ attribute: '', operator: 'eq', values: [] })}
        >
          <Plus className="h-4 w-4" />
          Add attribute rule
        </Button>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: TargetingRule;
  index: number;
  onChange: (patch: Partial<TargetingRule>) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState('');
  const singleValue = rule.operator === 'eq';
  const atCapacity = singleValue && rule.values.length >= 1;

  function commitValue() {
    const value = draft.trim();
    if (!value || atCapacity || rule.values.includes(value)) {
      setDraft('');
      return;
    }
    onChange({ values: [...rule.values, value] });
    setDraft('');
  }

  return (
    <Card className="p-4" data-testid={`rule-${index}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="space-y-1.5">
            <Label htmlFor={`rule-${index}-attribute`}>Attribute</Label>
            <Input
              id={`rule-${index}-attribute`}
              value={rule.attribute}
              placeholder="userId, email, plan…"
              onChange={(event) => onChange({ attribute: event.target.value })}
              aria-label={`Rule ${index + 1} attribute`}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`rule-${index}-operator`}>Operator</Label>
            <Select
              value={rule.operator}
              onValueChange={(operator) => onChange({ operator: operator as TargetingRule['operator'] })}
            >
              <SelectTrigger id={`rule-${index}-operator`} aria-label={`Rule ${index + 1} operator`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATORS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button
          type="button"
          variant="dangerGhost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove rule ${index + 1}`}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-3 space-y-1.5">
        <Label htmlFor={`rule-${index}-value`}>{singleValue ? 'Value' : 'Values'}</Label>

        {rule.values.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1">
            {rule.values.map((value) => (
              <Badge key={value} tone="brand" className="pr-1">
                <span className="max-w-48 truncate" title={value}>
                  {value}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  className="rounded-full p-0.5 hover:bg-brand/15"
                  onClick={() => onChange({ values: rule.values.filter((v) => v !== value) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            id={`rule-${index}-value`}
            value={draft}
            disabled={atCapacity}
            placeholder={atCapacity ? 'equals takes exactly one value' : 'Type a value, press Enter'}
            aria-label={`Rule ${index + 1} value`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                // Enter would otherwise submit the surrounding form.
                event.preventDefault();
                commitValue();
              }
            }}
            onBlur={commitValue}
          />
          <Button type="button" variant="secondary" onClick={commitValue} disabled={atCapacity}>
            Add
          </Button>
        </div>

        {rule.values.length === 0 && (
          <p className="text-xs text-ink-muted">
            A rule with no values is ignored by the evaluator.
          </p>
        )}
      </div>
    </Card>
  );
}
