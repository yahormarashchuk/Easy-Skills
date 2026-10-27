import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { pollRemote } from '../../src/runner/remote.js';

test('remote status retries a lost response and records terminal success only after reconciliation', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.parentIssue = 99; f.store.save(run, 'fixture');
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({remote: {allowedAuthors: ['human']}}));
    f.github.issueComments = [{id: 80, author: 'human', body: `/easy-skills status ${run.id} ${run.planHash}`}];
    let calls = 0;
    f.github.commentOnce = async () => {if (++calls === 1) throw new Error('ECONNRESET after read');};
    await pollRemote(f.store, run, f.engine, f.github);
    assert.equal(f.store.operation<any>(`${run.id}:remote:80`).state, 'transient_failed');
    await pollRemote(f.store, run, f.engine, f.github);
    await pollRemote(f.store, run, f.engine, f.github);
    assert.equal(calls, 2);
    assert.equal(f.store.operation<any>(`${run.id}:remote:80`).state, 'succeeded');
  } finally {await f.dispose();}
});

test('malformed command syntax gives one scoped reply only to an allowed author', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.parentIssue = 99; f.store.save(run, 'fixture');
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({remote: {allowedAuthors: ['human']}}));
    f.github.issueComments = [{id: 901, author: 'human', body: '/easy-skills answer malformed'}, {id: 902, author: 'other', body: '/easy-skills broken'}];
    await pollRemote(f.store, run, f.engine, f.github); await pollRemote(f.store, run, f.engine, f.github);
    assert.equal(f.github.commentsWritten.length, 1); assert.match(f.github.commentsWritten[0]!, /syntax/);
  } finally {await f.dispose();}
});

test('accepted merge code remains bound to the same durable operation after a crash', async () => {
  const f = await fixture();
  try {
    const run = f.engine.approve(f.run.id, f.run.planHash); run.parentIssue = 99;
    run.status = 'ready'; run.finalReviewHead = 'a'.repeat(40); f.store.save(run, 'fixture');
    const request = f.store.createDecision(run, run.finalReviewHead, 'final-merge', '12345678');
    writeFileSync(join(f.store.home, 'settings.json'), JSON.stringify({remote: {allowedAuthors: ['human']}}));
    const body = `/easy-skills confirm ${run.id} ${run.planHash} ${request} ${run.finalReviewHead} 12345678`;
    f.github.issueComments = [{id: 81, author: 'human', body}];
    let attempts = 0;
    f.engine.confirmFinalMerge = async () => {
      if (++attempts === 1) throw new Error('ECONNRESET before action');
      return run;
    };
    await pollRemote(f.store, run, f.engine, f.github);
    // Simulate a process that died with an executing intent, then reopen its database.
    const key = `${run.id}:remote:81`, intent = f.store.operation<any>(key);
    f.store.recordOperation(key, run.id, 'fixture.crash', {...intent, state: 'executing'});
    await pollRemote(f.store, run, f.engine, f.github);
    assert.equal(attempts, 2);
    assert.equal(f.store.operation<any>(key).state, 'succeeded');
    f.github.issueComments.push({id: 82, author: 'human', body});
    await pollRemote(f.store, run, f.engine, f.github);
    assert.equal(attempts, 2, 'another comment cannot reuse the code');
  } finally {await f.dispose();}
});
