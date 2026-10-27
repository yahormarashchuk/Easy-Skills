import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import { randomUUID } from 'node:crypto';
import { redact, message } from '../util.js';

export const LocalSettings = z.object({
  smtp: z.object({host: z.string().min(1), port: z.number().int().min(1).max(65535),
    secure: z.boolean(), user: z.string().optional(), passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    from: z.email(), to: z.email()}).strict().optional(),
  remote: z.object({allowedAuthors: z.array(z.string().min(1)).min(1)}).strict().optional(),
  execution: z.object({tools: z.record(z.string(), z.string()).optional(),
    environment: z.record(z.enum(['git', 'github', 'client', 'mcp', 'project', 'notification', 'supervisor', 'tool']), z.array(z.string())).optional()}).strict().optional(),
}).strict();
export type LocalSettings = z.infer<typeof LocalSettings>;
export function settings(store: Store): LocalSettings {
  const path = join(store.home, 'settings.json');
  return existsSync(path) ? LocalSettings.parse(JSON.parse(readFileSync(path, 'utf8'))) : {};
}
export function mailTransport(config: NonNullable<LocalSettings['smtp']>) {
  const pass = config.passwordEnv ? process.env[config.passwordEnv] : undefined;
  if (config.user && !pass) throw new Error('SMTP password environment variable is not available to this process');
  return nodemailer.createTransport({host: config.host, port: config.port, secure: config.secure,
    requireTLS: !config.secure, auth: config.user ? {user: config.user, pass} : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000});
}
export async function flushNotifications(store: Store, options: {transport?: {sendMail(mail: any): Promise<unknown>}} = {}): Promise<{sent: number; pending: number; configured: boolean}> {
  const config = settings(store).smtp, pending = store.pendingNotifications();
  if (!config) return {sent: 0, pending: pending.length, configured: false};
  const transport = options.transport || mailTransport(config), owner = randomUUID();
  let sent = 0;
  for (;;) {
    const row = store.claimNotification(owner);
    if (!row) break;
    try {
      const payload = JSON.parse(String(row.payload));
      await transport.sendMail({from: {name: 'Easy Skills', address: config.from}, to: config.to,
        messageId: `<${String(row.key).replace(/[^a-zA-Z0-9-]/g, '-')}@easy-skills.local>`,
        subject: redact(`[Easy Skills][${payload.project}][${payload.feature}] ${{needs_decision: 'Decision required', waiting_quota: 'Waiting for quota recovery', waiting_resource: 'Waiting for a resource', waiting_external: 'Waiting for external recovery', ready: 'Ready for final verification'}[payload.state as string] || payload.state}`).replace(/[\r\n]/g, ' '),
        text: redact(`${payload.reason}\n\nState: ${payload.state}\n${payload.url || ''}`)});
      if (store.completeNotification(String(row.key), owner)) sent++;
    } catch (error) {store.retryNotification(String(row.key), owner, Number(row.attempts)); store.event('notifications', 'notification.failed', {key: row.key, message: redact(message(error))});}
  }
  return {sent, pending: store.pendingNotifications().length, configured: true};
}
