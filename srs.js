/* 間隔反復（SM-2の簡略版）。忘却曲線に沿って、次にいつ出すかだけを決める。
   ここは DOM にも DB にも触らない純関数にしてあるので、
   コンソールで next({interval:1,ease:2.5,reps:0,lapses:0}, 'good') のように直接検算できる。 */

const DAY = 24 * 60 * 60 * 1000;

const EASE_MIN = 1.3;
const EASE_DELTA = { again: -0.2, hard: -0.15, good: 0, easy: 0.1 };

// 重要度が高いカードほど間隔を縮め、目に触れる回数を増やす
const IMPORTANCE_FACTOR = { 0: 1, 1: 1, 2: 0.85, 3: 0.7 };

/**
 * srs: { interval(日), ease, reps, lapses }
 * grade: 'again' | 'hard' | 'good' | 'easy'
 * importance: 0..3
 * now: Date.now() の値（テスト時に差し替えられるよう引数にする）
 * 戻り値: 新しい srs（due はタイムスタンプ）
 */
export function next(srs, grade, importance = 0, now = Date.now()) {
  const ease = Math.max(EASE_MIN, (srs.ease ?? 2.5) + EASE_DELTA[grade]);
  const reps = srs.reps ?? 0;
  const lapses = srs.lapses ?? 0;

  if (grade === 'again') {
    return {
      ease, reps, lapses: lapses + 1,
      interval: 0,
      due: now, // 当日中にもう一度出す
      lastResult: grade,
    };
  }

  let interval;
  if (reps === 0) interval = 1;
  else if (reps === 1) interval = 3;
  else interval = (srs.interval || 1) * ease;

  interval *= IMPORTANCE_FACTOR[importance] ?? 1;
  interval = Math.max(1, Math.round(interval * 10) / 10);

  return {
    ease, lapses,
    reps: reps + 1,
    interval,
    due: now + interval * DAY,
    lastResult: grade,
  };
}

/** 新規カードの初期状態 */
export function initial(now = Date.now()) {
  return { interval: 0, ease: 2.5, reps: 0, lapses: 0, due: now, lastResult: null };
}

/** カードを間違えたとき、つながっている類題を今日の期限に引き寄せる（1ホップのみ） */
export function pullDue(linkedSrs, now = Date.now()) {
  if (linkedSrs.due <= now) return linkedSrs; // 既に今日以前ならそのまま
  return { ...linkedSrs, due: now };
}

export { DAY };
