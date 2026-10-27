import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { flushNotifications } from '../../src/notifications/index.js';

test('notification subjects, redaction and retry visibility are preserved at the SMTP boundary', async () => {
  const f = await fixture(), mails: any[] = [];
  try {
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({smtp: {host: 'fixture.invalid', port: 25, secure: false, from: 'from@example.invalid', to: 'to@example.invalid'}}));
    for (const state of ['needs_decision', 'waiting_quota', 'ready']) f.store.enqueue(state, {runId: f.run.id, project: 'fixture', feature: 'notification', state, reason: 'password=synthetic'});
    await flushNotifications(f.store, {transport: {async sendMail(mail) {mails.push(mail);}}});
    assert.deepEqual(mails.map(mail => mail.subject.split('] ').at(-1)), ['Decision required', 'Waiting for quota recovery', 'Ready for final verification']);
    assert.ok(mails.every(mail => !mail.text.includes('synthetic')));
    f.store.enqueue('failed-delivery', {runId: f.run.id, project: 'fixture', feature: 'notification', state: 'ready'});
    await flushNotifications(f.store, {transport: {async sendMail() {throw new Error('password=synthetic');}}});
    assert.deepEqual(f.store.notificationSummary(f.run.id), {pending: 1, retrying: 1});
    assert.ok(f.store.events('notifications').some(event => event.type === 'notification.failed' && !String(event.data).includes('synthetic')));
  } finally {await f.dispose();}
});

test('outbox claims prevent concurrent delivery and one failed message does not block others', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({smtp: {host: 'fixture.invalid', port: 25, secure: false, from: 'from@example.invalid', to: 'to@example.invalid'}}));
    for (const key of ['bad', 'good']) f.store.enqueue(key, {project: 'fixture', feature: key, state: 'ready'});
    const delivered: string[] = [];
    const transport = {async sendMail(mail: {messageId: string}) {
      await new Promise(resolve => setTimeout(resolve, 20));
      delivered.push(mail.messageId);
      if (mail.messageId.includes('bad')) throw new Error('temporary SMTP failure');
    }};
    await Promise.all([flushNotifications(f.store, {transport}), flushNotifications(f.store, {transport})]);
    assert.equal(delivered.length, 2);
    assert.equal(new Set(delivered).size, 2);
    assert.equal(f.store.pendingNotifications().length, 1);
  } finally {await f.dispose();}
});

test('expired outbox claims retry the same Message-ID after delivery acknowledgement is lost', async () => {
  const f = await fixture();
  try {
    f.store.enqueue('delivery', {});
    const first = f.store.claimNotification('worker-one', 60_000)!;
    assert.equal(first.key, 'delivery');
    assert.equal(f.store.claimNotification('worker-two'), undefined);
    f.store.db.prepare('UPDATE notifications SET lease_until=? WHERE key=?').run('2000-01-01T00:00:00.000Z', 'delivery');
    const recovered = f.store.claimNotification('worker-two')!;
    assert.equal(recovered.key, first.key);
    assert.equal(f.store.completeNotification('delivery', 'worker-one'), false);
    assert.equal(f.store.completeNotification('delivery', 'worker-two'), true);
  } finally {await f.dispose();}
});

test('SMTP success followed by a process crash can redeliver, with the same Message-ID', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({smtp: {host: 'fixture.invalid', port: 25, secure: false, from: 'from@example.invalid', to: 'to@example.invalid'}}));
    f.store.enqueue('lost-ack', {project: 'fixture', feature: 'delivery', state: 'ready'});
    const ids: string[] = [], transport = {async sendMail(mail: {messageId: string}) {ids.push(mail.messageId);}};
    const complete = f.store.completeNotification.bind(f.store), retry = f.store.retryNotification.bind(f.store);
    f.store.completeNotification = () => {throw new Error('Simulated process crash after SMTP success');};
    f.store.retryNotification = () => {throw new Error('Process died before retry state');};
    await assert.rejects(flushNotifications(f.store, {transport}), /Process died/);
    f.store.completeNotification = complete; f.store.retryNotification = retry;
    f.store.db.prepare('UPDATE notifications SET lease_until=?').run('2000-01-01T00:00:00.000Z');
    await flushNotifications(f.store, {transport});
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
    assert.equal(f.store.pendingNotifications().length, 0);
  } finally {await f.dispose();}
});
