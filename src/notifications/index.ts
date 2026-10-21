import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { Store } from '../persistence/store.js';

export const LocalSettings = z.object({
  smtp: z.object({host: z.string().min(1), port: z.number().int().min(1).max(65535),
    secure: z.boolean(), user: z.string().optional(), passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    from: z.email(), to: z.email()}).strict().optional(),
  remote: z.object({allowedAuthors: z.array(z.string().min(1)).min(1)}).strict().optional(),
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
export async function flushNotifications(store: Store): Promise<{sent: number; pending: number; configured: boolean}> {
  const config = settings(store).smtp, pending = store.pendingNotifications();
  if (!config) return {sent: 0, pending: pending.length, configured: false};
  const transport = mailTransport(config);
  let sent = 0;
  for (const row of pending) {
    const payload = JSON.parse(String(row.payload));
    try {
      await transport.sendMail({from: {name: 'Easy Skills', address: config.from}, to: config.to,
        messageId: `<${String(row.key).replace(/[^a-zA-Z0-9-]/g, '-')}@easy-skills.local>`,
        subject: `[Easy Skills][${payload.project}][${payload.feature}] ${payload.state}`,
        text: `${payload.reason}\n\nState: ${payload.state}\n${payload.url || ''}`});
      store.markSent(String(row.key)); sent++;
    } catch (e) {store.markAttempt(String(row.key)); throw e;}
  }
  return {sent, pending: pending.length - sent, configured: true};
}
