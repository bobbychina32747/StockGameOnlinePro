// This only routes session renewal; the server still verifies every token.
export function tokenAlgorithm(token: string | null): string | null {
  try {
    const header = token?.split('.')[0];
    if (!header) return null;
    return JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/'))).alg ?? null;
  } catch { return null; }
}
