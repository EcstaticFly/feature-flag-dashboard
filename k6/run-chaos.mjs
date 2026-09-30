import { spawn, spawnSync } from 'node:child_process';

/**
 * Runs the chaos load test and kills Redis in the middle of it.
 *
 * Written in Node rather than bash so it behaves the same in Git Bash,
 * PowerShell and CI. k6 cannot shell out, so the orchestration has to live
 * outside the test script.
 *
 * Timeline (default 60s run):
 *   0s   load starts, Redis healthy
 *   20s  docker compose stop redis      <- the outage begins
 *   45s  docker compose start redis     <- recovery, with load still running
 *   60s  load ends
 */

const MODE = process.argv[2] === 'blackout' ? 'blackout' : 'redis';
const DURATION_S = Number(process.env.LOAD_DURATION_S || (MODE === 'blackout' ? 20 : 60));
const KILL_AT_S = Number(process.env.CHAOS_KILL_AT_S || 20);
const RESTORE_AT_S = Number(process.env.CHAOS_RESTORE_AT_S || 45);

const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));
const stamp = () => new Date().toISOString().slice(11, 19);

function compose(...args) {
  const result = spawnSync('docker', ['compose', ...args], { stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

function runK6(script) {
  return spawn(
    'docker',
    [
      // --no-deps is essential: without it `compose run` starts k6's
      // dependencies, which resurrects the very services this test just
      // stopped. The stack is expected to be up already (npm run compose:up).
      'compose', '--profile', 'load', 'run', '--rm', '--no-deps',
      '-e', `LOAD_DURATION=${DURATION_S}s`,
      'k6', 'run', `/scripts/${script}`,
    ],
    { stdio: 'inherit', shell: false },
  );
}

/** Always leave the stack running, however the run ended. */
function restoreAll() {
  for (const service of ['postgres', 'redis']) {
    try {
      compose('start', service);
    } catch {
      /* already running */
    }
  }
}

/**
 * Ctrl+C would otherwise leave Postgres and Redis stopped, because the restore
 * only ran when k6 exited normally — a chaos script must never leave the
 * machine in the state it created, least of all when someone aborts it.
 */
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`
[chaos] ${stamp()} interrupted — restarting postgres and redis`);
    restoreAll();
    process.exit(130);
  });
}

function finish(code, failed) {
  restoreAll();
  console.log(`
[chaos] ${stamp()} k6 exited with ${code}`);
  process.exit(failed ? 1 : (code ?? 1));
}

if (MODE === 'blackout') {
  /*
   * Total outage. Both tiers go down BEFORE the load starts, so every request
   * in the run takes the fallback path — the fail-closed policy is what is
   * under test here, not graceful degradation.
   */
  console.log(`[chaos] ${stamp()} blackout: stopping postgres and redis, then ${DURATION_S}s of load`);
  compose('stop', 'redis');
  compose('stop', 'postgres');

  runK6('blackout.js').on('exit', (code) => finish(code, false));
} else {
  console.log(`[chaos] ${stamp()} starting ${DURATION_S}s run; redis down ${KILL_AT_S}s-${RESTORE_AT_S}s`);

  const k6 = runK6('chaos.js');
  let failed = false;

  const schedule = (async () => {
    try {
      await sleep(KILL_AT_S);
      console.log(`
[chaos] ${stamp()} >>> stopping redis, mid-load <<<
`);
      compose('stop', 'redis');

      await sleep(RESTORE_AT_S - KILL_AT_S);
      console.log(`
[chaos] ${stamp()} >>> restarting redis <<<
`);
      compose('start', 'redis');
    } catch (err) {
      failed = true;
      console.error(`[chaos] orchestration failed: ${err.message}`);
    }
  })();

  k6.on('exit', async (code) => {
    await schedule;
    finish(code, failed);
  });
}
