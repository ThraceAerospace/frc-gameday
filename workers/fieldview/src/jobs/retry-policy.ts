/** HTTP responses that may recover without changing the command or its identity. */
export function isRetryableWorkflowHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
