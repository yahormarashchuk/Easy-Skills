import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { alive } from './util.js';

let ownIdentity: string | undefined;
export function processIdentity(pid: number): string | undefined {
  if (pid === process.pid && ownIdentity) return ownIdentity;
  let identity: string | undefined;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      identity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } else if (process.platform === 'win32') {
      const result = spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
        {encoding: 'utf8', windowsHide: true, timeout: 5000});
      if (result.status === 0 && /^\d+$/.test(result.stdout.trim())) identity = 'windows:' + result.stdout.trim();
    }
  } catch { /* Unknown identity must retain a live owner's lock. */ }
  if (pid === process.pid) ownIdentity = identity;
  return identity;
}
export function ownerAlive(pid?: number, identity?: string): boolean {
  if (!alive(pid)) return false;
  const actual = pid ? processIdentity(pid) : undefined;
  return !identity || !actual || actual === identity;
}
