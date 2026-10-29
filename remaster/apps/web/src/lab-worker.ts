import { runLab, verifyLabExport } from '../../../packages/engine/lab';

// No account transport, storage, or production API is imported into this worker.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (value: unknown) => void;
};
scope.onmessage = async event => {
  const { kind, input } = event.data ?? {};
  try {
    if (kind !== 'run' && kind !== 'replay') throw new Error('LAB_REQUEST');
    const result = kind === 'run' ? await runLab(input) : await verifyLabExport(input);
    scope.postMessage({ ok: true, result });
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : 'LAB_FAILED' });
  }
};
