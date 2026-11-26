import { fmtRemaining } from '../lib/format';
import { patchMe, type Ctx } from '../core/ctx';

export interface BanService {
  /** Shows the ban countdown until `until` (ISO), or `remainingSeconds` from now when `until` is unusable. */
  start(until: string | undefined, remainingSeconds: number | undefined): void;
  stop(): void;
}

export function createBan(ctx: Ctx): BanService {
  const { deps, store } = ctx;
  let timer: unknown = null;
  let until = 0;

  function clearTimer(): void {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  }

  function stop(): void {
    clearTimer();
    until = 0;
    store.set((s) => (s.ban === null ? s : { ...s, ban: null }));
  }

  function tick(): void {
    const left = (until - deps.now()) / 1000;
    if (left <= 0) {
      stop();
      patchMe(ctx, { ban: null });
      return;
    }
    store.set((s) => ({ ...s, ban: { until, label: fmtRemaining(left) } }));
  }

  function start(untilIso: string | undefined, remainingSeconds: number | undefined): void {
    let end = untilIso ? Date.parse(untilIso) : NaN;
    if (Number.isNaN(end)) end = deps.now() + (remainingSeconds || 0) * 1000;
    until = end;
    clearTimer();
    tick();
    if (until > deps.now()) timer = deps.setInterval(tick, 1000);
  }

  return { start, stop };
}
