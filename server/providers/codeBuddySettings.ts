/** Native local-command acknowledgements only; callers fence the session and output cursor. */
export function codeBuddyEffortAcknowledgement(output: string): string | undefined {
  const normal = output.match(/^Model reasoning effort set to `?([a-zA-Z0-9_-]{1,80})`?\.\s*$/m)?.[1];
  if (normal) return normal;
  if (/<system-reminder data-role="ultra_effort_enter">[\s\S]*?<\/system-reminder>/.test(output)
    || /^`workflowEffortLevel` is already `ultracode`\. No change\.\s*$/m.test(output)) return 'ultracode';
  const exit = output.match(/<system-reminder data-role="ultra_effort_exit">([\s\S]*?)<\/system-reminder>/)?.[1];
  return exit?.match(/\*\*ultracode mode disabled\*\* \(was `ultracode`, now `([a-zA-Z0-9_-]{1,80})`\)\./)?.[1];
}
