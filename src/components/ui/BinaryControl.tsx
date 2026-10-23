/** Shared two-choice control used by agent availability and Explorer. */
export function BinaryControl({ label, choices, value, disabledChoices, onChange }: {
  label: string; choices: readonly [{ value: string; label: string }, { value: string; label: string }];
  value: string; disabledChoices?: readonly [boolean, boolean]; onChange: (value: string) => void;
}) {
  return <div className="agent-enabled-control" data-disabled={value === choices[1].value} role="group" aria-label={label}>
    <span className="agent-enabled-indicator" aria-hidden="true" />
    {choices.map((choice, index) => <button type="button" key={choice.value} aria-pressed={choice.value === value} disabled={disabledChoices?.[index]} onClick={() => onChange(choice.value)}>{choice.label}</button>)}
  </div>;
}
